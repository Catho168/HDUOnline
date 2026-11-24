/**
 * 明日预告口径一致性锁定（第 242 轮巡检，一致性视角）：
 *
 * 两处「明日到期」数字的口径核对结论（读码推演 + 本测试锁定）：
 *  - 今日待办 / B 站今日卡「明日到期 N」Chip：callOp('review.due', { date: 明日 })
 *    → dueReviews（core/db/repo/library.ts）→ reviewJobs 按 dueDate 索引精确匹配
 *    + status === 'pending'；收藏删除时 softDeleteFavorites 级联取消全部复习作业
 *    （library.ts「关联复习计划一并取消」），孤儿作业在当前数据流中不存在；
 *  - 复习页 7 日预测「明」柱：callOp('review.list') → listReviewJobs 全量
 *    → buildReviewForecast（core/plan/reviewForecast.ts）按 dueDate 解析分桶，
 *    非法 dueDate 跳过。
 *
 * 两者对同一批数据必然相等：索引精确匹配（'YYYY-MM-DD' 整串相等）与
 * dayKeyToTs 正则解析 + 相等比较接受同一集合（严格 'YYYY-MM-DD' 形态）。
 * 本测试在纯函数层锁定该等价（repo 侧以镜像过滤器表示 dueReviews 的索引查询
 * 语义：pending + dueDate === dateKey），防止任一侧未来加过滤导致漂移。
 */

import { describe, expect, it } from 'vitest';
import { buildReviewForecast, forecastBarTitle } from '@/core/plan/reviewForecast';
import { addDaysKey, localDayKey } from '@/core/shared/utils';

const TODAY = localDayKey();
const TOMORROW = addDaysKey(TODAY, 1)!;

interface ConsistencyJob {
  id: string;
  status: string;
  dueDate: string;
  favorite: { id: string } | null;
}

function job(id: string, dueDate: string, status = 'pending', favorite: { id: string } | null = { id: `fav-${id}` }): ConsistencyJob {
  return { id, status, dueDate, favorite };
}

/**
 * dueReviews 的索引查询语义镜像（core/db/repo/library.ts:536）：'dueDate' 索引
 * 取该日键全部作业后按 status === 'pending' 过滤（favorite join 不影响计数——
 * job 恒返回，favorite 可能为 null）。
 */
function dueReviewsMirror(jobs: ConsistencyJob[], dateKey: string): ConsistencyJob[] {
  return jobs.filter((j) => j.status === 'pending' && j.dueDate === dateKey);
}

/** 预测「明」柱计数（UI 侧：review.list 全量 → pendingJobs 前置过滤 → buildReviewForecast 分桶） */
function forecastTomorrowCount(jobs: ConsistencyJob[]): number {
  // ReviewView 的 pendingJobs 过滤（status === 'pending'；type/template 筛选默认 all，
  // 用户持久化筛选下明柱只数筛选子集——见巡检日志第 242 轮口径核对结论）
  const pending = jobs.filter((j) => j.status === 'pending');
  const bars = buildReviewForecast(pending, TODAY, 7);
  return bars.find((bar) => bar.key === TOMORROW)?.count ?? -1;
}

describe('明日预告口径互认（今日卡 Chip ↔ 复习预测明柱，第 242 轮）', () => {
  it('同批数据两口径相等：混合状态 / 到期日 / 孤儿形状', () => {
    const jobs: ConsistencyJob[] = [
      job('a', TOMORROW),
      job('b', TOMORROW),
      job('c', TOMORROW, 'done'),
      job('d', TOMORROW, 'skipped'),
      job('e', TODAY),
      job('f', addDaysKey(TODAY, 2)!),
      job('g', '2020-01-01'),
      job('h', TOMORROW, 'pending', null), // 孤儿形状（favorite null）：两口径都计入
      job('i', 'not-a-date'), // 正则不匹配：索引取不到、预测跳过——两口径都不计
    ];
    expect(dueReviewsMirror(jobs, TOMORROW).length).toBe(3);
    expect(forecastTomorrowCount(jobs)).toBe(3);
    expect(forecastTomorrowCount(jobs)).toBe(dueReviewsMirror(jobs, TOMORROW).length);
  });

  it('非规范日键（正则匹配但越界，如 2026-13-99）不影响明柱对照', () => {
    // 越界日值经 Date 归一化进「以后」柱（dayKeyToTs 只拒正则不匹配），但索引精确
    // 匹配取不到该串——归一化结果不可能等于明日日键，明柱计数仍两口径相等。
    // （dueDate 由 localDayKey 产出恒为规范串，本例为防御性对照。）
    const jobs: ConsistencyJob[] = [job('a', TOMORROW), job('i', '2026-13-99')];
    expect(dueReviewsMirror(jobs, TOMORROW).length).toBe(1);
    expect(forecastTomorrowCount(jobs)).toBe(1);
  });

  it('多日批量对照：逾期/窗口日逐日相等；窗口外（≥+7）经「以后」柱合计相等', () => {
    const days = [-1, 0, 1, 2, 6, 7, 30].map((offset) => addDaysKey(TODAY, offset)!);
    const jobs: ConsistencyJob[] = days.flatMap((day, index) => [
      job(`j${index}-a`, day),
      job(`j${index}-b`, day, index % 2 === 0 ? 'pending' : 'done'),
    ]);
    jobs.push(job('dirty', 'not-a-date', 'pending'));
    const pendingJobs = jobs.filter((j) => j.status === 'pending'); // pendingJobs 前置过滤同上
    const bars = buildReviewForecast(pendingJobs, TODAY, 7);
    const dayBefore = addDaysKey(TODAY, -1)!;
    // 窗口内（逾期 + 今日..今日+6）：逐日对照（逾期日合并进「逾期」柱，本批仅一个逾期日）
    for (const day of days.slice(0, 5)) {
      const chipCount = dueReviewsMirror(jobs, day).length;
      const bar = day === dayBefore ? bars.find((b) => b.key === 'overdue') : bars.find((b) => b.key === day);
      expect(chipCount).toBeGreaterThan(0);
      expect(bar?.count ?? 0).toBe(chipCount);
    }
    // 窗口外（+7、+30）：两日 Chip 数之和 == 「以后」柱合计（多日合并无单一日键）
    const beyondSum = days.slice(5).reduce((acc, day) => acc + dueReviewsMirror(jobs, day).length, 0);
    const laterBar = bars.find((b) => b.key === 'later');
    expect(beyondSum).toBeGreaterThan(0);
    expect(laterBar?.count ?? 0).toBe(beyondSum);
    // 明日预告交叉指引文案要素：明柱 hover 标题含项数
    const tomorrowBar = bars.find((bar) => bar.key === TOMORROW)!;
    expect(forecastBarTitle(tomorrowBar)).toContain('项');
  });

  it('脏 dueDate 不进任何柱也不进 Chip（两口径同样跳过）', () => {
    const jobs: ConsistencyJob[] = [
      job('x', ''),
      job('y', '2026/11/22'),
      job('z', `${TOMORROW}T00:00:00`),
    ];
    expect(dueReviewsMirror(jobs, TOMORROW).length).toBe(0);
    const bars = buildReviewForecast(jobs, TODAY, 7);
    expect(bars.reduce((acc, bar) => acc + bar.count, 0)).toBe(0);
  });

  it('空数据两口径同为 0（Chip 不渲染的 0 项与预测空态一致）', () => {
    expect(dueReviewsMirror([], TOMORROW).length).toBe(0);
    expect(forecastTomorrowCount([])).toBe(0);
  });
});
