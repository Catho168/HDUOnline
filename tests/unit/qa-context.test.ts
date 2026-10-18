/** 问答上下文裁剪（锚点窗口与转写覆盖范围）的边界测试。 */

import { describe, expect, it } from 'vitest';
import { selectWindowSegments, transcriptRanges, transcriptSpan } from '@/core/llm/context';
import type { TranscriptSegment } from '@/core/shared/types';

const segments: TranscriptSegment[] = [
  { s: 0, e: 10, text: '开场' },
  { s: 10, e: 20, text: '第一节' },
  { s: 600, e: 620, text: '中间' },
  { s: 1200, e: 1230, text: '结尾' },
];

describe('selectWindowSegments', () => {
  it('只保留与锚点窗口相交的段落', () => {
    expect(selectWindowSegments(segments, [5, 15]).map((s) => s.text)).toEqual(['开场', '第一节']);
    expect(selectWindowSegments(segments, [590, 610]).map((s) => s.text)).toEqual(['中间']);
  });

  it('落在转写覆盖范围之外的窗口返回空数组（不再退回开头片段）', () => {
    expect(selectWindowSegments(segments, [2000, 2100])).toEqual([]);
    expect(selectWindowSegments(segments, [400, 500])).toEqual([]);
  });

  it('区间端点相接时算相交（与分段连续的时间轴一致）', () => {
    expect(selectWindowSegments(segments, [20, 30]).map((s) => s.text)).toEqual(['第一节']);
    expect(selectWindowSegments(segments, [620, 630]).map((s) => s.text)).toEqual(['中间']);
  });

  it('非法窗口不返回任何段落', () => {
    expect(selectWindowSegments(segments, [Number.NaN, 100])).toEqual([]);
    expect(selectWindowSegments(segments, [100, Number.POSITIVE_INFINITY])).toEqual([]);
  });
});

describe('transcriptSpan', () => {
  it('取首段起点与末段终点', () => {
    expect(transcriptSpan(segments)).toEqual({ start: 0, end: 1230 });
  });

  it('空数组与非法时间返回 null', () => {
    expect(transcriptSpan([])).toBeNull();
    expect(transcriptSpan([{ s: Number.NaN, e: Number.NaN, text: 'x' }])).toBeNull();
  });

  it('乱序段落也能得到完整覆盖范围', () => {
    expect(transcriptSpan([segments[3]!, segments[0]!])).toEqual({ start: 0, end: 1230 });
  });
});

describe('transcriptRanges', () => {
  it('窗口之间的大空档拆成多段（不把没转写的区间算进覆盖）', () => {
    expect(transcriptRanges(segments)).toEqual([
      { start: 0, end: 20 },
      { start: 600, end: 620 },
      { start: 1200, end: 1230 },
    ]);
  });

  it('相邻段落的短间隔会合并', () => {
    expect(
      transcriptRanges([
        { s: 0, e: 10, text: 'a' },
        { s: 30, e: 50, text: 'b' },
        { s: 200, e: 210, text: 'c' },
      ]),
    ).toEqual([
      { start: 0, end: 50 },
      { start: 200, end: 210 },
    ]);
  });

  it('空数组与非法段落被忽略', () => {
    expect(transcriptRanges([])).toEqual([]);
    expect(transcriptRanges([{ s: Number.NaN, e: 5, text: 'x' }])).toEqual([]);
  });
});
