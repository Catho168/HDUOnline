/**
 * 复习 N 日到期预测聚合（第 241 轮巡检，纯函数无 IO）：
 * 把待完成复习作业按到期日聚合为「逾期 + 今日起 days 天 + 以后」的预测柱，
 * 供复习计划视图的 7 日到期预测小柱图使用（列点击复用按日过滤/逾期过滤，
 * 与周历条/月历格的 dayFilter 交互闭环）。
 *
 * 口径裁决（与既有实现同源）：
 *  - 逾期口径与 buildReviewWeekColumns（core/plan/reviewWeek.ts）完全一致：
 *    dueTs < todayTs 归「逾期」首列，仅当有命中才输出该列（空列不占栅格）；
 *  - 今日起 days 列（缺省 7）恒定输出（空列也输出，便于 UI 固定栅格）；
 *  - 第 days+1 列「以后」合计 dueDate 晚于 今日+days-1 的全部作业（跨多日，
 *    无单一日期，UI 不提供点击过滤）；
 *  - 防御式：dueDate 非法（非 'YYYY-MM-DD' 形态）的作业跳过，不进任何列。
 */

export interface ReviewForecastBar {
  /** 柱筛选键：'overdue' / 日键 'YYYY-MM-DD' / 'later'（前两者可直接喂 dayFilter） */
  key: string;
  /** 柱归属日键 'YYYY-MM-DD'；逾期 / 以后两列无单一日期，留空 '' */
  date: string;
  /** 柱头标签：逾期 / 今日 / 明日 / 周X / 以后（紧凑短标签，完整日期看 hover） */
  dayLabel: string;
  /** 该柱到期 pending 作业数 */
  count: number;
  /** 最高柱：count>0 且等于全列最大值（并列同亮，UI accent 高亮用） */
  isPeak: boolean;
}

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 'YYYY-MM-DD' → 本地当日 00:00 毫秒；非法返回 null */
function dayKeyToTs(dayKey: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) return null;
  const ts = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
  return Number.isFinite(ts) ? ts : null;
}

/**
 * 聚合待完成作业（id + dueDate）为预测柱列。
 * todayKey = 'YYYY-MM-DD'；days = 未来窗口天数（含今天），钳制 [1, 31]。
 * 输出列序：[逾期（有命中才有）] → 今日..今日+days-1 → 以后；isPeak 标在
 * 全列最大 count（>0）上，并列同亮。
 */
export function buildReviewForecast(
  pending: Array<{ id: unknown; dueDate: unknown }>,
  todayKey: string,
  days = 7,
): ReviewForecastBar[] {
  const todayTs = dayKeyToTs(todayKey);
  if (todayTs === null) return [];
  const windowDays = Math.min(Math.max(Math.floor(days), 1), 31);
  const buckets = new Map<string, number>();
  for (const job of Array.isArray(pending) ? pending : []) {
    const due = typeof (job as { dueDate?: unknown })?.dueDate === 'string' ? (job as { dueDate: string }).dueDate : null;
    if (!due) continue;
    const dueTs = dayKeyToTs(due);
    if (dueTs === null) continue;
    const key = dueTs < todayTs ? 'overdue' : dueTs <= todayTs + (windowDays - 1) * 86_400_000 ? due : 'later';
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  const bars: ReviewForecastBar[] = [];
  const overdue = buckets.get('overdue');
  if (overdue && overdue > 0) {
    bars.push({ key: 'overdue', date: '', dayLabel: '逾期', count: overdue, isPeak: false });
  }
  for (let offset = 0; offset < windowDays; offset += 1) {
    const dayTs = todayTs + offset * 86_400_000;
    const day = new Date(dayTs);
    const dayKey = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    const weekday = WEEKDAY_LABELS[day.getDay()] ?? '';
    const label = offset === 0 ? '今日' : offset === 1 ? '明日' : weekday || dayKey;
    bars.push({ key: dayKey, date: dayKey, dayLabel: label, count: buckets.get(dayKey) ?? 0, isPeak: false });
  }
  const later = buckets.get('later');
  bars.push({ key: 'later', date: '', dayLabel: '以后', count: later ?? 0, isPeak: false });
  const max = bars.reduce((acc, bar) => Math.max(acc, bar.count), 0);
  if (max > 0) {
    for (const bar of bars) {
      if (bar.count === max) bar.isPeak = true;
    }
  }
  return bars;
}

/**
 * 柱 hover 标题（第 241 轮巡检，纯函数）：日柱「N 月 N 日 · M 项」；
 * 逾期「已逾期 · M 项」；以后「以后 · M 项」（无单一日期不拼日期）。
 */
export function forecastBarTitle(bar: Pick<ReviewForecastBar, 'date' | 'dayLabel' | 'count'>): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(bar.date);
  const dateLabel = match ? `${Number(match[2])} 月 ${Number(match[3])} 日` : bar.dayLabel;
  return `${dateLabel} · ${bar.count} 项`;
}
