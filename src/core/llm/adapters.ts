/**
 * 三种请求格式的适配器（技术文档 §6.2，逐条实现）。
 *
 * A. Anthropic Messages  → POST {base}/v1/messages
 * B. OpenAI Chat         → POST {base}/v1/chat/completions
 * C. OpenAI Responses    → POST {base}/v1/responses
 *
 * 共同行为：统一支持 AbortSignal、超时（连接/首字节/整体）、流式增量回调、错误分类。
 * 流式解析在**整条响应流**上进行（SSE 行可能跨 chunk 断行），首字节超时由
 * `guardFirstByte` 护栏保证。
 */

import { AppError, toAppError } from '../shared/errors';
import { checkUrl } from '../shared/urlGuard';
import type { LlmProviderConfig } from '../shared/types';
import { sseEvents, parseJsonSafe, type SseEvent } from './sse';
import { classify, classifyHttp, guardFirstByte, startRequest, type AttemptAbort } from './http';
import {
  DEFAULT_TIMEOUTS,
  type LlmAdapter,
  type LlmProvider,
  type LlmRequest,
  type LlmResult,
  type LlmTimeouts,
  type LlmUsage,
} from './types';

export interface AdapterContext {
  provider: LlmProvider;
  timeouts: LlmTimeouts;
  allowLocalEndpoints: boolean;
  fetchImpl?: typeof fetch;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

/** 统一入口：按 provider.kind 创建适配器。 */
export function createAdapter(ctx: AdapterContext): LlmAdapter {
  const verdict = checkUrl(ctx.provider.baseUrl, { allowLocal: ctx.allowLocalEndpoints });
  if (!verdict.ok) {
    throw new AppError('LLM_ENDPOINT_REJECTED', {
      userMessage: verdict.message ?? '端点地址被安全策略拒绝',
      detail: `url-guard:${verdict.reason ?? 'rejected'}`,
    });
  }
  switch (ctx.provider.kind) {
    case 'anthropic-messages':
      return new AnthropicAdapter(ctx);
    case 'openai-chat':
      return new OpenAiChatAdapter(ctx);
    case 'openai-responses':
      return new OpenAiResponsesAdapter(ctx);
    default: {
      const exhaustive: never = ctx.provider.kind;
      throw new AppError('LLM_SERVER_ERROR', { detail: `未知的请求格式：${String(exhaustive)}` });
    }
  }
}

abstract class BaseAdapter implements LlmAdapter {
  abstract readonly id: LlmAdapter['id'];
  protected readonly ctx: AdapterContext;

  constructor(ctx: AdapterContext) {
    this.ctx = ctx;
  }

  abstract complete(req: LlmRequest): Promise<LlmResult>;

  protected get fetchImpl(): typeof fetch {
    return this.ctx.fetchImpl ?? fetch;
  }

  /** 发起请求（连接 + 响应头阶段），非 2xx 抛分类错误。 */
  protected async request(url: string, init: RequestInit, req: LlmRequest): Promise<{ response: Response; abort: AttemptAbort }> {
    const { response, abort } = await startRequest(url, init, { timeouts: this.ctx.timeouts, signal: req.signal }, this.fetchImpl);
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      abort.dispose();
      throw classifyHttp(response.status, text);
    }
    return { response, abort };
  }

  /** 非流式：整读 body（首字节超时护栏 + 整体超时）。 */
  protected async readJson(response: Response, abort: AttemptAbort, signal?: AbortSignal): Promise<unknown> {
    try {
      const guarded = guardFirstByte(response, this.ctx.timeouts.firstByteMs, signal);
      const text = await guarded.text();
      const parsed = parseJsonSafe(text);
      if (parsed === null) {
        throw new AppError('LLM_BAD_OUTPUT', { userMessage: 'AI 服务返回了无法解析的内容', detail: text.slice(0, 400) });
      }
      return parsed;
    } catch (err) {
      throw err instanceof AppError ? err : classify(err, abort.reason, undefined, this.ctx.timeouts);
    } finally {
      abort.dispose();
    }
  }

  /** 流式：在整条流上迭代 SSE 事件（含首字节超时护栏）。 */
  protected async *stream(response: Response, req: LlmRequest, abort: AttemptAbort): AsyncGenerator<SseEvent> {
    const guarded = guardFirstByte(response, this.ctx.timeouts.firstByteMs, req.signal);
    try {
      yield* sseEvents(guarded);
    } catch (err) {
      throw err instanceof AppError ? err : classify(err, abort.reason, undefined, this.ctx.timeouts);
    }
  }
}

/** 合并 usage：后到字段覆盖先到字段，未提供的字段保持原值。 */
function mergeUsage(target: LlmUsage, patch: LlmUsage): LlmUsage {
  return {
    inputTokens: patch.inputTokens ?? target.inputTokens,
    outputTokens: patch.outputTokens ?? target.outputTokens,
  };
}

function errorMessage(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as { message?: unknown }).message === 'string') {
    return (value as { message: string }).message;
  }
  return undefined;
}

// ───────────────────────── A. Anthropic Messages ─────────────────────────

interface AnthropicStreamEvent {
  type?: string;
  delta?: { type?: string; text?: string };
  usage?: { input_tokens?: number; output_tokens?: number };
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  error?: { message?: string } | string;
}

class AnthropicAdapter extends BaseAdapter {
  readonly id = 'anthropic-messages' as const;

  async complete(req: LlmRequest): Promise<LlmResult> {
    const streaming = typeof req.onDelta === 'function';
    const url = joinUrl(this.ctx.provider.baseUrl, '/v1/messages');
    // Anthropic 无原生 JSON 模式：在 system 中强制“仅输出 JSON”（§6.2 A）。
    const system = req.jsonMode
      ? `${req.system}\n\n只输出一个合法的 JSON 对象；不要输出 Markdown 代码块、解释或其他文字。`
      : req.system;
    const body = {
      model: this.ctx.provider.model,
      max_tokens: req.maxTokens ?? 4096,
      system,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      stream: streaming,
      temperature: req.temperature ?? 0.2,
    };

    const { response, abort } = await this.request(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.ctx.provider.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true', // 浏览器环境必需（§6.2 A）
        },
        body: JSON.stringify(body),
      },
      req,
    );

    if (!streaming) {
      const parsed = (await this.readJson(response, abort, req.signal)) as {
        content?: Array<{ type: string; text?: string }>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const text = (parsed.content ?? [])
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text as string)
        .join('');
      if (!text) throw new AppError('LLM_BAD_OUTPUT', { detail: 'Anthropic 响应中未找到文本内容' });
      return { text, usage: { inputTokens: parsed.usage?.input_tokens, outputTokens: parsed.usage?.output_tokens } };
    }

    let text = '';
    let usage: LlmUsage = {};
    let streamError: string | null = null;
    try {
      for await (const evt of this.stream(response, req, abort)) {
        const payload = parseJsonSafe(evt.data) as AnthropicStreamEvent | null;
        if (!payload) continue;
        const type = payload.type ?? evt.event;
        if (type === 'content_block_delta' && payload.delta?.type === 'text_delta' && payload.delta.text) {
          text += payload.delta.text;
          req.onDelta?.(payload.delta.text);
        } else if (type === 'message_start' && payload.message?.usage) {
          usage = mergeUsage(usage, {
            inputTokens: payload.message.usage.input_tokens,
            outputTokens: payload.message.usage.output_tokens,
          });
        } else if (type === 'message_delta' && payload.usage) {
          usage = mergeUsage(usage, {
            inputTokens: payload.usage.input_tokens,
            outputTokens: payload.usage.output_tokens,
          });
        } else if (type === 'error') {
          streamError = errorMessage(payload.error) ?? '流式响应返回错误事件';
        }
      }
    } finally {
      abort.dispose();
    }
    if (streamError) throw new AppError('LLM_SERVER_ERROR', { detail: streamError, retryable: true });
    if (!text) throw new AppError('LLM_BAD_OUTPUT', { detail: '流式响应未产生任何文本' });
    return { text, usage };
  }
}

// ───────────────────────── B. OpenAI Chat Completions ─────────────────────────

interface ChatStreamEvent {
  choices?: Array<{ delta?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string } | string;
}

class OpenAiChatAdapter extends BaseAdapter {
  readonly id = 'openai-chat' as const;

  async complete(req: LlmRequest): Promise<LlmResult> {
    const streaming = typeof req.onDelta === 'function';
    const url = joinUrl(this.ctx.provider.baseUrl, '/v1/chat/completions');
    const body: Record<string, unknown> = {
      model: this.ctx.provider.model,
      messages: [{ role: 'system', content: req.system }, ...req.messages],
      stream: streaming,
      temperature: req.temperature ?? 0.2,
      max_tokens: req.maxTokens ?? 4096,
    };
    if (req.jsonMode) body.response_format = { type: 'json_object' };

    const { response, abort } = await this.request(
      url,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.ctx.provider.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      req,
    );

    if (!streaming) {
      const parsed = (await this.readJson(response, abort, req.signal)) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const text = parsed.choices?.[0]?.message?.content ?? '';
      if (!text) throw new AppError('LLM_BAD_OUTPUT', { detail: 'Chat Completions 响应中未找到内容' });
      return { text, usage: { inputTokens: parsed.usage?.prompt_tokens, outputTokens: parsed.usage?.completion_tokens } };
    }

    let text = '';
    let usage: LlmUsage = {};
    try {
      for await (const evt of this.stream(response, req, abort)) {
        const data = evt.data.trim();
        if (data === '[DONE]') continue;
        const payload = parseJsonSafe(data) as ChatStreamEvent | null;
        if (!payload) continue;
        const failure = errorMessage(payload.error);
        if (failure) throw new AppError('LLM_SERVER_ERROR', { detail: failure, retryable: true });
        const delta = payload.choices?.[0]?.delta?.content;
        if (delta) {
          text += delta;
          req.onDelta?.(delta);
        }
        if (payload.usage) {
          usage = mergeUsage(usage, {
            inputTokens: payload.usage.prompt_tokens,
            outputTokens: payload.usage.completion_tokens,
          });
        }
      }
    } finally {
      abort.dispose();
    }
    if (!text) throw new AppError('LLM_BAD_OUTPUT', { detail: '流式响应未产生任何文本' });
    return { text, usage };
  }
}

// ───────────────────────── C. OpenAI Responses API ─────────────────────────

interface ResponsesStreamEvent {
  type?: string;
  delta?: string;
  response?: {
    usage?: { input_tokens?: number; output_tokens?: number };
    error?: { message?: string } | string | null;
  };
  error?: { message?: string } | string;
  message?: string;
}

class OpenAiResponsesAdapter extends BaseAdapter {
  readonly id = 'openai-responses' as const;

  async complete(req: LlmRequest): Promise<LlmResult> {
    const streaming = typeof req.onDelta === 'function';
    const url = joinUrl(this.ctx.provider.baseUrl, '/v1/responses');
    const body: Record<string, unknown> = {
      model: this.ctx.provider.model,
      input: [
        { role: 'system', content: [{ type: 'input_text', text: req.system }] },
        ...req.messages.map((m) => ({ role: m.role, content: [{ type: 'input_text', text: m.content }] })),
      ],
      stream: streaming,
      temperature: req.temperature ?? 0.2,
      max_output_tokens: req.maxTokens ?? 4096,
    };
    if (req.jsonMode) body.text = { format: { type: 'json_object' } };

    const { response, abort } = await this.request(
      url,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.ctx.provider.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      req,
    );

    if (!streaming) {
      const parsed = (await this.readJson(response, abort, req.signal)) as {
        output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const text = (parsed.output ?? [])
        .filter((item) => item.type === 'message')
        .flatMap((item) => item.content ?? [])
        .filter((c) => c.type === 'output_text' && typeof c.text === 'string')
        .map((c) => c.text as string)
        .join('');
      if (!text) throw new AppError('LLM_BAD_OUTPUT', { detail: 'Responses 响应中未找到 output_text' });
      return { text, usage: { inputTokens: parsed.usage?.input_tokens, outputTokens: parsed.usage?.output_tokens } };
    }

    let text = '';
    let usage: LlmUsage = {};
    let failure: string | null = null;
    try {
      for await (const evt of this.stream(response, req, abort)) {
        const payload = parseJsonSafe(evt.data) as ResponsesStreamEvent | null;
        if (!payload) continue;
        const type = payload.type ?? evt.event;
        switch (type) {
          case 'response.output_text.delta':
            if (payload.delta) {
              text += payload.delta;
              req.onDelta?.(payload.delta);
            }
            break;
          case 'response.completed':
            if (payload.response?.usage) {
              usage = mergeUsage(usage, {
                inputTokens: payload.response.usage.input_tokens,
                outputTokens: payload.response.usage.output_tokens,
              });
            }
            break;
          case 'response.failed':
          case 'response.incomplete':
            failure = errorMessage(payload.response?.error) ?? type;
            break;
          case 'error':
            failure = errorMessage(payload.error) ?? payload.message ?? '错误事件';
            break;
          default:
            break;
        }
      }
    } finally {
      abort.dispose();
    }
    if (failure) throw new AppError('LLM_SERVER_ERROR', { detail: failure, retryable: true });
    if (!text) throw new AppError('LLM_BAD_OUTPUT', { detail: '流式响应未产生任何文本' });
    return { text, usage };
  }
}

// ───────────────────────── 连接测试 ─────────────────────────

export interface TestProviderResult {
  ok: boolean;
  text?: string;
  error?: string;
}

/** 供后台编排使用的对象式参数（可按设置覆盖超时）。 */
export interface TestProviderOptions {
  provider: LlmProvider;
  timeouts?: LlmTimeouts;
  allowLocalEndpoints: boolean;
}

function isTestProviderOptions(value: LlmProviderConfig | TestProviderOptions): value is TestProviderOptions {
  return typeof value === 'object' && value !== null && 'provider' in value && 'allowLocalEndpoints' in value;
}

/**
 * “测试连接”：发送一条极小请求（“只回复 OK”），验证端点可达、鉴权有效、
 * 且返回内容可解析。不经过重试（设置页需要即时反馈）。
 *
 * 同时接受两种调用方式：
 *  - `testProvider(provider, allowLocalEndpoints)`（契约签名，使用默认超时）；
 *  - `testProvider({ provider, timeouts, allowLocalEndpoints })`（后台可按设置传超时）。
 */
export function testProvider(provider: LlmProviderConfig, allowLocalEndpoints: boolean): Promise<TestProviderResult>;
export function testProvider(options: TestProviderOptions): Promise<TestProviderResult>;
export async function testProvider(
  first: LlmProviderConfig | TestProviderOptions,
  second?: boolean,
): Promise<TestProviderResult> {
  const options: TestProviderOptions = isTestProviderOptions(first)
    ? first
    : { provider: first, allowLocalEndpoints: second === true };
  const provider = options.provider;
  const verdict = checkUrl(provider.baseUrl, { allowLocal: options.allowLocalEndpoints });
  if (!verdict.ok) {
    return { ok: false, error: verdict.message ?? '端点地址被安全策略拒绝' };
  }
  try {
    const adapter = createAdapter({
      provider,
      timeouts: options.timeouts ?? DEFAULT_TIMEOUTS,
      allowLocalEndpoints: options.allowLocalEndpoints,
    });
    const result = await adapter.complete({
      system: '你是连通性测试助手。',
      messages: [{ role: 'user', content: '只回复 OK' }],
      maxTokens: 16,
      temperature: 0,
    });
    const text = result.text.trim();
    if (!text) return { ok: false, error: 'AI 服务返回了空内容' };
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: toAppError(err, 'LLM_SERVER_ERROR').userMessage };
  }
}
