/**
 * 文本文件下载（第 239 轮巡检，分享视角的单点下载工具）：content script 环境下
 * 无 `downloads` 权限（manifest 仅 storage/offscreen/alarms/notifications/webRequest，
 * 见 wxt.config.ts）时的下载方案——Blob → URL.createObjectURL → 隐式 <a download>
 * 点击。blob: 下载是页面 DOM 内的下载动作而非资源加载 / 导航，不受页面 CSP 的
 * script/style 约束（Chrome 对 a[download] 走下载通道），无需任何扩展权限。
 *
 * 与 reviewCards.ts 第 37 轮内联实现的差异（行为兼容升级，本轮起作为全仓单点）：
 *  - 锚点临时 append 到 document.body 再 click（部分浏览器对未挂载锚点的 click
 *    触发下载不可靠，挂载后触发是稳妥惯例），finally 中移除；
 *  - try/finally 保证清理：click 抛错也移除锚点并 revoke objectURL（旧实现无
 *    清理保证，锚点对象依赖 GC）；
 *  - revoke 延迟 DOWNLOAD_REVOKE_DELAY_MS：click() 的下载动作异步消费 blob 引用，
 *    同步 revoke 在个别环境可能截断刚启动的下载（FileSaver 等同款惯例的保守取值）；
 *    finally 保证 revoke 必被调度（异常路径亦然）。
 *
 * 自 reviewCards.downloadTextFile 收编而来：第 80 轮 PeriodReportCard 导出、
 * 第 37 轮复习卡片导出、收藏清单 CSV 等调用点本轮统一走本模块（reviewCards 保留
 * 同名 re-export 兼容旧引用）。函数不返回值、不抛错给调用方之外的世界——异常
 * 由调用方 try/catch 后决定 toast 文案（同步下载没有进度与失败回调，成败以
 * 是否抛错近似，人工验收点见 §174）。
 */

/** objectURL 回收延迟（毫秒）：给 click() 启动的下载留足引用消费窗口 */
export const DOWNLOAD_REVOKE_DELAY_MS = 10_000;

export function downloadTextFile(filename: string, text: string, mime = 'text/markdown;charset=utf-8'): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  let attached = false;
  try {
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    attached = true;
    anchor.click();
  } finally {
    if (attached && anchor.parentNode) {
      anchor.parentNode.removeChild(anchor);
    }
    // finally 内调度回收：正常路径与异常路径（click 抛错 / append 被拦）都必达；
    // 延迟回收避免同步 revoke 截断下载（见文件头「revoke 延迟」说明）
    setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_REVOKE_DELAY_MS);
  }
}
