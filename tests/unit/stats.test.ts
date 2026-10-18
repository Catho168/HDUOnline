/** 统计引擎与报表聚合测试（§9.1：跨零点拆分、挂机截断、封顶、倍速无关性）。 */

import { describe, expect, it } from 'vitest';
import { StatsEngine, toWatchRecord, type ClosedSegment, type TickInput } from '@/core/stats/engine';
import { buildReport, computeStreak, watchState } from '@/core/stats/aggregate';
import { STATS_LIMITS } from '@/core/shared/constants';
import type { WatchRecordEntity } from '@/core/shared/types';

/** 生成某本地日的指定时刻（避免 UTC 偏移干扰跨零点用例） */
function at(day: string, hour: number, minute = 0, second = 0): number {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, hour, minute, second, 0).getTime();
}

function engine(idleMin = 15): StatsEngine {
  return new StatsEngine({ idleThresholdSec: idleMin * 60 });
}

/** 以 500ms 心跳推进若干秒 */
function advance(
  target: StatsEngine,
  opts: {
    courId: number;
    teclId: number;
    from: number;
    seconds: number;
    rate?: number;
    visible?: boolean;
    focused?: boolean;
    interactedEvery?: number;
  },
): ClosedSegment[] {
  const closed: ClosedSegment[] = [];
  const steps = Math.round((opts.seconds * 1000) / 500);
  for (let i = 1; i <= steps; i += 1) {
    const now = opts.from + i * 500;
    closed.push(
      ...target.tick({
        courId: opts.courId,
        teclId: opts.teclId,
        now,
        state: { currentTime: i * 0.5 * (opts.rate ?? 1), duration: 2820, paused: false, rate: opts.rate ?? 1 },
        visible: opts.visible ?? true,
        focused: opts.focused ?? true,
        interacted: opts.interactedEvery ? i % opts.interactedEvery === 0 : false,
      }),
    );
  }
  return closed;
}

/** 单个持久化 tick 的便捷构造 */
function tickAt(e: StatsEngine, now: number, patch: Partial<TickInput> = {}): ClosedSegment[] {
  return e.tick({
    courId: 1,
    teclId: 9,
    now,
    state: { currentTime: 0, duration: 2820, paused: false, rate: 1 },
    visible: true,
    focused: true,
    interacted: false,
    ...patch,
  });
}

describe('StatsEngine 基本口径', () => {
  it('墙钟时间与倍速无关（2× 播放 60 秒只计 60 秒）', () => {
    const e1 = engine();
    const base = at('2026-05-06', 10);
    advance(e1, { courId: 1, teclId: 9, from: base, seconds: 60, rate: 1 });
    const secNormal = e1.flush().reduce((acc, rec) => acc + rec.durationSec, 0);

    const e2 = engine();
    advance(e2, { courId: 1, teclId: 9, from: base, seconds: 60, rate: 2 });
    const secFast = e2.flush().reduce((acc, rec) => acc + rec.durationSec, 0);

    expect(secNormal).toBeGreaterThan(58);
    expect(secFast).toBeCloseTo(secNormal, 0);
    expect(secFast).toBeLessThan(61);
  });

  it('暂停不再累计', () => {
    const e = engine();
    const base = at('2026-05-06', 10);
    advance(e, { courId: 1, teclId: 9, from: base, seconds: 10 });
    // 暂停 30 秒（心跳照发但 paused=true）；暂停时引擎会结算当前段
    const pauseClosed: ClosedSegment[] = [];
    for (let i = 0; i < 60; i += 1) {
      pauseClosed.push(
        ...e.tick({
          courId: 1,
          teclId: 9,
          now: base + 10_000 + i * 500,
          state: { currentTime: 10, duration: 2820, paused: true, rate: 1 },
          visible: true,
          focused: true,
          interacted: false,
        }),
      );
    }
    const closed = [...pauseClosed, ...e.flush()];
    const total = closed.reduce((acc, rec) => acc + rec.durationSec, 0);
    expect(total).toBeGreaterThan(9);
    expect(total).toBeLessThan(12);
  });

  it('页面不可见时不累计', () => {
    const e = engine();
    const base = at('2026-05-06', 10);
    const closed = advance(e, { courId: 1, teclId: 9, from: base, seconds: 20, visible: false });
    expect(closed).toHaveLength(0);
    expect(e.flush()).toHaveLength(0);
  });

  it('挂机：失焦后超过阈值不再累计（阈值内仍累计）', () => {
    const e = engine(1); // 阈值 1 分钟便于测试
    const base = at('2026-05-06', 10);
    // 前 30 秒有焦点
    advance(e, { courId: 1, teclId: 9, from: base, seconds: 30, focused: true });
    // 失焦并且不再交互：第 31 秒起的头 60 秒仍在阈值内（累计），之后停止
    const closed = advance(e, {
      courId: 1,
      teclId: 9,
      from: base + 30_000,
      seconds: 120,
      focused: false,
      interactedEvery: 0,
    });
    const total = [...closed, ...e.flush()].reduce((acc, rec) => acc + rec.durationSec, 0);
    // 30 秒 + 阈值内约 60 秒；不应包含之后 60 秒
    expect(total).toBeGreaterThan(85);
    expect(total).toBeLessThan(100);
  });

  it('失焦期间有交互心跳则继续累计', () => {
    const e = engine(1);
    const base = at('2026-05-06', 10);
    // 每 20 个 tick（10 秒）交互一次，始终低于 60 秒阈值
    advance(e, {
      courId: 1,
      teclId: 9,
      from: base,
      seconds: 120,
      focused: false,
      interactedEvery: 20,
    });
    const total = e.flush().reduce((acc, rec) => acc + rec.durationSec, 0);
    expect(total).toBeGreaterThan(115);
  });

  it('跨零点拆分为两条记录（本地时区）', () => {
    const e = engine();
    const start = at('2026-05-06', 23, 59);
    const closed = advance(e, { courId: 1, teclId: 9, from: start, seconds: 90 });
    closed.push(...e.flush());
    expect(closed.length).toBeGreaterThanOrEqual(2);
    const dates = new Set(closed.map((rec) => rec.date));
    expect(dates.has('2026-05-06')).toBe(true);
    expect(dates.has('2026-05-07')).toBe(true);
    // 两条记录都不跨日
    for (const rec of closed) {
      const d = new Date(rec.startTs);
      const [y, m, dd] = rec.date.split('-').map(Number);
      expect(d.getFullYear()).toBe(y);
      expect(d.getMonth() + 1).toBe(m);
      expect(d.getDate()).toBe(dd);
    }
  });

  it('单日封顶后仍有流水但 valid=false', () => {
    const e = new StatsEngine({ idleThresholdSec: 15 * 60, dailyCapSec: 10 });
    e.seedDayTotal('2026-05-06', 10); // 当日已满
    const base = at('2026-05-06', 12);
    const closed = advance(e, { courId: 1, teclId: 9, from: base, seconds: 20 });
    closed.push(...e.flush());
    expect(closed.length).toBeGreaterThan(0);
    expect(closed.every((rec) => rec.valid === false)).toBe(true);
  });

  it('默认单日上限为 16 小时（STATS_LIMITS.dailyCapSec）', () => {
    expect(STATS_LIMITS.dailyCapSec).toBe(16 * 3600);
    const e = new StatsEngine({ idleThresholdSec: 15 * 60 });
    e.seedDayTotal('2026-05-06', STATS_LIMITS.dailyCapSec);
    const base = at('2026-05-06', 12);
    const closed = advance(e, { courId: 1, teclId: 9, from: base, seconds: 2 });
    closed.push(...e.flush());
    expect(closed.length).toBeGreaterThan(0);
    expect(closed.every((rec) => rec.valid === false)).toBe(true);
  });

  it('同一段内封顶前的时间仍计入有效流水，不被整段作废', () => {
    const e = new StatsEngine({ idleThresholdSec: 15 * 60, dailyCapSec: 60 });
    e.seedDayTotal('2026-05-06', 50);
    const base = at('2026-05-06', 12);
    const closed = advance(e, { courId: 1, teclId: 9, from: base, seconds: 20 });
    closed.push(...e.flush());
    const validSec = closed.filter((rec) => rec.valid).reduce((acc, rec) => acc + rec.durationSec, 0);
    const invalidSec = closed.filter((rec) => !rec.valid).reduce((acc, rec) => acc + rec.durationSec, 0);
    // 当日已用 50s，上限 60s：20s 中约 10s 有效、10s 审计
    expect(validSec).toBeGreaterThan(9);
    expect(validSec).toBeLessThan(11);
    expect(invalidSec).toBeGreaterThan(8);
    expect(invalidSec).toBeLessThan(11);
  });

  it('封顶只影响达到上限当日，跨零点后恢复 valid', () => {    // 上限设为 30s：旧日已满，新日只累计 15s，不应被封顶
    const e = new StatsEngine({ idleThresholdSec: 15 * 60, dailyCapSec: 30 });
    e.seedDayTotal('2026-05-06', 30);
    const start = at('2026-05-06', 23, 59, 55);
    const closed = advance(e, { courId: 1, teclId: 9, from: start, seconds: 20 });
    closed.push(...e.flush());
    const before = closed.filter((rec) => rec.date === '2026-05-06');
    const after = closed.filter((rec) => rec.date === '2026-05-07');
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((rec) => rec.valid === false)).toBe(true);
    expect(after.length).toBeGreaterThan(0);
    expect(after.some((rec) => rec.valid === true)).toBe(true);
  });

  it('时间跳跃（进程挂起）不被计入', () => {
    const e = engine();
    const base = at('2026-05-06', 10);
    advance(e, { courId: 1, teclId: 9, from: base, seconds: 10 });
    // 直接跳到 10 分钟后（模拟休眠）
    const closed = e.tick({
      courId: 1,
      teclId: 9,
      now: base + 10_000 + 10 * 60_000,
      state: { currentTime: 15, duration: 2820, paused: false, rate: 1 },
      visible: true,
      focused: true,
      interacted: true,
    });
    const total = [...closed, ...e.flush()].reduce((acc, rec) => acc + rec.durationSec, 0);
    expect(total).toBeLessThan(12); // 只计前 10 秒
  });

  it('切换课次时结算旧段', () => {
    const e = engine();
    const base = at('2026-05-06', 10);
    advance(e, { courId: 1, teclId: 9, from: base, seconds: 10 });
    const closed = e.tick({
      courId: 2,
      teclId: 9,
      now: base + 10_500,
      state: { currentTime: 0, duration: 100, paused: false, rate: 1 },
      visible: true,
      focused: true,
      interacted: true,
    });
    expect(closed.some((rec) => rec.courId === 1)).toBe(true);
    expect(e.peek()?.courId).toBe(2);
  });

  it('过短分片被丢弃，不产生碎片记录', () => {
    const e = engine();
    const base = at('2026-05-06', 10);
    tickAt(e, base);
    const closed = tickAt(e, base + 500, { state: { currentTime: 0, duration: 2820, paused: true, rate: 1 } });
    expect(closed).toHaveLength(0);
  });

  it('peek / liveValidSec 反映当前打开段', () => {
    const e = engine();
    const base = at('2026-05-06', 10);
    expect(e.peek()).toBeNull();
    advance(e, { courId: 7, teclId: 3, from: base, seconds: 5 });
    expect(e.peek()?.courId).toBe(7);
    expect(e.peek()?.durationSec).toBe(5);
    expect(e.liveValidSec(7)).toBe(5);
    expect(e.liveValidSec(99)).toBe(0);
  });

  it('toWatchRecord 映射完整', () => {
    const e = engine();
    const base = at('2026-05-06', 10);
    advance(e, { courId: 7, teclId: 3, from: base, seconds: 5 });
    const closed = e.flush();
    const record: WatchRecordEntity = toWatchRecord(closed[0] as ClosedSegment);
    expect(record).toMatchObject({ courId: 7, teclId: 3, playMode: 'vod', valid: true });
    expect(record.durationSec).toBeGreaterThan(3);
    expect(record.date).toBe('2026-05-06');
  });
});

describe('报表聚合', () => {
  const now = at('2026-05-06', 20);

  function records(specs: Array<{ courId: number; teclId: number; date: string; sec: number; valid?: boolean }>): WatchRecordEntity[] {
    return specs.map((spec, index) => ({
      id: index,
      courId: spec.courId,
      teclId: spec.teclId,
      date: spec.date,
      startTs: at(spec.date, 10) + index,
      endTs: at(spec.date, 10) + index + spec.sec * 1000,
      durationSec: spec.sec,
      playMode: 'vod' as const,
      speed: 1,
      firstWatch: true,
      valid: spec.valid ?? true,
    }));
  }

  it('无效流水不进报表', () => {
    const report = buildReport({
      records: records([
        { courId: 1, teclId: 9, date: '2026-05-05', sec: 600 },
        { courId: 1, teclId: 9, date: '2026-05-05', sec: 600, valid: false },
      ]),
      sessions: [],
      courses: [],
      windowDays: 30,
      weeklyTargetSec: 5 * 3600,
      checkinMinSec: 600,
      now,
    });
    expect(report.totalSec).toBe(600);
  });

  it('今日/本周/连续天数计算正确', () => {
    const report = buildReport({
      records: records([
        { courId: 1, teclId: 9, date: '2026-05-04', sec: 900 },
        { courId: 1, teclId: 9, date: '2026-05-05', sec: 900 },
        { courId: 1, teclId: 9, date: '2026-05-06', sec: 1200 },
      ]),
      sessions: [],
      courses: [],
      windowDays: 30,
      weeklyTargetSec: 5 * 3600,
      checkinMinSec: 600,
      now,
    });
    expect(report.todaySec).toBe(1200);
    expect(report.weekSec).toBe(3000); // 2026-05-04 是周一
    expect(report.streakDays).toBe(3);
    expect(report.goal.hitDaysThisWeek).toBe(3);
  });

  it('课次完看度按课次时长计算并封顶 100%', () => {
    const report = buildReport({
      records: records([{ courId: 1227038, teclId: 9001, date: '2026-05-06', sec: 3000 }]),
      sessions: [
        {
          courId: 1227038,
          teclId: 9001,
          beginTime: new Date(at('2026-05-06', 10)).toISOString(),
          endTime: new Date(at('2026-05-06', 11)).toISOString(),
          durationSec: 2820,
          watchState: 'finished',
          courseName: '线性代数',
          courLabel: '第5周 / 2026-05-06 / 第12节课',
        },
      ],
      courses: [{ teclId: 9001, subjName: '线性代数', teacherNames: [], updatedAt: now }],
      windowDays: 30,
      weeklyTargetSec: 5 * 3600,
      checkinMinSec: 600,
      now,
    });
    expect(report.sessions[0]?.watchRatio).toBe(1);
    expect(report.courses[0]?.courseName).toBe('线性代数');
    expect(report.courses[0]?.sessionCount).toBe(1);
    expect(report.courses[0]?.finishedCount).toBe(1);
  });

  it('computeStreak：今天未学但昨天学过则连续不中断', () => {
    const active = new Set(['2026-05-03', '2026-05-04', '2026-05-05']);
    expect(computeStreak(active, '2026-05-06', now)).toBe(3);
    expect(computeStreak(new Set(['2026-05-06']), '2026-05-06', now)).toBe(1);
    expect(computeStreak(new Set(), '2026-05-06', now)).toBe(0);
  });

  it('watchState 阈值判定', () => {
    expect(watchState(0, 2820, 0.9)).toBe('unwatched');
    expect(watchState(1400, 2820, 0.9)).toBe('watching');
    expect(watchState(2600, 2820, 0.9)).toBe('finished');
  });
});
