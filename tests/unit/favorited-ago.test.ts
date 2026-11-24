/**
 * 收藏时间相对化（ui/VideoFavCard.tsx favoritedAgoLabel，第 241 轮巡检）纯函数单测：
 * 今天 / 昨天 / N 天前，满 7 天回落「MM-DD HH:mm」绝对时间（formatFavoritedAt 同格式）；
 * 非法时间戳返回空串（调用方不渲染该行）。与回收站 deletedAgoLabel（第 219 轮）同分桶口径。
 */

import { describe, expect, it } from 'vitest';
import { favoritedAgoLabel } from '@/entrypoints/content/ui/VideoFavCard';

const NOW = new Date(2026, 10, 21, 12, 0, 0).getTime(); // 2026-11-21 12:00 本地
const DAY = 86_400_000;

/** 本地时区「MM-DD HH:mm」（formatFavoritedAt 同款手写 pad，避免 ICU 差异） */
function abs(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

describe('favoritedAgoLabel', () => {
  it('今天 / 昨天 / N 天前（<7 天）', () => {
    expect(favoritedAgoLabel(NOW - 2 * 3600_000, NOW)).toBe('今天');
    expect(favoritedAgoLabel(NOW, NOW)).toBe('今天');
    expect(favoritedAgoLabel(NOW - DAY, NOW)).toBe('昨天');
    expect(favoritedAgoLabel(NOW - 3 * DAY, NOW)).toBe('3 天前');
    expect(favoritedAgoLabel(NOW - 6 * DAY, NOW)).toBe('6 天前');
  });

  it('满 7 天回落「MM-DD HH:mm」绝对时间', () => {
    const ts = new Date(2026, 10, 10, 9, 5, 0).getTime();
    expect(favoritedAgoLabel(ts, NOW)).toBe(abs(ts));
    expect(favoritedAgoLabel(ts, NOW)).toBe('11-10 09:05');
  });

  it('防御式：非法时间戳返回空串；未来时间按今天计', () => {
    expect(favoritedAgoLabel(NaN, NOW)).toBe('');
    expect(favoritedAgoLabel('nope', NOW)).toBe('');
    expect(favoritedAgoLabel(undefined, NOW)).toBe('');
    expect(favoritedAgoLabel(NOW + DAY, NOW)).toBe('今天');
  });
});
