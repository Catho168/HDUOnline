/**
 * 每周回看学习计划（纯函数，无 IO）。
 *
 * 为批量导入的 B 站视频生成「每天 N 个、按日历切片」的学习计划：
 *  - 学习顺序 = bvids 数组顺序（已去重保序）；第 d 天（d 从 0 计）的批次为
 *    `bvids.slice(d * perDay, (d + 1) * perDay)`；
 *  - 切片按「日历天数差」推进（与 core/plan/today 的 YYYY-MM-DD 本地日键同口径）；
 *    漏看的批次不顺延、不堆到明天（v1 决策：明确不做补卡）；
 *  - 完看口径与今日待办一致：收藏 `metadata.watchedRatio >= 0.95` 视为看完；
 *  - 「活跃计划」= 按日历尚未走完（今日 dayIndex < totalDays，含尚未开始的未来计划）。
 *
 * 输入可能来自消息通道 / 旧数据（字段缺失、类型不符），全部防御式解析，不抛错。
 */

import { clamp, dayKeyToTs, localDayKey, uuid } from '../shared/utils';

/** 完看阈值：与 core/plan/today 的 FINISHED_RATIO 同一口径（比率 ≥0.95 视为看完） */
const FINISHED_RATIO = 0.95;

/** 每天条数：脏输入的兜底默认值与 clamp 边界 */
export const WEEKLY_PER_DAY_DEFAULT = 2;
export const WEEKLY_PER_DAY_MIN = 1;
export const WEEKLY_PER_DAY_MAX = 20;

const DAY_MS = 86_400_000;

export interface WeeklyPlan {
  id: string;
  /** 来源收藏夹名（可选，仅展示用） */
  label?: string;
  /** 每天 N 个（已 clamp 到 1–20） */
  perDay: number;
  /** 学习顺序即数组顺序（去重保序） */
  bvids: string[];
  /** 'YYYY-MM-DD' 计划起始日（含），当天为第 1 天 */
  startDate: string;
  createdAt: number;
  updatedAt: number;
}

/** 某个日历日的批次切片；越界（未开始 / 已走完）时 bvids 为空 */
export interface WeeklyDaySlice {
  /** 日历天数差（未开始为负；已走完为 totalDays） */
  dayIndex: number;
  totalDays: number;
  bvids: string[];
}

/** 计划内 bvid 的完看进度（完看口径：对应收藏 watchedRatio ≥ 0.95） */
export interface WeeklyProgress {
  total: number;
  finished: number;
  /** finished / total；total 为 0 时为 0 */
  ratio: number;
}

// ───────────────────────── 防御式读取 ─────────────────────────

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 归一化日键：合法 'YYYY-MM-DD' 原样返回；缺省/非法返回 null */
function asDayKey(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return Number.isFinite(dayKeyToTs(value)) ? value : null;
}

/** 计划的每日条数（防御式：非法输入回退默认值，并 clamp 到 1–20） */
function planPerDay(perDay: unknown): number {
  const n = asFiniteNumber(perDay) ?? WEEKLY_PER_DAY_DEFAULT;
  return clamp(Math.round(n), WEEKLY_PER_DAY_MIN, WEEKLY_PER_DAY_MAX);
}

/** 计划的总天数（向上取整：每天至少 1 个） */
export function weeklyTotalDays(plan: Pick<WeeklyPlan, 'bvids' | 'perDay'>): number {
  const bvids = Array.isArray(plan?.bvids) ? plan.bvids : [];
  if (bvids.length === 0) return 0;
  return Math.ceil(bvids.length / planPerDay(plan?.perDay));
}

/** 'YYYY-MM-DD' / Date → 本地日键毫秒（与 today.ts 的日键口径一致）；非法输入返回 null */
function dayArgToTs(dayKey: string | Date): number | null {
  const key = dayKey instanceof Date ? localDayKey(dayKey) : dayKey;
  if (typeof key !== 'string') return null;
  const ts = dayKeyToTs(key);
  return Number.isFinite(ts) ? ts : null;
}

// ───────────────────────── 计划构造 ─────────────────────────

export interface BuildWeeklyPlanArgs {
  /** 候选视频 bvid 列表（非字符串 / 空串被过滤，重复项保序去重） */
  bvids: ReadonlyArray<unknown>;
  /** 每天 N 个（clamp 1–20，非法回退默认值） */
  perDay: unknown;
  /** 起始日 'YYYY-MM-DD'；缺省 / 非法时用 now 的当天 */
  startDate?: unknown;
  /** 来源收藏夹名（可选） */
  label?: unknown;
  /** 「当前时间」毫秒（id/时间戳与缺省 startDate 都由它派生；测试可注入） */
  now: number;
}

/**
 * 构造每周计划：
 *  - bvids 过滤 + 保序去重，全部无效 / 为空时返回 null（不建空计划）；
 *  - startDate 缺省取 now 的本地当天；
 *  - createdAt / updatedAt 同取 now。
 */
export function buildWeeklyPlan(args: BuildWeeklyPlanArgs): WeeklyPlan | null {
  const raw = Array.isArray(args?.bvids) ? args.bvids : [];
  const bvids: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const bvid = asString(item);
    if (!bvid || seen.has(bvid)) continue;
    seen.add(bvid);
    bvids.push(bvid);
  }
  if (bvids.length === 0) return null;
  const now = asFiniteNumber(args?.now) ?? Date.now();
  const label = asString(args?.label);
  return {
    id: uuid(),
    ...(label ? { label } : {}),
    perDay: planPerDay(args?.perDay),
    bvids,
    startDate: asDayKey(args?.startDate) ?? localDayKey(now),
    createdAt: now,
    updatedAt: now,
  };
}

// ───────────────────────── 日历切片 ─────────────────────────

/**
 * 某个日历日的批次切片：
 *  - dayIndex = 天数差（未开始为负、已走完为 totalDays，均返回空批次）；
 *  - 天数差用 Math.round 折算（与 today.ts 的 overdueDays 同式；本地日键差恒为整天，
 *    非整除只出现在跨夏令时的极端环境，round 保证仍落在正确的日历日上）；
 *  - 明确不做顺延/补卡：漏看的批次不会堆到今天。
 */
export function planDaySlice(plan: WeeklyPlan, dayKey: string | Date): WeeklyDaySlice {
  const totalDays = weeklyTotalDays(plan);
  const bvids = Array.isArray(plan?.bvids) ? plan.bvids.filter((b) => typeof b === 'string' && b.length > 0) : [];
  const dayTs = dayArgToTs(dayKey);
  const startTs = dayArgToTs(asDayKey(plan?.startDate) ?? localDayKey(asFiniteNumber(plan?.createdAt) ?? Date.now()));
  if (dayTs === null || startTs === null) {
    // 脏数据兜底：无法定位日历日时视为已走完（不给任何批次，避免误推送）
    return { dayIndex: totalDays, totalDays, bvids: [] };
  }
  const dayIndex = Math.round((dayTs - startTs) / DAY_MS);
  if (dayIndex < 0) return { dayIndex, totalDays, bvids: [] };
  if (dayIndex >= totalDays) return { dayIndex: totalDays, totalDays, bvids: [] };
  const per = planPerDay(plan?.perDay);
  return { dayIndex, totalDays, bvids: bvids.slice(dayIndex * per, dayIndex * per + per) };
}

/** 活跃计划：按日历尚未走完（dayIndex < totalDays，含尚未开始的未来计划） */
export function isActiveWeeklyPlan(plan: WeeklyPlan, dayKey: string | Date): boolean {
  return planDaySlice(plan, dayKey).dayIndex < weeklyTotalDays(plan);
}

/**
 * UI 展示口径的「今日活跃」计划：今日处于计划区间内
 * （dayIndex ∈ [0, totalDays)，即已开始且未走完），不含未开始的未来计划与已走完的计划。
 */
export function weeklyPlansToday(plans: ReadonlyArray<WeeklyPlan>, dayKey: string | Date): WeeklyPlan[] {
  return (Array.isArray(plans) ? plans : []).filter((plan) => {
    const slice = planDaySlice(plan, dayKey);
    return slice.dayIndex >= 0 && slice.dayIndex < slice.totalDays;
  });
}

/** 各计划「今日批次」bvid 的并集（保序去重；未开始/已走完的计划贡献空批次） */
export function weeklyTodayBvids(plans: ReadonlyArray<WeeklyPlan>, dayKey: string | Date): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const plan of Array.isArray(plans) ? plans : []) {
    for (const bvid of planDaySlice(plan, dayKey).bvids) {
      if (seen.has(bvid)) continue;
      seen.add(bvid);
      out.push(bvid);
    }
  }
  return out;
}

// ───────────────────────── 进度 ─────────────────────────

/**
 * 计划完看进度：统计计划内 bvid 对应收藏的 `metadata.watchedRatio >= 0.95` 数量。
 * 收藏缺失（未入库 / 已删除）不计完成；favorites 可传 knowledge 库全量或 video 子集。
 */
export function weeklyPlanProgress(
  plan: Pick<WeeklyPlan, 'bvids'>,
  favorites: ReadonlyArray<unknown>,
): WeeklyProgress {
  const bvids = Array.isArray(plan?.bvids) ? plan.bvids : [];
  const seen = new Set<string>();
  for (const bvid of bvids) {
    if (typeof bvid === 'string' && bvid.length > 0) seen.add(bvid);
  }
  // bvid → watchedRatio（首个命中优先；与 today 的条目解析同源：metadata.bvid 优先，回退 refId）
  const ratioByBvid = new Map<string, number>();
  for (const fav of Array.isArray(favorites) ? favorites : []) {
    if (!fav || typeof fav !== 'object' || Array.isArray(fav)) continue;
    const record = fav as Record<string, unknown>;
    const meta = record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
      ? (record.metadata as Record<string, unknown>)
      : {};
    const bvid = asString(meta.bvid) ?? asString(record.refId);
    const watched = asFiniteNumber(meta.watchedRatio);
    if (!bvid || watched === null || ratioByBvid.has(bvid)) continue;
    ratioByBvid.set(bvid, watched);
  }
  let finished = 0;
  for (const bvid of seen) {
    const watched = ratioByBvid.get(bvid);
    if (watched !== undefined && watched >= FINISHED_RATIO) finished += 1;
  }
  const total = seen.size;
  return { total, finished, ratio: total > 0 ? finished / total : 0 };
}
