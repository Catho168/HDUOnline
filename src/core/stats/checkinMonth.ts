/**
 * 打卡月历聚合（第 234 轮巡检）。
 *
 * 与 heatmap.ts / period.ts 同层的纯函数聚合器：输入按日报表行（DailyStat 的
 * { date, validSec } 口径）+ 目标年月 + 打卡线 + 今天日键，输出「周行 × 7 列
 * （周一..周日）」的月历格，逐格标注该日是否达标打卡。与 ActivityHeatmap 的
 * 定位差异：热力图看窗口内的强度趋势（站内 + 站外合并、四分位分档），月历看
 * 「哪些天打了卡」（仅站内 validSec 口径，与 aggregate.buildReport 的
 * goal.hitDaysThisWeek 同一线），卡标题各自写清，互不替代。
 *
 * 口径决定：
 *  - 判定：当日 validSec ≥ checkinMinSec 算达标（与 hitDaysThisWeek 完全同线，
 *    打卡线由调用方传 aggregate.CHECKIN_MIN_SEC，不在此复制魔数）；
 *  - 已过天：date ≤ todayKey 的本月日（今天本身计入）——达标率分母按「本月已过
 *    天数」算，未来日不进分母也不进分子；
 *  - 周界 = 本地周一（startOfLocalWeek / buildReviewMonthGrid 既有惯例）；
 *  - 未来日与前后月补位格：sec 恒 0、hit 恒 false，渲染层作占位（补位格可见但
 *    留白，未来格隐藏）；
 *  - 脏数据防御与 aggregate.ts / heatmap.ts 同风格：days 非数组 / 行非对象 /
 *    date 非合法日键 / sec 非有限正数逐条跳过，不抛错。
 */

import { CHECKIN_MIN_SEC } from './aggregate';

/** 单日打卡月历格 */
export interface CheckinMonthCell {
  /** 本地日键 'YYYY-MM-DD'（前后月补位格也有真实键，供 title 悬停） */
  key: string;
  /** 日号 '1'..'31' */
  dayLabel: string;
  /** 是否目标月（前后月补位格为 false） */
  inMonth: boolean;
  /** 是否「今天」 */
  isToday: boolean;
  /** 是否未来日（目标月内 dayKey > todayKey） */
  isFuture: boolean;
  /** 当日站内有效学习秒数（未来日恒 0） */
  sec: number;
  /** 是否达标打卡：sec ≥ checkinMinSec（未来日 / 补位格恒 false） */
  hit: boolean;
  /**
   * 是否达成每日目标：sec ≥ dailyGoalMin×60（第 261 轮，目标域 / 双口径延伸；
   * dailyGoalMin ≤ 0 时恒 false——与 hit 打卡线并行的第二条口径，见卡面图例）。
   * 未来日 / 补位格恒 false。
   */
  goalHit: boolean;
}

/** 打卡月历（周行为起点，每行恒 7 格，前后月补位成整周行） */
export interface CheckinMonthGrid {
  /** 'YYYY年M月' */
  label: string;
  /** 'YYYY-MM'（调用方导航用的规范化回传） */
  monthKey: string;
  /** 周行（周一为起点），每行恒 7 格 */
  weeks: CheckinMonthCell[][];
  /** 本月已过天数中的达标天数（未来日不计） */
  hitDays: number;
  /** 本月已过天数中达成每日目标的天数（第 261 轮目标线口径；dailyGoalMin≤0 恒 0） */
  goalHitDays: number;
  /** 本月已过天数（date ≤ todayKey 的本月日数；未来月为 0） */
  elapsedDays: number;
  /** 本月（截至今天）站内有效学习秒数合计 */
  totalSec: number;
}

/** 'YYYY-MM' → 月标签 'YYYY年M月'；非法（格式错或月份越界）返回 null */
function monthLabelOf(monthKey: string): string | null {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  const month = match ? Number(match[2]) : 0;
  if (!match || month < 1 || month > 12) return null;
  return `${match[1]}年${month}月`;
}

/** 合法日键守卫（'YYYY-MM-DD' 且月/日分量真实存在——round-trip 校验，
 *  防止 new Date('2026-02-30') 在部分引擎下 rollover 成 3 月） */
function isValidDayKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const parsed = new Date(year, month - 1, day);
  return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day;
}

/**
 * 打卡月历栅格（纯函数）。days = 按日报表行（只读 date / validSec 两个字段）；
 * year / month 为目标自然月（month 1..12）；checkinMinSec 打卡线（秒）；
 * todayKey 用于「今天」高亮与已过天切分，由调用方注入（纯函数不取 Date.now()）。
 * 非法输入（todayKey / 年月不合法）返回 null，与 buildReviewMonthGrid 同约定。
 */
export function buildCheckinMonthGrid(
  days: Array<{ date?: unknown; validSec?: unknown }>,
  year: number,
  month: number,
  checkinMinSec: number = CHECKIN_MIN_SEC,
  todayKey: string,
  dailyGoalMin: number = 0,
): CheckinMonthGrid | null {
  if (!isValidDayKey(todayKey)) return null;
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12 || year < 1970 || year > 9999) {
    return null;
  }
  const label = monthLabelOf(`${year}-${String(month).padStart(2, '0')}`);
  if (!label) return null;

  // 按日秒数归桶（防御式：date 非合法日键 / validSec 非有限非负逐条跳过）
  const secByDay = new Map<string, number>();
  for (const row of Array.isArray(days) ? days : []) {
    if (!row || typeof row !== 'object') continue;
    const date = (row as { date?: unknown }).date;
    const rawSec = (row as { validSec?: unknown }).validSec;
    if (!isValidDayKey(date)) continue;
    if (typeof rawSec !== 'number' || !Number.isFinite(rawSec) || rawSec < 0) continue;
    secByDay.set(date, (secByDay.get(date) ?? 0) + rawSec);
  }

  const first = new Date(year, month - 1, 1, 0, 0, 0, 0);
  const last = new Date(year, month, 0, 0, 0, 0, 0);
  const cellOf = (cursor: Date): CheckinMonthCell => {
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
    const inMonth = cursor.getMonth() === month - 1;
    const isFuture = key > todayKey;
    const sec = inMonth && !isFuture ? Math.max(0, secByDay.get(key) ?? 0) : 0;
    return {
      key,
      dayLabel: String(cursor.getDate()),
      inMonth,
      isToday: key === todayKey,
      isFuture,
      sec,
      hit: sec >= checkinMinSec,
      // 目标线（第 261 轮）：与打卡线并行的第二条口径——达标线由调用方传
      // clamp 后的 settings.dailyGoalMin（≤0 视为未启用）；未来日 / 补位格恒 false
      goalHit: dailyGoalMin > 0 && inMonth && !isFuture && sec >= dailyGoalMin * 60,
    };
  };

  // 起始补位：周一为起点（getDay() 0=周日 → 前移 6 天），与 buildReviewMonthGrid 同排布；
  // 行内 7 步推进游标，行末游标落在下一行首（越过月末即收行）
  const lead = (first.getDay() + 6) % 7;
  const weeks: CheckinMonthCell[][] = [];
  let hitDays = 0;
  let goalHitDays = 0;
  let elapsedDays = 0;
  let totalSec = 0;
  let cursor = new Date(first.getFullYear(), first.getMonth(), 1 - lead);
  while (cursor <= last) {
    const week: CheckinMonthCell[] = [];
    for (let i = 0; i < 7; i += 1) {
      const cell = cellOf(cursor);
      if (cell.inMonth && !cell.isFuture) {
        elapsedDays += 1;
        totalSec += cell.sec;
        if (cell.hit) hitDays += 1;
        if (cell.goalHit) goalHitDays += 1;
      }
      week.push(cell);
      cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
    }
    weeks.push(week);
  }

  return { label, monthKey: `${year}-${String(month).padStart(2, '0')}`, weeks, hitDays, goalHitDays, elapsedDays, totalSec: Math.round(totalSec) };
}
