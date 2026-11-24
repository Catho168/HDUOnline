/**
 * 字幕导出序列化单测（第 105 轮巡检）：buildSubtitleTxt / buildSubtitleSrt——
 * 时间轴格式、脏段落跳过、空输入防御。
 */
import { describe, expect, it } from 'vitest';
import { buildSubtitleSrt, buildSubtitleTxt } from '@/core/export/subtitles';
import type { TranscriptEntity } from '@/core/shared/types';

const transcript = (segments: Array<{ s: number; e: number; text: string }>): TranscriptEntity =>
  ({
    mediaKey: 'bili:BV1test',
    segments,
    model: 'bili-official-subtitle',
    lang: 'zh-CN',
    glossaryVersion: 0,
    createdAt: 0,
    source: 'bili-official-subtitle',
    coveredSec: 0,
    coverage: [],
    durationSec: 0,
    aiSubtitle: false,
    partial: false,
  }) as TranscriptEntity;

describe('字幕导出序列化（第 105 轮）', () => {
  it('TXT：[mm:ss] 文本；≥1h 带时位', () => {
    const txt = buildSubtitleTxt(
      transcript([
        { s: 65, e: 70, text: '矩阵乘法' },
        { s: 3675, e: 3680, text: '特征值' },
      ]),
    );
    expect(txt).toContain('[01:05] 矩阵乘法');
    expect(txt).toContain('[1:01:15] 特征值');
  });

  it('SRT：序号 + HH:MM:SS,mmm 时间轴（毫秒截断）', () => {
    const srt = buildSubtitleSrt(
      transcript([
        { s: 65.4, e: 70, text: '矩阵乘法' },
        { s: 70, e: 75, text: '特征值' },
      ]),
    );
    expect(srt).toContain('1\n00:01:05,400 --> 00:01:10,000\n矩阵乘法');
    expect(srt).toContain('2\n00:01:10,000 --> 00:01:15,000\n特征值');
  });

  it('脏段落跳过；e 缺失按 s+1 兜底；空输入返回空串', () => {
    const srt = buildSubtitleSrt(
      transcript([
        { s: -1, e: 5, text: '负数跳过' },
        { s: 10, e: NaN, text: '无结束' },
        { s: 12, e: 15, text: '  ' },
        { s: 20, e: 25, text: '有效' },
      ]),
    );
    expect(srt).toContain('00:00:10,000 --> 00:00:11,000');
    expect(srt).toContain('有效');
    expect(srt).not.toContain('负数跳过');
    expect(buildSubtitleTxt(null)).toBe('');
    expect(buildSubtitleSrt(transcript([]))).toBe('');
  });
});
