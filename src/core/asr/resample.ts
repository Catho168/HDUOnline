/**
 * 音频下混与重采样（§5.2 步骤 ④）。
 *
 * 实现说明：这里用**线性插值重采样**而非 OfflineAudioContext，原因：
 *  - 可在 Worker 内直接运行（不需要 DOM/AudioContext）；
 *  - 无需为每批数据创建 OfflineAudioContext 实例，避免频繁 GC 抖动；
 *  - 16k 单声道语音场景下线性插值质量足够（Whisper 前端本就带 Mel 滤波与归一化）。
 * OfflineAudioContext 路径保留为可选（见 §5.2 说明）；兜底整文件路径由 Offscreen 使用。
 */

/** 多声道下混为单声道（简单平均；不同长度时只下混公共前缀，尾部保持 0） */
export function downmixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0] as Float32Array;
  let maxLength = 0;
  let commonLength = Number.POSITIVE_INFINITY;
  for (const channel of channels) {
    maxLength = Math.max(maxLength, channel.length);
    commonLength = Math.min(commonLength, channel.length);
  }
  // 输出按最长声道分配；超过公共长度的部分没有完整的多声道样本，保持 0。
  const out = new Float32Array(maxLength);
  const scale = 1 / channels.length;
  for (let i = 0; i < commonLength; i += 1) {
    let sum = 0;
    for (const channel of channels) sum += channel[i] ?? 0;
    out[i] = sum * scale;
  }
  return out;
}

/**
 * 线性插值重采样。
 * @param input 输入样本（单声道）
 * @param fromRate 输入采样率
 * @param toRate 输出采样率（本项目固定 16000）
 * @param tail 上一次调用遗留的最后一个样本（跨批拼接，避免边界爆音）
 */
export function resampleLinear(
  input: Float32Array,
  fromRate: number,
  toRate: number,
  tail?: { sample: number; hasTail: boolean },
): { output: Float32Array; lastSample: { sample: number; hasTail: boolean } } {
  if (input.length === 0) {
    return { output: new Float32Array(0), lastSample: tail ?? { sample: 0, hasTail: false } };
  }
  if (fromRate === toRate) {
    return { output: input.slice(), lastSample: { sample: input[input.length - 1] ?? 0, hasTail: true } };
  }
  const ratio = fromRate / toRate;
  // 首样本若存在 tail，则从 tail 到 input[0] 之间也参与插值
  const prev = tail?.hasTail ? tail.sample : undefined;
  const totalIn = input.length + (prev !== undefined ? 1 : 0);
  const outLength = Math.max(0, Math.floor((totalIn - 1) / ratio) + 1);
  const out = new Float32Array(outLength);
  const at = (index: number): number =>
    index === 0 && prev !== undefined ? prev : (input[prev !== undefined ? index - 1 : index] ?? 0);

  for (let i = 0; i < outLength; i += 1) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const s0 = at(i0);
    const s1 = at(Math.min(i0 + 1, totalIn - 1));
    out[i] = s0 + (s1 - s0) * frac;
  }
  return { output: out, lastSample: { sample: input[input.length - 1] ?? 0, hasTail: true } };
}

/** 累计重采样器：跨批保持边界连续 */
export class StreamingResampler {
  private tail?: { sample: number; hasTail: boolean };

  constructor(
    private readonly fromRate: number,
    private readonly toRate: number,
  ) {}

  push(samples: Float32Array): Float32Array {
    const { output, lastSample } = resampleLinear(samples, this.fromRate, this.toRate, this.tail);
    this.tail = lastSample;
    return output;
  }

  get outputRate(): number {
    return this.toRate;
  }
}

/** 把 AudioData 的 planar f32 数据取成 Float32Array[]（按声道） */
export function extractPlanarChannels(
  copyTo: (destination: Float32Array, options: { planeIndex: number; format?: 'f32-planar' }) => void,
  numberOfFrames: number,
  numberOfChannels: number,
): Float32Array[] {
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numberOfChannels; ch += 1) {
    const buffer = new Float32Array(numberOfFrames);
    try {
      copyTo(buffer, { planeIndex: ch, format: 'f32-planar' });
      channels.push(buffer);
    } catch {
      // 该平面不存在（某些解码器只提供交错格式）时跳过
    }
  }
  return channels;
}

/** 拼接多个 Float32Array（返回新数组，不修改入参） */
export function concatFloat32(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((acc, c) => acc + c.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
