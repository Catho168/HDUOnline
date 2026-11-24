/** ASR 相关纯函数测试（§9.1：重采样正确性、样本区间计算、词表替换）。 */

import { describe, expect, it } from 'vitest';
import { StreamingResampler, concatFloat32, downmixToMono, resampleLinear } from '@/core/asr/resample';
import { buildSampleTimeline, extractSampleBytes, mergeRanges } from '@/core/asr/mp4';
import {
  BUILTIN_GLOSSARY,
  BUILTIN_GLOSSARY_SIZE,
  applyGlossaryToSegments,
  applyGlossaryToText,
  buildGlossaryPrompt,
  glossaryVersion,
} from '@/core/asr/glossary';

// ───────────────────────── 重采样 ─────────────────────────

describe('resampleLinear', () => {
  it('正弦波重采样后频率保持（过零率校验）', () => {
    const fromRate = 48000;
    const toRate = 16000;
    const freq = 440;
    const seconds = 1;
    const input = new Float32Array(fromRate * seconds);
    for (let i = 0; i < input.length; i += 1) {
      input[i] = Math.sin((2 * Math.PI * freq * i) / fromRate);
    }

    const { output } = resampleLinear(input, fromRate, toRate);
    expect(output.length).toBeCloseTo(toRate * seconds, -1);

    // 统计过零次数 → 估计频率
    let zeroCrossings = 0;
    for (let i = 1; i < output.length; i += 1) {
      if ((output[i - 1] ?? 0) <= 0 && (output[i] ?? 0) > 0) zeroCrossings += 1;
    }
    const estimatedFreq = zeroCrossings / seconds;
    expect(estimatedFreq).toBeGreaterThan(freq * 0.98);
    expect(estimatedFreq).toBeLessThan(freq * 1.02);
  });

  it('采样率一致时原样返回（不共享底层缓冲）', () => {
    const input = new Float32Array([1, 2, 3]);
    const { output } = resampleLinear(input, 16000, 16000);
    expect([...output]).toEqual([1, 2, 3]);
    expect(output).not.toBe(input);
  });

  it('空输入返回空输出并保留 tail 状态', () => {
    const tail = { sample: 0.5, hasTail: true };
    const { output, lastSample } = resampleLinear(new Float32Array(0), 48000, 16000, tail);
    expect(output.length).toBe(0);
    expect(lastSample).toEqual(tail);
  });

  it('跨批重采样保持边界连续（StreamingResampler）', () => {
    const rate = 48000;
    const batch = new Float32Array(rate);
    for (let i = 0; i < batch.length; i += 1) batch[i] = Math.sin((2 * Math.PI * 200 * i) / rate);
    const resampler = new StreamingResampler(rate, 16000);
    const first = resampler.push(batch);
    const second = resampler.push(batch);
    // 两批各 1 秒，输出应各约 16000 点（批次间无缝）
    expect(first.length).toBeGreaterThan(15900);
    expect(second.length).toBeGreaterThan(15900);
    // 边界样本应接近（无突变）
    expect(Math.abs((first[first.length - 1] ?? 0) - (second[0] ?? 0))).toBeLessThan(0.2);
    expect(resampler.outputRate).toBe(16000);
  });
});

describe('downmixToMono', () => {
  it('单声道直通', () => {
    const mono = new Float32Array([0.5, -0.5]);
    expect([...downmixToMono([mono])]).toEqual([0.5, -0.5]);
  });

  it('双声道取平均', () => {
    const left = new Float32Array([1, 0]);
    const right = new Float32Array([0, 1]);
    const result = downmixToMono([left, right]);
    expect(result[0]).toBeCloseTo(0.5);
    expect(result[1]).toBeCloseTo(0.5);
  });

  it('空输入返回空数组', () => {
    expect(downmixToMono([]).length).toBe(0);
  });

  it('不同长度的声道按最短长度下混', () => {
    const result = downmixToMono([new Float32Array([1, 1, 1]), new Float32Array([1, 1])]);
    expect([...result]).toEqual([1, 1, 0]);
  });
});

describe('concatFloat32', () => {
  it('按顺序拼接且不修改入参', () => {
    const first = new Float32Array([1, 2]);
    const result = concatFloat32([first, new Float32Array([3])]);
    expect([...result]).toEqual([1, 2, 3]);
    expect([...first]).toEqual([1, 2]);
  });

  it('空列表返回空数组', () => {
    expect(concatFloat32([]).length).toBe(0);
  });
});

// ───────────────────────── 样本区间（stsc/stco 语义） ─────────────────────────

/** 构造 mp4box 形态的 Sample 列表（仅用到 offset/size/dts/duration/timescale） */
function makeSamples(): Array<{ offset: number; size: number; dts: number; duration: number; timescale: number }> {
  // 模拟：每 1024 个采样一帧（AAC-LC），每帧 300 字节，帧时长 = 1024/48000 秒
  const count = 100;
  return Array.from({ length: count }, (_, index) => ({
    offset: index * 300,
    size: 300,
    dts: index * 1024,
    duration: 1024,
    timescale: 48000,
  }));
}

describe('mergeRanges', () => {
  it('相邻样本合并为连续区间', () => {
    const samples = makeSamples();
    const ranges = mergeRanges(samples as never, 3_000_000);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toEqual({ start: 0, end: 100 * 300 - 1 });
  });

  it('超过批次上限时切分为多段', () => {
    const samples = makeSamples();
    // 10 个样本 ≈ 3000 字节；限制 1500 字节 → 至少 2 段
    const ranges = mergeRanges(samples as never, 1500);
    expect(ranges.length).toBeGreaterThan(1);
    for (const range of ranges) {
      expect(range.end - range.start + 1).toBeLessThanOrEqual(1500 + 300);
    }
  });

  it('大间隙不合并', () => {
    const samples = [
      { offset: 0, size: 100, dts: 0, duration: 1024, timescale: 48000 },
      { offset: 10 * 1024 * 1024, size: 100, dts: 1024, duration: 1024, timescale: 48000 },
    ];
    const ranges = mergeRanges(samples as never, 3_000_000);
    expect(ranges).toHaveLength(2);
  });

  it('空样本列表返回空区间', () => {
    expect(mergeRanges([])).toEqual([]);
  });
});

describe('buildSampleTimeline', () => {
  it('依据 dts/timescale 计算起点与时长', () => {
    const samples = makeSamples();
    const timeline = buildSampleTimeline(samples as never, 48000);
    expect(timeline[0]?.startSec).toBe(0);
    expect(timeline[1]?.startSec).toBeCloseTo(1024 / 48000, 6);
    expect(timeline[1]?.durationSec).toBeCloseTo(1024 / 48000, 6);
  });

  it('timescale 非法时按 1000 兜底', () => {
    const timeline = buildSampleTimeline([{ dts: 500, duration: 250 } as never], 0);
    expect(timeline[0]?.startSec).toBe(0.5);
    expect(timeline[0]?.durationSec).toBe(0.25);
  });
});

describe('extractSampleBytes', () => {
  it('从拉取到的缓冲区中切出每个样本', () => {
    const samples = makeSamples().slice(0, 3);
    const buffer = new Uint8Array(900);
    for (let i = 0; i < buffer.length; i += 1) buffer[i] = i % 256;
    const result = extractSampleBytes(samples as never, [{ start: 0, bytes: buffer }]);
    expect(result).toHaveLength(3);
    expect(result[0]?.data.byteLength).toBe(300);
    expect(result[0]?.data[0]).toBe(0);
    expect(result[1]?.data[0]).toBe(44); // 300 % 256
    expect(result[2]?.data[0]).toBe(88); // 600 % 256
  });

  it('缓冲区未覆盖时返回空数据（调用方据此报错）', () => {
    const samples = makeSamples().slice(0, 2);
    const result = extractSampleBytes(samples as never, [{ start: 0, bytes: new Uint8Array(100) }]);
    expect(result[0]?.data.byteLength).toBe(0);
  });
});

// ───────────────────────── 术语纠错 ─────────────────────────

describe('glossary', () => {
  it('确定性替换误听词', () => {
    const text = '下面用科拉莫法则解这个方程，先求行列势。';
    expect(applyGlossaryToText(text, BUILTIN_GLOSSARY)).toBe('下面用克拉默法则解这个方程，先求行列式。');
  });

  it('长词优先，避免短词先替换导致长词失配', () => {
    const glossary = { 科拉莫: 'X', 科拉莫法则: '克拉默法则' };
    expect(applyGlossaryToText('科拉莫法则', glossary)).toBe('克拉默法则');
  });

  it('支持正则条目（/pattern/flags 形式）', () => {
    const glossary = { '/第(\\d+)节/g': '第$1节' };
    expect(applyGlossaryToText('第7节', glossary)).toBe('第7节');
    const replacing = { '/第(\\d+)节/g': '第$1讲' };
    expect(applyGlossaryToText('第7节', replacing)).toBe('第7讲');
  });

  it('恒等条目与空键被忽略', () => {
    const glossary = { 满秩: '满秩', '': 'x' };
    expect(applyGlossaryToText('满秩矩阵', glossary)).toBe('满秩矩阵');
    expect(BUILTIN_GLOSSARY_SIZE).toBeGreaterThan(0);
  });

  it('空文本原样返回', () => {
    expect(applyGlossaryToText('', BUILTIN_GLOSSARY)).toBe('');
  });

  it('segments 替换不修改入参；空词表也返回新数组', () => {
    const segments = [{ s: 0, e: 5, text: '航列式' }];
    const result = applyGlossaryToSegments(segments, BUILTIN_GLOSSARY);
    expect(result[0]?.text).toBe('行列式');
    expect(segments[0]?.text).toBe('航列式');
    expect(result[0]).not.toBe(segments[0]);

    const cloned = applyGlossaryToSegments(segments, {});
    expect(cloned[0]).toEqual(segments[0]);
    expect(cloned[0]).not.toBe(segments[0]);
  });

  it('版本号对键序不敏感、对内容敏感', () => {
    const v1 = glossaryVersion({ a: '1', b: '2' });
    const v2 = glossaryVersion({ b: '2', a: '1' });
    const v3 = glossaryVersion({ a: '1', b: '3' });
    expect(v1).toBe(v2);
    expect(v1).not.toBe(v3);
  });

  it('术语偏置提示词只含字面词条且有长度上限', () => {
    const prompt = buildGlossaryPrompt(BUILTIN_GLOSSARY, 5);
    expect(prompt).toBeTruthy();
    expect(prompt?.startsWith('本课程术语：')).toBe(true);
    expect((prompt ?? '').split('、').length).toBeLessThanOrEqual(5);
    expect(prompt).not.toContain('/');
    expect(buildGlossaryPrompt({ '/x/g': 'y' })).toBeUndefined();
  });
});
