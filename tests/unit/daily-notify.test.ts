/** 每日待办提醒：通知内容纯函数 + 与 buildTodayPlan 的计数口径一致性。 */

import { describe, expect, it } from 'vitest';
import {
  buildAchievementRecapLine,
  buildCoverageLine,
  buildDailyTodoNotification,
  buildStaleTagLine,
  buildWeeklyRecapLine,
  countTodayTodos,
  dailyTodoNotificationId,
  type DailyTodoCounts,
} from '@/core/plan/notify';
import { buildTodayPlan, type TodayPlanInput } from '@/core/plan/today';
import type { FavoriteEntity, ReviewJobEntity } from '@/core/shared/types';
import type { MissedItem } from '@/core/shared/ops';
import { DEFAULT_SETTINGS } from '@/core/shared/constants';

const TODAY = '2026-11-14';
const NOW = new Date('2026-11-14T19:00:00').getTime();

function reviewJob(id: string, dueDate = TODAY): ReviewJobEntity & { favorite: FavoriteEntity | null } {
  return {
    id,
    favoriteId: `fav-${id}`,
    dueDate,
    round: 1,
    template: 'regular',
    status: 'pending',
    createdAt: NOW,
    updatedAt: NOW,
    favorite: {
      id: `fav-${id}`,
      type: 'time',
      refId: `ref-${id}`,
      snapshot: { title: `卡片 ${id}`, content: '内容' },
      tags: [],
      pinned: false,
      favoritedAt: NOW,
      updatedAt: NOW,
    },
  };
}

function missedItem(courId: number, overrides: Partial<MissedItem> = {}): MissedItem {
  return {
    courId,
    teclId: 9001,
    courseName: `课程 ${courId}`,
    courLabel: `第5周 / 2026-11-10 / 第${courId}节课`,
    beginTime: NOW - 48 * 3600 * 1000,
    watchedSec: 0,
    watchRatio: 0,
    excluded: false,
    ...overrides,
  };
}

function videoFavorite(id: string, metadata: Record<string, unknown> = {}, deletedAt?: number): FavoriteEntity {
  return {
    id,
    type: 'video',
    refId: `BV-${id}`,
    snapshot: { title: `视频 ${id}`, content: '' },
    tags: [],
    pinned: false,
    favoritedAt: NOW,
    updatedAt: NOW,
    ...(deletedAt != null ? { deletedAt } : {}),
    metadata: { bvid: `BV-${id}`, url: `https://www.bilibili.com/video/BV-${id}`, ...metadata },
  };
}

function planInput(overrides: Partial<TodayPlanInput> = {}): TodayPlanInput {
  return {
    dueReviews: [],
    missedSessions: [],
    videoFavorites: [],
    doneKeys: [],
    today: TODAY,
    ...overrides,
  };
}

describe('buildDailyTodoNotification（通知内容纯函数）', () => {
  it('0 项不发：返回 null', () => {
    expect(buildDailyTodoNotification({ review: 0, missed: 0, video: 0 })).toBeNull();
  });

  it('脏计数（NaN / 负数 / 缺字段）按 0 处理，全为 0 时不发', () => {
    expect(buildDailyTodoNotification({ review: Number.NaN, missed: -3, video: 0 })).toBeNull();
    expect(buildDailyTodoNotification(null)).toBeNull();
    expect(buildDailyTodoNotification(undefined)).toBeNull();
    expect(buildDailyTodoNotification({} as never)).toBeNull();
  });

  it('部分分区：空分区不输出', () => {
    expect(buildDailyTodoNotification({ review: 2, missed: 0, video: 1 })).toEqual({
      title: '今日待办',
      message: '复习 2 · 待学视频 1，共 3 项',
    });
    expect(buildDailyTodoNotification({ review: 0, missed: 5, video: 0 })).toEqual({
      title: '今日待办',
      message: '补看 5，共 5 项',
    });
  });

  it('全分区：复习 x · 补看 y · 待学视频 z，共 N 项', () => {
    expect(buildDailyTodoNotification({ review: 1, missed: 2, video: 3 })).toEqual({
      title: '今日待办',
      message: '复习 1 · 补看 2 · 待学视频 3，共 6 项',
    });
  });

  it('大数：照常拼接，不截断不抛错', () => {
    expect(buildDailyTodoNotification({ review: 12345, missed: 0, video: 0 })).toEqual({
      title: '今日待办',
      message: '复习 12345，共 12345 项',
    });
    expect(buildDailyTodoNotification({ review: 999, missed: 8888, video: 77777 })?.message).toBe(
      '复习 999 · 补看 8888 · 待学视频 77777，共 87664 项',
    );
  });

  it('通知 id 按本地日去重', () => {
    expect(dailyTodoNotificationId('2026-11-14')).toBe('hdu-alarm-daily-todo-2026-11-14');
  });
});

describe('buildCoverageLine（标签覆盖率提醒，第 152 轮）', () => {
  it('设了目标且未达标：返回提醒句', () => {
    expect(buildCoverageLine(6, 10, 80)).toBe('标签覆盖率 60%（6/10），低于目标 80%——去知识库给收藏补打标签');
  });
  it('已达标 / 未设目标 / 无收藏 / 脏输入：null（不追加）', () => {
    expect(buildCoverageLine(9, 10, 80)).toBeNull();
    expect(buildCoverageLine(8, 10, 80)).toBeNull();
    expect(buildCoverageLine(6, 10, 0)).toBeNull();
    expect(buildCoverageLine(6, 0, 80)).toBeNull();
    expect(buildCoverageLine(Number.NaN, 10, 80)).toBeNull();
    expect(buildCoverageLine(6, 10, 150)).toBeNull();
  });
  it('coverageLine 非空时追加进通知消息末行', () => {
    const n = buildDailyTodoNotification({ review: 1, missed: 0, video: 0 }, { coverageLine: '标签覆盖率 60%（6/10），低于目标 80%' });
    expect(n?.message).toBe('复习 1，共 1 项\n标签覆盖率 60%（6/10），低于目标 80%');
  });
  it('coverageLine 为空 / 未传：消息不变', () => {
    expect(buildDailyTodoNotification({ review: 1, missed: 0, video: 0 })?.message).toBe('复习 1，共 1 项');
    expect(buildDailyTodoNotification({ review: 1, missed: 0, video: 0 }, { coverageLine: null })?.message).toBe('复习 1，共 1 项');
  });
});

describe('buildStaleTagLine（标签健康度点名，第 158 轮；第 179 轮附最近完成日期）', () => {
  const tsOf = (day: string): number => Date.parse(`${day}T12:00:00`);
  const lastDone = new Map([
    ['高数', tsOf('2026-11-10')],
    ['线代', tsOf('2026-11-05')],
    ['英语', tsOf('2026-11-15')],
  ]);
  it('无零完成标签：null', () => {
    expect(buildStaleTagLine([], lastDone)).toBeNull();
    expect(buildStaleTagLine(null, lastDone)).toBeNull();
    expect(buildStaleTagLine(['', 42 as never], lastDone)).toBeNull();
  });
  it('≤2 个：直接点名并附最近完成日期', () => {
    expect(buildStaleTagLine(['高数', '线代'], lastDone)).toBe(
      '有 2 个标签近 28 天零完成：线代（上次完成 11/05）、高数（上次完成 11/10）',
    );
    expect(buildStaleTagLine(['高数'], lastDone)).toBe('有 1 个标签近 28 天零完成：高数（上次完成 11/10）');
  });
  it('>2 个：按最近完成最早（无记录视为最久）点名前 2 个', () => {
    expect(buildStaleTagLine(['英语', '高数', '线代', '物理'], lastDone)).toBe(
      '有 4 个标签近 28 天零完成（最久：物理（从未完成）、线代（上次完成 11/05））',
    );
  });
  it('≥10 个：点名自适应扩到 3 个（第 160 轮）', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    // a/b/c 无最近完成记录（视为最久）且字典序最前 → 点名 a、b、c
    expect(buildStaleTagLine(many, lastDone)).toBe(
      '有 10 个标签近 28 天零完成（最久：a（从未完成）、b（从未完成）、c（从未完成））',
    );
  });
  it('窗口天数随设置（第 178 轮）：7 天窗口文案同步', () => {
    expect(buildStaleTagLine(['高数'], lastDone, 7)).toBe('有 1 个标签近 7 天零完成：高数（上次完成 11/10）');
  });
  it('extras 超 3 行折叠保护（第 162 轮）：保留前 2 行 + 汇总行', () => {
    const n = buildDailyTodoNotification({ review: 1, missed: 0, video: 0 }, {
      weeklyRecapLine: '上周：站内 1.0 小时',
      achievementLine: '昨日新解锁成就：养成习惯',
      staleTagLine: '有 1 个标签近 4 周零完成：高数',
      coverageLine: '标签覆盖率 60%（6/10），低于目标 80%',
    });
    expect(n?.message).toBe(
      '复习 1，共 1 项\n上周：站内 1.0 小时\n昨日新解锁成就：养成习惯\n另有 2 项提醒，点击通知直达学习看板',
    );
  });
  it('extras 恰 3 行不折叠（第 162 轮）', () => {
    const n = buildDailyTodoNotification({ review: 1, missed: 0, video: 0 }, {
      weeklyRecapLine: '上周：站内 1.0 小时',
      achievementLine: '昨日新解锁成就：养成习惯',
      staleTagLine: '有 1 个标签近 4 周零完成：高数',
    });
    expect(n?.message.split('\n').length).toBe(4);
    expect(n?.message).not.toContain('另有');
  });
});

describe('countTodayTodos 与 buildTodayPlan 口径一致性', () => {
  const input = planInput({
    // 2 条到期复习（其中 1 条已过期，同样计入今日待办）
    dueReviews: [reviewJob('r1'), reviewJob('r2', '2026-11-12')],
    // 2 条补看候选：1 条被用户标记「已到课」（剔除），1 条正常计入
    missedSessions: [missedItem(101, { excluded: true }), missedItem(102)],
    // 3 个视频收藏：已看完（≥0.95）剔除、已删除剔除、正常计入
    videoFavorites: [
      videoFavorite('v1', { watchedRatio: 0.97 }),
      videoFavorite('v2', {}, NOW - 1000),
      videoFavorite('v3'),
    ],
  });

  it('三分区计数 = buildTodayPlan 各分区条目数', () => {
    const counts = countTodayTodos(input);
    const plan = buildTodayPlan(input);
    const byKind = new Map(plan.sections.map((section) => [section.kind, section.items.length] as const));
    expect(counts).toEqual({
      review: byKind.get('review') ?? 0,
      missed: byKind.get('missed') ?? 0,
      video: byKind.get('video') ?? 0,
    });
  });

  it('过滤规则与看板一致：excluded 课次 / 已看完与已删视频不计入', () => {
    const counts = countTodayTodos(input);
    expect(counts).toEqual({ review: 2, missed: 1, video: 1 });
    expect(counts.review + counts.missed + counts.video).toBe(buildTodayPlan(input).totalCount);
  });

  it('空输入：0 项，通知不发', () => {
    expect(countTodayTodos(planInput())).toEqual({ review: 0, missed: 0, video: 0 });
    expect(buildDailyTodoNotification(countTodayTodos(planInput()))).toBeNull();
  });

  it('端到端：同一输入下通知文案的计数与看板 totalCount 一致', () => {
    const notification = buildDailyTodoNotification(countTodayTodos(input));
    expect(notification?.message).toBe('复习 2 · 补看 1 · 待学视频 1，共 4 项');
    expect(buildTodayPlan(input).totalCount).toBe(4);
  });

  it('weekly 输入（weeklyBvids）不改三分区计数与总数', () => {
    const base = planInput({
      dueReviews: [reviewJob('r1')],
      missedSessions: [missedItem(101)],
      videoFavorites: [videoFavorite('v1', { watchedRatio: 0.97 }), videoFavorite('v2'), videoFavorite('v3')],
    });
    // 命中每周计划的条目只影响排序与 dueLabel 前缀，不改变条目集合
    const withWeekly: TodayPlanInput = { ...base, weeklyBvids: ['BV-v2', 'BV-v3'] };
    expect(countTodayTodos(withWeekly)).toEqual(countTodayTodos(base));
    expect(buildTodayPlan(withWeekly).totalCount).toBe(buildTodayPlan(base).totalCount);
    // 分区计数仍与看板各分区条目数一致
    const plan = buildTodayPlan(withWeekly);
    const byKind = new Map(plan.sections.map((section) => [section.kind, section.items.length] as const));
    expect(countTodayTodos(withWeekly)).toEqual({
      review: byKind.get('review') ?? 0,
      missed: byKind.get('missed') ?? 0,
      video: byKind.get('video') ?? 0,
    });
  });
});

describe('buildWeeklyRecapLine 与上周回顾追加（第 13 轮任务 B）', () => {
  const counts: DailyTodoCounts = { review: 2, missed: 0, video: 1 };
  const recapData = { internalSec: 9000, externalSec: 5400, plan: { ratio: 0.6 } };

  it('有上周数据：回顾句含站内外时长与计划完成度，追加在主文案末行', () => {
    expect(buildWeeklyRecapLine(recapData)).toBe('上周：站内 2.5 小时 + 站外 1.5 小时，计划完成 60%');
    expect(buildDailyTodoNotification(counts, { weeklyRecapLine: buildWeeklyRecapLine(recapData) })).toEqual({
      title: '今日待办',
      message: '复习 2 · 待学视频 1，共 3 项\n上周：站内 2.5 小时 + 站外 1.5 小时，计划完成 60%',
    });
  });

  it('无计划排期（plan=null）不显示计划项；ratio 四舍五入为整数百分比；脏秒数按 0 计', () => {
    expect(buildWeeklyRecapLine({ internalSec: 9000, externalSec: 5400, plan: null })).toBe(
      '上周：站内 2.5 小时 + 站外 1.5 小时',
    );
    expect(buildWeeklyRecapLine({ internalSec: 0, externalSec: 0, plan: { ratio: 0.677 } })).toBe(
      '上周：站内 0.0 小时 + 站外 0.0 小时，计划完成 68%',
    );
    // 负数 / NaN 秒数按 0 处理；非有限 ratio 不显示计划项
    expect(buildWeeklyRecapLine({ internalSec: -100, externalSec: Number.NaN, plan: { ratio: Number.NaN } })).toBe(
      '上周：站内 0.0 小时 + 站外 0.0 小时',
    );
  });

  it('无数据降级：回顾句为 null，主文案不变（提醒照发）', () => {
    expect(buildWeeklyRecapLine(null)).toBeNull();
    expect(buildWeeklyRecapLine(undefined)).toBeNull();
    expect(buildWeeklyRecapLine('脏输入' as never)).toBeNull();
    const base = buildDailyTodoNotification(counts);
    expect(base?.message).not.toContain('上周');
    expect(buildDailyTodoNotification(counts, { weeklyRecapLine: null })).toEqual(base);
    expect(buildDailyTodoNotification(counts, { weeklyRecapLine: buildWeeklyRecapLine(null) })).toEqual(base);
    // 空字符串回顾句同样不追加
    expect(buildDailyTodoNotification(counts, { weeklyRecapLine: '' })).toEqual(base);
  });

  it('开关关闭（todo.weeklyRecap，默认开）不含回顾句：守卫口径与 alarms.ts 一致', () => {
    const on = DEFAULT_SETTINGS;
    const off = { ...DEFAULT_SETTINGS, todo: { ...DEFAULT_SETTINGS.todo, weeklyRecap: false } };
    // 守卫为「显式 false 才关闭」：默认值 / 旧存量设置经 deepMerge 补默认 true 后不关闭
    expect(on.todo.weeklyRecap !== false).toBe(true);
    expect(off.todo.weeklyRecap !== false).toBe(false);
    const recapOn = on.todo.weeklyRecap !== false ? buildWeeklyRecapLine(recapData) : null;
    const recapOff = off.todo.weeklyRecap !== false ? buildWeeklyRecapLine(recapData) : null;
    expect(recapOff).toBeNull();
    expect(buildDailyTodoNotification(counts, { weeklyRecapLine: recapOn })?.message).toContain('上周：');
    expect(buildDailyTodoNotification(counts, { weeklyRecapLine: recapOff })?.message).not.toContain('上周');
  });
});

describe('buildAchievementRecapLine（昨日新解锁成就，第 136 轮）', () => {
  const ts = (day: string) => new Date(`${day}T12:00:00`).getTime();
  it('昨天解锁的徽章 → 一句汇总；今天/更早的不算', () => {
    const line = buildAchievementRecapLine(
      { 'streak-3': ts('2026-11-13'), 'min-30': ts('2026-11-14'), 'fav-10': ts('2026-11-10') },
      NOW,
    );
    expect(line).toBe('昨日新解锁成就：养成习惯');
  });
  it('无昨日解锁 / 脏输入 → null', () => {
    expect(buildAchievementRecapLine(null, NOW)).toBeNull();
    expect(buildAchievementRecapLine({ 'streak-3': ts('2026-11-14') }, NOW)).toBeNull();
    expect(buildAchievementRecapLine({ bad: 'x' as never }, NOW)).toBeNull();
  });
  it('通知消息追加成就行', () => {
    const n = buildDailyTodoNotification({ review: 1, missed: 0, video: 0 }, { achievementLine: '昨日新解锁成就：养成习惯' });
    expect(n?.message).toContain('昨日新解锁成就：养成习惯');
  });
});

describe('buildAchievementRecapLine 自定义徽章（第 140 轮）', () => {
  const ts = (day: string) => new Date(`${day}T12:00:00`).getTime();
  it('自定义徽章昨日解锁也进回顾句', () => {
    const line = buildAchievementRecapLine(
      { 'custom-c1': ts('2026-11-13') },
      NOW,
      [{ id: 'c1', name: '百题斩', metric: 'reviewDone', threshold: 10 }],
    );
    expect(line).toBe('昨日新解锁成就：百题斩');
  });
});
