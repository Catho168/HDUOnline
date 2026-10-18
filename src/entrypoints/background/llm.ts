/**
 * SW 侧 LLM 代理：把请求转交 Offscreen 执行，并把流式增量/结果回传。
 *
 * 为什么执行放在 Offscreen（§2.1 架构意图 + MV3 限制）：
 * Service Worker 会因空闲被回收，长时流式生成（可达数分钟）有被中断的风险；
 * Offscreen 文档是"长任务宿主"，且与 SW 同属扩展源，host 权限完全一致。
 * 校验、缓存、落库仍在 SW 完成（保持"SW 是编排与持久化入口"）。
 */

import { AppError, deserializeError } from '@/core/shared/errors';
import { createLogger } from '@/core/shared/logger';
import type {
  OffscreenLlmDelta,
  OffscreenLlmDone,
  OffscreenLlmFailed,
  OffscreenLlmRun,
  OffscreenOutbound,
} from '@/core/shared/messages';
import { sendToOffscreen } from '@/core/shared/runtime';
import { uuid } from '@/core/shared/utils';
import type { LlmProvider, LlmTimeouts } from '@/core/llm/types';

const log = createLogger('sw-llm');

interface RunResult {
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

interface PendingRun {
  resolve: (result: RunResult) => void;
  reject: (err: unknown) => void;
  onDelta?: (text: string) => void;
}

const pending = new Map<string, PendingRun>();

export interface LlmProxyRequest {
  provider: LlmProvider;
  timeouts: LlmTimeouts;
  allowLocalEndpoints: boolean;
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
  stream: boolean;
  onDelta?: (text: string) => void;
  /** 运行标识回调：调用方据此把"停止生成"转发给 Offscreen */
  onRunId?: (runId: string) => void;
  /** 超时上限（含整体超时 + 传输余量） */
  waitMs?: number;
}

export async function runLlmViaOffscreen(req: LlmProxyRequest): Promise<RunResult> {
  const runId = uuid();
  const payload: OffscreenLlmRun = {
    type: 'OFFSCREEN_LLM_RUN',
    runId,
    provider: {
      kind: req.provider.kind,
      baseUrl: req.provider.baseUrl,
      model: req.provider.model,
      apiKey: req.provider.apiKey,
    },
    request: {
      system: req.system,
      messages: req.messages,
      maxTokens: req.maxTokens,
      temperature: req.temperature,
      jsonMode: req.jsonMode,
      stream: req.stream,
    },
    timeouts: req.timeouts,
    allowLocalEndpoints: req.allowLocalEndpoints,
  };

  const promise = new Promise<RunResult>((resolve, reject) => {
    pending.set(runId, { resolve, reject, onDelta: req.onDelta });
  });

  try {
    await sendToOffscreen({ type: 'OFFSCREEN_REQUEST', op: 'LLM_RUN', payload });
  } catch (err) {
    pending.delete(runId);
    throw new AppError('LLM_NETWORK_ERROR', { detail: `无法启动推理执行环境：${String(err)}`, retryable: true });
  }
  // 请求已下发后再告知调用方 runId：避免"取消"先于"开始"到达 Offscreen
  req.onRunId?.(runId);

  const waitMs = req.waitMs ?? req.timeouts.totalMs + 30_000;
  return withTimeout(promise, waitMs, runId);
}

export function abortLlmRun(runId: string): void {
  void sendToOffscreen({ type: 'OFFSCREEN_REQUEST', op: 'LLM_ABORT', payload: { type: 'OFFSCREEN_LLM_ABORT', runId } }).catch(
    () => undefined,
  );
}

/** 由 runId 取消（面板"停止生成"用） */
export const abortByRunId = abortLlmRun;

function withTimeout<T>(promise: Promise<T>, ms: number, runId: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      abortLlmRun(runId);
      pending.delete(runId);
      reject(new AppError('LLM_TIMEOUT', { userMessage: 'AI 请求超时，已中止', retryable: true }));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Offscreen → SW 的 LLM 事件入口；返回 true 表示已处理 */
export function handleLlmOffscreenEvent(payload: OffscreenOutbound): boolean {
  switch (payload.type) {
    case 'OFFSCREEN_LLM_DELTA': {
      const delta = payload as OffscreenLlmDelta;
      pending.get(delta.runId)?.onDelta?.(delta.text);
      return true;
    }
    case 'OFFSCREEN_LLM_DONE': {
      const done = payload as OffscreenLlmDone;
      const entry = pending.get(done.runId);
      pending.delete(done.runId);
      entry?.resolve({ text: done.text, usage: done.usage });
      return true;
    }
    case 'OFFSCREEN_LLM_FAILED': {
      const failed = payload as OffscreenLlmFailed;
      const entry = pending.get(failed.runId);
      pending.delete(failed.runId);
      log.warn('LLM 请求失败', failed.error.code);
      entry?.reject(deserializeError(failed.error));
      return true;
    }
    default:
      return false;
  }
}

/** 清理（SW 重启后无悬挂请求；测试与显式停止时使用） */
export function resetPending(): void {
  for (const entry of pending.values()) {
    entry.reject(new AppError('UNKNOWN', { userMessage: '后台已重启，请求已中断，请重试', retryable: true }));
  }
  pending.clear();
}
