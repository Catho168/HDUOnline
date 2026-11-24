/**
 * 打卡月历聚合 buildCheckinMonthGrid（core/stats/checkinMonth.ts，第 234 轮巡检）单测。
 *
 * 覆盖：
 *  1. 达标判定：validSec ≥ 打卡线 → hit=true；恰等打卡线算达标（≥ 语义，与
 *     hitDaysThisWeek 的 `d.validSec >= checkinMinSec` 完全同线）；
 *  2. 未达标但有学习：0 < sec < 打卡线 → hit=false 且 sec 保留（渲染层淡色显示时长）；
 *  3. 空日：无学习 sec=0、hit=false（渲染层留空格）；
 *  4. 未来日：isFuture=true、sec 恒 0、hit 恒 false，且不进 hitDays / elapsedDays / totalSec；
 *  5. 跨月边界：周一起点补位（前后月补位格 inMonth=false）、平月 / 闰月 / 整周月行数、
 *     已过天按 todayKey 切分（今天计入、未来月归零）；
 *  6. 摘要口径：hitDays / elapsedDays（本月已过天数）/ totalSec / 月标签；
 *  7. 脏数据防御：非数组 / 非对象行 / 非法 date / 非法 validSec 逐条跳过不抛错；
 *     todayKey 或年月非法返回 null（与 buildReviewMonthGrid 同约定）。
 */
import { describe, expect, it } from 'vitest';

import { CHECKIN_MIN_SEC } from '@/core/stats/aggregate';
import { buildCheckinMonthGrid } from '@/core/stats/checkinMonth';

/** 报表行构造器（date + validSec，与 DailyStat 的字段口径一致） */
const DAYS = (rows: Array<[string, number]>) => rows.map(([date, validSec]) => ({ date, validSec }));

describe('buildCheckinMonthGrid 达标判定（第 234 轮）', () => {
  it('恰等打卡线算达标（≥ 语义，与 hitDaysThisWeek 同线）', () => {
    const grid = buildCheckinMonthGrid(DAYS([['2026-11-05', CHECKIN_MIN_SEC]]), 2026, 11, CHECKIN_MIN_SEC, '2026-11-20');
    expect(grid).not.toBeNull();
    const cell = grid!.weeks.flat().find((c) => c.key === '2026-11-05');
    expect(cell?.hit).toBe(true);
    expect(grid!.hitDays).toBe(1);
  });

  it('未达标但有学习：hit=false、sec 保留；空日 sec=0', () => {
    const grid = buildCheckinMonthGrid(
      DAYS([
        ['2026-11-05', CHECKIN_MIN_SEC - 1],
        ['2026-11-06', 1],
      ]),
      2026,
      11,
      CHECKIN_MIN_SEC,
      '2026-11-20',
    );
    const flat = grid!.weeks.flat();
    const partial = flat.find((c) => c.key === '2026-11-05');
    const tiny = flat.find((c) => c.key === '2026-11-06');
    const empty = flat.find((c) => c.key === '2026-11-10');
    expect(partial).toMatchObject({ hit: false, sec: CHECKIN_MIN_SEC - 1, isFuture: false, inMonth: true });
    expect(tiny).toMatchObject({ hit: false, sec: 1 });
    expect(empty).toMatchObject({ hit: false, sec: 0, isFuture: false });
    expect(grid!.hitDays).toBe(0);
    // 累计只含站内 validSec（两行之和）
    expect(grid!.totalSec).toBe(CHECKIN_MIN_SEC);
  });

  it('未来日：sec 恒 0、hit 恒 false，不进摘要分母与累计', () => {
    const grid = buildCheckinMonthGrid(DAYS([['2026-11-25', 7200]]), 2026, 11, CHECKIN_MIN_SEC, '2026-11-20');
    const future = grid!.weeks.flat().find((c) => c.key === '2026-11-25');
    expect(future).toMatchObject({ isFuture: true, sec: 0, hit: false, inMonth: true });
    expect(grid!.hitDays).toBe(0);
    expect(grid!.totalSec).toBe(0);
    // 已过天 = 20（11-01 ~ 11-20，含今天）
    expect(grid!.elapsedDays).toBe(20);
  });

  it('今天本身计入已过天并参与判定；isToday 标注', () => {
    const grid = buildCheckinMonthGrid(DAYS([['2026-11-20', 3600]]), 2026, 11, CHECKIN_MIN_SEC, '2026-11-20');
    const today = grid!.weeks.flat().find((c) => c.key === '2026-11-20');
    expect(today).toMatchObject({ isToday: true, isFuture: false, hit: true, sec: 3600 });
    expect(grid!.hitDays).toBe(1);
    expect(grid!.elapsedDays).toBe(20);
    expect(grid!.totalSec).toBe(3600);
  });
});

describe('buildCheckinMonthGrid 月历排布与跨月边界（第 234 轮）', () => {
  it('周一起点补位：2026-11 首日为周日 → 首格是 10-26 补位，11-30（周一）成末行首', () => {
    const grid = buildCheckinMonthGrid([], 2026, 11, CHECKIN_MIN_SEC, '2026-11-20');
    const firstWeek = grid!.weeks[0]!;
    expect(firstWeek).toHaveLength(7);
    expect(firstWeek[0]!.key).toBe('2026-10-26');
    expect(firstWeek[0]!.inMonth).toBe(false);
    expect(firstWeek[6]!.key).toBe('2026-11-01');
    expect(firstWeek[6]!.inMonth).toBe(true);
    // 11-30 是周一：末行 30 + 6 个 12 月补位格（补位格仍是真实日期）
    const lastWeek = grid!.weeks[grid!.weeks.length - 1]!;
    expect(lastWeek[0]!.key).toBe('2026-11-30');
    expect(lastWeek[0]!.inMonth).toBe(true);
    expect(lastWeek[6]!.key).toBe('2026-12-06');
    expect(lastWeek[6]!.inMonth).toBe(false);
    // 每周恒 7 格、共 6 周（首尾半月周 + 4 个整周）
    expect(grid!.weeks).toHaveLength(6);
    expect(grid!.weeks.every((week) => week.length === 7)).toBe(true);
    // 补位格不进已过天分母：20 天（11-01 ~ 11-20）
    expect(grid!.elapsedDays).toBe(20);
  });

  it('整周月：2021-02（1 日周一、28 天）恰 4 周行、无补位格', () => {
    const grid = buildCheckinMonthGrid([], 2021, 2, CHECKIN_MIN_SEC, '2021-02-10');
    expect(grid!.weeks).toHaveLength(4);
    expect(grid!.weeks[0]![0]!.key).toBe('2021-02-01');
    const flat = grid!.weeks.flat();
    expect(flat.every((cell) => cell.inMonth)).toBe(true);
    expect(flat[flat.length - 1]!.key).toBe('2021-02-28');
    expect(grid!.elapsedDays).toBe(10);
  });

  it('闰年 2 月 29 天（2024-02，1 日周四）：首行 3 格 1 月补位、5 周行', () => {
    const grid = buildCheckinMonthGrid([], 2024, 2, CHECKIN_MIN_SEC, '2024-02-15');
    expect(grid!.weeks).toHaveLength(5);
    expect(grid!.weeks[0]![0]!.key).toBe('2024-01-29');
    expect(grid!.weeks[0]![0]!.inMonth).toBe(false);
    expect(grid!.elapsedDays).toBe(15);
  });

  it('过去月：整月都算已过天（分母 = 当月天数）；未来月归零', () => {
    const past = buildCheckinMonthGrid(DAYS([['2026-10-01', 3600]]), 2026, 10, CHECKIN_MIN_SEC, '2026-11-20');
    expect(past!.elapsedDays).toBe(31);
    expect(past!.hitDays).toBe(1);
    const future = buildCheckinMonthGrid([], 2026, 12, CHECKIN_MIN_SEC, '2026-11-20');
    expect(future!.elapsedDays).toBe(0);
    expect(future!.hitDays).toBe(0);
    expect(future!.totalSec).toBe(0);
    expect(future!.weeks.flat().every((cell) => cell.isFuture || !cell.inMonth)).toBe(true);
  });
});

describe('buildCheckinMonthGrid 标签与脏数据防御（第 234 轮）', () => {
  it('月标签与规范化 monthKey 回传', () => {
    const grid = buildCheckinMonthGrid([], 2026, 11, CHECKIN_MIN_SEC, '2026-11-20');
    expect(grid!.label).toBe('2026年11月');
    expect(grid!.monthKey).toBe('2026-11');
  });

  it('脏数据逐条跳过：非数组 / 非对象 / 非法 date / 非法 validSec', () => {
    const grid = buildCheckinMonthGrid(
      [
        null as unknown as { date: string; validSec: number },
        'junk' as unknown as { date: string; validSec: number },
        { date: '20261105', validSec: 600 },
        { date: '2026-11-05', validSec: '600' },
        { date: '2026-11-05', validSec: -5 },
        { date: '2026-02-30', validSec: 600 }, // 形似日键但不存在的日期
        { date: '2026-13-05', validSec: 600 },
        { date: '2026-11-05', validSec: 600 },
      ],
      2026,
      11,
      CHECKIN_MIN_SEC,
      '2026-11-20',
    );
    // 只有最后一行有效：11-05 恰达标
    expect(grid!.hitDays).toBe(1);
    expect(grid!.totalSec).toBe(600);
  });

  it('todayKey / 年月非法返回 null（与 buildReviewMonthGrid 同约定）', () => {
    expect(buildCheckinMonthGrid([], 2026, 11, CHECKIN_MIN_SEC, 'not-a-day')).toBeNull();
    expect(buildCheckinMonthGrid([], 2026, 11, CHECKIN_MIN_SEC, '')).toBeNull();
    expect(buildCheckinMonthGrid([], 2026, 0, CHECKIN_MIN_SEC, '2026-11-20')).toBeNull();
    expect(buildCheckinMonthGrid([], 2026, 13, CHECKIN_MIN_SEC, '2026-11-20')).toBeNull();
    expect(buildCheckinMonthGrid([], 2025.5, 11, CHECKIN_MIN_SEC, '2026-11-20')).toBeNull();
    expect(buildCheckinMonthGrid([], 2026, 11, CHECKIN_MIN_SEC, '2026-02-30')).toBeNull();
  });
});

describe('buildCheckinMonthGrid 目标线叠加（第 261 轮，目标域 / 双口径延伸）', () => {
  it('goalHit 判定：sec ≥ dailyGoalMin×60 达成（边界含等号）；打卡线与目标线并存可不同', () => {
    const grid = buildCheckinMonthGrid(
      DAYS([
        ['2026-11-05', CHECKIN_MIN_SEC], // 打卡达标（600）但低于目标线（1800）
        ['2026-11-06', 1800], // 恰等目标线 → goalHit
        ['2026-11-07', 1799], // 差一秒 → 打卡达标但目标未达成
      ]),
      2026,
      11,
      CHECKIN_MIN_SEC,
      '2026-11-20',
      30,
    );
    const flat = grid!.weeks.flat();
    const d05 = flat.find((c) => c.key === '2026-11-05');
    const d06 = flat.find((c) => c.key === '2026-11-06');
    const d07 = flat.find((c) => c.key === '2026-11-07');
    expect(d05?.hit).toBe(true);
    expect(d05?.goalHit).toBe(false);
    expect(d06?.hit).toBe(true);
    expect(d06?.goalHit).toBe(true);
    expect(d07?.hit).toBe(true);
    expect(d07?.goalHit).toBe(false);
    // goalHitDays（第 263 轮）：本月已过天中目标达成天数汇总（仅 11-06 达标）
    expect(grid!.goalHitDays).toBe(1);
  });

  it('dailyGoalMin ≤ 0（未启用）：goalHit 恒 false；未来日 / 补位格恒 false', () => {
    const grid = buildCheckinMonthGrid(DAYS([['2026-11-06', 7200]]), 2026, 11, CHECKIN_MIN_SEC, '2026-11-20', 0);
    const flat = grid!.weeks.flat();
    expect(flat.find((c) => c.key === '2026-11-06')?.goalHit).toBe(false);
    // 未启用目标线：goalHitDays 恒 0
    expect(grid!.goalHitDays).toBe(0);
    const grid2 = buildCheckinMonthGrid(DAYS([['2026-11-25', 7200]]), 2026, 11, CHECKIN_MIN_SEC, '2026-11-20', 30);
    const future = grid2!.weeks.flat().find((c) => c.key === '2026-11-25');
    expect(future?.isFuture).toBe(true);
    expect(future?.goalHit).toBe(false);
    // 补位格（上月末尾，inMonth=false）即使有秒数也不标目标
    const grid3 = buildCheckinMonthGrid(DAYS([['2026-10-31', 7200]]), 2026, 11, CHECKIN_MIN_SEC, '2026-11-20', 30);
    const out = grid3!.weeks.flat().find((c) => c.key === '2026-10-31');
    expect(out?.inMonth).toBe(false);
    expect(out?.goalHit).toBe(false);
  });
});
