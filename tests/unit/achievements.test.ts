/**
 * 学习成就徽章单测（第 125 轮巡检）：buildAchievements——解锁判定、进度钳制、脏数据防御。
 */
import { describe, expect, it } from 'vitest';
import { buildAchievements } from '@/core/plan/achievements';

describe('buildAchievements（学习成就徽章，第 125 轮）', () => {
  it('按阈值解锁并给出进度', () => {
    const rows = buildAchievements({ totalSec: 3600, streakDays: 5, favoriteCount: 12, externalSec: 600, reviewDoneCount: 10, noteCount: 2 });
    const get = (id: string) => rows.find((row) => row.id === id)!;
    expect(get('streak-3').unlocked).toBe(true);
    expect(get('streak-7').unlocked).toBe(false);
    expect(get('streak-7').progress).toBeCloseTo(5 / 7);
    expect(get('min-30').unlocked).toBe(true);
    expect(get('hour-1').unlocked).toBe(true);
    expect(get('hour-1').value).toBe(60);
    expect(get('hour-3').unlocked).toBe(false);
    expect(get('fav-10').unlocked).toBe(true);
    expect(get('external-10').unlocked).toBe(true);
    expect(get('review-10').unlocked).toBe(true);
    expect(get('note-5').unlocked).toBe(false);
    expect(get('note-5').progress).toBeCloseTo(2 / 5);
  });

  it('零值全锁定、进度 0；负数与非法输入按 0 处理', () => {
    const rows = buildAchievements({});
    expect(rows.every((row) => !row.unlocked && row.progress === 0)).toBe(true);
    const dirty = buildAchievements({ totalSec: -5, streakDays: 'x' as never, favoriteCount: NaN, externalSec: null as never });
    expect(dirty.every((row) => !row.unlocked)).toBe(true);
  });

  it('进度上限钳制到 1；null 输入不抛错', () => {
    const rows = buildAchievements({ totalSec: 36000, streakDays: 30, favoriteCount: 99, externalSec: 3600, reviewDoneCount: 99, noteCount: 99 });
    expect(rows.every((row) => row.progress === 1 && row.unlocked)).toBe(true);
    expect(() => buildAchievements(null)).not.toThrow();
    expect(buildAchievements(undefined)).toHaveLength(9);
  });
});

describe('buildAchievements 目标倍率（第 133 轮）', () => {
  it('阈值按倍率放大（四舍五入），进度随新阈值', () => {
    const rows = buildAchievements({ totalSec: 3600, goalScale: 2 });
    const get = (id: string) => rows.find((row) => row.id === id)!;
    expect(get('min-30').threshold).toBe(60);
    expect(get('min-30').unlocked).toBe(true);
    expect(get('hour-1').threshold).toBe(120);
    expect(get('hour-1').unlocked).toBe(false);
    expect(get('hour-1').progress).toBeCloseTo(0.5);
  });

  it('非法/过小倍率回退标准阈值', () => {
    const rows = buildAchievements({ totalSec: 3600, goalScale: 0.5 });
    expect(rows.find((row) => row.id === 'hour-1')!.threshold).toBe(60);
    const rows2 = buildAchievements({ totalSec: 3600, goalScale: 'x' as never });
    expect(rows2.find((row) => row.id === 'min-30')!.threshold).toBe(30);
  });
});

describe('buildAchievements 自定义徽章（第 139 轮）', () => {
  it('自定义徽章追加在预置之后，阈值同受目标倍率缩放', () => {
    const rows = buildAchievements({
      totalSec: 3600,
      reviewDoneCount: 10,
      customBadges: [{ id: 'c1', name: '百题斩', metric: 'reviewDone', threshold: 10 }],
      goalScale: 2,
    });
    expect(rows.length).toBe(10);
    const custom = rows.find((row) => row.id === 'custom-c1')!;
    expect(custom.name).toBe('百题斩');
    expect(custom.threshold).toBe(20);
    expect(custom.unlocked).toBe(false);
    expect(custom.progress).toBeCloseTo(0.5);
  });

  it('非法项跳过（缺名称/缺维度/未知维度/阈值≤0），重复 id 去重', () => {
    const rows = buildAchievements({
      customBadges: [
        { id: 'a', name: '', metric: 'notes', threshold: 5 },
        { id: 'b', name: '无维度', metric: 'unknown', threshold: 5 },
        { id: 'c', name: '零阈值', metric: 'notes', threshold: 0 },
        { id: 'd', name: '有效一', metric: 'notes', threshold: 3 },
        { id: 'd', name: '重复', metric: 'notes', threshold: 9 },
      ],
    });
    const custom = rows.filter((row) => row.id.startsWith('custom-'));
    expect(custom.map((row) => row.id)).toEqual(['custom-d']);
    expect(custom[0]!.name).toBe('有效一');
  });

  it('维度取值正确：连续天数 / 站外分钟 / 收藏数', () => {
    const rows = buildAchievements({
      streakDays: 4,
      externalSec: 1200,
      favoriteCount: 7,
      customBadges: [
        { id: 's', name: '连续四天', metric: 'streak', threshold: 4 },
        { id: 'e', name: '站外二十分', metric: 'externalMin', threshold: 20 },
        { id: 'f', name: '收藏七个', metric: 'favorites', threshold: 7 },
      ],
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get('custom-s')!.unlocked).toBe(true);
    expect(byId.get('custom-s')!.unit).toBe('天');
    expect(byId.get('custom-e')!.unlocked).toBe(true);
    expect(byId.get('custom-e')!.unit).toBe('分钟');
    expect(byId.get('custom-f')!.unlocked).toBe(true);
    expect(byId.get('custom-f')!.unit).toBe('个');
  });
});
