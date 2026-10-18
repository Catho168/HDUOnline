/** 通用工具：ID、时间、格式化、异步与对象操作。 */

export function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    // 极端环境兜底：标识符仅用于本地实体，不承担安全语义。
    // 使用时间戳 + 单调计数填充，避免引入可预测性更差的全局 PRNG。
    let seed = Date.now();
    for (let i = 0; i < bytes.length; i += 1) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      bytes[i] = seed & 0xff;
    }
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function formatClock(sec: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function formatDuration(sec: number): string {
  const total = Math.max(0, Math.round(sec));
  if (total < 60) return `${total} 秒`;
  const h = Math.floor(total / 3600);
  const m = Math.round((total % 3600) / 60);
  if (h === 0) return `${m} 分钟`;
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`;
}

export function localDayKey(ts: number | Date = Date.now()): string {
  const d = ts instanceof Date ? ts : new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function startOfLocalDay(ts: number = Date.now()): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function startOfLocalWeek(ts: number = Date.now()): number {
  const d = new Date(startOfLocalDay(ts));
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  return d.getTime();
}

export function dayKeyToTs(dayKey: string): number {
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0).getTime();
}

export function shortDayLabel(dayKey: string): string {
  const parts = dayKey.split('-');
  return `${parts[1] ?? ''}-${parts[2] ?? ''}`;
}

export function recentDayKeys(n: number, from: number = Date.now()): string[] {
  const out: string[] = [];
  const base = startOfLocalDay(from);
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date(base);
    d.setDate(d.getDate() - i);
    out.push(localDayKey(d));
  }
  return out;
}

export function buildCourLabel(opts: {
  weekNumber?: number;
  beginTime?: number;
  letiNumber?: number;
  clroName?: string;
}): string {
  const segs: string[] = [];
  if (opts.weekNumber && opts.weekNumber > 0) segs.push(`第${opts.weekNumber}周`);
  if (opts.beginTime) {
    const d = new Date(opts.beginTime);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    segs.push(`${y}-${m}-${day}`);
  }
  if (opts.letiNumber) segs.push(`第${opts.letiNumber}节课`);
  if (opts.clroName) segs.push(opts.clroName);
  if (segs.length === 0) segs.push('未知课次');
  return segs.join(' / ');
}

export function formatTimeRange(begin?: number, end?: number): string {
  const fmt = (ts?: number) => {
    if (!ts) return '';
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const b = fmt(begin);
  const e = fmt(end);
  return b && e ? `${b}–${e}` : b || e;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function roundTo(value: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function ratio(part: number, whole: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return 0;
  return clamp(part / whole, 0, 1);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: { retries: number; baseDelayMs?: number; shouldRetry?: (err: unknown, attempt: number) => boolean; signal?: AbortSignal },
): Promise<T> {
  const baseDelay = opts.baseDelayMs ?? 800;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (opts.signal?.aborted) throw err;
      if (attempt === opts.retries) break;
      if (opts.shouldRetry && !opts.shouldRetry(err, attempt)) break;
      await sleep(baseDelay * 2 ** attempt, opts.signal);
    }
  }
  throw lastErr;
}

export async function sequential<T, R>(items: T[], fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += 1) {
    out.push(await fn(items[i] as T, i));
  }
  return out;
}

export function deepMerge<T>(base: T, patch: Partial<T>): T {
  if (patch === undefined) return base;
  if (Array.isArray(base) || Array.isArray(patch)) return (patch as unknown as T) ?? base;
  if (typeof base === 'object' && base !== null && typeof patch === 'object' && patch !== null) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
      if (v === undefined) continue;
      const bv = (base as Record<string, unknown>)[k];
      out[k] =
        typeof v === 'object' && v !== null && !Array.isArray(v) && typeof bv === 'object' && bv !== null
          ? deepMerge(bv, v as never)
          : v;
    }
    return out as T;
  }
  return (patch as unknown as T) ?? base;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function summarize(text: string, max = 80): string {
  return truncate(text.replace(/\s+/g, ' ').trim(), max);
}

/** 毫秒时间戳的短日期：'MM-DD HH:mm' */
export function formatDateTime(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
