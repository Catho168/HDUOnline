/**
 * 相对时间分桶（第 243 轮巡检抽共享）：今天 / 昨天 / N 天前，满 7 天回落
 * 「MM-DD HH:mm」绝对时间。原为 VideoFavCard.tsx 私有实现（第 241 轮巡检，
 * favoritedAgoLabel），本课学习小条的「本课笔记最近一条」需要同一分桶口径，
 * 故抽到 core/shared 供 UI 层复用；VideoFavCard 保留同名 re-export（旧引用与
 * 单测导入路径不变）。与回收站 deletedAgoLabel（第 219 轮）同分桶口径。
 */

/** 本地时区「MM-DD HH:mm」。手写 pad 拼接而非 toLocaleString，避免 jsdom/Node
 *  ICU 差异导致的输出不稳定（单测友好）；年份省略保持紧凑（近期事件场景）。 */
function formatLocalClock(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 相对时间标签：今天 / 昨天 / N 天前（<7 天），满 7 天回落「MM-DD HH:mm」绝对时间。
 * 防御式：非法时间戳（非有限数）返回空串，调用方不渲染。
 */
export function favoritedAgoLabel(favoritedAt: unknown, now = Date.now()): string {
  if (typeof favoritedAt !== 'number' || !Number.isFinite(favoritedAt)) return '';
  const days = Math.floor((now - favoritedAt) / 86_400_000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  return formatLocalClock(favoritedAt);
}
