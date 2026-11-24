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

/** 字节数人性化展示（存储用量等；KB/MB 一位小数，GB 两位小数） */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 安全解析字符串数组 JSON（第 167 轮巡检）：非法 JSON / 非数组 / 非字符串元素均回退空数组。
 *  用于 sessionStorage 等不可信存储的防御式读取。 */
export function safeJsonParseStringArray(raw: string | null | undefined): string[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/** 时间戳 → 'MM/DD' 月日短格式（第 180 轮巡检：通知点名等场景统一口径）；非法时间戳返回空串 */
export function formatMonthDay(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const d = new Date(ts);
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

/** 计数徽标文案（第 187 轮巡检）：超过 99 折叠为「99+」，其余原样；非法值回退 '0' */
export function formatCount99(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '0';
  return count > 99 ? '99+' : String(Math.floor(count));
}

/** 批量进度百分比文案（第 222 轮巡检）：done/total → '42%'（四舍五入，封顶 100%）；
 *  total 非法或 ≤0 回退 '0%'，done 越界按边界处理，防「101%」类怪值上屏。 */
export function formatPercent(done: number, total: number): string {
  if (!Number.isFinite(total) || total <= 0) return '0%';
  const d = Number.isFinite(done) ? Math.min(Math.max(0, done), total) : 0;
  return `${Math.min(100, Math.round((d / total) * 100))}%`;
}

/** 菜单键盘导航的下一焦点索引（第 190 轮巡检）：ArrowDown/ArrowUp 相对移动、Home/End 跳首尾；
 *  其它按键返回 -1（不移动）。count ≤0 或 activeIndex 越界时按 0 处理。 */
export function nextMenuFocusIndex(key: string, count: number, activeIndex: number): number {
  if (!Number.isFinite(count) || count <= 0) return -1;
  const last = count - 1;
  let idx = Number.isFinite(activeIndex) ? Math.min(Math.max(0, Math.floor(activeIndex)), last) : 0;
  switch (key) {
    case 'ArrowDown':
      return Math.min(last, idx + 1);
    case 'ArrowUp':
      return Math.max(0, idx - 1);
    case 'Home':
      return 0;
    case 'End':
      return last;
    default:
      return -1;
  }
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

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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

/**
 * 宽松对象判断：非 null、非数组且 typeof === 'object' 才视为记录。
 * （第 16 轮全仓收敛：此前 bili 域（apiClient）、unified、today 各有一份私有实现，
 * 统一下沉到此处，签名与语义保持一致。）
 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 站外跳转协议白名单（第 17 轮 P2-1 收口，全仓单份实现）：URL 会直通 anchor href /
 * window.open，只放行 http(s)；其余（javascript:/data:/ftp: 等，来源可能是 DB 篡改或
 * 恶意备份导入——importer 对 favorites.metadata.url 无协议校验）一律丢弃返回 null，
 * 由调用方回退到按 bvid 还原的官方 URL。消费方：unified 搜索跳转、今日待办 video 条目、
 * 知识库卡片「打开视频/从 N 续看」。
 */
export function safeExternalUrl(url: unknown): string | null {
  const value = typeof url === 'string' ? url.trim() : '';
  return value !== '' && /^https?:\/\//i.test(value) ? value : null;
}

/**
 * 续看/锚点跳转的时间参数拼接（第 18 轮收敛：此前 today/unified 各有 resumeUrlOf、
 * LearningCenter 与 dashboard 各有内联副本，共四份）。URL 已带查询串时用 & 追加
 * （兼容 ?p= 分 P），秒数向下取整并钳制非负。
 *
 * 第 28 轮 P3-4（单点去重）：追加前先剥离 query 中已存在的 `t=` 参数——
 * B 站收藏的 metadata.url 取自动作时的 location.href，可能已带 `?t=`（从分享链接/
 * 进度跳转进入再收藏的场景），直接 `&` 追加会产生重复 `t=`，播放器只认其中一个，
 * 续看落点产生歧义。只在 query 段内做参数级过滤：不动 path/hash、不重编码其余参数
 * （不用 URL/URLSearchParams，避免其对保留字符的再编码改变原 URL 形态）。
 */
export function withTimeParam(url: string, lastPositionSec: number): string {
  const pos = Math.max(0, Math.floor(lastPositionSec));
  const hashIndex = url.indexOf('#');
  const beforeHash = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const hash = hashIndex === -1 ? '' : url.slice(hashIndex);
  const queryIndex = beforeHash.indexOf('?');
  if (queryIndex === -1) return `${beforeHash}?t=${pos}${hash}`;
  const base = beforeHash.slice(0, queryIndex);
  const kept = beforeHash
    .slice(queryIndex + 1)
    .split('&')
    .filter((pair) => pair !== '' && !pair.startsWith('t='));
  const separator = kept.length > 0 ? `${base}?${kept.join('&')}&` : `${base}?`;
  return `${separator}t=${pos}${hash}`;
}

/**
 * 读取深链秒级锚点（第 104 轮巡检）：统一搜索的课次跳转在 B 站侧以新标签打开
 * HDU 播放页，命中秒数经 withTimeParam 写入真实 query（`?t=<秒>`，见 openHduSession）。
 * HDU 内容脚本启动时解析一次并在播放器就绪后 seek；缺失/非纯数字返回 null（防御脏参，
 * 不抛错）。
 */
export function bootSeekSecondsOf(search: string): number | null {
  const raw = new URLSearchParams(search).get('t');
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const sec = Number(raw);
  return Number.isFinite(sec) ? sec : null;
}

/**
 * 日键加减天数（第 107 轮巡检）：'YYYY-MM-DD' → 'YYYY-MM-DD'（本地日历日，
 * 跨夏令时安全——用日期对象递推而非毫秒加法）。非法输入返回 null。
 */
export function addDaysKey(dayKey: string, days: number): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match || !Number.isFinite(days)) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  date.setDate(date.getDate() + Math.trunc(days));
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * 下一个指定星期几的日键（第 112 轮巡检）：改期快捷档（下周一/下周五）用。
 * weekday: 0=周日..6=周六；严格晚于 dayKey（当天不算）；非法输入返回 null。
 */
export function nextWeekdayKey(dayKey: string, weekday: number): string | null {
  const base = addDaysKey(dayKey, 0);
  if (base === null || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) return null;
  const date = new Date(Number(base.slice(0, 4)), Number(base.slice(5, 7)) - 1, Number(base.slice(8, 10)));
  const delta = (weekday - date.getDay() + 7) % 7 || 7;
  return addDaysKey(base, delta);
}

/**
 * 取键盘/指针事件的「真实目标」（第 51 轮审计 P2-1）：shadow DOM 内的键盘事件冒泡到
 * document 时 target 被重定向为 shadow host，输入态守卫（INPUT/TEXTAREA/SELECT/
 * isContentEditable）会失真；composedPath()[0] 是未重定向的原始目标。jsdom 等环境
 * 无 composedPath 时回落 event.target。
 */
export function eventTargetOf(event: {
  composedPath?: () => Array<unknown>;
  target?: unknown;
}): unknown {
  try {
    const path = event.composedPath?.();
    if (path && path.length > 0) return path[0] ?? null;
  } catch {
    /* composedPath 不可用时回落 target */
  }
  return event.target ?? null;
}
