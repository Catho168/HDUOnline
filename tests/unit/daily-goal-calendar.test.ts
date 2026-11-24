/**
 * 本周目标达成 7 日格纯函数测试（第 256 轮巡检，目标域）。
 * 覆盖：周界（周一起）/ hit 判定口径 / 未来日不判定 / 脏输入兜底 / clamp 兜底 / 同日去重。
 * now 固定 2026-11-20（本地周五；2026-11-16 为周一），跨时区稳定（全用本地日历构造）。
 */
import { describe, expect, it } from 'vitest';
import { buildWeeklyGoalCalendar } from '@/core/plan/dailyGoal';

const NOW = new Date(2026, 10, 20, 12, 0, 0, 0).getTime(); // 2026-11-20 周五（本地）

function day(date: string, validSec: number): { date: string; validSec: number } {
  return { date, validSec };
}

describe('buildWeeklyGoalCalendar', () => {
  it('周界：周一起 7 格，label 一~日，今天（周五）isToday，周末 isFuture', () => {
    const calendar = buildWeeklyGoalCalendar([], 30, NOW);
    expect(calendar.cells.map((c) => c.date)).toEqual([
      '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22',
    ]);
    expect(calendar.cells.map((c) => c.label)).toEqual(['一', '二', '三', '四', '五', '六', '日']);
    expect(calendar.cells[4]?.isToday).toBe(true);
    expect(calendar.cells[5]?.isFuture).toBe(true);
    expect(calendar.cells[6]?.isFuture).toBe(true);
    expect(calendar.judgedCount).toBe(5);
  });

  it('hit 判定：validSec ≥ dailyGoalMin×60 达标；恰好等于达标（边界含等号）', () => {
    const calendar = buildWeeklyGoalCalendar(
      [day('2026-11-16', 1800), day('2026-11-17', 1799), day('2026-11-18', 1800)],
      30,
      NOW,
    );
    expect(calendar.cells[0]?.hit).toBe(true);
    expect(calendar.cells[1]?.hit).toBe(false);
    expect(calendar.cells[2]?.hit).toBe(true);
    expect(calendar.hitCount).toBe(2);
  });

  it('未来日不判定：即使无数据也不算未达标（不计入 hitCount / judgedCount）', () => {
    const calendar = buildWeeklyGoalCalendar([], 30, NOW);
    expect(calendar.cells[5]?.hit).toBe(false);
    expect(calendar.cells[5]?.isFuture).toBe(true);
    expect(calendar.judgedCount).toBe(5);
    expect(calendar.hitCount).toBe(0);
  });

  it('脏输入：days 非数组 / 单条缺字段 / 非法日键 / 负秒数——按 0 处理不抛错', () => {
    const dirty = buildWeeklyGoalCalendar(
      [
        null,
        { date: 'not-a-date', validSec: 9999 },
        { date: '2026-11-17', validSec: -5 },
        { date: '2026-11-18' },
        'junk',
      ] as unknown as Array<{ date: string; validSec: number }>,
      30,
      NOW,
    );
    expect(dirty.cells[1]?.validSec).toBe(0);
    expect(dirty.cells[1]?.hit).toBe(false);
    expect(dirty.cells[2]?.validSec).toBe(0);
    expect(dirty.cells[3]?.validSec).toBe(0);
  });

  it('dailyGoalMin 脏值 clamp 兜底（缺省 30 / 下界 5 / 上界 600），返回值带生效值', () => {
    expect(buildWeeklyGoalCalendar([], undefined, NOW).dailyGoalMin).toBe(30);
    expect(buildWeeklyGoalCalendar([], 1, NOW).dailyGoalMin).toBe(5);
    expect(buildWeeklyGoalCalendar([], 9999, NOW).dailyGoalMin).toBe(600);
  });

  it('同日键重复出现取最大 validSec（防御重复输入）', () => {
    const calendar = buildWeeklyGoalCalendar([day('2026-11-16', 60), day('2026-11-16', 3600)], 30, NOW);
    expect(calendar.cells[0]?.validSec).toBe(3600);
    expect(calendar.cells[0]?.hit).toBe(true);
  });

  it('小数秒四舍五入：1799.6 → 1800 达标', () => {
    const calendar = buildWeeklyGoalCalendar([day('2026-11-16', 1799.6)], 30, NOW);
    expect(calendar.cells[0]?.hit).toBe(true);
  });
});
