/**
 * 回收站续期纯函数单测（第 233 轮巡检）：extendedExpiresAt 的默认值与钳制口径。
 */
import { describe, expect, it } from 'vitest';

import { extendedExpiresAt } from '@/core/db/repo/trash';

const DAY = 86_400_000;

describe('extendedExpiresAt（回收站续期，第 233 轮）', () => {
  it('默认 30 天；指定天数按 floor 计算', () => {
    const now = 1_000_000_000_000;
    expect(extendedExpiresAt(now, Number.NaN)).toBe(now + 30 * DAY);
    expect(extendedExpiresAt(now, 7)).toBe(now + 7 * DAY);
    expect(extendedExpiresAt(now, 7.9)).toBe(now + 7 * DAY);
  });

  it('钳制 1..365，不产生越界清理期', () => {
    const now = 1_000_000_000_000;
    expect(extendedExpiresAt(now, 0)).toBe(now + 1 * DAY);
    expect(extendedExpiresAt(now, -5)).toBe(now + 1 * DAY);
    expect(extendedExpiresAt(now, 365)).toBe(now + 365 * DAY);
    expect(extendedExpiresAt(now, 4000)).toBe(now + 365 * DAY);
  });
});
