/**
 * 学习热力图聚合（第 77 轮巡检）。
 *
 * 与 aggregate.ts / period.ts 同层的纯函数聚合器：输入站内观看流水 + 站外学习流水 +
 * 目标窗口（周数 + 锚点 now），输出按「周列 × 7 行（周一..周日）」排布的日级热力格。
 * **不含 Date.now() 副作用**：「今天」由调用方经 `now` 传入（非有限值按契约违约抛错，
 * 保证可测；与 periodBuckets 同一口径）。
 *
 * 口径决定（实现依据见各段注释）：
 *  - 日秒数 = 站内 `valid === true` 流水 durationSec 之和 + 站外 externalWatch seconds
 *    之和。两个独立通道在周月报里分开列示，热力图要的是「这天学没学、学了多久」的
 *    单一直观值，故合并计；跨零点记录由统计引擎按本地自然日拆分，按 date 日键归桶
 *    无歧义（与 buildReport / buildPeriodReport 同前提）。
 *  - 周界 = 本地周一（startOfLocalWeek 既有惯例，与周报一致）。
 *  - 强度档位（0–4）按「窗口内有学习日（sec>0）的秒数分布」的四分位切分（Q1/中位/Q3），
 *    无学习日为 0 档；比固定阈值更贴合不同学习强度的用户。样本不足（正数日少于 4 个）
 *    时四分位取值可能重合，属可接受退化（各档仍有序）。
 *  - 今天之后的格子 isFuture=true（本周右侧补位），秒数恒 0，渲染层作透明占位。
 *  - 脏数据防御与 aggregate.ts 同风格：非对象 / 缺字段 / 非有限正数的流水逐条跳过，
 *    不抛错（唯一例外：now 非有限，见上）。
 */

import type { ExternalWatchEntity, WatchRecordEntity } from '../shared/types';
import { clamp, localDayKey, startOfLocalWeek } from '../shared/utils';

/** 热力图默认窗口（含当前周的整数周数，GitHub 常规口径的半年量级） */
export const HEATMAP_DEFAULT_WEEKS = 26;

/** 热力图强度档位（0=无学习，1–4 递增） */
export type HeatmapLevel = 0 | 1 | 2 | 3 | 4;

/** 单日热力格 */
export interface HeatmapDayCell {
  /** 本地日键 'YYYY-MM-DD' */
  date: string;
  /** 当日学习秒数（站内 valid + 站外，见文件头口径） */
  sec: number;
  /** 强度档位 */
  level: HeatmapLevel;
  /** 是否「今天」 */
  isToday: boolean;
  /** 是否未来日（本周右侧补位） */
  isFuture: boolean;
}

/** 一周列（周一为起点，days 恒 7 格，周一..周日） */
export interface HeatmapWeekColumn {
  /** 周一日键 */
  startDay: string;
  days: HeatmapDayCell[];
}

export interface ActivityHeatmapData {
  /** 旧 → 新周列（最后一列为当前周） */
  weeks: HeatmapWeekColumn[];
  todayKey: string;
  /** 实际生成的周数（已 clamp） */
  weekCount: number;
  /** 窗口内（截至今天）学习秒数合计（站内 + 站外） */
  totalSec: number;
  /** 有学习的自然日数 */
  activeDays: number;
  /** 单日峰值秒数（图例参照） */
  maxDaySec: number;
  /** 档位阈值 [Q1, 中位, Q3]（秒）；窗口内无学习日时为 [0, 0, 0] */
  thresholds: [number, number, number];
  generatedAt: number;
}

export interface ActivityHeatmapInput {
  /** 「今天」毫秒时间戳（必填：纯函数约定，不内部取 Date.now()） */
  now: number;
  /** 周数（含当前周）；缺省 26，非法值回退默认并 clamp 到 [4, 52] */
  weeks?: number;
  /** 站内观看流水（可只传窗口内的） */
  records?: WatchRecordEntity[];
  /** 站外学习流水（可只传窗口内的） */
  externalRecords?: ExternalWatchEntity[];
}

/** 周数钳制：缺省 / 非法回退默认，合法域 [1, 52]（最少本周视图，最多一年） */
export function clampHeatmapWeeks(weeks: number | undefined): number {
  const value = typeof weeks === 'number' && Number.isFinite(weeks) ? Math.round(weeks) : HEATMAP_DEFAULT_WEEKS;
  return clamp(value, 1, 52);
}

/** 热力图窗口的起始日（含）：当前周的周一回退 (weeks-1) 周 */
export function heatmapWindowStartDay(now: number, weeks: number): string {
  const start = new Date(startOfLocalWeek(now));
  start.setDate(start.getDate() - (clampHeatmapWeeks(weeks) - 1) * 7);
  return localDayKey(start);
}

/**
 * 秒数 → 档位：0 档为无学习；1–3 档按阈值下界（不含）切分；达到 Q3 及以上为 4 档。
 * 「≥Q3 即最高档」的边界语义使四分位样本 [a,b,c,d] 恰好落满 1–4 档；阈值须非降序，
 * 相等的退化阈值（样本少 / 同值）仍保持单调语义。
 */
export function heatLevel(sec: number, thresholds: [number, number, number]): HeatmapLevel {
  if (!(sec > 0)) return 0;
  const [q1, q2, q3] = thresholds;
  if (sec < q1) return 1;
  if (sec < q2) return 2;
  if (sec < q3) return 3;
  return 4;
}

/** 站内流水防御式取秒（valid 且 durationSec 为有限正数才计入） */
function internalSecondsByDay(records: unknown, into: Map<string, number>): void {
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || typeof record !== 'object') continue;
    const r = record as Partial<WatchRecordEntity>;
    if (r.valid !== true) continue;
    if (typeof r.date !== 'string' || r.date.length === 0) continue;
    if (!Number.isFinite(r.durationSec) || (r.durationSec as number) <= 0) continue;
    into.set(r.date, (into.get(r.date) ?? 0) + (r.durationSec as number));
  }
}

/** 站外流水防御式取秒（与 aggregate.externalSecondsByDay 同规则，脏行逐条跳过） */
function externalSecondsByDay(records: unknown, into: Map<string, number>): void {
  for (const row of Array.isArray(records) ? records : []) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Partial<ExternalWatchEntity>;
    if (typeof r.date !== 'string' || r.date.length === 0) continue;
    if (typeof r.bvid !== 'string' || r.bvid.length === 0) continue;
    if (!Number.isFinite(r.seconds) || (r.seconds as number) <= 0) continue;
    into.set(r.date, (into.get(r.date) ?? 0) + (r.seconds as number));
  }
}

/** 站内 + 站外流水按日合并（防御式；周/月热力图共用同一归桶口径） */
export function collectDaySeconds(
  records?: WatchRecordEntity[],
  externalRecords?: ExternalWatchEntity[],
): Map<string, number> {
  const daySec = new Map<string, number>();
  internalSecondsByDay(records, daySec);
  externalSecondsByDay(externalRecords, daySec);
  return daySec;
}

/** 正数日秒数的四分位阈值（供周/月热力图共用） */
export function heatThresholdsOf(daySec: Map<string, number>): [number, number, number] {
  return quartileThresholds([...daySec.values()].filter((sec) => sec > 0));
}

/** 正数日秒数的四分位阈值（升序取样；样本不足按可及下标取，结果仍非降序） */
function quartileThresholds(values: number[]): [number, number, number] {
  if (values.length === 0) return [0, 0, 0];
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  return [at(0.25), at(0.5), at(0.75)];
}

/**
 * 学习热力图聚合（纯函数）。输入数组允许脏数据 / 非数组（逐条防御跳过，同
 * aggregate.ts 风格），不抛错（唯一例外：now 非有限，按契约违约抛错）。
 */
export function buildActivityHeatmap(input: ActivityHeatmapInput): ActivityHeatmapData {
  if (!Number.isFinite(input?.now)) {
    throw new Error('buildActivityHeatmap: now 必须是有限毫秒时间戳（由调用方注入）');
  }
  const now = input.now;
  const weekCount = clampHeatmapWeeks(input?.weeks);
  const todayKey = localDayKey(now);

  const daySec = collectDaySeconds(input?.records, input?.externalRecords);
  const thresholds = heatThresholdsOf(daySec);

  const anchor = new Date(startOfLocalWeek(now));
  const weeks: HeatmapWeekColumn[] = [];
  let totalSec = 0;
  let activeDays = 0;
  let maxDaySec = 0;

  for (let w = weekCount - 1; w >= 0; w -= 1) {
    const weekStart = new Date(anchor);
    weekStart.setDate(weekStart.getDate() - w * 7);
    const days: HeatmapDayCell[] = [];
    for (let d = 0; d < 7; d += 1) {
      const cursor = new Date(weekStart);
      cursor.setDate(cursor.getDate() + d);
      const date = localDayKey(cursor);
      const isFuture = date > todayKey;
      const sec = isFuture ? 0 : Math.max(0, daySec.get(date) ?? 0);
      if (sec > 0) {
        totalSec += sec;
        activeDays += 1;
        if (sec > maxDaySec) maxDaySec = sec;
      }
      days.push({
        date,
        sec,
        level: isFuture ? 0 : heatLevel(sec, thresholds),
        isToday: date === todayKey,
        isFuture,
      });
    }
    weeks.push({ startDay: localDayKey(weekStart), days });
  }

  return {
    weeks,
    todayKey,
    weekCount,
    totalSec: Math.round(totalSec),
    activeDays,
    maxDaySec: Math.round(maxDaySec),
    thresholds,
    generatedAt: now,
  };
}

// ───────────────────────── 单日明细（第 79 轮巡检） ─────────────────────────

/** 当日明细单行（站内流水或站外流水归一后的展示行） */
export interface DayDetailRow {
  /** 主标题：课程名（subjName · teclCode）/ 站外视频标题 / bvid 兜底 */
  label: string;
  /** 副标题：课次号 / 「站外视频」等来源说明 */
  sub?: string;
  /** 该行学习秒数 */
  seconds: number;
  /** 站内流水是否有效（invalid 保留展示但标注「不计入」） */
  valid: boolean;
  /** 站内行回跳字段（第 80 轮巡检）：课次跳转（HDU 站内 seek / B 站侧新标签深链） */
  courId?: number;
  teclId?: number;
  /** 站外行回跳字段：视频页链接 */
  url?: string;
}

/** 单日学习明细（热力图格子点击弹出；stats.dayDetail op 返回） */
export interface DayDetailReport {
  date: string;
  /** 站内流水行（按秒数降序） */
  internal: DayDetailRow[];
  /** 站外流水行（按秒数降序） */
  external: DayDetailRow[];
  /** 站内有效秒数合计（invalid 不计入） */
  internalSec: number;
  /** 站外秒数合计 */
  externalSec: number;
}

// ───────────────────────── 月视图热力图（第 81 轮巡检） ─────────────────────────

/** 月视图默认窗口（含当前月的整数月数） */
export const MONTHLY_HEATMAP_DEFAULT_MONTHS = 12;

/** 月列：该自然月的逐日格（days 长度 = 当月实际天数） */
export interface HeatmapMonthColumn {
  /** 'YYYY-MM' */
  key: string;
  /** 列标注：'M月'（跨年不加年份，窗口跨度由调用方控制） */
  label: string;
  days: HeatmapDayCell[];
}

export interface MonthlyHeatmapData {
  /** 旧 → 新月列（最后一列为当前月） */
  months: HeatmapMonthColumn[];
  todayKey: string;
  monthCount: number;
  /** 窗口内（截至今天）学习秒数合计（站内 + 站外） */
  totalSec: number;
  activeDays: number;
  maxDaySec: number;
  thresholds: [number, number, number];
  generatedAt: number;
}

/** 月数钳制：缺省 / 非法回退默认，合法域 [1, 24] */
export function clampHeatmapMonths(months: number | undefined): number {
  const value = typeof months === 'number' && Number.isFinite(months) ? Math.round(months) : MONTHLY_HEATMAP_DEFAULT_MONTHS;
  return clamp(value, 1, 24);
}

/**
 * 月视图热力图聚合（纯函数；第 81 轮巡检）：与周视图同口径（日秒数合并、四分位档位、
 * 未来日补位），仅桶从「周列 × 7 行」换为「月列 × 当月天数」。
 * now 非有限按契约违约抛错；流水脏数据逐条跳过，不抛错。
 */
export function buildMonthlyHeatmap(input: {
  now: number;
  months?: number;
  records?: WatchRecordEntity[];
  externalRecords?: ExternalWatchEntity[];
}): MonthlyHeatmapData {
  if (!Number.isFinite(input?.now)) {
    throw new Error('buildMonthlyHeatmap: now 必须是有限毫秒时间戳（由调用方注入）');
  }
  const now = input.now;
  const monthCount = clampHeatmapMonths(input?.months);
  const todayKey = localDayKey(now);

  const daySec = collectDaySeconds(input?.records, input?.externalRecords);
  const thresholds = heatThresholdsOf(daySec);

  const anchor = new Date(now);
  anchor.setHours(0, 0, 0, 0);
  const months: HeatmapMonthColumn[] = [];
  let totalSec = 0;
  let activeDays = 0;
  let maxDaySec = 0;

  for (let i = monthCount - 1; i >= 0; i -= 1) {
    const first = new Date(anchor.getFullYear(), anchor.getMonth() - i, 1, 0, 0, 0, 0);
    const last = new Date(first.getFullYear(), first.getMonth() + 1, 0, 0, 0, 0, 0);
    const days: HeatmapDayCell[] = [];
    for (const cursor = new Date(first); cursor.getTime() <= last.getTime(); cursor.setDate(cursor.getDate() + 1)) {
      const date = localDayKey(cursor);
      const isFuture = date > todayKey;
      const sec = isFuture ? 0 : Math.max(0, daySec.get(date) ?? 0);
      if (sec > 0) {
        totalSec += sec;
        activeDays += 1;
        if (sec > maxDaySec) maxDaySec = sec;
      }
      days.push({
        date,
        sec,
        level: isFuture ? 0 : heatLevel(sec, thresholds),
        isToday: date === todayKey,
        isFuture,
      });
    }
    months.push({ key: localDayKey(first).slice(0, 7), label: `${first.getMonth() + 1}月`, days });
  }

  return {
    months,
    todayKey,
    monthCount,
    totalSec: Math.round(totalSec),
    activeDays,
    maxDaySec: Math.round(maxDaySec),
    thresholds,
    generatedAt: now,
  };
}
