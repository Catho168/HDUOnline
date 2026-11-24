/**
 * 复习「顺延到指定日」快捷日期选项（core/plan/rescheduleOptions.ts，第 244 轮巡检）
 * 纯函数单测：
 *  - 默认（days=14）8 档：明天 / 后天 / 周X×4（+3..+6）/ 下周同一日（+7，恰为
 *    第 7 天以跳档标签命名，避免同日重复 chip）/ 下月同一日；
 *  - 周几 label 与 M月D日 副行（固定基准日逐档断言）；
 *  - 跨月 / 跨年 / 月末溢出钳制（1-31 → 2-28；闰年 1-31 → 2-29）；
 *  - days 参数：3 → chips 收窄 + 两跳档补齐；0 → 仅两跳档；非法 today → 空数组；
 *  - clampRescheduleDate：早于今日钳回今日（sameDay）、今日 = sameDay、未来原样、
 *    非法/非字符串 → null。
 */

import { describe, expect, it } from 'vitest';
import { buildRescheduleOptions, clampRescheduleDate } from '@/core/plan/rescheduleOptions';

const TODAY = '2026-11-21'; // 周六

describe('buildRescheduleOptions（默认 days=14）', () => {
  const options = buildRescheduleOptions(TODAY);

  it('输出 8 档，key 依序为 d1..d6 / next-week / next-month', () => {
    expect(options.map((o) => o.key)).toEqual(['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'next-week', 'next-month']);
  });

  it('主行 label：明天 / 后天 / 周X / 下周同一日 / 下月同一日（基准日周几逐档核对）', () => {
    expect(options.map((o) => o.label)).toEqual([
      '明天', // 11-22 周日
      '后天', // 11-23 周一
      '周二', // 11-24
      '周三', // 11-25
      '周四', // 11-26
      '周五', // 11-27
      '下周同一日', // 11-28 周六（today+7，同「几」）
      '下月同一日', // 12-21 周一
    ]);
  });

  it('日键逐档推进；第 7 档 = today+7，第 8 档 = 下月同日', () => {
    expect(options.map((o) => o.dateKey)).toEqual([
      '2026-11-22',
      '2026-11-23',
      '2026-11-24',
      '2026-11-25',
      '2026-11-26',
      '2026-11-27',
      '2026-11-28',
      '2026-12-21',
    ]);
  });

  it('副行 dayLabel = M月D日 周X（跨月档带正确月份）', () => {
    expect(options[0]!.dayLabel).toBe('11月22日 周日');
    expect(options[2]!.dayLabel).toBe('11月24日 周二');
    expect(options[6]!.dayLabel).toBe('11月28日 周六');
    expect(options[7]!.dayLabel).toBe('12月21日 周一');
  });
});

describe('buildRescheduleOptions 边界', () => {
  it('跨月：11-30 → 明天落到 12-01，下月同一日 = 12-30', () => {
    const options = buildRescheduleOptions('2026-11-30');
    expect(options[0]).toMatchObject({ key: 'd1', label: '明天', dateKey: '2026-12-01' });
    expect(options.at(-1)).toMatchObject({ key: 'next-month', dateKey: '2026-12-30' });
  });

  it('跨年：12-31 → 明天 2027-01-01，下月同一日 = 2027-01-31', () => {
    const options = buildRescheduleOptions('2026-12-31');
    expect(options[0]).toMatchObject({ dateKey: '2027-01-01' });
    expect(options.at(-1)).toMatchObject({ key: 'next-month', dateKey: '2027-01-31' });
  });

  it('月末溢出钳制：1-31 → 下月同一日 = 2-28（平年）；闰年 → 2-29', () => {
    expect(buildRescheduleOptions('2026-01-31').at(-1)).toMatchObject({ dateKey: '2026-02-28' });
    expect(buildRescheduleOptions('2024-01-31').at(-1)).toMatchObject({ dateKey: '2024-02-29' });
  });

  it('days=3：chips 收窄为明天/后天/周X，两跳档补齐共 5 档', () => {
    const options = buildRescheduleOptions(TODAY, 3);
    expect(options.map((o) => o.key)).toEqual(['d1', 'd2', 'd3', 'next-week', 'next-month']);
    expect(options[2]).toMatchObject({ label: '周二', dateKey: '2026-11-24' });
    expect(options[3]).toMatchObject({ key: 'next-week', label: '下周同一日', dateKey: '2026-11-28' });
  });

  it('days=0：不出 chips，仅两跳档', () => {
    const options = buildRescheduleOptions(TODAY, 0);
    expect(options.map((o) => o.key)).toEqual(['next-week', 'next-month']);
  });

  it('days=7 与默认一致（第 7 天仍以「下周同一日」命名，不重复）', () => {
    expect(buildRescheduleOptions(TODAY, 7).map((o) => o.key)).toEqual(
      buildRescheduleOptions(TODAY).map((o) => o.key),
    );
  });

  it('非法 today 返回空数组（防御）', () => {
    expect(buildRescheduleOptions('')).toEqual([]);
    expect(buildRescheduleOptions('2026/11/21')).toEqual([]);
    expect(buildRescheduleOptions('not-a-day')).toEqual([]);
  });
});

describe('clampRescheduleDate', () => {
  it('早于今日钳回今日并标 sameDay（调用方提示保持不变）', () => {
    expect(clampRescheduleDate('2026-11-19', TODAY)).toEqual({ dateKey: TODAY, sameDay: true });
    expect(clampRescheduleDate('2020-01-01', TODAY)).toEqual({ dateKey: TODAY, sameDay: true });
  });

  it('目标即今日：sameDay=true 且原样', () => {
    expect(clampRescheduleDate(TODAY, TODAY)).toEqual({ dateKey: TODAY, sameDay: true });
  });

  it('未来日期原样放行（sameDay=false）', () => {
    expect(clampRescheduleDate('2026-11-25', TODAY)).toEqual({ dateKey: '2026-11-25', sameDay: false });
  });

  it('非法输入返回 null：非字符串 / 错误格式', () => {
    expect(clampRescheduleDate(undefined, TODAY)).toBeNull();
    expect(clampRescheduleDate(123, TODAY)).toBeNull();
    expect(clampRescheduleDate('2026-13-40', TODAY)).toBeNull();
    expect(clampRescheduleDate('', TODAY)).toBeNull();
  });
});
