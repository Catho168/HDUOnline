/**
 * 播放页顶栏注入锚点（注入式 UI 第一阶段）。
 *
 * 职责：观察站点 `.play-header` 的出现与 Vue 重渲染（注入节点会被站点 diff 掉），
 * 在其末尾 append 一枚受控 chip host（独立 open shadow + HeaderChip 组件），
 * 并在顶栏消失时摘除自身节点。append-only：绝不修改/删除站点既有节点。
 *
 * 应对先例（照 player.ts）：MutationObserver（childList+subtree，120ms 去抖重扫）
 * + 周期轮询兜底（站点部分操作不触发可观察的 DOM 变更）。
 * 生命周期（照 pageCleanups 契约）：路由 teardown / onInvalidated 时 dispose 全量摘除。
 */

import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SELECTORS } from '@/core/shared/constants';
import { createLogger } from '@/core/shared/logger';
import { CHIP_CSS, HeaderChip } from '../ui/HeaderChip';

const log = createLogger('content');

const DEBOUNCE_MS = 120;
/** chip host 自标识：重挂去重与清理识别都靠它 */
const HOST_MARKER = 'data-hdu-anchor-chip';

export interface PlayHeaderAnchor {
  /** chip 当前是否已挂载到站点顶栏 */
  isMounted(): boolean;
  /** 全量摘除：unmount React、移除自身 host、停观察器（站点 DOM 恢复原状） */
  dispose(): void;
}

export interface PlayHeaderAnchorOptions {
  /** 挂载状态变化回调（联动 uiStore.anchorChipActive：true 时隐藏浮窗胶囊） */
  onMountedChange?: (mounted: boolean) => void;
  /** 轮询兜底间隔（测试可注入小值；0 关闭轮询） */
  pollMs?: number;
}

export function createPlayHeaderAnchor(options: PlayHeaderAnchorOptions = {}): PlayHeaderAnchor {
  const { onMountedChange, pollMs = 2000 } = options;
  let disposed = false;
  let mounted = false;
  let host: HTMLElement | null = null;
  let root: Root | null = null;
  let debounceTimer: number | null = null;
  let pollTimer: number | null = null;
  let observer: MutationObserver | null = null;

  const setMounted = (next: boolean): void => {
    if (mounted === next) return;
    mounted = next;
    try {
      onMountedChange?.(next);
    } catch (err) {
      log.warn('anchor 挂载状态回调异常', err);
    }
  };

  const unmountChip = (): void => {
    if (!host) return;
    try {
      root?.unmount();
    } catch (err) {
      log.warn('anchor chip unmount 异常', err);
    }
    root = null;
    host.remove();
    host = null;
    setMounted(false);
  };

  const mountChip = (header: Element): void => {
    // 去重：顶栏里已有本扩展的 chip host（可能刚被 Vue 移动过）则不重复 append
    const existing = header.querySelector(`:scope [${HOST_MARKER}]`);
    if (existing) {
      if (existing !== host) {
        // 理论不可达（同页面只有一个 anchor 实例），防御式清理再重挂
        existing.remove();
      } else {
        setMounted(true);
        return;
      }
    }
    unmountChip();
    try {
      const nextHost = document.createElement('div');
      nextHost.setAttribute(HOST_MARKER, '1');
      // display:contents 让 chip 按钮直接成为顶栏 flex 的成员（不引入多余布局层）
      nextHost.style.cssText = 'all: initial; display: contents;';
      // host 引用赋值前移（第 16 轮 P3）：后续 attachShadow / appendChild / createRoot /
      // render 任一步同步抛错时，catch 路径的 unmountChip 都能摘除这个已带标记的
      // nextHost（旧实现 host 在末尾赋值，catch 时 host===null 早退，孤儿节点残留站点顶栏）
      host = nextHost;
      const shadow = nextHost.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = CHIP_CSS;
      shadow.appendChild(style);
      const mountPoint = document.createElement('div');
      shadow.appendChild(mountPoint);
      header.appendChild(nextHost);
      root = createRoot(mountPoint);
      root.render(createElement(HeaderChip));
      setMounted(true);
    } catch (err) {
      log.warn('anchor chip 挂载失败（保持浮窗降级）', err);
      unmountChip();
    }
  };

  const scan = (): void => {
    if (disposed) return;
    const header = document.querySelector(SELECTORS.playHeader);
    if (header) {
      // chip host 已被站点 Vue diff 掉（host 不在 header 内）时重挂
      if (!host || !host.isConnected || host.parentElement !== header) {
        mountChip(header);
      } else {
        setMounted(true);
      }
    } else {
      unmountChip();
    }
  };

  const scheduleScan = (): void => {
    if (disposed || debounceTimer !== null) return;
    debounceTimer = window.setTimeout(() => {
      debounceTimer = null;
      scan();
    }, DEBOUNCE_MS);
  };

  // 首次扫描（顶栏可能已渲染）
  scan();

  try {
    observer = new MutationObserver(() => scheduleScan());
    observer.observe(document.body, { childList: true, subtree: true });
  } catch (err) {
    log.warn('anchor MutationObserver 启动失败（仅靠轮询兜底）', err);
  }

  if (pollMs > 0) {
    pollTimer = window.setInterval(scan, pollMs);
  }

  return {
    isMounted: () => mounted,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (debounceTimer !== null) window.clearTimeout(debounceTimer);
      if (pollTimer !== null) window.clearInterval(pollTimer);
      observer?.disconnect();
      observer = null;
      unmountChip();
    },
  };
}
