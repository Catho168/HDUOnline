/**
 * LLM 执行器（与运行环境无关，技术文档 §6.2）。
 *
 * - 由 Offscreen 文档承载实际请求（长任务宿主，§2.1；避免 SW 因空闲被回收而中断流式生成）；
 * - Options 页“测试连接”直接在同页调用 adapters/testProvider；
 * - 重试策略（§6.2）：网络错误 / 429 / 5xx 指数退避 ≤ `maxRetries` 次；4xx（除 429）不重试。
 */

import { AppError } from '../shared/errors';
import { retry } from '../shared/utils';
import { createAdapter, type AdapterContext } from './adapters';
import { isRetryable } from './http';
import type { LlmProvider, LlmRequest, LlmResult, LlmTimeouts } from './types';

// 测试连接与执行器同属“运行入口”，后台与设置页都从本模块引用。
export { testProvider } from './adapters';
export type { TestProviderOptions, TestProviderResult } from './adapters';

export interface LlmRunConfig {
  provider: LlmProvider;
  timeouts: LlmTimeouts;
  allowLocalEndpoints: boolean;
  maxRetries: number;
  fetchImpl?: typeof fetch;
}

export async function runLlm(cfg: LlmRunConfig, req: LlmRequest): Promise<LlmResult> {
  const ctx: AdapterContext = {
    provider: cfg.provider,
    timeouts: cfg.timeouts,
    allowLocalEndpoints: cfg.allowLocalEndpoints,
    fetchImpl: cfg.fetchImpl,
  };
  const adapter = createAdapter(ctx);
  return retry(() => adapter.complete(req), {
    retries: Math.max(0, cfg.maxRetries),
    baseDelayMs: 800,
    shouldRetry: (err) => isRetryable(err) && !(err instanceof AppError && err.code === 'LLM_ABORTED'),
    signal: req.signal,
  });
}
