/**
 * 每日待办提醒调度单测（第 83 轮巡检）：nextDailyTodoTriggerMs 的时刻参数处理——
 * 默认 20:00、当天已过则顺延明天、自定义时刻（0–23）与非法值回退。
 */
import { describe, expect, it } from 'vitest';
import { nextDailyTodoTriggerMs, nextDueTomorrowTriggerMs } from '@/entrypoints/background/alarms';

/** 固定「现在」：2026-11-18（周三）本地 12:00 */
const NOON = new Date(2026, 10, 18, 12, 0, 0, 0).getTime();

function localStamp(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

describe('nextDailyTodoTriggerMs（每日提醒时刻，第 83 轮）', () => {
  it('默认 20:00：当天未到取今天，已过顺延明天', () => {
    expect(localStamp(nextDailyTodoTriggerMs(NOON))).toBe('2026-11-18 20:00');
    expect(localStamp(nextDailyTodoTriggerMs(new Date(2026, 10, 18, 21, 0, 0, 0).getTime()))).toBe('2026-11-19 20:00');
  });

  it('自定义时刻：当天未到取当天，已过顺延明天', () => {
    expect(localStamp(nextDailyTodoTriggerMs(NOON, 8))).toBe('2026-11-19 08:00');
    expect(localStamp(nextDailyTodoTriggerMs(new Date(2026, 10, 18, 7, 30, 0, 0).getTime(), 8))).toBe('2026-11-18 08:00');
    // 恰好等于当前时刻：视为已过，顺延明天（alarm 需严格落在未来）
    expect(localStamp(nextDailyTodoTriggerMs(NOON, 12))).toBe('2026-11-19 12:00');
  });

  it('非法/越界时刻回退或钳制：小数四舍五入、负数归 0、>23 归 23、NaN 回退默认', () => {
    expect(localStamp(nextDailyTodoTriggerMs(NOON, 23.7))).toBe('2026-11-18 23:00');
    expect(localStamp(nextDailyTodoTriggerMs(NOON, -1))).toBe('2026-11-19 00:00');
    expect(localStamp(nextDailyTodoTriggerMs(NOON, Number.NaN))).toBe('2026-11-18 20:00');
  });
});

describe('nextDueTomorrowTriggerMs（明日到期提醒时刻，第 243 轮）', () => {
  it('默认 = 每日待办提醒 +30 分钟（20:00 → 20:30），当天未到取今天', () => {
    expect(localStamp(nextDueTomorrowTriggerMs(NOON))).toBe('2026-11-18 20:30');
    // 已过 20:30（如 21:00）→ 顺延明天 20:30
    expect(localStamp(nextDueTomorrowTriggerMs(new Date(2026, 10, 18, 21, 0, 0, 0).getTime()))).toBe('2026-11-19 20:30');
  });

  it('待办时刻可配时跟随偏移；跨日边界（23:00）保持 30 分钟错开到 23:30', () => {
    expect(localStamp(nextDueTomorrowTriggerMs(NOON, 8))).toBe('2026-11-19 08:30');
    expect(localStamp(nextDueTomorrowTriggerMs(new Date(2026, 10, 18, 22, 40, 0, 0).getTime(), 23))).toBe('2026-11-18 23:30');
  });
});
