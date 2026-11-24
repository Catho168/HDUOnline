/**
 * 学习连续天数（streak，第 125 轮巡检）：由「有学习的本地日键集合」推导
 * 当前连续天数 / 最长连续天数 / 今日是否已学习。
 * 纯函数、防御式：非法键跳过不抛错；今天未学习时当前连续从昨天起算（次日恢复前不断档）。
 */

export interface StudyStreak {
  /** 当前连续天数（今天未学则截至昨天） */
  current: number;
  /** 观测窗口内的最长连续天数 */
  longest: number;
  /** 今天是否已有学习 */
  activeToday: boolean;
}

function isValidDay(key: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(key);
}

/** 日键 → UTC 天序号（差值即可判断相邻日）；非法键返回 null */
function dayIndex(key: string): number | null {
  if (!isValidDay(key)) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)!;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000;
}

function dayKeyFromIndex(index: number): string {
  const d = new Date(index * 86400000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function computeStudyStreak(activeDays: string[] | null | undefined, todayKey: string): StudyStreak {
  const set = new Set<string>();
  for (const day of Array.isArray(activeDays) ? activeDays : []) {
    if (typeof day === 'string' && isValidDay(day)) set.add(day);
  }
  const today = isValidDay(todayKey) ? todayKey : '';
  let current = 0;
  if (today) {
    const todayIdx = dayIndex(today)!;
    let cursor = set.has(today) ? todayIdx : todayIdx - 1;
    while (set.has(dayKeyFromIndex(cursor))) {
      current += 1;
      cursor -= 1;
    }
  }
  const sorted = [...set].map((key) => dayIndex(key)!).sort((a, b) => a - b);
  let longest = 0;
  let run = 0;
  let prev: number | null = null;
  for (const index of sorted) {
    run = prev !== null && index === prev + 1 ? run + 1 : 1;
    if (run > longest) longest = run;
    prev = index;
  }
  return { current, longest, activeToday: today ? set.has(today) : false };
}

/** 热力图数据 → 有学习的日键列表（排除未来补位日；sec>0 视为有学习） */
export function activeDaysFromHeatmap(
  weeks: Array<{ days?: Array<{ date?: unknown; sec?: unknown; isFuture?: unknown }> }> | null | undefined,
  todayKey: string,
): string[] {
  const out: string[] = [];
  for (const week of Array.isArray(weeks) ? weeks : []) {
    for (const cell of Array.isArray(week?.days) ? week.days : []) {
      if (!cell || typeof cell.date !== 'string' || !isValidDay(cell.date)) continue;
      if (cell.isFuture === true) continue;
      if (cell.date > todayKey) continue;
      if (typeof cell.sec === 'number' && Number.isFinite(cell.sec) && cell.sec > 0) out.push(cell.date);
    }
  }
  return out;
}
