/**
 * SSE（Server-Sent Events）解析（技术文档 §6.2 通用实现要求 / 附录 D-1）。
 *
 * 相比附录 D-1 的"逐行产出"版本，本实现按 SSE 规范**按事件分组**：
 *  - 支持跨 chunk 断行（`data:` 行可能被网络分片切断）；
 *  - `data:` 多行拼接；
 *  - 忽略注释行（`:` 开头）与未知字段；
 *  - 空行作为事件结束标志；流结束时冲刷未闭合事件。
 *
 * 三种适配器都只消费自己关心的事件，其余事件忽略但可记录。
 */

export interface SseEvent {
  /** `event:` 字段（默认空串）；Anthropic 风格可直接用 data.type 判定 */
  event: string;
  /** `data:` 拼接结果 */
  data: string;
}

/** 逐行产出（保留给需要原始行的调用方与单元测试）。 */
export async function* sseLines(resp: Response): AsyncGenerator<string> {
  if (!resp.body) return;
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line.trim()) yield line.trim();
    }
  }
  buf += dec.decode();
  if (buf.trim()) yield buf.trim();
}

/** 按事件分组产出。 */
export async function* sseEvents(resp: Response): AsyncGenerator<SseEvent> {
  if (!resp.body) return;
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let eventName = '';
  let dataLines: string[] = [];

  const flush = (): SseEvent | null => {
    if (dataLines.length === 0) {
      eventName = '';
      return null;
    }
    const evt: SseEvent = { event: eventName, data: dataLines.join('\n') };
    eventName = '';
    dataLines = [];
    return evt;
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const rawLine = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const line = rawLine.replace(/\r$/, '');
      if (line === '') {
        const evt = flush();
        if (evt) yield evt;
        continue;
      }
      if (line.startsWith(':')) continue; // 注释 / 心跳
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let val = colon < 0 ? '' : line.slice(colon + 1);
      if (val.startsWith(' ')) val = val.slice(1);
      if (field === 'event') eventName = val;
      else if (field === 'data') dataLines.push(val);
      // id / retry 字段对文本增量无用，忽略
    }
  }
  buf += dec.decode();
  // 处理没有以空行结束的尾部数据
  for (const line of buf.split('\n')) {
    const trimmed = line.replace(/\r$/, '');
    if (!trimmed || trimmed.startsWith(':')) continue;
    const colon = trimmed.indexOf(':');
    const field = colon < 0 ? trimmed : trimmed.slice(0, colon);
    let val = colon < 0 ? '' : trimmed.slice(colon + 1);
    if (val.startsWith(' ')) val = val.slice(1);
    if (field === 'event') eventName = val;
    else if (field === 'data') dataLines.push(val);
  }
  const last = flush();
  if (last) yield last;
}

/** 安全解析 JSON（失败返回 null，不抛错）。 */
export function parseJsonSafe(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
