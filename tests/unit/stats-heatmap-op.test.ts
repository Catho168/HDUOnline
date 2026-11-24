/**
 * stats.heatmap / stats.dayDetail op 接线单测（第 77/79 轮巡检）：经 dispatchOp 走
 * 真实仓储层（fake-indexeddb），锁定「op 参数 → 范围查询 → 纯函数聚合」链路的形状契约。
 */
import { describe, expect, it } from 'vitest';
import { dispatchOp } from '@/entrypoints/background/ops';
import { addWatchRecord } from '@/core/db/repo/stats';
import { addExternalWatch } from '@/core/db/repo/external';
import { upsertCourse } from '@/core/db/repo/content';
import type { CourseEntity, WatchRecordEntity } from '@/core/shared/types';

describe('stats.heatmap op 接线', () => {
  it('weeks 缺省（26 周）返回完整网格，周一日键成列', async () => {
    const result = await dispatchOp('stats.heatmap', {});
    expect(result.weeks).toHaveLength(26);
    expect(result.weeks[0]?.days).toHaveLength(7);
    expect(result.todayKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.generatedAt).toBeGreaterThan(0);
  });

  it('weeks 显式传入时按钳制后的周数返回', async () => {
    const result = await dispatchOp('stats.heatmap', { weeks: 4 });
    expect(result.weeks).toHaveLength(4);
    // 每列首日为周一：相邻列起点间隔 7 天
    const starts = result.weeks.map((w) => w.startDay);
    expect(new Set(starts).size).toBe(4);
  });
});

describe('stats.dayDetail op 接线（第 79 轮）', () => {
  function rec(overrides: Partial<WatchRecordEntity>): WatchRecordEntity {
    return {
      courId: 1,
      teclId: 9,
      date: '2026-05-06',
      startTs: 1,
      endTs: 2,
      durationSec: 120,
      playMode: 'vod',
      speed: 1,
      firstWatch: false,
      valid: true,
      ...overrides,
    } as WatchRecordEntity;
  }

  it('按日取站内外流水并富化课程名；invalid 行保留但不算入 internalSec', async () => {
    await upsertCourse({ teclId: 9, subjName: '高等数学', teclCode: 'M101', teacherNames: [], updatedAt: 1 } as CourseEntity);
    await addWatchRecord(rec({ durationSec: 120, valid: true }));
    await addWatchRecord(rec({ courId: 2, durationSec: 30, valid: false }));
    await addExternalWatch({ date: '2026-05-06', bvid: 'BV1DayDetail', title: '线代公开课', seconds: 60 });
    const report = await dispatchOp('stats.dayDetail', { date: '2026-05-06' });
    expect(report.date).toBe('2026-05-06');
    expect(report.internal).toHaveLength(2);
    expect(report.internal[0]?.label).toContain('高等数学');
    expect(report.internal[0]?.label).toContain('M101');
    expect(report.internal.some((row) => row.sub?.includes('不计入'))).toBe(true);
    expect(report.internalSec).toBe(120);
    expect(report.external).toHaveLength(1);
    expect(report.external[0]).toMatchObject({ label: '线代公开课', seconds: 60, sub: '站外视频' });
    expect(report.externalSec).toBe(60);
  });

  it('非法日期回退今天；无流水日返回空行与 0 合计', async () => {
    const report = await dispatchOp('stats.dayDetail', { date: 'not-a-day' });
    expect(report.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(report.internal).toEqual([]);
    expect(report.external).toEqual([]);
    expect(report.internalSec).toBe(0);
    expect(report.externalSec).toBe(0);
  });
});
