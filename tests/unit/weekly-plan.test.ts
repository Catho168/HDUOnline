/** 每周回看学习计划纯函数测试：构造（clamp / 去重 / 空输入）、日历切片、活跃判定与完看进度。 */

import { describe, expect, it } from 'vitest';
import {
  buildWeeklyPlan,
  isActiveWeeklyPlan,
  planDaySlice,
  weeklyPlanProgress,
  weeklyPlansToday,
  weeklyTodayBvids,
  weeklyTotalDays,
  type WeeklyPlan,
} from '@/core/plan/weekly';

const START = '2026-11-02'; // 计划起始日（第 1 天）
const NOW = new Date(`${START}T10:00:00`).getTime();

/** 本地日键 → 毫秒（与 shared/utils.dayKeyToTs 同口径，避免测试依赖时区） */
function dayKeyToTs(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0).getTime();
}

/** 相对某日键偏移 N 天的日键 */
function dayKey(offsetDays: number, from = START): string {
  const d = new Date(dayKeyToTs(from));
  d.setDate(d.getDate() + offsetDays);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** 5 个 bvid / 每天 2 个 → 共 3 天（第 3 天只有 1 个） */
function plan(overrides: Partial<WeeklyPlan> = {}): WeeklyPlan {
  return {
    id: 'plan-1',
    perDay: 2,
    bvids: ['BV1', 'BV2', 'BV3', 'BV4', 'BV5'],
    startDate: START,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/** 视频收藏（watchedRatio 存于 metadata；缺省未看过） */
function videoFav(id: string, watchedRatio?: number): Record<string, unknown> {
  return {
    id,
    type: 'video',
    refId: id,
    snapshot: { title: `视频 ${id}`, content: '' },
    tags: [],
    pinned: false,
    favoritedAt: NOW,
    updatedAt: NOW,
    metadata: {
      platform: 'bilibili',
      bvid: id,
      url: `https://www.bilibili.com/video/${id}`,
      ...(watchedRatio !== undefined ? { watchedRatio } : {}),
    },
  };
}

describe('buildWeeklyPlan（构造）', () => {
  it('perDay clamp 到 1–20；非法输入回退默认 2', () => {
    const build = (perDay: unknown) => buildWeeklyPlan({ bvids: ['BV1'], perDay, now: NOW });
    expect(build(0)?.perDay).toBe(1);
    expect(build(-3)?.perDay).toBe(1);
    expect(build(25)?.perDay).toBe(20);
    expect(build(2.6)?.perDay).toBe(3);
    expect(build(Number.NaN)?.perDay).toBe(2);
    expect(build('不是数字')?.perDay).toBe(2);
    expect(build(undefined)?.perDay).toBe(2);
  });

  it('bvids 去重保序，过滤非字符串与空串', () => {
    const result = buildWeeklyPlan({ bvids: ['BV2', 'BV1', 'BV2', '', null, 42, 'BV3'], perDay: 2, now: NOW });
    expect(result?.bvids).toEqual(['BV2', 'BV1', 'BV3']);
    expect(result?.perDay).toBe(2);
  });

  it('空 bvids / 全非法输入返回 null（不建空计划）', () => {
    expect(buildWeeklyPlan({ bvids: [], perDay: 2, now: NOW })).toBeNull();
    expect(buildWeeklyPlan({ bvids: ['', null, 42], perDay: 2, now: NOW })).toBeNull();
    expect(buildWeeklyPlan({ bvids: 'BV1' as never, perDay: 2, now: NOW })).toBeNull();
  });

  it('startDate 缺省用 now 当天；显式合法 startDate 保留', () => {
    expect(buildWeeklyPlan({ bvids: ['BV1'], perDay: 2, now: NOW })?.startDate).toBe(START);
    expect(buildWeeklyPlan({ bvids: ['BV1'], perDay: 2, startDate: '2026-12-01', now: NOW })?.startDate).toBe('2026-12-01');
    // 非法 startDate 回退到 now 当天
    expect(buildWeeklyPlan({ bvids: ['BV1'], perDay: 2, startDate: '明天', now: NOW })?.startDate).toBe(START);
  });

  it('label 可选：缺省不带 label 字段；非字符串忽略；id 由 uuid 生成、时间戳取 now', () => {
    const plain = buildWeeklyPlan({ bvids: ['BV1'], perDay: 2, now: NOW });
    expect(plain?.label).toBeUndefined();
    expect(plain?.createdAt).toBe(NOW);
    expect(plain?.updatedAt).toBe(NOW);
    expect(typeof plain?.id).toBe('string');
    expect((plain?.id ?? '').length).toBeGreaterThan(0);
    const labeled = buildWeeklyPlan({ bvids: ['BV1'], perDay: 2, label: '我的收藏夹', now: NOW });
    expect(labeled?.label).toBe('我的收藏夹');
    expect(buildWeeklyPlan({ bvids: ['BV1'], perDay: 2, label: 42, now: NOW })?.label).toBeUndefined();
  });
});

describe('weeklyTotalDays / planDaySlice（日历切片）', () => {
  it('总天数向上取整：5 个 / 每天 2 个 = 3 天；空计划为 0 天', () => {
    expect(weeklyTotalDays(plan())).toBe(3);
    expect(weeklyTotalDays(plan({ bvids: [] }))).toBe(0);
    expect(weeklyTotalDays({ bvids: ['BV1', 'BV2', 'BV3'], perDay: 2 })).toBe(2);
  });

  it('起点（第 1 天）：dayIndex 0，取前 perDay 个', () => {
    expect(planDaySlice(plan(), START)).toEqual({ dayIndex: 0, totalDays: 3, bvids: ['BV1', 'BV2'] });
  });

  it('中途：按日历天数差取对应批次', () => {
    expect(planDaySlice(plan(), dayKey(2))).toEqual({ dayIndex: 2, totalDays: 3, bvids: ['BV5'] });
    expect(planDaySlice(plan(), dayKey(1))).toEqual({ dayIndex: 1, totalDays: 3, bvids: ['BV3', 'BV4'] });
  });

  it('Date 输入与日键字符串等价', () => {
    expect(planDaySlice(plan(), new Date(dayKeyToTs(dayKey(1)) + 13 * 3600_000))).toEqual({
      dayIndex: 1,
      totalDays: 3,
      bvids: ['BV3', 'BV4'],
    });
  });

  it('早于 startDate：空批次，dayIndex 为负', () => {
    const slice = planDaySlice(plan(), dayKey(-2));
    expect(slice.bvids).toEqual([]);
    expect(slice.dayIndex).toBeLessThan(0);
    expect(slice.totalDays).toBe(3);
  });

  it('超过总天数：空批次且 dayIndex = totalDays', () => {
    expect(planDaySlice(plan(), dayKey(3))).toEqual({ dayIndex: 3, totalDays: 3, bvids: [] });
    expect(planDaySlice(plan(), dayKey(30)).dayIndex).toBe(3);
  });

  it('脏数据不抛错：非法 dayKey 给空批次；非法 startDate 回退按创建日切片', () => {
    expect(planDaySlice(plan(), '不是日期').bvids).toEqual([]);
    // startDate 非法时回退到 createdAt 当天（兜底而非永久空计划）
    expect(planDaySlice(plan({ startDate: '垃圾' }), START)).toEqual({ dayIndex: 0, totalDays: 3, bvids: ['BV1', 'BV2'] });
    // 回退基准 = createdAt：创建日在 3 天前 → 今日已走完
    const oldPlan = plan({ startDate: '垃圾', createdAt: dayKeyToTs(dayKey(-3)) });
    expect(planDaySlice(oldPlan, START)).toEqual({ dayIndex: 3, totalDays: 3, bvids: [] });
    expect(planDaySlice(plan({ bvids: '垃圾' as never }), START)).toEqual({ dayIndex: 0, totalDays: 0, bvids: [] });
  });
});

describe('isActiveWeeklyPlan / weeklyPlansToday / weeklyTodayBvids（活跃与批次并集）', () => {
  it('活跃 = dayIndex < totalDays：区间内与未开始的未来计划活跃，走完不活跃', () => {
    expect(isActiveWeeklyPlan(plan(), dayKey(2))).toBe(true);
    // 未开始（dayIndex 为负）也算活跃
    expect(isActiveWeeklyPlan(plan(), dayKey(-1))).toBe(true);
    expect(isActiveWeeklyPlan(plan(), dayKey(3))).toBe(false);
  });

  it('weeklyPlansToday 只保留「今日在计划区间内」的计划（排除未开始与已走完）', () => {
    const active = weeklyPlansToday([plan({ id: 'a' }), plan({ id: 'future', startDate: dayKey(2) }), plan({ id: 'expired', startDate: dayKey(-5) })], START);
    expect(active.map((p) => p.id)).toEqual(['a']);
  });

  it('weeklyTodayBvids 取各计划今日批次的并集（保序去重）', () => {
    const bvids = weeklyTodayBvids([plan({ bvids: ['BV1', 'BV2', 'BV3'] }), plan({ bvids: ['BV2', 'BV9'] })], START);
    expect(bvids).toEqual(['BV1', 'BV2', 'BV9']);
    // 未开始 / 已走完的计划贡献空批次
    expect(weeklyTodayBvids([plan({ startDate: dayKey(5) }), plan({ startDate: dayKey(-9) })], START)).toEqual([]);
  });
});

describe('weeklyPlanProgress（完看进度）', () => {
  it('完看口径 ≥0.95：0.95 算完成、0.94 不算', () => {
    const progress = weeklyPlanProgress(plan({ bvids: ['BV1', 'BV2', 'BV3', 'BV4', 'BV5'] }), [
      videoFav('BV1', 0.95),
      videoFav('BV2', 0.9499),
      videoFav('BV3', 1),
    ]);
    expect(progress).toEqual({ total: 5, finished: 2, ratio: 0.4 });
  });

  it('收藏缺失 / 未看过不计完成；refId 回退；ratio 在 total=0 时为 0', () => {
    // 计划里的 BV4/BV5 没有对应收藏
    const progress = weeklyPlanProgress(plan({ bvids: ['BV1', 'BV4'] }), [videoFav('BV1', 0.97)]);
    expect(progress).toEqual({ total: 2, finished: 1, ratio: 0.5 });
    // 收藏没有 metadata.watchedRatio：视为未看完
    const noMeta = weeklyPlanProgress({ bvids: ['BV1'] }, [
      { id: 'x', type: 'video', refId: 'BV1', snapshot: { title: 't', content: '' }, tags: [], pinned: false, favoritedAt: 0 },
    ]);
    expect(noMeta).toEqual({ total: 1, finished: 0, ratio: 0 });
    // 空计划
    expect(weeklyPlanProgress({ bvids: [] }, [videoFav('BV1', 1)])).toEqual({ total: 0, finished: 0, ratio: 0 });
  });

  it('favorites 里的脏条目（null / 数字 / 非 video）不抛错，按缺失处理', () => {
    const progress = weeklyPlanProgress({ bvids: ['BV1'] }, [null, 42, '垃圾', videoFav('BV1', 0.96)]);
    expect(progress).toEqual({ total: 1, finished: 1, ratio: 1 });
  });
});
