/**
 * Whisper 输出后处理（纯函数，便于单测）。
 *
 * 解决的问题：
 *  1. 模型对某段音频不给结束时间戳时，旧逻辑用 `start + 4` 兜底，导致 10 分钟的
 *     音频被显示成“只转写了 8 秒”（两个 4 秒段落）；这里改为用下一段起点 / 分片末尾
 *     作为边界，绝不伪造 4 秒。
 *  2. 时间戳整体塌陷（文本很多、时间跨度极小）时，把文本收敛为**整个推理切片**的
 *     粗粒度段落，并标记 `coarse`，让问答仍能按切片范围命中，而不是落到一个随机点。
 *  3. 静音/噪声上 Whisper 会输出重复标点、重复字符或“谢谢观看”一类幻觉；这里在
 *     入库前过滤，避免字幕层出现 `0))))))))` 这种内容。
 */

import { ASR_PARAMS } from '../shared/constants';
import type { TranscriptSegment } from '../shared/types';

export interface WhisperChunkLike {
  text?: string;
  timestamp?: [number | null, number | null] | null;
}

export interface TimestampBuildOptions {
  /** 本次推理音频在整节课中的起点（秒） */
  offsetSec: number;
  /** 本次推理音频的时长（秒） */
  audioDurationSec: number;
  /** 缺失结束时间戳时的兜底段长上限（秒） */
  maxSegmentSec?: number;
}

export interface TimestampBuildResult {
  segments: TranscriptSegment[];
  /** 被判定为幻觉/纯标点而丢弃的段数 */
  dropped: number;
  /** 保留下来的有效字符数（去掉空白与标点） */
  textLength: number;
  timestampQuality: 'ok' | 'coarse' | 'empty';
}

export interface AudioLevel {
  rms: number;
  peak: number;
  silent: boolean;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 只保留字母/数字/汉字，用于重复度与信息量判断 */
export function textCore(text: string): string {
  return text.replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * 判断 Whisper 幻觉。规则刻意保守：只丢弃“几乎不可能是正常课堂语句”的输出，
 * 不按长度或标点数量做过度过滤。
 */
export function isLikelyHallucination(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;

  const compact = trimmed.replace(/\s+/gu, '');
  const core = textCore(trimmed);
  if (core.length === 0) return true;

  // 纯标点/符号：`0))))))))`、`????????`、`|)|)|)` 等
  if (compact.length >= 4 && core.length / compact.length < 0.35) return true;

  // 整段几乎由同一个字符构成：`0000000000`、`哈哈哈哈哈哈`
  if (core.length >= 6) {
    const counts = new Map<string, number>();
    let max = 0;
    for (const char of core) {
      const next = (counts.get(char) ?? 0) + 1;
      counts.set(char, next);
      if (next > max) max = next;
    }
    if (max / core.length >= 0.7) return true;
  }

  // 1–4 字符的短单元循环：`0)0)0)0)`、`啊啊啊`
  if (core.length >= 8 && /^(.{1,4})\1{3,}$/u.test(core)) return true;

  // 三元组高度重复：模型卡在同一个短语上反复输出
  if (core.length >= 12) {
    const counts = new Map<string, number>();
    let max = 0;
    for (let index = 0; index + 3 <= core.length; index += 1) {
      const gram = core.slice(index, index + 3);
      const next = (counts.get(gram) ?? 0) + 1;
      counts.set(gram, next);
      if (next > max) max = next;
    }
    const total = core.length - 2;
    if (total > 0 && max / total >= 0.5) return true;
  }

  // 只有链接/水印，没有实际讲解内容
  if (/(?:https?:\/\/|www\.)\S+/iu.test(trimmed)) {
    const withoutUrl = trimmed.replace(/(?:https?:\/\/|www\.)\S+/giu, '').trim();
    if (textCore(withoutUrl).length < 4) return true;
  }

  // 常见的 Whisper 静音幻觉短语；只在整段几乎就是这句话时丢弃
  const hallucinationPhrases = [
    '谢谢观看',
    '感谢观看',
    '感谢您的观看',
    '字幕由',
    '字幕提供',
    '请不吝点赞',
    '点赞订阅',
    '订阅转发',
    '明镜与点点',
    '优优独播剧场',
    '中文字幕',
    '字幕组',
  ];
  if (core.length <= 16) {
    const lower = core.toLowerCase();
    for (const phrase of hallucinationPhrases) {
      const phraseCore = textCore(phrase).toLowerCase();
      if (phraseCore && lower.includes(phraseCore) && lower.length <= phraseCore.length + 4) {
        return true;
      }
    }
  }

  return false;
}

/** 计算 PCM 电平，判断是否接近数字静音（用于跳过无意义推理） */
export function analyzeAudioLevel(pcm: Float32Array): AudioLevel {
  if (pcm.length === 0) return { rms: 0, peak: 0, silent: true };
  let sumSquares = 0;
  let peak = 0;
  for (let index = 0; index < pcm.length; index += 1) {
    const sample = pcm[index] ?? 0;
    sumSquares += sample * sample;
    const absolute = Math.abs(sample);
    if (absolute > peak) peak = absolute;
  }
  const rms = Math.sqrt(sumSquares / pcm.length);
  return {
    rms,
    peak,
    silent: rms < ASR_PARAMS.silenceRms && peak < ASR_PARAMS.silencePeak,
  };
}

/** 过滤非法/幻觉段落，保留顺序与文本内容 */
export function sanitizeSegments(
  segments: TranscriptSegment[],
): { segments: TranscriptSegment[]; dropped: number } {
  const out: TranscriptSegment[] = [];
  let dropped = 0;
  for (const segment of segments) {
    const text = segment.text.trim();
    if (!text || !Number.isFinite(segment.s) || !Number.isFinite(segment.e)) {
      dropped += 1;
      continue;
    }
    if (isLikelyHallucination(text)) {
      dropped += 1;
      continue;
    }
    out.push({ ...segment, text });
  }
  return { segments: out, dropped };
}

/**
 * 把 transformers.js 的 `chunks` 转成带全局时间戳的段落。
 *
 * 时间戳规则（不再出现硬编码 4 秒）：
 *  - 有结束时间戳：直接用；
 *  - 缺结束时间戳：优先用下一段的起点，其次 `start + maxSegmentSec`，再裁剪到音频末尾；
 *  - 起点缺失：按段落在 chunks 中的位置比例估算（唯一可用的信息）。
 */
export function buildSegmentsFromWhisper(
  chunks: WhisperChunkLike[],
  opts: TimestampBuildOptions,
): TimestampBuildResult {
  const durationSec = Math.max(0, opts.audioDurationSec);
  const maxSegmentSec = Math.max(1, opts.maxSegmentSec ?? 30);
  if (chunks.length === 0 || durationSec <= 0) {
    return { segments: [], dropped: 0, textLength: 0, timestampQuality: 'empty' };
  }

  const rawStarts = chunks.map((chunk) => {
    const raw = chunk.timestamp?.[0];
    return isFiniteNumber(raw) ? clamp(raw, 0, durationSec) : null;
  });

  const accepted: Array<{ start: number; end: number; text: string; missingTimestamp: boolean }> = [];
  let dropped = 0;
  let textLength = 0;

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const text = (chunk?.text ?? '').trim();
    if (!text) continue;
    if (isLikelyHallucination(text)) {
      dropped += 1;
      continue;
    }

    const rawStart = rawStarts[index] ?? null;
    const rawEndValue = chunk?.timestamp?.[1];
    const rawEnd = isFiniteNumber(rawEndValue) ? clamp(rawEndValue, 0, durationSec) : null;

    let start = rawStart ?? (index / Math.max(1, chunks.length)) * durationSec;
    let end: number;
    if (rawEnd !== null && rawEnd > start) {
      end = rawEnd;
    } else {
      // 下一段有明确起点时，用它作为本段终点；否则最多延伸 maxSegmentSec
      let nextStart: number | null = null;
      for (let next = index + 1; next < rawStarts.length; next += 1) {
        const value = rawStarts[next];
        if (value !== null && value !== undefined && value > start) {
          nextStart = value;
          break;
        }
      }
      end = nextStart ?? Math.min(durationSec, start + maxSegmentSec);
    }

    // 极端情况：起点落在音频末尾，给一个可见的最小段
    if (!(end > start)) {
      start = Math.max(0, Math.min(start, durationSec - 0.2));
      end = Math.min(durationSec, start + 0.2);
    }
    end = Math.min(durationSec, Math.max(end, start + 0.05));

    accepted.push({
      start,
      end,
      text,
      missingTimestamp: rawStart === null || rawEnd === null,
    });
    textLength += textCore(text).length;
  }

  if (accepted.length === 0) {
    return { segments: [], dropped, textLength: 0, timestampQuality: 'empty' };
  }

  const minStart = Math.min(...accepted.map((segment) => segment.start));
  const maxEnd = Math.max(...accepted.map((segment) => segment.end));
  const span = Math.max(0, maxEnd - minStart);
  const missing = accepted.filter((segment) => segment.missingTimestamp).length;

  // 文本量不小、时间跨度却只占切片的很小一部分 → 时间戳不可信。
  // 与其把整段讲解挂到某个随机 4 秒上，不如按整个切片对齐，并标记为粗粒度。
  const collapsed =
    durationSec >= 15 &&
    textLength >= 30 &&
    (span < Math.max(4, durationSec * 0.15) ||
      (missing > 0 && accepted.length <= 2 && textLength >= 80));

  if (collapsed) {
    const text = accepted.map((segment) => segment.text).join(' ').trim();
    return {
      segments: [
        {
          s: round2(opts.offsetSec),
          e: round2(opts.offsetSec + durationSec),
          text,
          coarse: true,
        },
      ],
      dropped,
      textLength,
      timestampQuality: 'coarse',
    };
  }

  const segments = accepted.map((segment) => {
    const start = round2(opts.offsetSec + segment.start);
    const end = round2(opts.offsetSec + segment.end);
    return {
      s: start,
      e: end > start ? end : round2(start + 0.05),
      text: segment.text,
    };
  });

  return { segments, dropped, textLength, timestampQuality: 'ok' };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
