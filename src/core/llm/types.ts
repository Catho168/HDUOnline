/** LLM 适配器契约（技术文档 §6.1）。 */

import { LLM_TIMEOUTS } from '../shared/constants';
import type { LlmKind } from '../shared/types';

export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  maxTokens?: number;
  temperature?: number;
  /** 要求严格 JSON（适配器各自映射，见 §6.2） */
  jsonMode?: boolean;
  signal?: AbortSignal;
  /** 流式回调（提供即启用流式） */
  onDelta?: (text: string) => void;
}

export interface LlmResult {
  text: string;
  usage?: LlmUsage;
}

export interface LlmAdapter {
  readonly id: LlmKind;
  complete(req: LlmRequest): Promise<LlmResult>;
}

/**
 * 一次请求所需的最小 provider 形状。
 * 允许携带 `id` / `label` 等展示字段，因此可直接传入 `LlmProviderConfig`。
 */
export interface LlmProvider {
  kind: LlmKind;
  baseUrl: string;
  model: string;
  apiKey: string;
  id?: string;
  label?: string;
}

export interface LlmTimeouts {
  connectMs: number;
  firstByteMs: number;
  totalMs: number;
}

/** 与设置默认值（constants.DEFAULT_SETTINGS.llm）保持一致的兜底。 */
export const DEFAULT_TIMEOUTS: LlmTimeouts = {
  connectMs: LLM_TIMEOUTS.connectMs,
  firstByteMs: LLM_TIMEOUTS.firstByteMs,
  totalMs: LLM_TIMEOUTS.totalMs,
};
