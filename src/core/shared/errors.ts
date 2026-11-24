/**
 * 统一错误模型。UI 只展示 userMessage；detail 进本地环形日志。
 */

export type AppErrorCode =
  | 'SITE_API_FAILED'
  | 'SITE_SELECTOR_MISSING'
  | 'SITE_ROUTE_UNSUPPORTED'
  | 'SITE_SESSION_UNRESOLVED'
  | 'BILI_API_FAILED'
  | 'AUTH_EXPIRED'
  | 'ASR_MODEL_MISSING'
  | 'ASR_MODEL_DOWNLOAD_FAILED'
  | 'ASR_DECODE_FAILED'
  | 'ASR_PARSE_FAILED'
  | 'ASR_NETWORK_FAILED'
  | 'ASR_INFER_FAILED'
  | 'ASR_MEMORY_PRESSURE'
  | 'ASR_UNSUPPORTED_FORMAT'
  | 'ASR_CANCELLED'
  | 'ASR_NO_AUDIO_TRACK'
  | 'LLM_NO_PROVIDER'
  | 'LLM_AUTH_FAILED'
  | 'LLM_PERMISSION_DENIED'
  | 'LLM_RATE_LIMITED'
  | 'LLM_SERVER_ERROR'
  | 'LLM_TIMEOUT'
  | 'LLM_NETWORK_ERROR'
  | 'LLM_BAD_OUTPUT'
  | 'LLM_ABORTED'
  | 'LLM_ENDPOINT_REJECTED'
  | 'DB_FAILED'
  | 'STORAGE_QUOTA'
  | 'INVALID_INPUT'
  | 'NOT_IMPLEMENTED'
  | 'UNKNOWN';

const FRIENDLY: Record<AppErrorCode, string> = {
  SITE_API_FAILED: '站点接口请求失败，请确认已登录并刷新页面',
  SITE_SELECTOR_MISSING: '页面结构已变化，该功能已自动跳过',
  SITE_ROUTE_UNSUPPORTED: '当前页面不支持该功能',
  SITE_SESSION_UNRESOLVED: '还不能确定当前课次，请在面板中手动选择',
  BILI_API_FAILED: 'B 站接口请求失败，请确认已登录 bilibili.com 并稍后重试',
  AUTH_EXPIRED: '登录状态可能已过期，请重新登录站点',
  ASR_MODEL_MISSING: '尚未准备转写模型，请在设置中下载或导入',
  ASR_MODEL_DOWNLOAD_FAILED: '模型下载失败，可重试或改为手动导入',
  ASR_DECODE_FAILED: '音频解码失败，该节次可能使用了不支持的编码',
  ASR_PARSE_FAILED: '视频文件结构解析失败',
  ASR_NETWORK_FAILED: '音频拉取中断，请检查网络后继续',
  ASR_INFER_FAILED: '语音识别推理失败，请重试（若反复失败可切换模型档位）',
  ASR_MEMORY_PRESSURE: '内存压力过大，已停止转写（可稍后从断点继续）',
  ASR_UNSUPPORTED_FORMAT: '该节次音频格式暂不支持转写',
  ASR_CANCELLED: '转写已取消',
  ASR_NO_AUDIO_TRACK: '未在该视频中找到音轨',
  LLM_NO_PROVIDER: '尚未配置 AI 服务，请在设置中添加',
  LLM_AUTH_FAILED: 'AI 服务鉴权失败，请检查 API Key',
  LLM_PERMISSION_DENIED: '缺少该端点的访问权限，请在设置中重新授权',
  LLM_RATE_LIMITED: 'AI 服务限流，请稍后重试',
  LLM_SERVER_ERROR: 'AI 服务返回错误',
  LLM_TIMEOUT: 'AI 请求超时',
  LLM_NETWORK_ERROR: '无法连接 AI 服务（网络或跨域限制）',
  LLM_BAD_OUTPUT: 'AI 返回内容不符合要求（已重试）',
  LLM_ABORTED: '已停止生成',
  LLM_ENDPOINT_REJECTED: '该端点地址被安全策略拒绝（本地/私网地址默认禁止）',
  DB_FAILED: '本地数据读写失败',
  STORAGE_QUOTA: '本地存储空间不足，建议导出并清理数据',
  INVALID_INPUT: '输入不合法',
  NOT_IMPLEMENTED: '功能尚未实现',
  UNKNOWN: '发生未知错误',
};

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly userMessage: string;
  readonly detail?: string;
  readonly retryable: boolean;

  constructor(code: AppErrorCode, opts: { detail?: string; userMessage?: string; retryable?: boolean; cause?: unknown } = {}) {
    super(opts.userMessage ?? FRIENDLY[code]);
    this.name = 'AppError';
    this.code = code;
    this.userMessage = opts.userMessage ?? FRIENDLY[code];
    this.detail = opts.detail ?? (opts.cause instanceof Error ? opts.cause.message : undefined);
    this.retryable = opts.retryable ?? false;
  }

  toJSON(): SerializedAppError {
    return { code: this.code, userMessage: this.userMessage, detail: this.detail, retryable: this.retryable };
  }
}

export interface SerializedAppError {
  code: AppErrorCode;
  userMessage: string;
  detail?: string;
  retryable: boolean;
}

/** errorTextOf 对非 Error 异常值（字符串 throw / undefined 等）的固定兜底文案 */
export const ERROR_TEXT_FALLBACK = '操作失败，请重试';

/**
 * 面板/弹窗错误文案统一出口（第 27 轮审计 P3-3；第 222 轮收紧）：AppError 取 userMessage
 * （callOp 反序列化回来的错误就是 AppError，且 message === userMessage，既有行为不变）；
 * 普通 Error / 其余异常值一律回退兜底文案——不再透出内部技术文案（第 221 轮实证：
 * showBatchResult 递归 bug 期间用户 toast 直显过 "Maximum call stack size exceeded"）。
 * 替代各 UI 里 `err instanceof Error ? err.message : '…'` 的散落三元式。fallback 可选，
 * 供调用方保留语境化兜底文案；缺省统一为「操作失败，请重试」。
 *
 * 结构化错误透传链（第 255 轮盘点收口）：主链 AppError → serializeError（op RPC 响应）
 * → deserializeError → AppError 全程保 userMessage；跨模块传递中未经 deserialize 的
 * 裸结构化对象（SerializedAppError 形态 / duck-typed `{ userMessage: string }`）也一并
 * 识别——非空字符串 userMessage 视为已归类文案直取，空串 / 非字符串 / 普通对象
 * （如 `{ code: 1 }`）维持回退，不扩大技术文案泄漏面。
 */
export function errorTextOf(err: unknown, fallback: string = ERROR_TEXT_FALLBACK): string {
  if (err instanceof AppError) return err.userMessage;
  const structured = (err as { userMessage?: unknown } | null | undefined)?.userMessage;
  if (typeof structured === 'string' && structured.length > 0) return structured;
  return fallback;
}

export function toAppError(err: unknown, fallbackCode: AppErrorCode = 'UNKNOWN'): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof DOMException && err.name === 'AbortError') {
    return new AppError('LLM_ABORTED', { cause: err });
  }
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return new AppError(fallbackCode, { detail, cause: err });
}

export function serializeError(err: unknown): SerializedAppError {
  const appErr = toAppError(err);
  return { code: appErr.code, userMessage: appErr.userMessage, detail: appErr.detail, retryable: appErr.retryable };
}

export function deserializeError(err: SerializedAppError): AppError {
  return new AppError(err.code, { userMessage: err.userMessage, detail: err.detail, retryable: err.retryable });
}
