/**
 * 剪贴板复制（第 235 轮巡检）：content script 环境（Shadow DOM 注入 UI）下
 * `navigator.clipboard.writeText` 可能不可用（无权限 / 非安全上下文）或被拒，
 * 回退 `document.execCommand('copy')` + 临时 textarea 方案。
 *
 * 返回是否成功（不抛错），由调用方决定 toast 文案；空文本直接按失败处理
 * （避免复制空串给用户「已复制」的错觉）。
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof text !== 'string' || text.length === 0) return false;
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 权限被拒 / 环境不支持：落入 execCommand 回退 */
  }
  try {
    if (typeof document === 'undefined') return false;
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
    document.body.removeChild(textarea);
    return ok === true;
  } catch {
    return false;
  }
}
