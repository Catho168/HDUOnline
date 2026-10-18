/** 三种 LLM 适配器的请求构造、流式响应解析与输出校验（§9.1 / §6.2 / §6.4）。 */

import { describe, expect, it, vi } from 'vitest';
import { createAdapter } from '@/core/llm/adapters';
import { extractJson, buildQaSystemPrompt, buildQaUserPrompt, buildRetryInstruction, buildTopicsUserPrompt, PROMPT_VERSION, TOPICS_SYSTEM_PROMPT } from '@/core/llm/prompts';
import { validateTopicsOutline, validateQaAnswer } from '@/core/llm/validate';

const timeouts = { connectMs: 5000, firstByteMs: 5000, totalMs: 10000 };
const API_KEY = 'sk-test-not-a-real-key';

function adapterFor(kind: 'anthropic-messages' | 'openai-chat' | 'openai-responses', fetchImpl: typeof fetch) {
  return createAdapter({
    provider: { kind, baseUrl: 'https://api.example.com', model: 'test-model', apiKey: API_KEY },
    timeouts,
    allowLocalEndpoints: false,
    fetchImpl,
  });
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

type MockFetch = typeof fetch & { mock: { calls: Array<[string, RequestInit]> } };

function requestOf(fetchImpl: typeof fetch): [string, RequestInit] {
  return (fetchImpl as MockFetch).mock.calls[0] as [string, RequestInit];
}

// ───────────────────────── A. Anthropic Messages ─────────────────────────

describe('AnthropicAdapter', () => {
  it('请求头与请求体符合规范（含浏览器直连必需标头）', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 3, output_tokens: 5 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;

    const adapter = adapterFor('anthropic-messages', fetchImpl);
    const result = await adapter.complete({
      system: 'SYS',
      messages: [{ role: 'user', content: 'HI' }],
      maxTokens: 128,
      temperature: 0.1,
      jsonMode: true,
    });

    expect(result.text).toBe('ok');
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 5 });

    const [url, init] = requestOf(fetchImpl);
    expect(url).toBe('https://api.example.com/v1/messages');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe(API_KEY);
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    // Anthropic 无原生 json mode：提示词被追加到 system，且不得携带 response_format
    expect(String(body.system)).toContain('SYS');
    expect(String(body.system)).toContain('只输出一个合法的 JSON 对象');
    expect(body.max_tokens).toBe(128);
    expect(body.stream).toBe(false);
    expect(body.messages).toEqual([{ role: 'user', content: 'HI' }]);
    expect(body.response_format).toBeUndefined();
  });

  it('流式：跨 chunk 的 content_block_delta 增量拼接', async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse([
        'event: message_start\ndata: {"type":"message_start"}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你"}}\n\n',
        'event: content_block_delta\nda',
        'ta: {"type":"content_block_delta","delta":{"type":"text_delta","text":"好"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":10,"output_tokens":2}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    ) as unknown as typeof fetch;

    const deltas: string[] = [];
    const result = await adapterFor('anthropic-messages', fetchImpl).complete({
      system: 'S',
      messages: [{ role: 'user', content: 'Q' }],
      onDelta: (text) => deltas.push(text),
    });

    expect(deltas).toEqual(['你', '好']);
    expect(result.text).toBe('你好');
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
  });

  it('流式 error 事件转换为可重试错误', async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse(['event: error\ndata: {"type":"error","error":{"message":"overloaded"}}\n\n']),
    ) as unknown as typeof fetch;

    await expect(
      adapterFor('anthropic-messages', fetchImpl).complete({
        system: 'S',
        messages: [{ role: 'user', content: 'Q' }],
        onDelta: () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'LLM_SERVER_ERROR', retryable: true });
  });
});

// ───────────────────────── B. OpenAI Chat Completions ─────────────────────────

describe('OpenAiChatAdapter', () => {
  it('携带 response_format（jsonMode）与系统消息', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 7, completion_tokens: 9 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;

    const adapter = adapterFor('openai-chat', fetchImpl);
    const result = await adapter.complete({
      system: 'SYS',
      messages: [{ role: 'user', content: 'HI' }],
      jsonMode: true,
      maxTokens: 64,
    });
    expect(result.text).toBe('{"ok":true}');
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 9 });

    const [url, init] = requestOf(fetchImpl);
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${API_KEY}`);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(Array.isArray(body.messages)).toBe(true);
    expect((body.messages as Array<{ role: string }>)[0]?.role).toBe('system');
  });

  it('流式：过滤 [DONE]，拼接 delta.content', async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"A"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"B"}}]}\n\ndata: [DO',
        'NE]\n\n',
      ]),
    ) as unknown as typeof fetch;

    const deltas: string[] = [];
    const result = await adapterFor('openai-chat', fetchImpl).complete({
      system: 'S',
      messages: [{ role: 'user', content: 'Q' }],
      onDelta: (text) => deltas.push(text),
    });
    expect(deltas).toEqual(['A', 'B']);
    expect(result.text).toBe('AB');
  });

  it('流式 error 载荷转换为可重试错误', async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse(['data: {"error":{"message":"quota"}}\n\n']),
    ) as unknown as typeof fetch;

    await expect(
      adapterFor('openai-chat', fetchImpl).complete({
        system: 'S',
        messages: [{ role: 'user', content: 'Q' }],
        onDelta: () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'LLM_SERVER_ERROR', retryable: true });
  });
});

// ───────────────────────── C. OpenAI Responses API ─────────────────────────

describe('OpenAiResponsesAdapter', () => {
  it('input 使用 input_text 结构，jsonMode 映射到 text.format', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }],
          usage: { input_tokens: 4, output_tokens: 6 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;

    const result = await adapterFor('openai-responses', fetchImpl).complete({
      system: 'SYS',
      messages: [{ role: 'user', content: 'HI' }],
      jsonMode: true,
      maxTokens: 32,
    });
    expect(result.text).toBe('hello');
    expect(result.usage).toEqual({ inputTokens: 4, outputTokens: 6 });

    const [url, init] = requestOf(fetchImpl);
    expect(url).toBe('https://api.example.com/v1/responses');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.max_output_tokens).toBe(32);
    expect(body.text).toEqual({ format: { type: 'json_object' } });
    const input = body.input as Array<{ role: string; content: Array<{ type: string; text: string }> }>;
    expect(input[0]?.role).toBe('system');
    expect(input[0]?.content[0]).toEqual({ type: 'input_text', text: 'SYS' });
  });

  it('流式：response.output_text.delta 拼接，response.failed 报错', async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse([
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"你"}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"好"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":2}}}\n\n',
      ]),
    ) as unknown as typeof fetch;

    const deltas: string[] = [];
    const result = await adapterFor('openai-responses', fetchImpl).complete({
      system: 'S',
      messages: [{ role: 'user', content: 'Q' }],
      onDelta: (text) => deltas.push(text),
    });
    expect(deltas).toEqual(['你', '好']);
    expect(result.text).toBe('你好');
    expect(result.usage).toEqual({ inputTokens: 1, outputTokens: 2 });

    const failing = vi.fn(async () =>
      sseResponse(['event: response.failed\ndata: {"type":"response.failed","response":{"error":{"message":"boom"}}}\n\n']),
    ) as unknown as typeof fetch;
    await expect(
      adapterFor('openai-responses', failing).complete({
        system: 'S',
        messages: [{ role: 'user', content: 'Q' }],
        onDelta: () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'LLM_SERVER_ERROR' });
  });
});

// ───────────────────────── 错误分类 ─────────────────────────

describe('HTTP 错误分类', () => {
  it.each([
    [401, 'LLM_AUTH_FAILED', false],
    [403, 'LLM_AUTH_FAILED', false],
    [429, 'LLM_RATE_LIMITED', true],
    [500, 'LLM_SERVER_ERROR', true],
    [404, 'LLM_SERVER_ERROR', false],
    [400, 'LLM_SERVER_ERROR', false],
  ])('HTTP %i → %s（retryable=%s）', async (status, code, retryable) => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'server says no' } }), { status, headers: { 'content-type': 'application/json' } }),
    ) as unknown as typeof fetch;

    await expect(
      adapterFor('openai-chat', fetchImpl).complete({ system: 'S', messages: [{ role: 'user', content: 'Q' }] }),
    ).rejects.toMatchObject({ code, retryable });
  });

  it('拒绝环回端点（默认安全策略，§6.3）', () => {
    expect(() =>
      createAdapter({
        provider: { kind: 'openai-chat', baseUrl: 'http://127.0.0.1:11434', model: 'm', apiKey: API_KEY },
        timeouts,
        allowLocalEndpoints: false,
      }),
    ).toThrowError(/本地\/私网地址/);
  });

  it('显式允许后可创建本地端点适配器', () => {
    const adapter = createAdapter({
      provider: { kind: 'openai-chat', baseUrl: 'http://127.0.0.1:11434', model: 'm', apiKey: API_KEY },
      timeouts,
      allowLocalEndpoints: true,
      fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch,
    });
    expect(adapter.id).toBe('openai-chat');
  });

  it('非 JSON 响应归类为 LLM_BAD_OUTPUT', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('<html>not json</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    ) as unknown as typeof fetch;

    await expect(
      adapterFor('openai-chat', fetchImpl).complete({ system: 'S', messages: [{ role: 'user', content: 'Q' }] }),
    ).rejects.toMatchObject({ code: 'LLM_BAD_OUTPUT' });
  });
});

// ───────────────────────── JSON 校验器边界 ─────────────────────────

describe('validateTopicsOutline', () => {
  const segments = [
    { s: 0, e: 60, text: '今天我们讲克拉默法则，它是线性代数的重要工具' },
    { s: 60, e: 120, text: '克拉默法则用于求解方程个数与未知数个数相等的线性方程组' },
  ];

  it('越界时间被裁剪并记录 warning', () => {
    const result = validateTopicsOutline(
      JSON.stringify({
        topics: [
          { name: '克拉默法则', summary: 's', confidence: 'high', intervals: [[-10, 30], [100, 5000]] },
          { name: '线性方程组', summary: 's', confidence: 'high', intervals: [[40, 90]] },
          { name: '行列式', summary: 's', confidence: 'medium', intervals: [[10, 20]] },
        ],
        outline: [
          { level: 1, title: 'A', start: 0, end: 60 },
          { level: 2, title: 'A1', start: 0, end: 30, parent: 0 },
          { level: 1, title: 'B', start: 60, end: 120 },
          { level: 2, title: 'B1', start: 60, end: 90, parent: 2 },
        ],
      }),
      120,
      segments,
    );
    expect(result.topics[0]?.intervals).toEqual([
      [0, 30],
      [100, 120],
    ]);
    expect(result.warnings.some((warning) => warning.includes('越界'))).toBe(true);
  });

  it('L2 的 parent 指向不存在的 L1 时降级为一级节点', () => {
    const result = validateTopicsOutline(
      JSON.stringify({
        topics: [
          { name: '克拉默法则', summary: '', confidence: 'high', intervals: [[0, 30]] },
          { name: '线性方程组', summary: '', confidence: 'high', intervals: [[30, 60]] },
          { name: '行列式', summary: '', confidence: 'high', intervals: [[60, 90]] },
        ],
        outline: [
          { level: 1, title: 'A', start: 0, end: 60 },
          { level: 2, title: 'B', start: 0, end: 30, parent: 99 },
          { level: 1, title: 'C', start: 60, end: 90 },
          { level: 1, title: 'D', start: 90, end: 120 },
        ],
      }),
      120,
      segments,
    );
    expect(result.outline[1]?.level).toBe(1);
    expect(result.outline[1]?.parent).toBeUndefined();
    expect(result.warnings.some((warning) => warning.includes('父节点无效'))).toBe(true);
  });

  it('非 JSON 输出抛 LLM_BAD_OUTPUT', () => {
    expect(() => validateTopicsOutline('抱歉，我无法完成。', 120, segments)).toThrowError(/合法 JSON/);
  });

  it('Markdown 代码块包裹的 JSON 可被容错提取', () => {
    const result = validateTopicsOutline(
      '```json\n' +
        JSON.stringify({
          topics: [
            { name: '克拉默法则', summary: '', confidence: 'high', intervals: [[0, 30]] },
            { name: '线性方程组', summary: '', confidence: 'high', intervals: [[30, 60]] },
            { name: '行列式', summary: '', confidence: 'high', intervals: [[60, 90]] },
          ],
          outline: [
            { level: 1, title: 'A', start: 0, end: 60 },
            { level: 1, title: 'B', start: 60, end: 90 },
            { level: 1, title: 'C', start: 90, end: 110 },
            { level: 1, title: 'D', start: 110, end: 120 },
          ],
        }) +
        '\n```',
      120,
      segments,
    );
    expect(result.topics).toHaveLength(3);
  });

  it('知识点过少时整体失败（要求 3–30 条）', () => {
    expect(() =>
      validateTopicsOutline(
        JSON.stringify({
          topics: [{ name: '克拉默法则', summary: '', confidence: 'high', intervals: [[0, 30]] }],
          outline: [
            { level: 1, title: 'A', start: 0, end: 30 },
            { level: 1, title: 'B', start: 30, end: 60 },
            { level: 1, title: 'C', start: 60, end: 90 },
            { level: 1, title: 'D', start: 90, end: 120 },
          ],
        }),
        120,
        segments,
      ),
    ).toThrowError(/知识点过少/);
  });

  it('术语无依据时置信度降级为 low', () => {
    const result = validateTopicsOutline(
      JSON.stringify({
        topics: [
          { name: '完全编造的术语XYZ', summary: '', confidence: 'high', intervals: [[0, 30]] },
          { name: '线性方程组', summary: '', confidence: 'high', intervals: [[30, 60]] },
          { name: '行列式', summary: '', confidence: 'high', intervals: [[60, 90]] },
        ],
        outline: [
          { level: 1, title: 'A', start: 0, end: 60 },
          { level: 1, title: 'B', start: 60, end: 90 },
          { level: 1, title: 'C', start: 90, end: 110 },
          { level: 1, title: 'D', start: 110, end: 120 },
        ],
      }),
      120,
      segments,
    );
    expect(result.topics[0]?.confidence).toBe('low');
    expect(result.warnings.some((warning) => warning.includes('依据'))).toBe(true);
  });

  it('知识点名称缺失时跳过并记录 warning', () => {
    const result = validateTopicsOutline(
      JSON.stringify({
        topics: [
          { name: '', summary: '', confidence: 'high', intervals: [[0, 30]] },
          { name: '克拉默法则', summary: '', confidence: 'high', intervals: [[0, 30]] },
          { name: '线性方程组', summary: '', confidence: 'high', intervals: [[30, 60]] },
          { name: '行列式', summary: '', confidence: 'high', intervals: [[60, 90]] },
        ],
        outline: [
          { level: 1, title: 'A', start: 0, end: 60 },
          { level: 1, title: 'B', start: 60, end: 90 },
          { level: 1, title: 'C', start: 90, end: 110 },
          { level: 1, title: 'D', start: 110, end: 120 },
        ],
      }),
      120,
      segments,
    );
    expect(result.topics).toHaveLength(3);
    expect(result.warnings.some((warning) => warning.includes('缺少名称'))).toBe(true);
  });
});

describe('validateQaAnswer', () => {
  it('insufficient 时清空 answer', () => {
    const result = validateQaAnswer(JSON.stringify({ answer: '我猜是……', evidence: { start: 0, end: 10 }, insufficient: true }), 120, [0, 60]);
    expect(result.answer).toBe('');
    expect(result.insufficient).toBe(true);
    expect(result.warnings.some((warning) => warning.includes('insufficient'))).toBe(true);
  });

  it('依据范围越界被裁剪', () => {
    const result = validateQaAnswer(JSON.stringify({ answer: '答案', evidence: { start: -5, end: 999 }, insufficient: false }), 120, [0, 60]);
    expect(result.evidence).toEqual({ start: 0, end: 120 });
    expect(result.warnings.some((warning) => warning.includes('越界'))).toBe(true);
  });

  it('缺少 evidence 时退化为上下文窗口', () => {
    const result = validateQaAnswer(JSON.stringify({ answer: '答案' }), 120, [30, 90]);
    expect(result.evidence).toEqual({ start: 30, end: 90 });
    expect(result.warnings.some((warning) => warning.includes('上下文窗口'))).toBe(true);
  });

  it('缺少 answer 且非 insufficient 时抛错', () => {
    expect(() => validateQaAnswer(JSON.stringify({ answer: '', insufficient: false }), 120, [0, 60])).toThrowError(/未给出回答/);
  });
});

// ───────────────────────── 提示词模板 ─────────────────────────

describe('prompts', () => {
  it('system prompt 含条数约束与 JSON 契约', () => {
    expect(TOPICS_SYSTEM_PROMPT).toContain('3–30');
    expect(TOPICS_SYSTEM_PROMPT).toContain('"topics"');
    expect(TOPICS_SYSTEM_PROMPT).toContain('只输出一个 JSON 对象');
  });

  it('问答 system prompt 将锚点替换为 mm:ss', () => {
    const prompt = buildQaSystemPrompt(65);
    expect(prompt).toContain('01:05');
    expect(prompt).not.toContain('{锚点}');
  });

  it('标注输入按 10 分钟分块并标注时间戳', () => {
    const prompt = buildTopicsUserPrompt(
      [
        { s: 0, e: 10, text: '开头' },
        { s: 599, e: 600, text: '第一块末尾' },
        { s: 600, e: 601, text: '第二块开头' },
      ],
      2820,
    );
    expect(prompt).toContain('课次总时长：2820 秒（47:00）');
    expect(prompt).toContain('【第 1 块：00:00 – 10:00】');
    expect(prompt).toContain('【第 2 块：10:00 – 20:00】');
    expect(prompt).toContain('[09:59] 第一块末尾');
    expect(prompt).toContain('[10:00] 第二块开头');
  });

  it('无转写内容与时长缺失时的兜底', () => {
    expect(buildTopicsUserPrompt([], 0)).toBe('（无转写内容）');
    const prompt = buildTopicsUserPrompt([{ s: 0, e: 30, text: 'x' }], 0);
    expect(prompt).toContain('课次总时长：30 秒');
  });

  it('问答输入包含窗口、锚点、问题与最近 6 条历史', () => {
    const history = Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `m${index}`,
    }));
    const prompt = buildQaUserPrompt({
      segments: [{ s: 30, e: 40, text: '转写内容' }],
      question: '为什么？',
      anchorSec: 65,
      history,
      windowRange: [0, 120],
    });
    expect(prompt).toContain('上下文时间范围为 0–120 秒（锚点 65 秒）');
    expect(prompt).toContain('[00:30] 转写内容');
    expect(prompt).toContain('用户问题：为什么？');
    expect(prompt).toContain('用户：m2');
    expect(prompt).not.toContain('m0');
    expect(prompt).not.toContain('m1');
  });

  it('纠错重试指令与 JSON 容错提取', () => {
    expect(buildRetryInstruction('缺少 outline')).toContain('缺少 outline');
    expect(buildRetryInstruction('缺少 outline')).toContain('纯 JSON 对象');
    expect(extractJson('前缀 {"a":1} 后缀')).toBe('{"a":1}');
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(PROMPT_VERSION).toBeGreaterThanOrEqual(1);
  });
});
