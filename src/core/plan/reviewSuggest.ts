/**
 * 复习完成后的「下次复习日期」建议（第 245 轮巡检，复习策略域 / 反馈视角）。
 *
 * 选型说明（数据可得性研判）：ReviewJobEntity 有 round（第几轮）+ template（模板），
 * 模板间隔 steps[round-1] 即「上一段间隔」——round 1 完成后建议 3 天再看、round 2
 * （3 天间隔）完成后建议 7 天……按完成日的倍增序列推进；round/模板间隔不可得
 * （脏数据 / 自定义模板越界）时回退首档 3 天。纯提示不自动创建作业：调用方只在
 * toast 里展示建议日期，「排到 M/D」按钮由用户显式点击才写数据（reopen + reschedule）。
 *
 * 倍增序列 [3, 7, 14, 30]（天）：lastInterval 落在两档之间时取第一个大于它的档；
 * ≥30 封顶（首档 3 > 1，与默认模板 regular [1,3,7,16] 的首段 1 天衔接自然）。
 * 所有输入防御式解析，非法入参返回 null（调用方降级为普通完成 toast）。
 *
 * 第 246 轮巡检补可视化视角：intervalScalePosition 把同一倍增序列画成 4 格刻度条
 * （复习列表行内迷你档位条），与完成 toast 的建议日期同源同口径——当前位置 =
 * 已完成轮数（round-1）落到哪一档，完成当前轮后的建议间隔即当前高亮档。
 */
import { addDaysKey, localDayKey } from '@/core/shared/utils';
import type { ReviewTemplate } from '@/core/shared/types';

/** 倍增间隔序列（天）：首次完成后 3 天 → 7 → 14 → 30 封顶 */
export const REVIEW_SUGGEST_INTERVALS = [3, 7, 14, 30] as const;

/** 建议间隔封顶（= 序列末档；独立常量便于单测与序列解耦） */
const SUGGEST_CAP_DAYS: number = REVIEW_SUGGEST_INTERVALS[REVIEW_SUGGEST_INTERVALS.length - 1] ?? 30;

/** 建议结果：目标日键（'YYYY-MM-DD'）+ 建议间隔天数 */
export interface NextReviewSuggestion {
  dateKey: string;
  intervalDays: number;
}

/**
 * 由上一段间隔推下一档建议间隔：
 *  - lastIntervalDays 为正有限数 → 取序列中第一个严格大于它的档（无则封顶 30）；
 *  - 缺失 / 非法（0、负数、NaN、非数值）→ 首档 3（「已完成次数不可得时默认 3 天」）。
 */
export function nextSuggestIntervalDays(lastIntervalDays?: number | null): number {
  if (typeof lastIntervalDays === 'number' && Number.isFinite(lastIntervalDays) && lastIntervalDays > 0) {
    for (const step of REVIEW_SUGGEST_INTERVALS) {
      if (step > lastIntervalDays) return step;
    }
    return SUGGEST_CAP_DAYS;
  }
  return REVIEW_SUGGEST_INTERVALS[0];
}

/** 'YYYY-MM-DD' 校验（含 round-trip 语义校验，拒绝 2026-13-40 之类溢出键） */
function parseDayKeyOrNull(key: unknown): string | null {
  if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  const [y, mo, d] = [Number(key.slice(0, 4)), Number(key.slice(5, 7)), Number(key.slice(8, 10))];
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return key;
}

/**
 * 完成时刻 → 下次复习建议：
 *  - completedAt 接受毫秒时间戳 / Date / 'YYYY-MM-DD' 日键（三者都可能来自上层）；
 *  - 返回 { dateKey, intervalDays }，dateKey = 完成日 + intervalDays 个自然日；
 *  - 非法入参（NaN / Invalid Date / 非法日键）返回 null，不抛错。
 */
export function suggestNextReviewDate(
  completedAt: number | Date | string,
  lastIntervalDays?: number | null,
): NextReviewSuggestion | null {
  const intervalDays = nextSuggestIntervalDays(lastIntervalDays);
  let baseKey: string | null = null;
  if (completedAt instanceof Date) {
    baseKey = Number.isNaN(completedAt.getTime()) ? null : localDayKey(completedAt);
  } else if (typeof completedAt === 'number') {
    baseKey = Number.isFinite(completedAt) ? localDayKey(completedAt) : null;
  } else {
    baseKey = parseDayKeyOrNull(completedAt);
  }
  if (!baseKey) return null;
  const dateKey = addDaysKey(baseKey, intervalDays);
  return dateKey ? { dateKey, intervalDays } : null;
}

/**
 * 由作业的 template + round 反推「上一段间隔」（模板间隔 steps[round-1]）：
 *  - intervals 形如 { regular: [1,3,7,16], ... }（与 settings.review.intervals 同形）；
 *  - template 未收录 / round 越界 / 元素非正数 → undefined（调用方回退默认首档 3 天）。
 */
export function lastIntervalForRound(
  template: unknown,
  round: unknown,
  intervals: Partial<Record<ReviewTemplate, number[]>> | undefined,
): number | undefined {
  if (!intervals || typeof template !== 'string') return undefined;
  const steps = intervals[template as ReviewTemplate];
  if (!Array.isArray(steps)) return undefined;
  const idx = typeof round === 'number' && Number.isFinite(round) ? Math.floor(round) - 1 : -1;
  if (idx < 0 || idx >= steps.length) return undefined;
  const step = steps[idx];
  return typeof step === 'number' && Number.isFinite(step) && step > 0 ? step : undefined;
}

/** 日键 → 「M月D日」短标签（非法键原样返回；toast / 按钮文案共用） */
export function monthDayLabelOf(dateKey: string): string {
  const key = parseDayKeyOrNull(dateKey);
  if (!key) return dateKey;
  return `${Number(key.slice(5, 7))}月${Number(key.slice(8, 10))}日`;
}

/**
 * 倍增刻度条定位结果（第 246 轮巡检，复习策略域 / 可视化视角）：
 * 复习列表行内的 4 格迷你档位条（3/7/14/30 天）按此渲染。
 */
export interface IntervalScalePosition {
  /** 当前档下标（0 起，对齐 REVIEW_SUGGEST_INTERVALS 下标；已钳制在末档） */
  index: number;
  /** 当前档间隔天数（= REVIEW_SUGGEST_INTERVALS[index]，与完成建议倍增口径同源） */
  intervalDays: number;
  /** 进度百分比 0–100：(index+1) / 总档数（当前档及之前档位高亮的填充比例，取整） */
  percent: number;
  /** 总档数（= REVIEW_SUGGEST_INTERVALS.length，供调用方渲染格数，避免二次耦合） */
  tiers: number;
}

/**
 * 复习作业在倍增刻度条 [3,7,14,30] 上的位置（第 246 轮巡检）：
 *  - 语义：round 为「当前第几轮」（1 起），round-1 = 已完成的复习次数 = 已走过的
 *    倍增档数；当前档下标 = clamp(round-1, 0, 3)，超多轮封顶末档（30 天）。
 *    与第 245 轮建议同源（同一倍增序列 [3,7,14,30]，hover title 提及）：regular
 *    模板 1–4 轮内「完成当前轮的建议档」恰好等于当前高亮档（steps 首段 1 天 +
 *    严格递增时 lastInterval=steps[round-1] < 序列第 round 档恒成立）；其他模板
 *    （exam 5 档等）模板间隔与倍增档错位时高亮档仅表示进度，不等于建议档——
 *    title 文案不含「建议」字样，避免口径误读；
 *  - steps（模板间隔）只作合法性校验：非数组 / 空 / 含非正数 / 非严格递增 → null
 *    （调用方不渲染刻度条，行内降级为既有「第 X/Y 轮」文本徽标）；
 *  - round 非法（非数值 / 有限 / <1）→ null；小数向下取整。
 */
export function intervalScalePosition(round: unknown, steps: unknown): IntervalScalePosition | null {
  if (!Array.isArray(steps) || steps.length === 0) return null;
  let prev = 0;
  for (const step of steps) {
    if (typeof step !== 'number' || !Number.isFinite(step) || step <= 0) return null;
    if (step <= prev) return null; // 严格递增：相等或倒退都是脏模板
    prev = step;
  }
  if (typeof round !== 'number' || !Number.isFinite(round) || round < 1) return null;
  const r = Math.floor(round);
  const tiers = REVIEW_SUGGEST_INTERVALS.length;
  const index = Math.min(r - 1, tiers - 1);
  const intervalDays = REVIEW_SUGGEST_INTERVALS[index] ?? SUGGEST_CAP_DAYS;
  const percent = Math.round(((index + 1) / tiers) * 100);
  return { index, intervalDays, percent, tiers };
}
