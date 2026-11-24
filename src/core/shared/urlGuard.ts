/**
 * 网络请求地址校验。
 *  - 只允许 http(s)；
 *  - 默认拒绝环回/私网/链路本地/保留地址；
 *  - 用户显式开启 allowLocal 后放行环回，但始终拒绝云元数据地址。
 */

export interface UrlGuardOptions {
  allowLocal?: boolean;
  protocols?: string[];
}

export interface UrlGuardResult {
  ok: boolean;
  reason?: 'bad-url' | 'bad-protocol' | 'no-host' | 'private-address' | 'metadata-endpoint';
  message?: string;
}

const METADATA_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  '100.100.100.200',
  'fd00:ec2::254',
]);

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV4_MAPPED_V6_PATTERN = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;

function isPrivateIPv4(host: string): boolean {
  const m = host.match(IPV4_PATTERN);
  if (!m) return false;
  const octets = [m[1], m[2], m[3], m[4]].map((part) => Number(part));
  if (octets.some((o) => o > 255)) return true;
  const a = octets[0] ?? 0;
  const b = octets[1] ?? 0;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIPv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === '::' || h === '::1') return true;
  if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) return true;
  if (h.startsWith('fc') || h.startsWith('fd')) return true;
  if (h.startsWith('ff')) return true;
  const mapped = h.match(IPV4_MAPPED_V6_PATTERN);
  if (mapped?.[1]) return isPrivateIPv4(mapped[1]);
  return false;
}

function isLocalHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === 'local' ||
    h.endsWith('.local') ||
    h.endsWith('.internal') ||
    h === 'host.docker.internal' ||
    h === 'gateway.docker.internal'
  );
}

export function checkUrl(rawUrl: string, opts: UrlGuardOptions = {}): UrlGuardResult {
  const protocols = opts.protocols ?? ['http:', 'https:'];
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'bad-url', message: '地址格式不正确' };
  }
  if (!protocols.includes(url.protocol)) {
    return { ok: false, reason: 'bad-protocol', message: `仅支持 ${protocols.join(' / ')} 协议` };
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) return { ok: false, reason: 'no-host', message: '地址缺少主机名' };

  if (METADATA_HOSTS.has(host.toLowerCase())) {
    return { ok: false, reason: 'metadata-endpoint', message: '该地址属于云元数据服务，已拒绝访问' };
  }

  const isLiteralV4 = IPV4_PATTERN.test(host);
  const isLiteralV6 = host.includes(':');
  const isPrivate = isLiteralV4 ? isPrivateIPv4(host) : isLiteralV6 ? isPrivateIPv6(host) : isLocalHostname(host);

  if (isPrivate && !opts.allowLocal) {
    return {
      ok: false,
      reason: 'private-address',
      message: '本地/私网地址默认被拒绝；如确实使用本机推理服务，请在设置中开启"允许本地推理端点"',
    };
  }
  return { ok: true };
}

export function assertUrlAllowed(rawUrl: string, opts: UrlGuardOptions = {}): void {
  const res = checkUrl(rawUrl, opts);
  if (!res.ok) {
    const err = new Error(res.message ?? 'URL rejected');
    err.name = `UrlRejected:${res.reason ?? 'unknown'}`;
    throw err;
  }
}

/** 日志/展示用：去掉 query 与 hash（避免 auth_key 签名进入日志） */
export function redactUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    const idx = rawUrl.search(/[?#]/);
    return idx >= 0 ? rawUrl.slice(0, idx) : rawUrl;
  }
}

/** 规范化为 host 权限匹配串（Chrome match pattern 不区分端口，端口需去掉） */
export function toOriginPattern(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `${url.protocol}//${url.hostname}/*`;
  } catch {
    return null;
  }
}
