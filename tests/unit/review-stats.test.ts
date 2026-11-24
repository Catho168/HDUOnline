/**
 * 复习统计摘要纯函数单测（第 247 轮巡检，复习域收官 / 信息视角）：
 * buildReviewStats 的四指标口径（累计完成 / 本周完成 / 跳过率 / 连续天数）与
 * 防御行为（空列表、非数组、脏数据、除零、周界）。
 *
 * 固定参考时刻：2026-11-18（周三）12:00 本地时间 → 本周一 = 2026-11-16 00:00。
 */
import { describe, expect, it } from 'vitest';

import { buildReviewStats } from '@/core/plan/reviewStats';
import { startOfLocalWeek } from '@/core/shared/utils';
import type { ReviewJobEntity } from '@/core/shared/types';

/** 2026-11-18 12:00 本地（周三） */
const NOW = new Date(2026, 10, 18, 12, 0, 0).getTime();
/** 本周一 00:00（startOfLocalWeek 既有口径） */
const MONDAY = startOfLocalWeek(NOW);
const DAY = 86_400_000;

function job(partial: Partial<ReviewJobEntity>): ReviewJobEntity {
  return {
    id: 'job',
    favoriteId: 'fav-1',
    dueDate: '2026-11-20',
    round: 1,
    template: 'regular',
    status: 'pending',
    createdAt: 1000,
    updatedAt: 1000,
    ...partial,
  };
}

describe('buildReviewStats · 累计完成与跳过率（第 247 轮）', () => {
  it('空列表 / 非数组 / null：全零 + 跳过率 null + hasRecords false', () => {
    for (const empty of [[], null, undefined, 'jobs', 42]) {
      const stats = buildReviewStats(empty, NOW);
      expect(stats.totalDone).toBe(0);
      expect(stats.weekDone).toBe(0);
      expect(stats.skipRate).toBeNull();
      expect(stats.streakDays).toBe(0);
      expect(stats.hasRecords).toBe(false);
    }
  });

  it('累计完成只计 done；pending 不影响任何指标', () => {
    const stats = buildReviewStats(
      [
        job({ id: 'a', status: 'done', updatedAt: NOW }),
        job({ id: 'b', status: 'done', updatedAt: NOW }),
        job({ id: 'c', status: 'pending' }),
      ],
      NOW,
    );
    expect(stats.totalDone).toBe(2);
    expect(stats.skipRate).toBe(0); // 0/(2+0)
    expect(stats.hasRecords).toBe(true);
  });

  it('跳过率 = skipped/(done+skipped) 取整；只有 skipped 时 100；只有 pending 时除零 → null', () => {
    const oneThird = buildReviewStats(
      [
        job({ id: 'a', status: 'done', updatedAt: NOW }),
        job({ id: 'b', status: 'skipped', updatedAt: NOW }),
        job({ id: 'c', status: 'skipped', updatedAt: NOW }),
      ],
      NOW,
    );
    expect(oneThird.skipRate).toBe(67); // 2/3 → 66.67 → 67
    const allSkipped = buildReviewStats([job({ id: 'a', status: 'skipped', updatedAt: NOW })], NOW);
    expect(allSkipped.skipRate).toBe(100);
    const onlyPending = buildReviewStats([job({ id: 'a', status: 'pending' })], NOW);
    expect(onlyPending.skipRate).toBeNull();
    expect(onlyPending.hasRecords).toBe(false);
  });
});

describe('buildReviewStats · 本周完成周界（第 247 轮）', () => {
  it('本周一 00:00 恰好计入（含边界）；上周日不计', () => {
    const stats = buildReviewStats(
      [
        job({ id: 'monday', status: 'done', updatedAt: MONDAY }),
        job({ id: 'lastWeek', status: 'done', updatedAt: MONDAY - 1000 }),
      ],
      NOW,
    );
    expect(stats.totalDone).toBe(2);
    expect(stats.weekDone).toBe(1);
  });

  it('周中与今天完成都计入本周', () => {
    const stats = buildReviewStats(
      [
        job({ id: 'tue', status: 'done', updatedAt: MONDAY + DAY }),
        job({ id: 'today', status: 'done', updatedAt: NOW }),
      ],
      NOW,
    );
    expect(stats.weekDone).toBe(2);
  });
});

describe('buildReviewStats · 连续完成天数（streak 口径回放）', () => {
  it('今天 + 昨天完成 → 2 天', () => {
    const stats = buildReviewStats(
      [
        job({ id: 'today', status: 'done', updatedAt: NOW }),
        job({ id: 'yesterday', status: 'done', updatedAt: NOW - DAY }),
      ],
      NOW,
    );
    expect(stats.streakDays).toBe(2);
  });

  it('今天未完成、昨天完成 → 从昨天起算 1 天（streak「跨日未学不断档」口径）', () => {
    const stats = buildReviewStats([job({ id: 'yesterday', status: 'done', updatedAt: NOW - DAY })], NOW);
    expect(stats.streakDays).toBe(1);
  });

  it('断档（最近完成在 3 天前）→ 0；同一日多次完成去重', () => {
    const gapped = buildReviewStats([job({ id: 'old', status: 'done', updatedAt: NOW - 3 * DAY })], NOW);
    expect(gapped.streakDays).toBe(0);
    const sameDayTwice = buildReviewStats(
      [
        job({ id: 'a', status: 'done', updatedAt: NOW }),
        job({ id: 'b', status: 'done', updatedAt: NOW - 60_000 }),
      ],
      NOW,
    );
    expect(sameDayTwice.streakDays).toBe(1);
  });
});

describe('buildReviewStats · 脏数据防御（第 247 轮）', () => {
  it('非对象条目 / 未知 status 逐条跳过不抛错', () => {
    const stats = buildReviewStats([null, 42, 'x', {}, { status: 'weird', updatedAt: NOW }], NOW);
    expect(stats.totalDone).toBe(0);
    expect(stats.skipRate).toBeNull();
  });

  it('done 但 updatedAt 缺失 / NaN / 字符串 / Infinity：计入累计与跳过率分母，不计入本周与连续天数', () => {
    const stats = buildReviewStats(
      [
        job({ id: 'noTs', status: 'done' }),
        job({ id: 'nan', status: 'done', updatedAt: Number.NaN }),
        job({ id: 'str', status: 'done', updatedAt: '2026-11-18' as unknown as number }),
        job({ id: 'inf', status: 'done', updatedAt: Number.POSITIVE_INFINITY }),
      ],
      NOW,
    );
    expect(stats.totalDone).toBe(4);
    expect(stats.weekDone).toBe(0);
    expect(stats.streakDays).toBe(0);
    expect(stats.skipRate).toBe(0);
  });

  it('now 为 Date 与毫秒时间戳等价', () => {
    const viaDate = buildReviewStats([job({ id: 'a', status: 'done', updatedAt: NOW })], new Date(NOW));
    const viaTs = buildReviewStats([job({ id: 'a', status: 'done', updatedAt: NOW })], NOW);
    expect(viaDate).toEqual(viaTs);
    expect(viaDate.weekDone).toBe(1);
  });
});
