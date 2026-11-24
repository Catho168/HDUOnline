/**
 * 学习里程碑回放 deriveMilestones（core/stats/milestones.ts，第 235 轮巡检）单测。
 *
 * 覆盖：
 *  1. 累计跨越：1h 首跨记一条、单日跨两档同日各记一条、恰等档位算跨越（≥ 语义）、
 *     已跨档位不重复、空日子（sec=0）不触发；
 *  2. 连续新高：刷新个人最长且 ≥3 天才记（2 天不记）、同段内逐日刷新逐日记、
 *     断档后重开需超越旧纪录才再记；
 *  3. 单日新高：≥30 分钟才记（29 分钟不记且不阻塞后续新高判定）、并列不记；
 *  4. 首次打卡：恰等打卡线算（≥ 语义，与 hitDaysThisWeek 同线）、仅记一次；
 *  5. 同日多事件：四类事件同日并存，输出顺序 = 累计 → 连续 → 单日 → 打卡；
 *  6. 截断：limit 取最近 N 条（保持升序）、total 保留全量计数、默认 12 条；
 *  7. 脏数据防御：非数组 / 非对象行 / 非法 date（含 2026-02-30 形似键）/ 非法
 *     validSec 逐条跳过；日期乱序自动归并升序回放、同日重复行求和。
 *
 * 注：四类事件共享同一份回放数据，多数用例传 NO_CHECKIN（打卡线上调到 24h）
 * 以隔离首次打卡事件，或按 kind 过滤断言——预期均按全量回放手工核算。
 */
import { describe, expect, it } from 'vitest';

import { CHECKIN_MIN_SEC } from '@/core/stats/aggregate';
import { deriveMilestones, MILESTONE_TOTAL_THRESHOLDS_SEC } from '@/core/stats/milestones';

/** 报表行构造器（date + validSec，与 DailyStat 的字段口径一致） */
const DAYS = (rows: Array<[string, number]>) => rows.map(([date, validSec]) => ({ date, validSec }));

const H = 3600;
/** 隔离「首次打卡」事件用：打卡线调到 24h（当日 ≤24h 学习永不触发） */
const NO_CHECKIN = { checkinMinSec: 24 * H };

describe('deriveMilestones 累计跨越（第 235 轮）', () => {
  it('首次跨越 1h 记一条，detail 写当日累计（非相邻日避免连续新高噪声）', () => {
    const { items, total } = deriveMilestones(
      DAYS([
        ['2026-11-01', 20 * 60],
        ['2026-11-05', 20 * 60],
        ['2026-11-09', 21 * 60], // 累计 61 分钟，跨 1h
      ]),
      NO_CHECKIN,
    );
    expect(total).toBe(1);
    expect(items[0]).toMatchObject({ date: '2026-11-09', kind: 'cumulative', title: '累计学习 1 小时', detail: '当日累计 1 小时 1 分' });
  });

  it('恰等档位算跨越（≥ 语义）', () => {
    const { items, total } = deriveMilestones(DAYS([['2026-11-01', H]]), NO_CHECKIN);
    // 当日同时是单日新高（1h ≥ 30 分钟）
    expect(total).toBe(2);
    expect(items.filter((m) => m.kind === 'cumulative')[0]).toMatchObject({ kind: 'cumulative', detail: '当日累计 1 小时' });
  });

  it('单日跨两档同日各记一条（升序）；空日子（sec=0）不触发', () => {
    const { items, total } = deriveMilestones(
      DAYS([
        ['2026-11-01', 4.9 * H],
        ['2026-11-02', 6.2 * H], // 累计 11h6m：跨 5h 与 10h 两档
        ['2026-11-03', 0],
      ]),
      NO_CHECKIN,
    );
    const cumulative = items.filter((m) => m.kind === 'cumulative');
    // 11-01 已跨 1h 档；11-02 当日跨 5h 与 10h 两档（升序）
    expect(cumulative.map((m) => m.date)).toEqual(['2026-11-01', '2026-11-02', '2026-11-02']);
    expect(cumulative[1]!.title).toBe('累计学习 5 小时');
    expect(cumulative[2]!.title).toBe('累计学习 10 小时');
    // 全量 = 累计 3 条 + 单日新高 2 条（4.9h 与 6.2h）；空日子 0 条
    expect(total).toBe(5);
  });

  it('已跨越档位不再重复记录（仅「首次」跨越）', () => {
    const { items } = deriveMilestones(
      DAYS([
        ['2026-11-01', H],
        ['2026-11-02', H],
        ['2026-11-03', H],
      ]),
      NO_CHECKIN,
    );
    expect(items.filter((m) => m.kind === 'cumulative')).toHaveLength(1);
  });
});

describe('deriveMilestones 连续新高（第 235 轮）', () => {
  it('连续 ≥3 天才记：2 天不记，第 3 天记一条', () => {
    const { items, total } = deriveMilestones(
      DAYS([
        ['2026-11-01', 300],
        ['2026-11-02', 300],
        ['2026-11-03', 300],
      ]),
      NO_CHECKIN,
    );
    expect(total).toBe(1);
    expect(items[0]).toMatchObject({ date: '2026-11-03', kind: 'streak', title: '连续学习新高', detail: '连续 3 天' });
  });

  it('段内逐日刷新逐日记：4 天连续记 3 天与 4 天两条', () => {
    const { items, total } = deriveMilestones(
      DAYS([
        ['2026-11-01', 300],
        ['2026-11-02', 300],
        ['2026-11-03', 300],
        ['2026-11-04', 300],
      ]),
      NO_CHECKIN,
    );
    expect(total).toBe(2);
    const streaks = items.filter((m) => m.kind === 'streak');
    expect(streaks.map((m) => m.detail)).toEqual(['连续 3 天', '连续 4 天']);
  });

  it('断档后重开需超越旧纪录才再记', () => {
    const { items, total } = deriveMilestones(
      DAYS([
        ['2026-11-01', 300],
        ['2026-11-02', 300],
        ['2026-11-03', 300],
        ['2026-11-05', 300], // 断档重开：1 天
        ['2026-11-06', 300],
        ['2026-11-07', 300], // 追平 3 天：不记（未刷新纪录）
        ['2026-11-08', 300], // 4 天：刷新纪录，记一条
      ]),
      NO_CHECKIN,
    );
    expect(total).toBe(2);
    const streaks = items.filter((m) => m.kind === 'streak');
    expect(streaks.map((m) => m.detail)).toEqual(['连续 3 天', '连续 4 天']);
    expect(streaks[1]!.date).toBe('2026-11-08');
  });
});

describe('deriveMilestones 单日新高与首次打卡（第 235 轮）', () => {
  it('单日新高 ≥30 分钟才记：29 分钟不记且不阻塞后续新高判定', () => {
    const { items } = deriveMilestones(
      DAYS([
        ['2026-11-01', 29 * 60], // 新高但 <30 分钟：不记
        ['2026-11-02', 31 * 60], // 超过 29 分钟历史且 ≥30 分钟：记
      ]),
      NO_CHECKIN,
    );
    // 当日另有累计跨 1h 档（29+31=60 分钟恰跨越）
    const dailies = items.filter((m) => m.kind === 'daily');
    expect(dailies).toHaveLength(1);
    expect(dailies[0]).toMatchObject({ date: '2026-11-02', kind: 'daily', title: '单日学习新高', detail: '单日 31 分钟' });
  });

  it('单日并列历史最高不记（严格 > 才刷新）', () => {
    const { items } = deriveMilestones(
      DAYS([
        ['2026-11-01', 45 * 60],
        ['2026-11-05', 45 * 60],
      ]),
      NO_CHECKIN,
    );
    expect(items.filter((m) => m.kind === 'daily')).toHaveLength(1);
  });

  it('首次打卡：恰等打卡线算（≥ 语义），全期仅记一次', () => {
    const { items } = deriveMilestones(
      DAYS([
        ['2026-11-01', CHECKIN_MIN_SEC - 1],
        ['2026-11-02', CHECKIN_MIN_SEC],
        ['2026-11-03', 5 * H],
      ]),
    );
    const checkins = items.filter((m) => m.kind === 'checkin');
    expect(checkins).toHaveLength(1);
    expect(checkins[0]).toMatchObject({ date: '2026-11-02', title: '首次打卡', detail: '当日有效 10 分钟' });
  });

  it('同日多事件：单日四类并存时顺序 = 累计 → 连续 → 单日 → 打卡', () => {
    const { items } = deriveMilestones(DAYS([['2026-11-01', 2 * H]]));
    expect(items.map((m) => m.kind)).toEqual(['cumulative', 'daily', 'checkin']);
    expect(items.map((m) => m.title)).toEqual(['累计学习 1 小时', '单日学习新高', '首次打卡']);
  });
});

describe('deriveMilestones 截断与脏数据防御（第 235 轮）', () => {
  it('limit 取最近 N 条（保持升序），total 保留全量计数；默认 12 条', () => {
    // 20 个连续学习日（每日 10 分钟）：全量 = 首次打卡(day1) + 累计 1h(day6) + 连续新高 18 条(day3..20) = 20 条
    const rows = Array.from({ length: 20 }, (_, i) => [`2026-11-${String(i + 1).padStart(2, '0')}`, 600] as [string, number]);
    const all = deriveMilestones(DAYS(rows), { limit: 100 });
    expect(all.total).toBe(20);
    const twelve = deriveMilestones(DAYS(rows));
    expect(twelve.items).toHaveLength(12);
    expect(twelve.total).toBe(20);
    // 全量第 9 条起：连续 9 天 → 连续 20 天
    expect(twelve.items[0]!.detail).toBe('连续 9 天');
    expect(twelve.items[twelve.items.length - 1]!.detail).toBe('连续 20 天');
    const last = deriveMilestones(DAYS(rows), { limit: 3 });
    expect(last.items.map((m) => m.detail)).toEqual(['连续 18 天', '连续 19 天', '连续 20 天']);
    // 档位常量健全性：首档 = 1h
    expect(MILESTONE_TOTAL_THRESHOLDS_SEC[0]).toBe(H);
  });

  it('脏数据逐条跳过：非数组 / 非对象 / 非法 date / 非法 validSec', () => {
    const { items, total } = deriveMilestones([
      null as unknown as { date: string; validSec: number },
      'junk' as unknown as { date: string; validSec: number },
      { date: '20261105', validSec: 600 },
      { date: '2026-11-05', validSec: '600' },
      { date: '2026-11-05', validSec: -5 },
      { date: '2026-02-30', validSec: 2 * H }, // 形似日键但不存在的日期
      { date: '2026-13-05', validSec: 2 * H },
      { date: '2026-11-05', validSec: 2 * H },
    ]);
    // 唯一有效行 11-05（2h）：累计 1h + 单日新高 + 首次打卡 = 3 条
    expect(total).toBe(3);
    expect(items.map((m) => `${m.date}:${m.kind}`)).toEqual([
      '2026-11-05:cumulative',
      '2026-11-05:daily',
      '2026-11-05:checkin',
    ]);
  });

  it('日期乱序自动归并升序回放；同日重复行求和', () => {
    const { items, total } = deriveMilestones(
      DAYS([
        ['2026-11-03', 20 * 60],
        ['2026-11-01', 20 * 60],
        ['2026-11-01', 15 * 60], // 同日重复行：与上行求和 = 35 分钟
        ['2026-11-02', 20 * 60],
      ]),
    );
    // 归并后 11-01=35m、11-02=20m、11-03=20m：
    // 11-01 单日新高(35m)+首次打卡；11-02 累计 75 分钟跨 1h；11-03 连续 3 天新高
    expect(total).toBe(4);
    expect(items.map((m) => `${m.date}:${m.kind}`)).toEqual([
      '2026-11-01:daily',
      '2026-11-01:checkin',
      '2026-11-03:cumulative',
      '2026-11-03:streak',
    ]);
  });

  it('空数据 / 全无效数据回退空结果（不抛错）', () => {
    expect(deriveMilestones([])).toEqual({ items: [], total: 0 });
    expect(deriveMilestones(null as unknown as Array<{ date: string; validSec: number }>)).toEqual({ items: [], total: 0 });
    expect(deriveMilestones(undefined as unknown as Array<{ date: string; validSec: number }>)).toEqual({ items: [], total: 0 });
    expect(deriveMilestones(DAYS([['2026-11-01', 0]]))).toEqual({ items: [], total: 0 });
  });

  it('limit 非法回退默认 12；checkinMinSec 可参数化', () => {
    const rows = DAYS([['2026-11-01', 600]]);
    // 打卡线 5 分钟：600 秒恰达标 → 首次打卡
    const custom = deriveMilestones(rows, { limit: -1, checkinMinSec: 5 * 60 });
    expect(custom.items.some((m) => m.kind === 'checkin')).toBe(true);
    // 打卡线 20 分钟：不触发打卡
    const strict = deriveMilestones(rows, { checkinMinSec: 20 * 60 });
    expect(strict.items.some((m) => m.kind === 'checkin')).toBe(false);
  });
});
