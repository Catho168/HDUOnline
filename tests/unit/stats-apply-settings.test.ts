/**
 * SW 统计服务设置热更单测（第 252 轮巡检，健壮性域 / 可靠性视角；照 alarms.test.ts
 * 直测 background 模块的先例）。
 *
 * 背景（SW 内存态 vs 持久态审计缺口 B）：statsService.finishThreshold 原先只在
 * ensureEngine 冷建时读一次 chrome.storage，SW 存活期间（播放心跳保活）用户在设置页
 * 调整完看阈值不生效，回写 sessions.watchState 用内存旧值。修齐：applySettings 由
 * background/index.ts 的 onSettingsChanged 调用热更；解析逻辑抽纯函数
 * resolveFinishThreshold（非法/越界回退默认 0.9 并钳制 [0,1]），冷建与热更共用同一
 * 解析，单测锁定口径不漂移。
 *
 * 职责边界（记巡检日志第 252 轮盘点表）：idleThresholdMin 属 StatsEngine 构造参数，
 * 热更需重建引擎（丢弃进行中分段），维持「SW 重启后生效」既有边界；bootstrap 的
 * loadSettings 兜底与 alarms 每次启动对账（候选 A / C）在 index.ts / alarms.ts 落实，
 * 纯函数判定不存在（「每次启动即对账」为无条件幂等设计），不设开关函数。
 */

import { describe, expect, it } from 'vitest';

import { resolveFinishThreshold, statsService } from '@/entrypoints/background/stats';

describe('resolveFinishThreshold（完看阈值解析，第 252 轮）', () => {
  it('合法值原样通过（含边界 0 与 1）', () => {
    expect(resolveFinishThreshold(0.75)).toBe(0.75);
    expect(resolveFinishThreshold(0)).toBe(0);
    expect(resolveFinishThreshold(1)).toBe(1);
    expect(resolveFinishThreshold(0.9)).toBe(0.9);
  });

  it('越界值钳制到 [0,1]', () => {
    expect(resolveFinishThreshold(1.2)).toBe(1);
    expect(resolveFinishThreshold(5)).toBe(1);
    expect(resolveFinishThreshold(-0.5)).toBe(0);
  });

  it('非法值回退默认 0.9（NaN / Infinity / 非数值 / 缺省）', () => {
    expect(resolveFinishThreshold(Number.NaN)).toBe(0.9);
    expect(resolveFinishThreshold(Number.POSITIVE_INFINITY)).toBe(0.9);
    expect(resolveFinishThreshold('0.8')).toBe(0.9);
    expect(resolveFinishThreshold(null)).toBe(0.9);
    expect(resolveFinishThreshold(undefined)).toBe(0.9);
  });
});

describe('statsService.applySettings（设置变更热更，第 252 轮）', () => {
  it('合法设置：返回并生效新阈值', () => {
    expect(statsService.applySettings({ finishThreshold: 0.8 })).toBe(0.8);
  });

  it('越界/非法设置：回退默认 0.9（不采纳脏值）', () => {
    expect(statsService.applySettings({ finishThreshold: 7 })).toBe(1);
    expect(statsService.applySettings({ finishThreshold: 'x' })).toBe(0.9);
    expect(statsService.applySettings(null)).toBe(0.9);
    expect(statsService.applySettings(undefined)).toBe(0.9);
  });
});
