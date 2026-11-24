/**
 * estimateStoreGrowth 流水增长预估纯函数测试（第 254 轮巡检，存储健康域 / 透明度视角）：
 *  - 口径：近 N 天日均条数 → 30 天月增量条数 / 体积（单条 WATCH_RECORD_BYTES_EST=200B
 *    粗估常数，估据见 storage.ts 注释——7 数值字段 + 日期字符串 + IDB 记录开销取中值）；
 *  - 边界：空数据 / 非法天数 / 非数组输入 → 全 0（不给无据估计）；
 *  - 常数口径锁定（防实现漂移，UI 副文案「单条约 200 字节」与此联动）。
 * 纯函数无 IO，node 环境直测。
 */

import { describe, expect, it } from 'vitest';
import { estimateStoreGrowth, WATCH_RECORD_BYTES_EST } from '@/core/shared/storage';

describe('estimateStoreGrowth 增长预估（第 254 轮）', () => {
  it('常数口径锁定：单条 200B（UI 副文案与巡检日志引用同一数字）', () => {
    expect(WATCH_RECORD_BYTES_EST).toBe(200);
  });

  it('30 条 / 30 天 → 日均 1 → 月增量 30 条 · 6000B（粗估）', () => {
    const records = Array.from({ length: 30 }, (_, i) => ({ date: `2026-11-${String((i % 30) + 1).padStart(2, '0')}` }));
    const est = estimateStoreGrowth(records, 30);
    expect(est.windowCount).toBe(30);
    expect(est.windowDays).toBe(30);
    expect(est.dailyAvg).toBe(1);
    expect(est.monthlyCount).toBe(30);
    expect(est.monthlyBytes).toBe(30 * WATCH_RECORD_BYTES_EST);
    expect(est.recordBytesEst).toBe(WATCH_RECORD_BYTES_EST);
  });

  it('非整除日均四舍五入到 0.1 位，月增量按日均 × 30 取整', () => {
    // 7 条 / 3 天 → 2.333… → dailyAvg 2.3 → 月 69 条
    const est = estimateStoreGrowth([1, 2, 3, 4, 5, 6, 7], 3);
    expect(est.dailyAvg).toBe(2.3);
    expect(est.monthlyCount).toBe(69);
    expect(est.monthlyBytes).toBe(69 * WATCH_RECORD_BYTES_EST);
  });

  it('空数据 → 全 0（不给无据估计，窗口计数回显 0）', () => {
    const est = estimateStoreGrowth([], 30);
    expect(est).toMatchObject({ windowCount: 0, windowDays: 30, dailyAvg: 0, monthlyCount: 0, monthlyBytes: 0 });
  });

  it('非数组输入（null / undefined）→ 全 0，不抛错', () => {
    expect(estimateStoreGrowth(null, 30).monthlyCount).toBe(0);
    expect(estimateStoreGrowth(undefined, 30).monthlyCount).toBe(0);
  });

  it('非法天数（0 / 负数 / NaN / Infinity）→ 全 0，records 原样回显', () => {
    expect(estimateStoreGrowth([1, 2], 0)).toMatchObject({ windowCount: 2, windowDays: 0, monthlyCount: 0, monthlyBytes: 0 });
    expect(estimateStoreGrowth([1, 2], -5).windowDays).toBe(0);
    expect(estimateStoreGrowth([1, 2], Number.NaN).windowDays).toBe(0);
    expect(estimateStoreGrowth([1, 2], Number.POSITIVE_INFINITY).windowDays).toBe(0);
  });

  it('小数天数防御式向下取整（与取数窗口天数语义一致）', () => {
    // 3 条 / 2.9 天 → windowDays floor 2 → 日均 1.5 → 月 45 条
    const est = estimateStoreGrowth([1, 2, 3], 2.9);
    expect(est.windowDays).toBe(2);
    expect(est.dailyAvg).toBe(1.5);
    expect(est.monthlyCount).toBe(45);
    expect(est.monthlyBytes).toBe(45 * WATCH_RECORD_BYTES_EST);
  });

  it('大体量口径不溢出：日均 500 条 → 月 15000 条 · 3MB 量级', () => {
    const records = Array.from({ length: 500 });
    const est = estimateStoreGrowth(records, 1);
    expect(est.monthlyCount).toBe(15_000);
    expect(est.monthlyBytes).toBe(3_000_000);
  });
});
