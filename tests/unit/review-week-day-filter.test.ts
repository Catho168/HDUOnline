/**
 * 复习周历/月历按日筛选解析纯函数单测（第 240 轮巡检）：
 * jobIdsForDayFilter 是周历条与月历格共用的「日筛选键 → 作业 id 集」解析器——
 * 月历格可指向周历窗口（逾期 + 7/14/30 天）之外的日期（前后月导航），
 * 第 240 轮起列表过滤改用本函数对全量 pending 解析，不再查周历列。
 *
 * 覆盖：
 *  1. 'overdue' 键 = dueDate < today 全集；
 *  2. 精确日键 = dueDate 等值命中；
 *  3. 窗口外日键（月视图场景）仍命中——周历列查表会落空的回归锁定；
 *  4. null / 非法键 / 脏数据防御；
 *  5. 与 buildReviewWeekColumns 同窗口一致性（同一日键解析结果相等）。
 */
import { describe, expect, it } from 'vitest';
import { buildReviewWeekColumns, jobIdsForDayFilter } from '@/core/plan/reviewWeek';

const TODAY = '2026-11-21';

function makeJobs(): Array<{ id: string; dueDate: string }> {
  return [
    { id: 'job-overdue-1', dueDate: '2026-11-19' },
    { id: 'job-overdue-2', dueDate: '2026-01-01' },
    { id: 'job-today', dueDate: TODAY },
    { id: 'job-in-window', dueDate: '2026-11-24' },
    // 周历 7 天窗口外（+20 天）——月视图导航可达
    { id: 'job-beyond-window', dueDate: '2026-12-11' },
    { id: 'job-bad-due', dueDate: 'not-a-date' },
    { id: 'job-no-due', dueDate: '' },
  ];
}

describe('jobIdsForDayFilter（第 240 轮，周历/月历共用日筛选解析）', () => {
  it('overdue 键 = dueDate < today 全集（跨月/跨年都算）', () => {
    const ids = jobIdsForDayFilter(makeJobs(), 'overdue', TODAY);
    expect([...ids].sort()).toEqual(['job-overdue-1', 'job-overdue-2']);
  });

  it('精确日键 = 等值命中（今天）', () => {
    expect(jobIdsForDayFilter(makeJobs(), TODAY, TODAY)).toEqual(new Set(['job-today']));
  });

  it('窗口外日键（月视图 +20 天）仍命中——回归锁定：不再查周历列', () => {
    expect(jobIdsForDayFilter(makeJobs(), '2026-12-11', TODAY)).toEqual(new Set(['job-beyond-window']));
  });

  it('窗口边界日键：+6 天在窗口内、+7 天在窗外，两者都命中（解析与窗口无关）', () => {
    const jobs = [
      { id: 'job-d6', dueDate: '2026-11-27' },
      { id: 'job-d7', dueDate: '2026-11-28' },
    ];
    expect(jobIdsForDayFilter(jobs, '2026-11-27', TODAY)).toEqual(new Set(['job-d6']));
    expect(jobIdsForDayFilter(jobs, '2026-11-28', TODAY)).toEqual(new Set(['job-d7']));
  });

  it('null / 非法键返回空集；todayKey 非法也返回空集', () => {
    expect(jobIdsForDayFilter(makeJobs(), null, TODAY).size).toBe(0);
    expect(jobIdsForDayFilter(makeJobs(), '2026-13-40', TODAY).size).toBe(0);
    expect(jobIdsForDayFilter(makeJobs(), TODAY, 'bad-today').size).toBe(0);
  });

  it('脏数据防御：id/dueDate 非法条目不进结果', () => {
    const dirty = [
      { id: 'ok', dueDate: TODAY },
      { id: 42, dueDate: TODAY },
      { id: 'no-due', dueDate: null },
      null,
    ] as unknown as Array<{ id: string; dueDate: string }>;
    expect(jobIdsForDayFilter(dirty, TODAY, TODAY)).toEqual(new Set(['ok']));
  });

  it('非数组入参返回空集', () => {
    expect(jobIdsForDayFilter(undefined as unknown as Array<{ id: unknown; dueDate: unknown }>, TODAY, TODAY).size).toBe(0);
    expect(jobIdsForDayFilter('jobs' as unknown as Array<{ id: unknown; dueDate: unknown }>, TODAY, TODAY).size).toBe(0);
  });

  it('与 buildReviewWeekColumns 同窗口一致性：列内 jobIds 与本函数解析相等', () => {
    const jobs = makeJobs();
    const columns = buildReviewWeekColumns(jobs, TODAY, 7);
    for (const col of columns) {
      expect(jobIdsForDayFilter(jobs, col.key, TODAY)).toEqual(new Set(col.jobIds));
    }
  });
});
