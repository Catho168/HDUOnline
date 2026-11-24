/**
 * B 站视频页工具栏注入探针（第 33 轮巡检，框架先行）。
 *
 * 职责：按优先级扫描 B 站视频页原生工具栏候选（点赞/投币/收藏按钮区域 → 工具栏容器），
 * 在第一个命中且稳定（连续两轮扫描命中同一元素，滤掉站点动态重建的瞬时节点）的候选
 * 末尾 append 一枚受控注入 host（独立 open shadow + 一枚圆形「学习助手」图标按钮）。
 * 点击经 props.onActivate() 交回内容脚本——B 站侧走既有 .bili-qa-fab 的点击路径
 * （等价 setQaOpen(true)），不新增面板控制通道。
 *
 * 为什么「框架先行」：B 站视频页工具栏类名在仓库内零 DOM 证据（站点改版频繁，盲写
 * 选择器会漂移），因此本探针不依赖勘察结果——全部候选不命中时保持未挂载，继续走现有
 * 浮层 FAB 降级（零回归）；真机勘察回填后只需替换 constants.ts 的
 * BILI_TOOLBAR_PROBE_SELECTORS 常量，探针逻辑零改动。
 *
 * 应对先例（照 HDU 侧 anchorProbe.ts 同构）：MutationObserver（childList+subtree，
 * 120ms 去抖重扫）+ 周期轮询兜底；append-only（绝不修改/删除站点既有节点）；站点
 * diff 掉 host 后自动重挂；onInvalidated 时 dispose 全量摘除。
 *
 * 主题跟随：挂载时采样站点深浅（resolveHostTheme），低频（5s 节流，随扫描周期）复采；
 * 深色时在入口根节点加 data-theme="dark" 切换 BILI_TOOLBAR_ENTRY_CSS 的深色令牌
 * （中性玻璃质感，不写死 B 站配色变量，不依赖站点类名 / 站点 CSS）。
 */

import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BILI_TOOLBAR_PROBE_HOST_MARKER, BILI_TOOLBAR_PROBE_SELECTORS } from '@/core/shared/constants';
import { createLogger } from '@/core/shared/logger';
import { resolveHostTheme, type HostTheme } from '@/core/shared/hostTheme';
import { Icon } from '../ui/icons';

const log = createLogger('content');

const DEBOUNCE_MS = 120;
/** 站点深浅复采节流：低频跟随站点换肤，避免每次扫描都读 computed style */
const THEME_SAMPLE_MS = 5000;
/** 注入 host 自标识：重挂去重与清理识别都靠它 */
const HOST_MARKER = BILI_TOOLBAR_PROBE_HOST_MARKER;

/** 本扩展在 B 站页面的既有注入宿主（护栏：候选不得落在自家节点内） */
const OWN_HOST_IDS = ['hdu-bili-collect-host', 'hdu-bili-hub-host'] as const;

export type BiliToolbarProbeKind = 'toolbar';

/**
 * 候选清单（顺序 = 优先级），每轮扫描全量重评以填充诊断（不短路）。
 * 选择器串在 constants.ts 的 BILI_TOOLBAR_PROBE_SELECTORS（真机勘察回填点）。
 */
const CANDIDATES: ReadonlyArray<{ kind: BiliToolbarProbeKind; selector: string }> =
  BILI_TOOLBAR_PROBE_SELECTORS.toolbar.map((selector) => ({ kind: 'toolbar' as const, selector }));

// ───────────────────────── 诊断（供与真机勘察对照） ─────────────────────────

export interface BiliToolbarProbeSelectorDiag {
  kind: BiliToolbarProbeKind;
  selector: string;
  /** 最近一次扫描是否命中（已过自身宿主排除护栏） */
  hit: boolean;
  firstHitAt: number | null;
  lastHitAt: number | null;
}

export interface BiliToolbarProbeDiagnostics {
  installedAt: number;
  updatedAt: number;
  mounted: boolean;
  active: { kind: BiliToolbarProbeKind; selector: string } | null;
  candidates: ReadonlyArray<BiliToolbarProbeSelectorDiag>;
}

declare global {
  interface Window {
    /** B 站工具栏探针只读诊断快照（best-effort，try/catch 包裹，不保证存在） */
    __hduBiliToolbarProbe?: BiliToolbarProbeDiagnostics;
  }
}

// ───────────────────────── 注入入口组件（样式自包含在 shadow 内） ─────────────────────────

/**
 * 入口视觉：中性玻璃质感圆形按钮（约 38px，与 B 站工具栏按钮尺寸相近），自带全部
 * 样式令牌，不依赖站点类名 / 不用站点 CSS 变量。hover 态自包含；站点深色模式由
 * 控制器采样后在根节点挂 data-theme="dark" 切换深色令牌。
 */
export const BILI_TOOLBAR_ENTRY_CSS = `
:host { all: initial; }
.hdu-bili-toolbar-entry {
  display: inline-flex; flex: 0 0 auto; align-items: center;
  margin-left: 8px; vertical-align: middle;
  font-family: -apple-system, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif;
}
.hdu-bili-toolbar-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 38px; height: 38px; padding: 0;
  border-radius: 50%;
  border: 1px solid rgba(15, 23, 42, 0.14);
  background: rgba(255, 255, 255, 0.92);
  color: #1f2937;
  cursor: pointer; user-select: none;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.1);
  transition: background .15s ease, border-color .15s ease;
}
.hdu-bili-toolbar-btn:hover { background: #ffffff; border-color: rgba(15, 23, 42, 0.3); }
.hdu-bili-toolbar-btn svg { flex: 0 0 auto; }
/* ───────── 站点深色模式跟随 ─────────
   采样到站点深底（resolveHostTheme）时由控制器给入口根节点挂 data-theme="dark"，
   此处只覆盖入口自身的低亮度配色（调性对齐 anchorProbe 的深色令牌一族），
   不依赖站点类名。 */
.hdu-bili-toolbar-entry[data-theme="dark"] .hdu-bili-toolbar-btn {
  border-color: rgba(148, 163, 184, 0.28);
  background: rgba(26, 29, 33, 0.92);
  color: #e2e8f0;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
}
.hdu-bili-toolbar-entry[data-theme="dark"] .hdu-bili-toolbar-btn:hover {
  background: #22262b;
  border-color: rgba(148, 163, 184, 0.45);
}
`;

interface BiliToolbarEntryProps {
  /** 点击回调：交回内容脚本走既有学习助手入口路径 */
  onActivate: () => void;
  /** 站点深浅模式（挂载时采样 + 低频跟随），dark 时切深色令牌 */
  theme: HostTheme;
}

function BiliToolbarEntry(props: BiliToolbarEntryProps) {
  const { onActivate, theme } = props;
  return createElement(
    'div',
    { className: 'hdu-bili-toolbar-entry', 'data-theme': theme },
    createElement(
      'button',
      {
        key: 'btn',
        type: 'button',
        className: 'hdu-bili-toolbar-btn',
        title: '学习助手',
        'aria-label': '学习助手',
        onClick: onActivate,
      },
      createElement(Icon, { key: 'btn-icon', name: 'spark', size: 20 }),
    ),
  );
}

// ───────────────────────── 探针控制器 ─────────────────────────

interface ToolbarHit {
  kind: BiliToolbarProbeKind;
  selector: string;
  el: Element;
}

export interface BiliToolbarProbe {
  /** 注入入口当前是否已挂载到某个候选锚点 */
  isMounted(): boolean;
  /** 当前命中的候选（未挂载时 null；诊断/测试用） */
  getActive(): { kind: BiliToolbarProbeKind; selector: string } | null;
  /** 全量摘除：unmount React、移除自身 host、停观察器、清诊断（站点 DOM 恢复原状） */
  dispose(): void;
}

export interface BiliToolbarProbeOptions {
  /** 挂载状态变化回调（内容脚本据此隐藏/恢复 .bili-qa-fab 浮层入口，保持单入口） */
  onMountedChange?: (mounted: boolean) => void;
  /** 入口按钮点击回调（打开学习助手面板） */
  onActivate?: () => void;
  /** 轮询兜底间隔（测试可注入小值；0 关闭轮询，仅靠首扫 + 去抖确认） */
  pollMs?: number;
}

export function createBiliToolbarProbe(options: BiliToolbarProbeOptions = {}): BiliToolbarProbe {
  const { onMountedChange, onActivate, pollMs = 2000 } = options;
  const installedAt = Date.now();
  let disposed = false;
  let mounted = false;
  let host: HTMLElement | null = null;
  let root: Root | null = null;
  let active: { kind: BiliToolbarProbeKind; selector: string } | null = null;
  /** 稳定性确认：上一轮扫描命中的候选元素（连续两轮命中同一元素才挂载） */
  let pending: { el: Element; kind: BiliToolbarProbeKind } | null = null;
  let debounceTimer: number | null = null;
  let pollTimer: number | null = null;
  let observer: MutationObserver | null = null;
  /** 站点深浅模式：挂载时采样一次，之后随扫描周期低频复采跟随 */
  let theme: HostTheme = 'light';
  let lastThemeSampleAt = 0;
  const diag: BiliToolbarProbeSelectorDiag[] = CANDIDATES.map((spec) => ({
    kind: spec.kind,
    selector: spec.selector,
    hit: false,
    firstHitAt: null,
    lastHitAt: null,
  }));

  const setMounted = (next: boolean): void => {
    if (mounted === next) return;
    mounted = next;
    try {
      onMountedChange?.(next);
    } catch (err) {
      log.warn('bili toolbar probe 挂载状态回调异常', err);
    }
  };

  /** 候选资格护栏：必须连接在文档上，且不能落在本扩展自身的注入宿主内 */
  const isEligibleAnchor = (el: Element): boolean => {
    try {
      if (!el.isConnected) return false;
      for (const id of OWN_HOST_IDS) {
        if (el.closest(`#${id}`)) return false;
      }
      if (el.closest(`[${HOST_MARKER}]`)) return false;
      return true;
    } catch {
      return false;
    }
  };

  /** 全量重评所有候选（不短路：诊断需要每个选择器的命中情况），返回最高优先级的合格命中 */
  const evaluate = (): ToolbarHit | null => {
    let hit: ToolbarHit | null = null;
    const now = Date.now();
    CANDIDATES.forEach((spec, index) => {
      const entry = diag[index];
      if (!entry) return;
      let el: Element | null = null;
      try {
        el = document.querySelector(spec.selector);
      } catch {
        // 非法选择器（勘察回填笔误）按未命中处理，不中断扫描
      }
      if (el && isEligibleAnchor(el)) {
        entry.hit = true;
        if (entry.firstHitAt === null) entry.firstHitAt = now;
        entry.lastHitAt = now;
        if (!hit) hit = { kind: spec.kind, selector: spec.selector, el };
      } else {
        entry.hit = false;
      }
    });
    return hit;
  };

  const publishDiagnostics = (): void => {
    try {
      const snapshot: BiliToolbarProbeDiagnostics = {
        installedAt,
        updatedAt: Date.now(),
        mounted,
        active: active ? { kind: active.kind, selector: active.selector } : null,
        candidates: diag.map((entry) => Object.freeze({ ...entry })),
      };
      Object.freeze(snapshot.candidates);
      window.__hduBiliToolbarProbe = Object.freeze(snapshot);
    } catch (err) {
      log.debug('bili toolbar probe 诊断快照写入失败', err);
    }
  };

  /** 以当前 theme 渲染入口（主题变化只重渲染，不重挂、不动候选状态） */
  const renderEntry = (): void => {
    if (!root) return;
    root.render(createElement(BiliToolbarEntry, { onActivate: () => onActivate?.(), theme }));
  };

  /** 采样站点深浅（5s 节流）；变化时重渲染入口切换深色令牌 */
  const sampleTheme = (): void => {
    const now = Date.now();
    if (now - lastThemeSampleAt < THEME_SAMPLE_MS) return;
    lastThemeSampleAt = now;
    const next = resolveHostTheme(document);
    if (next === theme) return;
    theme = next;
    renderEntry();
  };

  const unmountEntry = (): void => {
    active = null;
    if (!host) return;
    try {
      root?.unmount();
    } catch (err) {
      log.warn('bili toolbar probe unmount 异常', err);
    }
    root = null;
    host.remove();
    host = null;
    setMounted(false);
  };

  const mountEntry = (hit: ToolbarHit): void => {
    // 去重：候选里已有本扩展的注入 host（可能刚被站点移动过）则不重复 append
    const existing = hit.el.querySelector(`:scope [${HOST_MARKER}]`);
    if (existing) {
      if (existing !== host) {
        // 理论不可达（同页面只有一个探针实例），防御式清理再重挂
        existing.remove();
      } else {
        setMounted(true);
        return;
      }
    }
    unmountEntry();
    try {
      const nextHost = document.createElement('div');
      nextHost.setAttribute(HOST_MARKER, '1');
      // all:initial 隔离站点样式；host 自身建立行内布局上下文（跟随工具栏排布）
      nextHost.style.cssText = 'all: initial;';
      // host 引用赋值前移（照 anchorProbe）：后续 attachShadow / appendChild /
      // createRoot / render 任一步同步抛错时，catch 路径的 unmountEntry 都能摘除这个
      // 已带标记的 nextHost，不残留孤儿节点到站点工具栏里
      host = nextHost;
      active = { kind: hit.kind, selector: hit.selector };
      const shadow = nextHost.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = BILI_TOOLBAR_ENTRY_CSS;
      shadow.appendChild(style);
      const mountPoint = document.createElement('div');
      shadow.appendChild(mountPoint);
      hit.el.appendChild(nextHost);
      root = createRoot(mountPoint);
      // 挂载即采样一次站点深浅（后续由扫描周期低频复采跟随）
      theme = resolveHostTheme(document);
      lastThemeSampleAt = Date.now();
      renderEntry();
      setMounted(true);
    } catch (err) {
      log.warn('bili toolbar probe 注入失败（保持浮层 FAB 降级）', err);
      unmountEntry();
    }
  };

  const scan = (): void => {
    if (disposed) return;
    const hit = evaluate();
    publishDiagnostics();
    // 低频复采站点深浅（内部 5s 节流；未挂载时仅更新采样值，不渲染）
    sampleTheme();
    if (!hit) {
      pending = null;
      unmountEntry();
      return;
    }
    // 已挂在命中候选上（host 被站点移动到候选内部也算仍在位）
    if (host && host.isConnected && host.parentElement === hit.el) {
      pending = null;
      setMounted(true);
      return;
    }
    // 稳定性确认：连续两轮扫描命中同一元素才挂载（滤掉站点重建的瞬时节点）
    if (pending && pending.el === hit.el) {
      pending = null;
      mountEntry(hit);
      return;
    }
    pending = { el: hit.el, kind: hit.kind };
    scheduleScan();
  };

  const scheduleScan = (): void => {
    if (disposed || debounceTimer !== null) return;
    debounceTimer = window.setTimeout(() => {
      debounceTimer = null;
      scan();
    }, DEBOUNCE_MS);
  };

  // 首次扫描（工具栏可能已渲染；稳定性确认靠下一轮去抖/轮询扫描）
  scan();

  try {
    observer = new MutationObserver(() => scheduleScan());
    observer.observe(document.body, { childList: true, subtree: true });
  } catch (err) {
    log.warn('bili toolbar probe MutationObserver 启动失败（仅靠轮询兜底）', err);
  }

  if (pollMs > 0) {
    pollTimer = window.setInterval(scan, pollMs);
  }

  return {
    isMounted: () => mounted,
    getActive: () => (active ? { ...active } : null),
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (debounceTimer !== null) window.clearTimeout(debounceTimer);
      if (pollTimer !== null) window.clearInterval(pollTimer);
      observer?.disconnect();
      observer = null;
      unmountEntry();
      try {
        delete window.__hduBiliToolbarProbe;
      } catch {
        /* 诊断清理失败不影响摘除 */
      }
    },
  };
}
