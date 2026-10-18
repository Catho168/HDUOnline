/**
 * 本地环形日志（上限 200 条），写入前脱敏 URL 与常见密钥形态。
 */

import { MAX_LOG_ENTRIES, STORAGE_KEYS } from './constants';
import { extStorage } from './storage';
import { redactUrl } from './urlGuard';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: number;
  level: LogLevel;
  scope: string;
  message: string;
  detail?: string;
}

type Redactor = string | ((match: string, ...groups: string[]) => string);
const SECRET_PATTERNS: Array<[RegExp, Redactor]> = [
  [/\b(sk-[A-Za-z0-9_-]{6,})/g, 'sk-***'],
  [/\b(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1***'],
  [/(x-api-key|api[-_]?key|authorization)("?\s*[:=]\s*"?)([^\s",}]{6,})/gi, '$1$2***'],
  [/(auth_key=)[^&\s]+/gi, '$1***'],
  [/((?:cookie|jwt[-_]?token|refresh[-_]?token)("?\s*[:=]\s*"?))([^\s",}]{6,})/gi, '$1***'],
  [/\bhttps?:\/\/[^\s"'<>)]+/g, (match) => redactUrl(match)],
];

export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement as unknown as string);
  }
  return out;
}

function writeLine(entry: LogEntry): void {
  const line = `[${entry.scope}] ${entry.message}${entry.detail ? ` — ${entry.detail}` : ''}`;
  switch (entry.level) {
    case 'error':
      console.error(line);
      break;
    case 'warn':
      console.warn(line);
      break;
    case 'debug':
      console.debug(line);
      break;
    default:
      console.info(line);
  }
}

class Logger {
  private scope: string;
  private enabled = true;

  constructor(scope: string) {
    this.scope = scope;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  debug(message: string, detail?: unknown): void {
    void this.append('debug', message, detail);
  }

  info(message: string, detail?: unknown): void {
    void this.append('info', message, detail);
  }

  warn(message: string, detail?: unknown): void {
    void this.append('warn', message, detail);
  }

  error(message: string, detail?: unknown): void {
    void this.append('error', message, detail);
  }

  private async append(level: LogLevel, message: string, detail?: unknown): Promise<void> {
    const entry: LogEntry = {
      ts: Date.now(),
      level,
      scope: this.scope,
      message: redact(String(message)),
      detail: detail === undefined ? undefined : redact(formatDetail(detail)),
    };
    const verbose = this.enabled || level === 'error' || level === 'warn';
    if (verbose) writeLine(entry);
    if (!verbose) return;
    if (!this.enabled && level === 'debug') return;
    try {
      const logs = await extStorage.get<LogEntry[]>('local', STORAGE_KEYS.logs, []);
      logs.push(entry);
      const trimmed = logs.length > MAX_LOG_ENTRIES ? logs.slice(logs.length - MAX_LOG_ENTRIES) : logs;
      await extStorage.set('local', STORAGE_KEYS.logs, trimmed);
    } catch {
      /* 日志失败不得影响主流程 */
    }
  }
}

function formatDetail(detail: unknown): string {
  if (detail instanceof Error) return `${detail.name}: ${detail.message}`;
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

export function createLogger(scope: string): Logger {
  return new Logger(scope);
}

export async function readLogs(): Promise<LogEntry[]> {
  return extStorage.get<LogEntry[]>('local', STORAGE_KEYS.logs, []);
}

export async function clearLogs(): Promise<void> {
  await extStorage.set('local', STORAGE_KEYS.logs, []);
}
