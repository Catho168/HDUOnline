/** ASR Worker ↔ Offscreen 文档的消息协议。 */

import type { SerializedAppError } from '../shared/errors';
import type { AsrModelTier } from '../shared/constants';
import type { MediaKey } from '../shared/mediaRef';
import type { AsrQualityStats, TranscriptSegment } from '../shared/types';

export interface WorkerStartPayload {
  /** 媒体主键（`hdu:<courId>` / `bili:<bvid>`；Worker 不解析，仅透传给管线日志） */
  mediaKey: MediaKey;
  viewNum: number;
  audioUrl: string;
  doneChunks: number[];
  totalChunks: number;
  chunkSec: number;
  durationSec: number;
  modelTier: AsrModelTier;
  lang: 'zh' | 'en' | 'auto';
  remoteHost: string;
  /** 扩展内 wasm 目录（绝对 chrome-extension:// 地址；Worker 内可能拿不到 chrome.*） */
  wasmBaseUrl?: string;
  glossaryPrompt?: string;
  /** 只转写该时间窗（§5.2 B1：片段流式，只转当前进度前后 x 分钟） */
  window?: { start: number; end: number };
}

export type WorkerInbound =
  | { type: 'W_START'; payload: WorkerStartPayload }
  | { type: 'W_CONTROL'; action: 'pause' | 'resume' | 'cancel' }
  | { type: 'W_WARMUP'; modelTier: AsrModelTier; lang: 'zh' | 'en' | 'auto'; remoteHost: string; wasmBaseUrl?: string }
  /** 兜底模式：Offscreen 已解码好 PCM，按 worker 的请求逐片回灌 */
  | { type: 'W_FEED_BEGIN'; payload: WorkerStartPayload }
  | { type: 'W_FEED_PCM'; chunk: { chunkIndex: number; startSec: number; endSec: number; pcm: Float32Array } }
  | { type: 'W_FEED_END' };

export type WorkerOutbound =
  | { type: 'W_READY' }
  | {
      type: 'W_PROGRESS';
      payload: {
        phase: 'extracting' | 'decoding' | 'transcribing' | 'finalizing';
        progress: number;
        doneChunks: number;
        totalChunks: number;
        rate?: number;
        etaSec?: number;
      };
    }
  | {
      type: 'W_CHUNK';
      payload: {
        chunkIndex: number;
        startSec: number;
        endSec: number;
        segments: TranscriptSegment[];
      };
    }
  | {
      type: 'W_DONE';
      payload: { segmentCount: number; coveredSec: number; model: string; stats: AsrQualityStats };
    }
  | {
      type: 'W_FAILED';
      error: SerializedAppError;
      needFallback: boolean;
      errorKind: 'network' | 'decode' | 'model' | 'memory' | 'unknown';
    }
  | { type: 'W_MODEL_PROGRESS'; payload: { loaded: number; total: number; file?: string } }
  /** 兜底模式：请求下一片 PCM（Offscreen 收到后回 W_FEED_PCM 或 W_FEED_END） */
  | { type: 'W_FEED_WANT'; chunkIndex: number }
  | { type: 'W_WARMUP_DONE'; ok: boolean; device?: string; error?: SerializedAppError };
