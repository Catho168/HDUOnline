/**
 * 复习计划周视图聚合单测（第 105 轮巡检）：buildReviewWeekColumns——
 * 逾期列 + 今日起 7 天分栏、按日聚合、脏数据防御。
 */
import { describe, expect, it } from 'vitest';
import { buildReviewMonthGrid, buildReviewWeekColumns } from '@/core/plan/reviewWeek';

describe('buildReviewWeekColumns（复习计划周视图，第 105 轮）', () => {
  const TODAY = '2026-11-18';

  it('逾期列 + 今日起 7 天列；按日聚合 jobIds', () => {
    const cols = buildReviewWeekColumns(
      [
        { id: 'a', dueDate: '2026-11-16' },
        { id: 'b', dueDate: '2026-11-17' },
        { id: 'c', dueDate: '2026-11-18' },
        { id: 'd', dueDate: '2026-11-19' },
        { id: 'e', dueDate: '2026-11-25' },
      ],
      TODAY,
    );
    expect(cols[0]!).toMatchObject({ key: 'overdue', label: '逾期', kind: 'overdue' });
    expect(cols[0]!.jobIds).toEqual(['a', 'b']);
    expect(cols[1]!).toMatchObject({ key: '2026-11-18', label: '今日', kind: 'today' });
    expect(cols[1]!.jobIds).toEqual(['c']);
    expect(cols[2]!).toMatchObject({ key: '2026-11-19', label: '明日' });
    // 逾期列 + 7 天 = 8 列；窗外（11-25）不进任何列
    expect(cols).toHaveLength(8);
    expect(cols.flatMap((col) => col.jobIds)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('无逾期时省略逾期列；脏 dueDate / 脏 id 跳过', () => {
    const cols = buildReviewWeekColumns(
      [
        { id: 'c', dueDate: '2026-11-18' },
        { id: 'x', dueDate: 'not-a-date' },
        { id: null, dueDate: '2026-11-18' },
        { id: 'y', dueDate: 123 },
      ],
      TODAY,
    );
    expect(cols).toHaveLength(7);
    expect(cols[0]!.key).toBe('2026-11-18');
    expect(cols.flatMap((col) => col.jobIds)).toEqual(['c']);
  });

  it('空入参 / 非数组 / 非法 today 防御', () => {
    expect(buildReviewWeekColumns([], TODAY)).toHaveLength(7);
    expect(buildReviewWeekColumns(null as never, TODAY)).toHaveLength(7);
    expect(buildReviewWeekColumns([{ id: 'a', dueDate: '2026-11-18' }], 'bad')).toEqual([]);
  });

  it('14 天窗口档（第 108 轮）：列数 15（含逾期），窗外作业不进列', () => {
    const cols = buildReviewWeekColumns(
      [
        { id: 'a', dueDate: '2026-11-17' },
        { id: 'b', dueDate: '2026-11-18' },
        { id: 'c', dueDate: '2026-11-24' },
        { id: 'd', dueDate: '2026-12-05' },
      ],
      TODAY,
      14,
    );
    // 逾期 1 列 + 14 天 = 15 列；12-05 在 14 天窗外
    expect(cols).toHaveLength(15);
    expect(cols[0]!.jobIds).toEqual(['a']);
    expect(cols.flatMap((col) => col.jobIds)).toEqual(['a', 'b', 'c']);
  });
});

describe('buildReviewMonthGrid（复习计划月视图，第 111 轮）', () => {
  const TODAY = '2026-11-18';

  it('自然月周历：周一为起点、前后月补位、今天高亮、按日聚合', () => {
    // 2026-11-01 是周日：首行补位 10-26（周一）..10-31（周六），11-01 起为本月
    const grid = buildReviewMonthGrid(
      [
        { id: 'a', dueDate: '2026-11-01' },
        { id: 'b', dueDate: '2026-11-18' },
        { id: 'c', dueDate: '2026-11-30' },
        { id: 'd', dueDate: 'bad' },
      ],
      '2026-11',
      TODAY,
    );
    expect(grid).not.toBeNull();
    expect(grid!.label).toBe('2026年11月');
    const cells = grid!.weeks.flat();
    expect(cells).toHaveLength(42); // 6 周整（10-26..12-06，尾周补 12 月初）
    expect(cells[0]!.key).toBe('2026-10-26');
    expect(cells[0]!.inMonth).toBe(false);
    const todayCell = cells.find((c) => c.key === '2026-11-18');
    expect(todayCell?.isToday).toBe(true);
    expect(todayCell?.jobIds).toEqual(['b']);
    expect(cells.some((c) => c.key === '2026-11-30' && c.jobIds.includes('c'))).toBe(true);
  });

  it('非法月份 / 非法 today 返回 null', () => {
    expect(buildReviewMonthGrid([], '2026-13', TODAY)).toBeNull();
    expect(buildReviewMonthGrid([{ id: 'a', dueDate: '2026-11-18' }], 'bad', TODAY)).toBeNull();
  });
});
