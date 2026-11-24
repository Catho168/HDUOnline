/**
 * HDU TimelineLayer 近缘溢出钳制（第 28 轮任务 B-1）单测。
 *
 * 背景：App.tsx 的 TimelineLayer 原内联换算 `width = max(0.35, min(100 - left, 区间占比))`
 * 在 left∈(99.65,100) 时会因 0.35 下限让 left+width 最高到 100.35%，溢出播放器右缘。
 * 修法与 B 站 core/bili/aiMarkers.ts 对齐：先按占比算宽、再以 100-left 钳制，
 * left>=100（起点越出时长）时 width=0，零宽标记由渲染层过滤。
 *
 * 换算已抽为纯函数 timelineMarkerRect（src/core/shared/timelineMarkers.ts），
 * node 环境直测，无需 jsdom。
 */

import { describe, expect, it } from 'vitest';
import { timelineMarkerRect } from '@/core/shared/timelineMarkers';
import { buildTimelineMarkers } from '@/core/bili/aiMarkers';

describe('timelineMarkerRect 常规区间（行为不变）', () => {
  it('区间按占比换算 left/width', () => {
    expect(timelineMarkerRect(10, 35, 100)).toEqual({ leftPercent: 10, widthPercent: 25 });
    expect(timelineMarkerRect(0, 50, 100)).toEqual({ leftPercent: 0, widthPercent: 50 });
  });

  it('窄区间保最小可点宽度 0.35', () => {
    const rect = timelineMarkerRect(0, 0.1, 100);
    expect(rect.leftPercent).toBe(0);
    expect(rect.widthPercent).toBeCloseTo(0.35);
  });

  it('超长区间宽度以 100-left 封顶（left+width 不超过 100）', () => {
    const rect = timelineMarkerRect(50, 200, 100);
    expect(rect.leftPercent).toBe(50);
    expect(rect.widthPercent).toBe(50);
    expect(rect.leftPercent + rect.widthPercent).toBeLessThanOrEqual(100);
  });

  it('负起点 left 钳 0', () => {
    const rect = timelineMarkerRect(-5, 10, 100);
    expect(rect.leftPercent).toBe(0);
    expect(rect.widthPercent).toBe(15);
  });
});

describe('timelineMarkerRect 近缘/越界钳制（第 28 轮修复点）', () => {
  it('近缘区间 left∈(99.65,100)：width 钳到 100-left，left+width ≤ 100（修复前溢出到 100.15）', () => {
    const rect = timelineMarkerRect(99.8, 105, 100);
    expect(rect.leftPercent).toBeCloseTo(99.8);
    // 修复前：max(0.35, min(0.2, 5.2)) = 0.35 → left+width = 100.15 溢出右缘
    expect(rect.widthPercent).toBeCloseTo(0.2);
    expect(rect.leftPercent + rect.widthPercent).toBeLessThanOrEqual(100);
  });

  it('left 恰为 100（起点=时长）：width=0，不叠加最小宽度', () => {
    const rect = timelineMarkerRect(100, 120, 100);
    expect(rect.leftPercent).toBe(100);
    expect(rect.widthPercent).toBe(0);
  });

  it('left > 100（起点越出时长）：left 钳 100、width=0', () => {
    const rect = timelineMarkerRect(120, 150, 100);
    expect(rect.leftPercent).toBe(100);
    expect(rect.widthPercent).toBe(0);
    expect(rect.leftPercent + rect.widthPercent).toBeLessThanOrEqual(100);
  });

  it('近缘窄区间 left=99.98：width 钳到 0.02（低于 0.35 下限，不溢出右缘）', () => {
    const rect = timelineMarkerRect(99.98, 105, 100);
    expect(rect.leftPercent).toBeCloseTo(99.98);
    expect(rect.widthPercent).toBeCloseTo(0.02);
    expect(rect.leftPercent + rect.widthPercent).toBeLessThanOrEqual(100);
  });

  it('与 B 站 aiMarkers.buildTimelineMarkers 同口径（常规/越界区间同输入同几何）', () => {
    // 近缘带（left∈(99.65,100)）除外：B 站第 27 轮只钳 left>=100，HDU 本轮把整段
    // 近缘带一并钳到 100-left（见 timelineMarkerRect 注释），该带内两侧几何有意不同
    const intervals: Array<[number, number]> = [[0, 0.1], [10, 35], [50, 200], [120, 150]];
    const markers = buildTimelineMarkers(
      [{ name: 't', summary: '', confidence: 'low', intervals }],
      100,
    );
    intervals.forEach(([start, end], i) => {
      const rect = timelineMarkerRect(start, end, 100);
      expect(rect.leftPercent).toBeCloseTo(markers[i]!.leftPercent);
      expect(rect.widthPercent).toBeCloseTo(markers[i]!.widthPercent);
    });
  });
});
