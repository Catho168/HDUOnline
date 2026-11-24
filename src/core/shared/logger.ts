/**
 * 本地环形日志（上限 200 条），写入前脱敏 URL 与常见密钥形态。
 */

import { MAX_LOG_ENTRIES, STORAGE_KEYS } from './constants';
import { extStorage } from './storage';
import { redactUrl } from './urlGuard';

/** 单条日志 detail 最大长度（第 273 轮，工程域）：超长详情（如组件栈）截断，防单条挤占环形日志配额 */
export const MAX_LOG_DETAIL = 500;

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

/** 全局开关（第 291 轮，工程域）：诊断日志开关（settings.debug.logEnabled）应用到
 *  此模块级变量——所有 scope 的 logger 实例共享同一开关（实例 setEnabled 委托）；
 *  模块级而非类静态，便于 applyDebugLogEnabled 从类外写入 */
let globalEnabled = true;

/** 存储写队列（第 299 轮，工程域）：append 是 fire-and-forget 的并发入口，
 *  get→push→读改写必须串行化，否则同 tick 并发日志会互相覆盖丢条目 */
let writeQueue: Promise<void> = Promise.resolve();

class Logger {
  private scope: string;

  constructor(scope: string) {
    this.scope = scope;
  }

  setEnabled(enabled: boolean): void {
    globalEnabled = enabled;
  }

  private get enabled(): boolean {
    return globalEnabled;
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

  private append(level: LogLevel, message: string, detail?: unknown): void {
    // detail 截断（第 273 轮，工程域）：componentStack 等超长详情限 500 字符——
    // 环形日志上限 200 条，防单条超长栈挤占配额；脱敏在截断前执行（先脱敏后截断，
    // 避免截断点切断脱敏标记）
    const rawDetail = detail === undefined ? undefined : redact(formatDetail(detail));
    const entry: LogEntry = {
      ts: Date.now(),
      level,
      scope: this.scope,
      message: redact(String(message)),
      detail:
        rawDetail === undefined
          ? undefined
          : rawDetail.length > MAX_LOG_DETAIL
            ? `${rawDetail.slice(0, MAX_LOG_DETAIL)}…`
            : rawDetail,
    };
    const verbose = this.enabled || level === 'error' || level === 'warn';
    if (verbose) writeLine(entry);
    if (!verbose) return;
    if (!this.enabled && level === 'debug') return;
    // 落存储走串行队列（第 299 轮，工程域）：排队执行读改写，防并发覆盖；
    // 队列自身吞异常，日志失败不得影响主流程
    writeQueue = writeQueue.then(() => this.writeEntry(entry)).catch(() => undefined);
  }

  private async writeEntry(entry: LogEntry): Promise<void> {
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

/** 应用诊断日志开关（第 291 轮，工程域）：settings.debug.logEnabled → 全局开关。
 *  各入口在加载 settings 后调用，使「记录诊断日志」设置真正生效。 */
export function applyDebugLogEnabled(enabled: boolean): void {
  globalEnabled = enabled;
}

export async function readLogs(): Promise<LogEntry[]> {
  return extStorage.get<LogEntry[]>('local', STORAGE_KEYS.logs, []);
}

/** 日志导出格式化（第 300 轮，功能域）：环形日志 → 纯文本（每条一行主消息 +
 *  可选详情行），供设置页「导出」按钮落盘离线排障；与日志区展示同构。 */
export function formatLogsAsText(logs: LogEntry[]): string {
  return logs
    .map((entry) => {
      const line = `[${new Date(entry.ts).toLocaleString()}] [${entry.level}] [${entry.scope}] ${entry.message}`;
      return entry.detail ? `${line}\n${entry.detail}` : line;
    })
    .join('\n');
}

export async function clearLogs(): Promise<void> {
  await extStorage.set('local', STORAGE_KEYS.logs, []);
}
