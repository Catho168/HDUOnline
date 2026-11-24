/** SSE 解析测试（§9.1：含跨 chunk 断行、错误事件）。 */

import { describe, expect, it } from 'vitest';
import { sseEvents, sseLines } from '@/core/llm/sse';

/** 用可控分片构造 Response，模拟网络切包 */
function responseFromChunks(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function collect(chunks: string[]): Promise<Array<{ event: string; data: string }>> {
  const out: Array<{ event: string; data: string }> = [];
  for await (const evt of sseEvents(responseFromChunks(chunks))) out.push(evt);
  return out;
}

describe('sseEvents', () => {
  it('解析单条事件', async () => {
    const events = await collect(['data: {"a":1}\n\n']);
    expect(events).toEqual([{ event: '', data: '{"a":1}' }]);
  });

  it('解析 Anthropic 风格 event + data', async () => {
    const events = await collect(['event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n']);
    expect(events).toEqual([{ event: 'content_block_delta', data: '{"type":"content_block_delta"}' }]);
  });

  it('跨 chunk 断行（data: 行被拆成两段）', async () => {
    // 关键场景：一个事件的字节被网络切成 3 段，其中一段正好切在 "data:" 中间
    const events = await collect(['da', 'ta: {"text":"你', '好"}\n', '\ndata: {"text":"世界"}\n\n']);
    expect(events).toEqual([
      { event: '', data: '{"text":"你好"}' },
      { event: '', data: '{"text":"世界"}' },
    ]);
  });

  it('多行 data 按换行拼接', async () => {
    const events = await collect(['data: line1\ndata: line2\n\n']);
    expect(events).toEqual([{ event: '', data: 'line1\nline2' }]);
  });

  it('忽略注释行与 id/retry 字段', async () => {
    const events = await collect([': keep-alive\nid: 7\nretry: 1000\ndata: payload\n\n']);
    expect(events).toEqual([{ event: '', data: 'payload' }]);
  });

  it('支持 CRLF 行尾', async () => {
    const events = await collect(['data: a\r\n\r\ndata: b\r\n\r\n']);
    expect(events).toEqual([
      { event: '', data: 'a' },
      { event: '', data: 'b' },
    ]);
  });

  it('流结束时冲刷未闭合事件', async () => {
    const events = await collect(['data: tail-without-blank-line']);
    expect(events).toEqual([{ event: '', data: 'tail-without-blank-line' }]);
  });

  it('OpenAI 的 [DONE] 作为普通事件返回（由适配器过滤）', async () => {
    const events = await collect(['data: [DONE]\n\n']);
    expect(events).toEqual([{ event: '', data: '[DONE]' }]);
  });

  it('data 值前的单个空格按规范剔除', async () => {
    const events = await collect(['data:  leading-space\n\n']);
    expect(events).toEqual([{ event: '', data: ' leading-space' }]);
  });

  it('ignore 无 body 的响应', async () => {
    const events = await collect([]);
    expect(events).toEqual([]);
  });
});

describe('sseLines（原始行视图）', () => {
  it('产出非空行并去除首尾空白', async () => {
    const lines: string[] = [];
    for await (const line of sseLines(responseFromChunks(['event: x\n\n', 'data: y\n']))) lines.push(line);
    expect(lines).toEqual(['event: x', 'data: y']);
  });
});
