/**
 * 问答上下文裁剪（§6.4②）。
 *
 * 锚点窗口与转写时间轴的交集必须显式判断：片段流式转写（默认 ±10 分钟）
 * 只覆盖看过的区域，窗口内没有字幕时**不能**退回开头若干段冒充上下文，
 * 否则模型看到的是别处的内容，只会回答"字幕不足/为空"。
 */

import type { TranscriptSegment } from '../shared/types';

/** 与窗口相交的段落（半开区间；无窗口恒为全部） */
export function selectWindowSegments(
  segments: TranscriptSegment[],
  range: [number, number],
): TranscriptSegment[] {
  const [start, end] = range;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
  return segments.filter((seg) => seg.e >= start && seg.s <= end);
}

/** 转写实际覆盖的时间范围（首段起点 ~ 末段终点）；无有效段落时返回 null */
export function transcriptSpan(segments: TranscriptSegment[]): { start: number; end: number } | null {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const seg of segments) {
    if (!Number.isFinite(seg.s) || !Number.isFinite(seg.e)) continue;
    start = Math.min(start, seg.s);
    end = Math.max(end, seg.e);
  }
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : null;
}

/**
 * 转写覆盖的连续区段（相邻段落间隔不超过 gapSec 视为同一段）。
 * 片段流式转写会留下多个窗口；"已转写 00:00–40:00" 这种首尾说法会把空档也算进去。
 */
export function transcriptRanges(
  segments: TranscriptSegment[],
  gapSec = 60,
): Array<{ start: number; end: number }> {
  const sorted = segments
    .filter((seg) => Number.isFinite(seg.s) && Number.isFinite(seg.e) && seg.e > seg.s)
    .slice()
    .sort((a, b) => a.s - b.s);
  const ranges: Array<{ start: number; end: number }> = [];
  for (const seg of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && seg.s - last.end <= gapSec) {
      last.end = Math.max(last.end, seg.e);
    } else {
      ranges.push({ start: seg.s, end: seg.e });
    }
  }
  return ranges;
}
