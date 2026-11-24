/**
 * 学习周报 / 月报聚合（第 10 轮任务 B）。
 *
 * 与 aggregate.ts 的 buildReport 同层的纯函数聚合器：输入各 store 实体数组 +
 * 目标周期（周 / 月 + 锚点 now），输出纯数据结构。**不含 Date.now() 副作用**：
 * 「今天」由调用方经 `now` 传入（必填；传入非有限值按契约违约抛错，保证可测）。
 *
 * 口径决定（实现依据见各段注释）：
 *  - 周界 = 本地周一（沿用 shared/utils.startOfLocalWeek 与 buildReport「近 12 周」的既有惯例；
 *    weeklyPlans 本身不按日历周对齐——它是「从 startDate 起按天切片」的日历计划，
 *    与任何周界都兼容，故周界取既有惯例即可，不与计划起始日强绑定）。
 *  - 月界 = 本地自然月（1 日 00:00 → 次月 1 日 00:00）。
 *  - 站内秒数 = `valid === true` 流水的 durationSec 之和（与 buildReport.totalSec 同口径；
 *    跨零点记录由引擎按本地自然日拆分，故按 `date` 日键归桶与按 startTs 归桶等价）。
 *  - 站外秒数 = externalWatch.seconds 按 `date` 归桶（独立口径，不并入站内，同 buildReport）。
 *  - 周报计划完成度：完全复用 core/plan/weekly 的既有口径函数——
 *    `planDaySlice` 算「该周排期到的 bvid」，`weeklyPlanProgress`（收藏
 *    `metadata.watchedRatio >= 0.95`）算完看，不另造阈值。
 *  - 月报复习保持率：reviewJobs 中 `status === 'done'` 的作业以 `updatedAt`（完成时刻）
 *    为复习时间；「有复习记录的收藏」= 有至少一条 done 作业的 favoriteId；
 *    保持率 = 最近一次 done 落在该月内的收藏数 / 有复习记录的收藏数。
 */

import type { WeeklyPlan } from '../plan/weekly';
import { planDaySlice, weeklyPlanProgress } from '../plan/weekly';
import type { ExternalWatchEntity, FavoriteEntity, ReviewJobEntity, WatchRecordEntity } from '../shared/types';
import { clamp, dayKeyToTs, localDayKey, shortDayLabel, startOfLocalWeek } from '../shared/utils';

export type PeriodKind = 'week' | 'month';

/** 周报默认跨度（含当前周） */
export const DEFAULT_WEEK_COUNT = 8;
/** 月报默认跨度（含当前月） */
export const DEFAULT_MONTH_COUNT = 6;

/** 周：周期内计划完成度（口径 = core/plan/weekly 的完看定义） */
export interface PeriodPlanProgress {
  /** 该周计划排期到的视频数（多计划去重合并） */
  total: number;
  /** 其中已完看数（收藏 metadata.watchedRatio ≥ 0.95，现值口径，见文件头注释） */
  finished: number;
  /** 其中该周有站外流水（externalWatch seconds > 0）覆盖数 */
  touched: number;
  /** finished / total；total 为 0 时为 0 */
  ratio: number;
}

/** 月：复习保持率（口径见文件头注释） */
export interface PeriodReviewRetention {
  /** 有复习记录（≥1 条 done 作业）的收藏数（全库口径，各月分母相同） */
  reviewed: number;
  /** 最近一次复习完成落在该月内的收藏数 */
  retained: number;
  /** retained / reviewed；reviewed 为 0 时为 0 */
  ratio: number;
}

/** 单个周期桶（旧 → 新排列；当前周期为最后一个，天然是「进行中的部分周期」） */
export interface PeriodBucket {
  /** 周 = 周一日键 'YYYY-MM-DD'；月 = 'YYYY-MM' */
  key: string;
  /** 明细行标签：周 'MM-DD–MM-DD'；月 'YYYY年M月' */
  label: string;
  /** 趋势图短标签：周 'MM-DD'；月 'M月'（跨年 'YY年M月'） */
  chartLabel: string;
  kind: PeriodKind;
  /** 起始日（含）'YYYY-MM-DD'（周一 / 1 日） */
  startDay: string;
  /** 结束日（含）'YYYY-MM-DD'（周日 / 月末；不随「今天」截断，未来天无数据自然为 0） */
  endDay: string;
  /** startDay 本地 00:00（含） */
  startTs: number;
  /** endDay 次日本地 00:00（不含） */
  endTs: number;
  /** 站内有效学习秒数（valid 流水，与报表口径一致） */
  internalSec: number;
  /** 站外视频学习秒数（externalWatch，独立口径） */
  externalSec: number;
  /** 活跃天数：站内有效学习或站外学习覆盖的自然日数 */
  activeDays: number;
  /** 站内有效流水条数 */
  flowCount: number;
  /** 周：计划完成度；该周无任何计划排期时为 null */
  plan?: PeriodPlanProgress | null;
  /** 月：复习保持率；无任何复习完成记录时为 null */
  review?: PeriodReviewRetention | null;
}

export interface PeriodReport {
  kind: PeriodKind;
  /** 实际生成的周期数（已 clamp） */
  count: number;
  /** 聚合锚点的本地日键（调用方传入的「今天」） */
  todayKey: string;
  /** 旧 → 新 */
  buckets: PeriodBucket[];
  /** 窗口内站内 / 站外合计秒数（冗余汇总，免去 UI 再 reduce） */
  totalInternalSec: number;
  totalExternalSec: number;
  generatedAt: number;
}

export interface PeriodReportInput {
  kind: PeriodKind;
  /** 周期数（含当前周期）；缺省周 8 / 月 6，非法值回退默认并 clamp */
  count?: number;
  /** 「今天」毫秒时间戳（必填：纯函数约定，不内部取 Date.now()） */
  now: number;
  /** 站内观看流水（可只传窗口内的） */
  records?: WatchRecordEntity[];
  /** 站外学习流水（可只传窗口内的） */
  externalRecords?: ExternalWatchEntity[];
  /** 每周学习计划（周报计划完成度用；缺省 / 空数组 → plan 全为 null） */
  plans?: WeeklyPlan[];
  /** 收藏（计划完看口径读 metadata.watchedRatio；缺省 → finished 记 0） */
  favorites?: FavoriteEntity[];
  /** 复习作业（月报保持率用；缺省 / 空数组 → review 全为 null） */
  reviewJobs?: ReviewJobEntity[];
}

// ───────────────────────── 周期列表 ─────────────────────────

function isFiniteNum(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 'YYYY-MM-DD' → 次日 00:00 本地毫秒（按日历日 +1，跨夏令时安全） */
function nextDayTs(dayKey: string): number {
  const d = new Date(dayKeyToTs(dayKey));
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 生成最近 N 个周期的空桶（旧 → 新，最后一个为当前周期）。
 * 周 = 本地周一为界（startOfLocalWeek 既有惯例）；月 = 本地自然月。
 * now 非有限时抛错：纯函数契约，「今天」必须由调用方给定。
 */
export function periodBuckets(kind: PeriodKind, count: number | undefined, now: number): PeriodBucket[] {
  if (!isFiniteNum(now)) throw new Error('periodBuckets: now 必须是有限毫秒时间戳（由调用方注入）');
  const fallback = kind === 'month' ? DEFAULT_MONTH_COUNT : DEFAULT_WEEK_COUNT;
  const maxCount = kind === 'month' ? 60 : 104;
  const n = clamp(Math.round(isFiniteNum(count) ? count : fallback), 1, maxCount);
  const buckets: PeriodBucket[] = [];

  if (kind === 'week') {
    const weekStart = new Date(startOfLocalWeek(now));
    for (let i = n - 1; i >= 0; i -= 1) {
      const ws = new Date(weekStart);
      ws.setDate(ws.getDate() - i * 7);
      const we = new Date(ws);
      we.setDate(we.getDate() + 6);
      const startDay = localDayKey(ws);
      const endDay = localDayKey(we);
      buckets.push({
        key: startDay,
        label: `${shortDayLabel(startDay)}–${shortDayLabel(endDay)}`,
        chartLabel: shortDayLabel(startDay),
        kind,
        startDay,
        endDay,
        startTs: ws.getTime(),
        endTs: nextDayTs(endDay),
        internalSec: 0,
        externalSec: 0,
        activeDays: 0,
        flowCount: 0,
      });
    }
    return buckets;
  }

  // 月：以 now 所在本地月为锚，按日历月回退（Date 月份减法自动处理跨年）
  const anchor = new Date(now);
  anchor.setHours(0, 0, 0, 0);
  const currentYear = anchor.getFullYear();
  for (let i = n - 1; i >= 0; i -= 1) {
    const first = new Date(anchor.getFullYear(), anchor.getMonth() - i, 1, 0, 0, 0, 0);
    const last = new Date(first.getFullYear(), first.getMonth() + 1, 0, 0, 0, 0, 0); // 月末日 00:00
    const startDay = localDayKey(first);
    const endDay = localDayKey(last);
    const y = first.getFullYear();
    const m = first.getMonth() + 1;
    buckets.push({
      key: `${y}-${String(m).padStart(2, '0')}`,
      label: `${y}年${m}月`,
      chartLabel: y === currentYear ? `${m}月` : `${String(y).slice(2)}年${m}月`,
      kind,
      startDay,
      endDay,
      startTs: first.getTime(),
      endTs: nextDayTs(endDay),
      internalSec: 0,
      externalSec: 0,
      activeDays: 0,
      flowCount: 0,
    });
  }
  return buckets;
}

// ───────────────────────── 桶归集 ─────────────────────────

/** 桶累加器：PeriodBucket 本体 + 聚合中间集合（最终输出前剥离） */
interface BucketAcc {
  bucket: PeriodBucket;
  /** 活跃日键集合（站内有效或站外有学习） */
  activeKeys: Set<string>;
  /** 该周期有站外流水覆盖的 bvid（计划完成度 touched 用） */
  externalBvids: Set<string>;
}

/** 日键 → 桶下标（周期是连续本地日的并集，逐日登记即可，无需逐条比较区间） */
function indexBucketsByDay(buckets: PeriodBucket[]): Map<string, number> {
  const byDay = new Map<string, number>();
  buckets.forEach((bucket, index) => {
    const cursor = new Date(dayKeyToTs(bucket.startDay));
    const endTs = dayKeyToTs(bucket.endDay);
    while (cursor.getTime() <= endTs) {
      byDay.set(localDayKey(cursor), index);
      cursor.setDate(cursor.getDate() + 1);
    }
  });
  return byDay;
}

/** 站外流水防御式校验（与 aggregate.externalSecondsByDay 同规则） */
function asExternalRow(row: unknown): { date: string; bvid: string; seconds: number } | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Partial<ExternalWatchEntity>;
  if (typeof r.date !== 'string' || r.date.length === 0) return null;
  if (typeof r.bvid !== 'string' || r.bvid.length === 0) return null;
  if (!isFiniteNum(r.seconds) || r.seconds <= 0) return null;
  return { date: r.date, bvid: r.bvid, seconds: r.seconds };
}

// ───────────────────────── 周报：计划完成度 ─────────────────────────

/**
 * 某计划在某周内排期到的 bvid（去重保序）：
 *  - 对「该周 ∩ ≤ 今天」的每个日历日取 planDaySlice 批次（复用既有切片口径，
 *    计划未开始 / 已走完的日子批次为空，天然过滤）；
 *  - 截到今天：当前周的「未来天」尚未到期，不计入分母，避免未到期视频拉低完成度；
 *    历史周整天落在今天之前，不受影响。
 */
function scheduledBvidsInWeek(plan: WeeklyPlan, startDay: string, endDay: string, todayKey: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const planStartTs = dayKeyToTs(plan.startDate);
  // startDate 非法时不再额外收紧起点：planDaySlice 对脏 startDate 有按 createdAt 的兜底口径
  const fromTs = Math.max(dayKeyToTs(startDay), Number.isFinite(planStartTs) ? planStartTs : dayKeyToTs(startDay));
  const toTs = Math.min(dayKeyToTs(endDay), dayKeyToTs(todayKey));
  const cursor = new Date(fromTs);
  while (cursor.getTime() <= toTs) {
    for (const bvid of planDaySlice(plan, localDayKey(cursor)).bvids) {
      if (!seen.has(bvid)) {
        seen.add(bvid);
        out.push(bvid);
      }
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

/** 周报计划完成度：完全复用 weeklyPlanProgress 的完看口径（收藏 metadata.watchedRatio ≥ 0.95） */
function buildPlanProgress(
  plans: WeeklyPlan[],
  favorites: FavoriteEntity[],
  bucket: { startDay: string; endDay: string },
  externalBvids: Set<string>,
  todayKey: string,
): PeriodPlanProgress | null {
  const scheduled: string[] = [];
  const seen = new Set<string>();
  for (const plan of plans) {
    // 防御式：脏计划（null / 非对象 / bvids 缺失）跳过，与 weekly repo 读取侧的兜底口径一致
    if (!plan || typeof plan !== 'object' || !Array.isArray(plan.bvids)) continue;
    for (const bvid of scheduledBvidsInWeek(plan, bucket.startDay, bucket.endDay, todayKey)) {
      if (!seen.has(bvid)) {
        seen.add(bvid);
        scheduled.push(bvid);
      }
    }
  }
  if (scheduled.length === 0) return null;
  // 复用既有口径函数：传「该周排期 bvid」构成的切片计划，完看判定与今日待办同源
  const progress = weeklyPlanProgress({ bvids: scheduled }, favorites);
  let touched = 0;
  for (const bvid of scheduled) {
    if (externalBvids.has(bvid)) touched += 1;
  }
  return { total: progress.total, finished: progress.finished, touched, ratio: progress.ratio };
}

// ───────────────────────── 月报：复习保持率 ─────────────────────────

/**
 * 收藏 → 最近一次复习完成时刻（status='done' 的 updatedAt 最大值）。
 * 复习作业在收藏软删时一并删除，故 store 自洽，无需再查 favorites 判活。
 */
export function lastDoneReviewTsByFavorite(jobs: ReviewJobEntity[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!job || typeof job !== 'object') continue;
    if (job.status !== 'done') continue;
    if (typeof job.favoriteId !== 'string' || job.favoriteId.length === 0) continue;
    if (!isFiniteNum(job.updatedAt)) continue;
    const prev = map.get(job.favoriteId);
    if (prev === undefined || job.updatedAt > prev) map.set(job.favoriteId, job.updatedAt);
  }
  return map;
}

// ───────────────────────── 主聚合 ─────────────────────────

/**
 * 学习周报 / 月报聚合（纯函数）。
 * 输入数组允许脏数据 / 非数组（逐条防御跳过，同 aggregate.ts 风格），不抛错
 * （唯一例外：now 非有限，见 periodBuckets）。
 */
export function buildPeriodReport(input: PeriodReportInput): PeriodReport {
  const kind: PeriodKind = input?.kind === 'month' ? 'month' : 'week';
  const buckets = periodBuckets(kind, input?.count, input?.now);
  const todayKey = localDayKey(input.now);
  const byDay = indexBucketsByDay(buckets);
  const acc: BucketAcc[] = buckets.map((bucket) => ({
    bucket,
    activeKeys: new Set<string>(),
    externalBvids: new Set<string>(),
  }));

  // ── 站内流水：valid 秒数 + 流水条数 + 活跃日 ──
  for (const record of Array.isArray(input?.records) ? input.records : []) {
    if (!record || typeof record !== 'object') continue;
    if (record.valid !== true) continue;
    const sec = isFiniteNum(record.durationSec) ? record.durationSec : 0;
    if (sec <= 0) continue;
    const index = byDay.get(record.date);
    const target = index !== undefined ? acc[index] : undefined;
    if (!target) continue;
    target.bucket.internalSec += sec;
    target.bucket.flowCount += 1;
    target.activeKeys.add(record.date);
  }

  // ── 站外流水：秒数（独立口径）+ 活跃日 + 计划 touched 的 bvid 覆盖 ──
  for (const row of Array.isArray(input?.externalRecords) ? input.externalRecords : []) {
    const parsed = asExternalRow(row);
    if (!parsed) continue;
    const index = byDay.get(parsed.date);
    const target = index !== undefined ? acc[index] : undefined;
    if (!target) continue;
    target.bucket.externalSec += parsed.seconds;
    target.activeKeys.add(parsed.date);
    target.externalBvids.add(parsed.bvid);
  }

  // ── 周期附加指标 ──
  const plans = Array.isArray(input?.plans) ? input.plans : [];
  const favorites = Array.isArray(input?.favorites) ? input.favorites : [];
  const reviewJobs = Array.isArray(input?.reviewJobs) ? input.reviewJobs : [];
  const lastDone = kind === 'month' ? lastDoneReviewTsByFavorite(reviewJobs) : null;

  for (const { bucket, activeKeys, externalBvids } of acc) {
    bucket.activeDays = activeKeys.size;
    if (kind === 'week') {
      bucket.plan = plans.length > 0 ? buildPlanProgress(plans, favorites, bucket, externalBvids, todayKey) : null;
    } else if (lastDone) {
      let reviewed = 0;
      let retained = 0;
      for (const ts of lastDone.values()) {
        reviewed += 1;
        if (ts >= bucket.startTs && ts < bucket.endTs) retained += 1;
      }
      bucket.review = reviewed > 0 ? { reviewed, retained, ratio: retained / reviewed } : null;
    }
  }

  return {
    kind,
    count: buckets.length,
    todayKey,
    buckets,
    totalInternalSec: Math.round(buckets.reduce((sum, b) => sum + b.internalSec, 0)),
    totalExternalSec: Math.round(buckets.reduce((sum, b) => sum + b.externalSec, 0)),
    generatedAt: input.now,
  };
}

// ───────────────────────── 环比对比（第 80 轮巡检） ─────────────────────────

/**
 * 周期环比文案：当前周期 vs 上一周期（同口径数值，秒数或天数皆可）。
 *  - 上一周期 ≤0 且当前 >0 →「新增」；两者都 ≤0 → null（不展示）；
 *  - 否则输出带符号百分比（四舍五入取整，|Δ|<0.5% 记「持平」）。
 */
export function formatPeriodDelta(current: number, previous: number): string | null {
  const cur = Number.isFinite(current) ? Math.max(0, current) : 0;
  const prev = Number.isFinite(previous) ? Math.max(0, previous) : 0;
  if (prev <= 0) return cur > 0 ? '新增' : null;
  const pct = Math.round(((cur - prev) / prev) * 100);
  if (pct === 0) return '持平';
  return `${pct > 0 ? '+' : ''}${pct}%`;
}

// ───────────────────────── 周目标连续达成（第 235 轮巡检） ─────────────────────────

/**
 * 连续达成周目标的周数（激励视角延伸）：从周达成史（stats.period 周桶，旧 → 新）
 * 回溯「连续达成每周目标」的周数。
 *
 * 口径：**含本周**——buckets 最后一项即当前周（见 periodBuckets 的「旧 → 新，当前
 * 周期为最后一个」约定）：本周已达成则从本周起算；本周未达成则跳过本周、从上一个
 * 完整周起算（进行中的周不该打断历史连续）。达成判定 = bucket.internalSec ≥ goalSec
 * （与 PeriodReportCard / dashboard 周目标 Progress 的分母同源：goalSec 由调用方传
 * settings.weeklyGoalHours * 3600，不在此复制换算）。goalSec ≤ 0 / 非有限（未设目标）
 * 或无历史返回 0；桶行脏数据（internalSec 非有限）按未达成处理，不抛错。
 */
export function weeklyGoalStreak(buckets: PeriodBucket[], goalSec: number): number {
  if (!Array.isArray(buckets) || buckets.length === 0) return 0;
  if (typeof goalSec !== 'number' || !Number.isFinite(goalSec) || goalSec <= 0) return 0;
  const achieved = (bucket: PeriodBucket | undefined): boolean =>
    !!bucket && Number.isFinite(bucket.internalSec) && bucket.internalSec >= goalSec;
  let start = buckets.length - 1;
  if (!achieved(buckets[start])) start -= 1; // 本周未达成：从上一个完整周起算
  let count = 0;
  for (let i = start; i >= 0; i -= 1) {
    if (!achieved(buckets[i])) break;
    count += 1;
  }
  return count;
}
