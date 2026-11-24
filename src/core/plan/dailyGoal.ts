/**
 * 每日学习目标（第 234 轮巡检）。
 *
 * 纯函数层：默认值与钳制规则单点定义，设置页（options App）、总览 mini 卡
 * （OverviewView）与 dashboard 指标卡共用，避免各处魔数漂移。
 *
 * 定位（与既有口径的边界）：每日目标是**展示与激励层**——总览「今日目标」
 * Ring 与 dashboard 指标卡的进度分母；不改变 aggregate.buildReport 的打卡判定
 * （CHECKIN_MIN_SEC = 10 分钟线）与 goal.hitDaysThisWeek 语义，统计口径零回归。
 */

import { localDayKey, startOfLocalWeek } from '../shared/utils';

/** 每日目标默认分钟数（设置缺省 / 非法值回退） */
export const DEFAULT_DAILY_GOAL_MIN = 30;

/** 每日目标合法域下界（分钟）：低于 5 分钟失去「目标」意义 */
export const DAILY_GOAL_MIN_FLOOR = 5;

/** 每日目标合法域上界（分钟）：10 小时封顶，覆盖挂机式长日也用不到更高 */
export const DAILY_GOAL_MIN_CEIL = 600;

/**
 * 钳制每日目标分钟数：非数字 / 非有限值（含 undefined / NaN / 字符串等脏输入）
 * 回退默认 30；有限值四舍五入后 clamp 到 [5, 600]。纯函数无副作用，供设置页
 * onChange 与读取侧（渲染进度前）双端复用。
 */
export function clampDailyGoalMin(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_DAILY_GOAL_MIN;
  const rounded = Math.round(value);
  if (rounded < DAILY_GOAL_MIN_FLOOR) return DAILY_GOAL_MIN_FLOOR;
  if (rounded > DAILY_GOAL_MIN_CEIL) return DAILY_GOAL_MIN_CEIL;
  return rounded;
}

// ───────────────────────── 目标合理性提示（第 242 轮巡检，防呆视角） ─────────────────────────

/** 周目标合理区间下界倍数：周目标低于「日目标 × 5 天」视为可能偏低（一周总得学几天） */
export const GOAL_WEEKLY_LOW_DAYS = 5;

/** 周目标合理区间上界倍数：周目标高于「日目标 × 7 天 × 2」视为可能偏高（全周翻倍也达不到） */
export const GOAL_WEEKLY_HIGH_DAYS = 14;

/** 目标合理性提示（goalConsistencyHint 返回）：kind 供 UI 两档着色（偏低 gold / 偏高 danger 淡色） */
export interface GoalConsistencyHint {
  kind: 'low' | 'high';
  text: string;
}

/** 分钟数 → 小时数文案：整数不带小数，非整数保留至多 2 位并去尾零（2.5 → '2.5'，3.75 → '3.75'） */
function minutesToHoursLabel(min: number): string {
  const hours = Math.round((min / 60) * 100) / 100;
  return String(hours);
}

/**
 * 周目标 × 每日目标交叉合理性提示（纯函数，第 242 轮巡检）：
 *  - 周目标 < 日目标 × 5（GOAL_WEEKLY_LOW_DAYS）→ 偏低提示（按每日目标 X 分钟，
 *    一周至少 Y 小时——即 5 倍下界）；
 *  - 周目标 > 日目标 × 7 × 2（GOAL_WEEKLY_HIGH_DAYS）→ 偏高提示（按每日目标 X 分钟，
 *    一周最多 Z 小时——即 14 倍上界，日目标全周翻倍仍达不到）；
 *  - 两者之间（合理区间）或任一目标未设 / 非法（weeklyTargetSec 非有限正数、
 *    dailyGoalMin 非有限正数）→ null（不提示，UI 不渲染）。
 * 边界约定：恰好 5× 与恰好 14× 都算合理（严格不等号才触发），避免整点组合误报。
 * 建议性软提示：不阻断保存、不自动改值，由用户自行裁决。
 */
export function goalConsistencyHint(weeklyTargetSec: unknown, dailyGoalMin: unknown): GoalConsistencyHint | null {
  if (typeof weeklyTargetSec !== 'number' || !Number.isFinite(weeklyTargetSec) || weeklyTargetSec <= 0) return null;
  if (typeof dailyGoalMin !== 'number' || !Number.isFinite(dailyGoalMin) || dailyGoalMin <= 0) return null;
  const weeklySec = weeklyTargetSec;
  const dailyMin = dailyGoalMin;
  if (weeklySec < dailyMin * 60 * GOAL_WEEKLY_LOW_DAYS) {
    const floorHours = minutesToHoursLabel(dailyMin * GOAL_WEEKLY_LOW_DAYS);
    return {
      kind: 'low',
      text: `周目标可能偏低（按每日目标 ${dailyMin} 分钟，一周至少 ${floorHours} 小时）`,
    };
  }
  if (weeklySec > dailyMin * 60 * GOAL_WEEKLY_HIGH_DAYS) {
    const ceilHours = minutesToHoursLabel(dailyMin * GOAL_WEEKLY_HIGH_DAYS);
    return {
      kind: 'high',
      text: `周目标可能偏高（按每日目标 ${dailyMin} 分钟，一周最多 ${ceilHours} 小时）`,
    };
  }
  return null;
}

// ───────────────────────── 本周目标达成 7 日格（第 256 轮巡检，目标域 / 习惯视角） ─────────────────────────

/** 单日格：date=本地日键；hit=当日有效学习达到每日目标（仅今天与过去判定） */
export interface WeeklyGoalCell {
  date: string;
  /** 周内序标签（一~日，周一开始，与 startOfLocalWeek 对齐） */
  label: string;
  validSec: number;
  hit: boolean;
  isToday: boolean;
  /** 本周内尚未到来的日子：不判定达成（UI dim 展示） */
  isFuture: boolean;
}

export interface WeeklyGoalCalendar {
  cells: WeeklyGoalCell[];
  /** 已判定日中达标天数（不含未来日） */
  hitCount: number;
  /** 已判定日数（过去 + 今天；未来日不参与） */
  judgedCount: number;
  /** 参与判定的每日目标分钟数（clamp 兜底后） */
  dailyGoalMin: number;
}

const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'] as const;

/**
 * 本周（周一起）7 日目标达成格：每日 hit = validSec ≥ dailyGoalMin × 60。
 *
 * 口径边界（与既有统计的关系，改任一侧须同步核对）：这里按「每日目标」判定，
 * 与 aggregate.buildReport 的 hitDaysThisWeek（CHECKIN_MIN_SEC = 10 分钟打卡线）
 * 是两条不同口径——打卡线回答「是否有效学习」，目标线回答「是否达成自己定的
 * 目标」；本函数不改打卡判定，也不写回 goal 统计。
 *
 * 防御式：days 非数组 / 单条脏数据按 0 秒处理（不抛错）；dailyGoalMin 经
 * clampDailyGoalMin 兜底（缺省 30 分钟）；同日键重复出现取最大 validSec。
 */
export function buildWeeklyGoalCalendar(
  days: unknown,
  dailyGoalMin: unknown,
  now: number = Date.now(),
): WeeklyGoalCalendar {
  const goalMin = clampDailyGoalMin(dailyGoalMin);
  const goalSec = goalMin * 60;
  const secByDate = new Map<string, number>();
  if (Array.isArray(days)) {
    for (const day of days) {
      const record = (day ?? {}) as Partial<Record<'date' | 'validSec', unknown>>;
      if (typeof record.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(record.date)) continue;
      const sec =
        typeof record.validSec === 'number' && Number.isFinite(record.validSec) ? Math.max(0, Math.round(record.validSec)) : 0;
      secByDate.set(record.date, Math.max(secByDate.get(record.date) ?? 0, sec));
    }
  }
  const weekStart = startOfLocalWeek(now);
  const todayKey = localDayKey(now);
  const cells: WeeklyGoalCell[] = [];
  for (let i = 0; i < 7; i += 1) {
    // 逐日走日历算法（setDate +1），跨 DST 时仍落在正确的本地日键
    const dayTs = new Date(weekStart);
    dayTs.setDate(dayTs.getDate() + i);
    const date = localDayKey(dayTs);
    const validSec = secByDate.get(date) ?? 0;
    const isFuture = date > todayKey;
    cells.push({
      date,
      label: WEEKDAY_LABELS[i] ?? '',
      validSec,
      hit: !isFuture && validSec >= goalSec,
      isToday: date === todayKey,
      isFuture,
    });
  }
  const judged = cells.filter((cell) => !cell.isFuture);
  return {
    cells,
    hitCount: judged.filter((cell) => cell.hit).length,
    judgedCount: judged.length,
    dailyGoalMin: goalMin,
  };
}
