/**
 * 复习计划周视图聚合（第 105 轮巡检，纯函数无 IO）：
 * 把待完成复习作业按到期日聚合为「逾期 + 今日起 7 天」的周历条，
 * 供复习计划视图顶部的一键定位/按日筛选使用。防御式：dueDate 非法
 * （非 'YYYY-MM-DD' 形态）的作业不进任何列，由调用方维持全量兜底。
 */

export interface ReviewWeekColumn {
  /** 筛选键：'overdue' 或日键 'YYYY-MM-DD' */
  key: string;
  /** 列头标签：逾期 / 今日 / 明日 / 周X MM-DD */
  label: string;
  kind: 'overdue' | 'today' | 'future';
  /** 该列作业 id（保持入参顺序） */
  jobIds: string[];
}

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 'YYYY-MM-DD' → 本地当日 00:00 毫秒；非法返回 null */
function dayKeyToTs(dayKey: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) return null;
  const ts = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
  return Number.isFinite(ts) ? ts : null;
}

/** 日键 → 'MM-DD' 短标签 */
function shortDay(dayKey: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  return match ? `${match[2]}-${match[3]}` : dayKey;
}

/**
 * 聚合待完成作业（id + dueDate）为周历列：
 *  - 第 1 列「逾期」：dueDate < today（仅当有命中时输出）；
 *  - 其后 days 列（缺省 7，第 108 轮巡检支持 14 天窗口）：今日起按日历日递推
 *    （今日 / 明日 / 周X MM-DD）；
 *  - 列恒定输出（空列也输出，便于 UI 固定栅格——逾期列除外）。
 */
export function buildReviewWeekColumns(
  pending: Array<{ id: unknown; dueDate: unknown }>,
  todayKey: string,
  days = 7,
): ReviewWeekColumn[] {
  const todayTs = dayKeyToTs(todayKey);
  if (todayTs === null) return [];
  const windowDays = Math.min(Math.max(Math.floor(days), 1), 31);
  const buckets = new Map<string, string[]>();
  for (const job of Array.isArray(pending) ? pending : []) {
    const id = typeof (job as { id?: unknown })?.id === 'string' ? (job as { id: string }).id : null;
    const due = typeof (job as { dueDate?: unknown })?.dueDate === 'string' ? (job as { dueDate: string }).dueDate : null;
    if (!id || !due) continue;
    const dueTs = dayKeyToTs(due);
    if (dueTs === null) continue;
    const key = dueTs < todayTs ? 'overdue' : due;
    const list = buckets.get(key) ?? [];
    list.push(id);
    buckets.set(key, list);
  }
  const columns: ReviewWeekColumn[] = [];
  const overdue = buckets.get('overdue');
  if (overdue && overdue.length > 0) {
    columns.push({ key: 'overdue', label: '逾期', kind: 'overdue', jobIds: overdue });
  }
  for (let offset = 0; offset < windowDays; offset += 1) {
    const dayTs = todayTs + offset * 86_400_000;
    const day = new Date(dayTs);
    const dayKey = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    const jobIds = buckets.get(dayKey) ?? [];
    const weekday = WEEKDAY_LABELS[day.getDay()] ?? '';
    const label = offset === 0 ? '今日' : offset === 1 ? '明日' : `${weekday} ${shortDay(dayKey)}`;
    columns.push({ key: dayKey, label, kind: offset === 0 ? 'today' : 'future', jobIds });
  }
  return columns;
}

/**
 * 按日筛选键解析待完成作业 id（第 240 轮巡检，纯函数无 IO）：
 *  - dayFilter = 'overdue' → dueDate < today 的全部作业；
 *  - dayFilter = 'YYYY-MM-DD' → dueDate 精确等于该日的作业。
 * 与周历窗口无关——月历格可指向窗口外日期（前后月导航、>30 天），周历列
 * 查表会落空，这里直接对全量 pending 按到期日解析；非法键 / 无命中返回空集。
 * 周历条既有的列内 jobIds 与本函数对同一日键的解析结果一致（同一批桶）。
 */
export function jobIdsForDayFilter(
  pending: Array<{ id: unknown; dueDate: unknown }>,
  dayFilter: string | null,
  todayKey: string,
): Set<string> {
  const result = new Set<string>();
  if (!dayFilter) return result;
  const todayTs = dayKeyToTs(todayKey);
  if (todayTs === null) return result;
  const filterTs = dayFilter === 'overdue' ? null : dayKeyToTs(dayFilter);
  if (dayFilter !== 'overdue' && filterTs === null) return result;
  for (const job of Array.isArray(pending) ? pending : []) {
    const id = typeof (job as { id?: unknown })?.id === 'string' ? (job as { id: string }).id : null;
    const due = typeof (job as { dueDate?: unknown })?.dueDate === 'string' ? (job as { dueDate: string }).dueDate : null;
    if (!id || !due) continue;
    const dueTs = dayKeyToTs(due);
    if (dueTs === null) continue;
    if (dayFilter === 'overdue' ? dueTs < todayTs : due === dayFilter) result.add(id);
  }
  return result;
}

// ───────────────────────── 月视图（第 111 轮巡检） ─────────────────────────

export interface ReviewMonthCell {
  /** 日键 'YYYY-MM-DD'（前后月补位格也有真实键，供悬停提示） */
  key: string;
  /** 日号 '1'..'31' */
  dayLabel: string;
  /** 是否本月（前后月补位格为 false） */
  inMonth: boolean;
  /** 是否今天 */
  isToday: boolean;
  jobIds: string[];
}

export interface ReviewMonthGrid {
  /** 'YYYY年M月' */
  label: string;
  /** 周行（周一为起点），每行恒 7 格（前后月补位） */
  weeks: ReviewMonthCell[][];
}

/** 'YYYY-MM' → 月标签 'YYYY年M月'；非法（格式错或月份越界）返回 null */
function monthLabelOf(monthKey: string): string | null {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  const month = match ? Number(match[2]) : 0;
  if (!match || month < 1 || month > 12) return null;
  return `${match[1]}年${month}月`;
}

/**
 * 月历栅格（纯函数）：把待完成作业按到期日放进自然月周历（周一为起点，
 * 前后月补位成整周行）。monthKey = 'YYYY-MM'；todayKey 用于「今天」高亮。
 * 非法输入返回 null；作业 dueDate 非法或落在补位格时计入该格（补位格仍属真实日期）。
 */
export function buildReviewMonthGrid(
  pending: Array<{ id: unknown; dueDate: unknown }>,
  monthKey: string,
  todayKey: string,
): ReviewMonthGrid | null {
  const label = monthLabelOf(monthKey);
  const todayTs = dayKeyToTs(todayKey);
  if (!label || todayTs === null) return null;
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey)!;
  const first = new Date(Number(match[1]), Number(match[2]) - 1, 1);
  const last = new Date(Number(match[1]), Number(match[2]), 0);
  const buckets = new Map<string, string[]>();
  for (const job of Array.isArray(pending) ? pending : []) {
    const id = typeof (job as { id?: unknown })?.id === 'string' ? (job as { id: string }).id : null;
    const due = typeof (job as { dueDate?: unknown })?.dueDate === 'string' ? (job as { dueDate: string }).dueDate : null;
    if (!id || !due) continue;
    if (dayKeyToTs(due) === null) continue;
    const list = buckets.get(due) ?? [];
    list.push(id);
    buckets.set(due, list);
  }
  const cellOf = (date: Date): ReviewMonthCell => {
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    return {
      key,
      dayLabel: String(date.getDate()),
      inMonth: date.getMonth() === first.getMonth(),
      isToday: key === todayKey,
      jobIds: buckets.get(key) ?? [],
    };
  };
  // 起始补位：周一为起点（getDay() 0=周日 → 前移 6 天）
  const lead = (first.getDay() + 6) % 7;
  const weeks: ReviewMonthCell[][] = [];
  let cursor = new Date(first.getFullYear(), first.getMonth(), 1 - lead);
  while (cursor <= last) {
    const week: ReviewMonthCell[] = [];
    for (let i = 0; i < 7; i += 1) {
      week.push(cellOf(cursor));
      cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
    }
    weeks.push(week);
  }
  return { label, weeks };
}
