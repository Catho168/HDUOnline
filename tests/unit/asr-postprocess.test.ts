/** Whisper 后处理：时间戳兜底、塌陷收敛、静音与幻觉过滤。 */

import { describe, expect, it } from 'vitest';
import {
  analyzeAudioLevel,
  buildSegmentsFromWhisper,
  isLikelyHallucination,
  sanitizeSegments,
  textCore,
} from '@/core/asr/postprocess';

describe('analyzeAudioLevel', () => {
  it('空音频与全零音频视为静音', () => {
    expect(analyzeAudioLevel(new Float32Array(0)).silent).toBe(true);
    expect(analyzeAudioLevel(new Float32Array(16_000)).silent).toBe(true);
  });

  it('正常语音电平不会被判为静音', () => {
    const pcm = new Float32Array(16_000);
    for (let index = 0; index < pcm.length; index += 1) {
      pcm[index] = Math.sin((2 * Math.PI * 220 * index) / 16_000) * 0.1;
    }
    const level = analyzeAudioLevel(pcm);
    expect(level.silent).toBe(false);
    expect(level.rms).toBeGreaterThan(0.05);
    expect(level.peak).toBeGreaterThan(0.09);
  });
});

describe('isLikelyHallucination', () => {
  it('过滤重复标点/符号输出', () => {
    expect(isLikelyHallucination('0))))))))))')).toBe(true);
    expect(isLikelyHallucination('??????????')).toBe(true);
    expect(isLikelyHallucination('|)|)|)|)|)')).toBe(true);
    expect(isLikelyHallucination('。，。，。，。，')).toBe(true);
  });

  it('过滤单字循环与常见静音幻觉', () => {
    expect(isLikelyHallucination('哈哈哈哈哈哈')).toBe(true);
    expect(isLikelyHallucination('0000000000')).toBe(true);
    expect(isLikelyHallucination('谢谢观看')).toBe(true);
    expect(isLikelyHallucination('字幕由某某提供')).toBe(true);
  });

  it('保留正常课堂语句', () => {
    expect(isLikelyHallucination('今天我们讲克拉默法则')).toBe(false);
    expect(isLikelyHallucination('老师刚才举了什么例子？')).toBe(false);
    expect(isLikelyHallucination('对，就是这样')).toBe(false);
    expect(isLikelyHallucination('这是课程链接 https://example.com 可以课后看')).toBe(false);
  });

  it('textCore 只保留字母、数字与汉字', () => {
    expect(textCore('0))))')).toBe('0');
    expect(textCore('矩阵 A 的秩 = 3')).toBe('矩阵A的秩3');
  });
});

describe('buildSegmentsFromWhisper', () => {
  it('缺结束时间戳时不再伪造 4 秒（复现 520s/620s 两段 4 秒的问题）', () => {
    const result = buildSegmentsFromWhisper(
      [
        { text: '第一段', timestamp: [520, null] },
        { text: '第二段', timestamp: [620, null] },
      ],
      { offsetSec: 0, audioDurationSec: 600 },
    );
    expect(result.segments).toHaveLength(2);
    const first = result.segments[0]!;
    const second = result.segments[1]!;
    // 第一段延伸到下一段起点（600s），而不是 524s
    expect(first.s).toBe(520);
    expect(first.e).toBe(600);
    // 超出音频末尾的起点会被收敛到最后 0.2 秒，且不会出现 4 秒伪造段
    expect(second.s).toBeGreaterThanOrEqual(599.7);
    expect(second.e).toBe(600);
    for (const segment of result.segments) {
      expect(segment.e - segment.s).not.toBeCloseTo(4, 1);
    }
  });

  it('缺结束时间戳时优先使用下一段起点', () => {
    const result = buildSegmentsFromWhisper(
      [
        { text: '前一句', timestamp: [10, null] },
        { text: '后一句', timestamp: [20, 25] },
      ],
      { offsetSec: 0, audioDurationSec: 60 },
    );
    expect(result.segments[0]).toMatchObject({ s: 10, e: 20 });
  });

  it('最后一段缺结束时间戳时收敛到推理切片末尾', () => {
    const result = buildSegmentsFromWhisper([{ text: '最后一句', timestamp: [50, null] }], {
      offsetSec: 0,
      audioDurationSec: 60,
    });
    expect(result.segments[0]).toMatchObject({ s: 50, e: 60 });
  });

  it('文本很多但时间跨度极小时收敛为整片粗粒度段落', () => {
    const text =
      '这部分内容讲的是矩阵的秩与线性方程组解的关系，老师先回顾了行列式的定义，然后举了一个三阶矩阵的例子，最后说明了满秩与唯一解之间的关系。';
    const result = buildSegmentsFromWhisper([{ text, timestamp: [58, 60] }], {
      offsetSec: 120,
      audioDurationSec: 60,
    });
    expect(result.timestampQuality).toBe('coarse');
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({ s: 120, e: 180, coarse: true, text });
  });

  it('正常时间戳保持原样并应用全局偏移', () => {
    const result = buildSegmentsFromWhisper(
      [
        { text: '第一句', timestamp: [5, 10] },
        { text: '第二句', timestamp: [20, 25] },
        { text: '第三句', timestamp: [40, 45] },
      ],
      { offsetSec: 600, audioDurationSec: 60 },
    );
    expect(result.timestampQuality).toBe('ok');
    expect(result.segments.map((segment) => [segment.s, segment.e])).toEqual([
      [605, 610],
      [620, 625],
      [640, 645],
    ]);
  });

  it('纯符号输出在解析阶段就被丢弃', () => {
    const result = buildSegmentsFromWhisper([{ text: '0))))))))', timestamp: [0, 5] }], {
      offsetSec: 0,
      audioDurationSec: 60,
    });
    expect(result.segments).toEqual([]);
    expect(result.dropped).toBe(1);
    expect(result.timestampQuality).toBe('empty');
  });
});

describe('sanitizeSegments', () => {
  it('过滤幻觉但保留正常段落与 coarse 标记', () => {
    const result = sanitizeSegments([
      { s: 0, e: 5, text: '谢谢观看' },
      { s: 10, e: 20, text: '老师讲了克拉默法则', coarse: true },
      { s: 30, e: 35, text: '？？？？？' },
    ]);
    expect(result.dropped).toBe(2);
    expect(result.segments).toEqual([{ s: 10, e: 20, text: '老师讲了克拉默法则', coarse: true }]);
  });
});
