/**
 * 类型化消息协议（技术文档 §2.2）。
 * 请求-响应经 REQUEST/RESPONSE；推送经 EVENT；大对象只传 IndexedDB key。
 */

import type { SerializedAppError } from './errors';
import type { OpArgs, OpName } from './ops';
import type {
  AsrJobEntity,
  AsrQualityStats,
  PageContext,
  PlayerState,
  PopupOverview,
  SessionMeta,
  TranscriptSegment,
} from './types';

// ───────────────────────── 推送事件 ─────────────────────────

export type EventPayload =
  | { name: 'SEEK_TO'; data: { courId: number; seconds: number; viewNum?: number } }
  | {
      name: 'UI_COMMAND';
      data: {
        command: 'openPanel' | 'closePanel' | 'togglePanel' | 'openCenter' | 'toast';
        message?: string;
        level?: 'info' | 'warn' | 'error';
      };
    }
  | { name: 'ASR_PROGRESS'; data: { courId: number; job: AsrJobEntity } }
  | {
      name: 'ASR_SEGMENTS';
      data: { courId: number; segments: TranscriptSegment[]; window?: { start: number; end: number } };
    }
  | { name: 'ASR_DONE'; data: { courId: number; segmentCount: number; coveredSec: number; auto?: boolean } }
  | { name: 'ASR_FAILED'; data: { courId: number; error: SerializedAppError; auto?: boolean } }
  | { name: 'AI_PROGRESS'; data: { courId: number; stage: 'preparing' | 'requesting' | 'validating' | 'retrying'; progress?: number } }
  | { name: 'AI_DONE'; data: { courId: number; result: { topicCount: number; outlineCount: number; cached: boolean } } }
  | { name: 'AI_FAILED'; data: { courId: number; error: SerializedAppError } }
  | { name: 'QA_DELTA'; data: { chatId: string; groupId: string; text: string } }
  | { name: 'QA_DONE'; data: { chatId: string; message: unknown } }
  | { name: 'QA_FAILED'; data: { chatId: string; error: SerializedAppError } }
  | { name: 'MODEL_PROGRESS'; data: { tier: string; loaded: number; total: number; file?: string } }
  | { name: 'MODEL_DONE'; data: { tier: string } }
  | { name: 'MODEL_FAILED'; data: { tier: string; error: SerializedAppError } }
  | { name: 'SESSION_META_READY'; data: { meta: SessionMeta } }
  | { name: 'SITE_SESSION_HINT'; data: { url: string; courId?: number } }
  | { name: 'SETTINGS_APPLIED'; data: Record<string, never> }
  | { name: 'STATS_UPDATED'; data: { courId?: number } };

export type EventName = EventPayload['name'];

// ───────────────────────── SW → Offscreen ─────────────────────────

export interface OffscreenAsrStart {
  type: 'OFFSCREEN_ASR_START';
  courId: number;
  viewNum: number;
  audioUrl: string;
  doneChunks: number[];
  totalChunks: number;
  chunkSec: number;
  durationSec: number;
  modelTier: 'fast' | 'standard' | 'high';
  lang: 'zh' | 'en' | 'auto';
  glossaryPrompt?: string;
  window?: { start: number; end: number };
}

export interface OffscreenAsrControl {
  type: 'OFFSCREEN_ASR_CONTROL';
  courId: number;
  action: 'pause' | 'resume' | 'cancel';
}

export interface OffscreenAsrChunkDone {
  type: 'OFFSCREEN_ASR_CHUNK_DONE';
  courId: number;
  viewNum: number;
  chunkIndex: number;
  startSec: number;
  endSec: number;
  segments: TranscriptSegment[];
}

export interface OffscreenModelProgress {
  type: 'OFFSCREEN_MODEL_PROGRESS';
  tier: 'fast' | 'standard' | 'high';
  loaded: number;
  total: number;
  file?: string;
}

export interface OffscreenPing {
  type: 'OFFSCREEN_PING';
}

export interface OffscreenPingReply {
  type: 'OFFSCREEN_PING_REPLY';
  activeCourIds: number[];
  device?: string;
}

export interface OffscreenAsrProgress {
  type: 'OFFSCREEN_ASR_PROGRESS';
  courId: number;
  phase: 'extracting' | 'decoding' | 'transcribing' | 'finalizing';
  progress: number;
  doneChunks: number;
  totalChunks: number;
  rate?: number;
  etaSec?: number;
}

export interface OffscreenAsrDone {
  type: 'OFFSCREEN_ASR_DONE';
  courId: number;
  segmentCount: number;
  coveredSec: number;
  model: string;
  durationSec: number;
  stats?: AsrQualityStats;
}

export interface OffscreenAsrFailed {
  type: 'OFFSCREEN_ASR_FAILED';
  courId: number;
  error: SerializedAppError;
  errorKind: 'network' | 'decode' | 'model' | 'memory' | 'unknown';
}

export interface OffscreenWarmup {
  type: 'OFFSCREEN_WARMUP';
  modelTier: 'fast' | 'standard' | 'high';
}

export interface OffscreenWarmupDone {
  type: 'OFFSCREEN_WARMUP_DONE';
  ok: boolean;
  device?: string;
  error?: SerializedAppError;
}

export interface OffscreenShotCapture {
  type: 'OFFSCREEN_SHOT';
  requestId: string;
  courId: number;
  teclId: number;
  view: number;
  atSec: number;
  url: string;
  watermark: boolean;
  meta: { courseName: string; courLabel: string; anchorTime: number };
}

export interface OffscreenShotResult {
  type: 'OFFSCREEN_SHOT_RESULT';
  requestId: string;
  ok: boolean;
  screenshotId?: string;
  width?: number;
  height?: number;
  error?: SerializedAppError;
}

export interface OffscreenLlmRun {
  type: 'OFFSCREEN_LLM_RUN';
  runId: string;
  provider: { kind: 'anthropic-messages' | 'openai-chat' | 'openai-responses'; baseUrl: string; model: string; apiKey: string };
  request: {
    system: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    maxTokens?: number;
    temperature?: number;
    jsonMode?: boolean;
    stream: boolean;
  };
  timeouts: { connectMs: number; firstByteMs: number; totalMs: number };
  allowLocalEndpoints: boolean;
}

export interface OffscreenLlmAbort {
  type: 'OFFSCREEN_LLM_ABORT';
  runId: string;
}

export interface OffscreenLlmDelta {
  type: 'OFFSCREEN_LLM_DELTA';
  runId: string;
  text: string;
}

export interface OffscreenLlmDone {
  type: 'OFFSCREEN_LLM_DONE';
  runId: string;
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface OffscreenLlmFailed {
  type: 'OFFSCREEN_LLM_FAILED';
  runId: string;
  error: SerializedAppError;
}

export type OffscreenInbound =
  | OffscreenAsrStart
  | OffscreenAsrControl
  | OffscreenWarmup
  | OffscreenShotCapture
  | OffscreenLlmRun
  | OffscreenLlmAbort
  | OffscreenPing;

export type OffscreenRequestEnvelope =
  | { type: 'OFFSCREEN_REQUEST'; op: 'ASR_START'; payload: OffscreenAsrStart }
  | { type: 'OFFSCREEN_REQUEST'; op: 'ASR_CONTROL'; payload: OffscreenAsrControl }
  | { type: 'OFFSCREEN_REQUEST'; op: 'WARMUP'; payload: OffscreenWarmup }
  | { type: 'OFFSCREEN_REQUEST'; op: 'SHOT'; payload: OffscreenShotCapture }
  | { type: 'OFFSCREEN_REQUEST'; op: 'LLM_RUN'; payload: OffscreenLlmRun }
  | { type: 'OFFSCREEN_REQUEST'; op: 'LLM_ABORT'; payload: OffscreenLlmAbort }
  | { type: 'OFFSCREEN_REQUEST'; op: 'PING'; payload: OffscreenPing };

export type OffscreenOutbound =
  | OffscreenAsrChunkDone
  | OffscreenAsrProgress
  | OffscreenAsrDone
  | OffscreenAsrFailed
  | OffscreenWarmupDone
  | OffscreenModelProgress
  | OffscreenShotResult
  | OffscreenLlmDelta
  | OffscreenLlmDone
  | OffscreenLlmFailed
  | OffscreenPingReply
  | { type: 'OFFSCREEN_READY' };

export interface OffscreenOutboundEnvelope {
  type: 'OFFSCREEN_EVENT';
  payload: OffscreenOutbound;
}

// ───────────────────────── CS → SW ─────────────────────────

export interface RequestMessage<N extends OpName = OpName> {
  type: 'REQUEST';
  requestId: string;
  op: N;
  args: OpArgs<N>;
}

export interface PageContextMessage {
  type: 'PAGE_CONTEXT';
  requestId: string;
  context: PageContext;
}

export interface SessionMetaMessage {
  type: 'SESSION_META';
  requestId: string;
  meta: SessionMeta;
}

export interface PlayerStateMessage {
  type: 'PLAYER_STATE';
  requestId: string;
  courId: number;
  teclId: number;
  state: PlayerState;
  visible: boolean;
  focused: boolean;
  interacted: boolean;
}

export interface PanelStateMessage {
  type: 'PANEL_STATE';
  requestId: string;
  open: boolean;
  courId?: number;
}

export interface PopupOverviewMessage {
  type: 'POPUP_OVERVIEW';
  requestId: string;
  courId?: number;
}

export type ContentToBackground =
  | RequestMessage
  | PageContextMessage
  | SessionMetaMessage
  | PlayerStateMessage
  | PanelStateMessage
  | PopupOverviewMessage;

// ───────────────────────── SW → CS ─────────────────────────

export interface EventMessage {
  type: 'EVENT';
  event: EventName;
  payload: EventPayload;
}

export interface OverviewResultMessage {
  type: 'POPUP_OVERVIEW_RESULT';
  overview: PopupOverview;
}

export type BackgroundToContent = EventMessage | OverviewResultMessage;

// ───────────────────────── 响应 ─────────────────────────

export interface ResponseMessage {
  type: 'RESPONSE';
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: SerializedAppError;
}

export type AnyMessage =
  | ContentToBackground
  | BackgroundToContent
  | OffscreenInbound
  | OffscreenOutboundEnvelope
  | ResponseMessage
  | OffscreenRequestEnvelope
  | { type: 'KEEPALIVE' };
