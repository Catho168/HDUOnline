/**
 * 注入式 UI 第二阶段：多锚点探针（框架先行）。
 *
 * 职责：按优先级扫描候选锚点（播放器控制条 → 站点 AI 字幕模块位 → 全局导航），
 * 在第一个命中且稳定（连续两轮扫描命中同一元素，滤掉 KMedia SDK 动态重建的瞬时节点）
 * 的锚点末尾 append 一枚受控注入 host（独立 open shadow + 「学习助手」入口按钮 +
 * 四项目菜单：本节助手 / 学习中心 / 收藏此时刻 / AI 标注）。
 *
 * 主题跟随：挂载时采样站点深浅（resolveHostTheme），并以低频（5s 节流，随扫描周期）
 * 复采；结果作为 prop 传入入口组件，深色时在 shadow 根加 data-theme="dark" 切换
 * ANCHOR_ENTRY_CSS 里的深色令牌（照 styles.ts / bilibili.content.tsx 的既有做法）。
 *
 * 为什么「框架先行」：控制条 / 全局导航 / ai-caption-wrapper 三类候选在仓库内零 DOM
 * 证据（站点由 KMedia SDK 动态重建，盲写选择器会漂移），因此本探针不依赖勘察结果——
 * 全部候选不命中时保持未挂载，走现有浮层降级；勘察 JSON 回填后只需替换
 * constants.ts 的 ANCHOR_PROBE_SELECTORS 常量，探针逻辑零改动。
 *
 * 应对先例（照 anchor.ts / player.ts）：MutationObserver（childList+subtree，120ms
 * 去抖重扫）+ 周期轮询兜底；append-only（绝不修改/删除站点既有节点）；站点 diff 掉
 * host 后自动重挂；路由 teardown / onInvalidated 时 dispose 全量摘除。
 *
 * playHeader 不参加候选：第一阶段 chip 已占用顶栏入口，避免双入口（扫描时有护栏排除）。
 */

import { createElement, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  ANCHOR_PROBE_HOST_MARKER,
  ANCHOR_PROBE_SELECTORS,
  HOST_ELEMENT_ID,
  SELECTORS,
} from '@/core/shared/constants';
import { createLogger } from '@/core/shared/logger';
import { resolveHostTheme, type HostTheme } from '@/core/shared/hostTheme';
import { Icon } from '../ui/icons';
import { uiStore } from '../ui/store';

const log = createLogger('content');

const DEBOUNCE_MS = 120;
/** 站点深浅复采节流：低频跟随站点换肤，避免每次扫描都读 computed style */
const THEME_SAMPLE_MS = 5000;
/** 注入 host 自标识：重挂去重与清理识别都靠它（与 chip 的 data-hdu-anchor-chip 同思路） */
const HOST_MARKER = ANCHOR_PROBE_HOST_MARKER;

export type AnchorProbeKind = 'controlBar' | 'aiCaptionWrapper' | 'globalNav';

/**
 * 候选锚点注册表：优先级从高到低。
 * direction 决定入口菜单弹出方向（页面底部锚点向上弹、全局导航向下弹）。
 * 选择器串在 constants.ts 的 ANCHOR_PROBE_SELECTORS（实站勘察回填点）。
 */
const ANCHOR_PROBE_KINDS: ReadonlyArray<{ kind: AnchorProbeKind; direction: 'up' | 'down' }> = [
  { kind: 'controlBar', direction: 'up' },
  { kind: 'aiCaptionWrapper', direction: 'up' },
  { kind: 'globalNav', direction: 'down' },
];

interface CandidateSpec {
  kind: AnchorProbeKind;
  selector: string;
  direction: 'up' | 'down';
}

/** 展平的候选清单（顺序 = 优先级），每轮扫描全量重评以填充诊断 */
const CANDIDATES: ReadonlyArray<CandidateSpec> = ANCHOR_PROBE_KINDS.flatMap((entry) =>
  ANCHOR_PROBE_SELECTORS[entry.kind].map((selector) => ({ kind: entry.kind, selector, direction: entry.direction })),
);

// ───────────────────────── 诊断（供与实站勘察 JSON 对照） ─────────────────────────

export interface AnchorProbeSelectorDiag {
  kind: AnchorProbeKind;
  selector: string;
  /** 最近一次扫描是否命中（已过 playHeader / 自身 host 排除护栏） */
  hit: boolean;
  firstHitAt: number | null;
  lastHitAt: number | null;
}

export interface AnchorProbeDiagnostics {
  installedAt: number;
  updatedAt: number;
  mounted: boolean;
  active: { kind: AnchorProbeKind; selector: string } | null;
  candidates: ReadonlyArray<AnchorProbeSelectorDiag>;
}

declare global {
  interface Window {
    /** 锚点探针只读诊断快照（best-effort，try/catch 包裹，不保证存在） */
    __hduAnchorProbe?: AnchorProbeDiagnostics;
  }
}

// ───────────────────────── 注入入口组件（样式自包含在 shadow 内） ─────────────────────────

/**
 * 入口视觉：中性玻璃质感小胶囊 + 白底菜单卡片，自带全部样式令牌，
 * 不依赖站点类名 / 不用站点 CSS 变量（照 HeaderChip 设计铁律）。
 */
export const ANCHOR_ENTRY_CSS = `
:host { all: initial; }
.hdu-probe-entry {
  position: relative; display: inline-block; flex: 0 0 auto;
  font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
}
.hdu-probe-btn {
  display: inline-flex; align-items: center; gap: 6px;
  height: 28px; padding: 0 11px;
  border-radius: 999px;
  border: 1px solid rgba(15, 23, 42, 0.16);
  background: rgba(255, 255, 255, 0.92);
  color: #1f2937;
  font-size: 12.5px; line-height: 1; white-space: nowrap;
  cursor: pointer; user-select: none;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08);
  transition: background .15s ease, border-color .15s ease;
}
.hdu-probe-btn:hover { background: #ffffff; border-color: rgba(15, 23, 42, 0.3); }
.hdu-probe-btn.is-open { border-color: rgba(15, 23, 42, 0.32); }
.hdu-probe-btn svg { flex: 0 0 auto; }
.hdu-probe-menu {
  position: absolute; right: 0; z-index: 2147483647;
  min-width: 148px; padding: 5px;
  border-radius: 10px;
  border: 1px solid rgba(15, 23, 42, 0.12);
  background: #ffffff;
  box-shadow: 0 8px 28px rgba(15, 23, 42, 0.18);
}
.hdu-probe-menu.up { bottom: calc(100% + 8px); animation: hdu-probe-menu-up .16s ease-out; }
.hdu-probe-menu.down { top: calc(100% + 8px); animation: hdu-probe-menu-down .16s ease-out; }
.hdu-probe-item {
  display: flex; align-items: center; gap: 8px;
  width: 100%; padding: 8px 9px;
  border: 0; border-radius: 7px;
  background: transparent; color: #1f2937;
  font-size: 13px; line-height: 1.2; text-align: left; white-space: nowrap;
  cursor: pointer;
}
.hdu-probe-item:hover { background: rgba(15, 23, 42, 0.06); }
.hdu-probe-item svg { flex: 0 0 auto; color: #475569; }
/* ───────── 站点深色模式跟随 ─────────
   采样到站点深底（resolveHostTheme）时由控制器给入口根节点挂 data-theme="dark"，
   此处只覆盖入口自身的低亮度配色：按钮/菜单换深灰卡片（调性对齐 ui/styles.ts 的
   暗色 paper-2 #1a1d21 一族）+ 提亮文字、阴影换纯黑深投影。不依赖站点类名。 */
.hdu-probe-entry[data-theme="dark"] .hdu-probe-btn {
  border-color: rgba(148, 163, 184, 0.28);
  background: rgba(26, 29, 33, 0.92);
  color: #e2e8f0;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
}
.hdu-probe-entry[data-theme="dark"] .hdu-probe-btn:hover { background: #22262b; border-color: rgba(148, 163, 184, 0.45); }
.hdu-probe-entry[data-theme="dark"] .hdu-probe-btn.is-open { border-color: rgba(148, 163, 184, 0.5); }
.hdu-probe-entry[data-theme="dark"] .hdu-probe-menu {
  border-color: rgba(148, 163, 184, 0.2);
  background: #1a1d21;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.55);
}
.hdu-probe-entry[data-theme="dark"] .hdu-probe-item { color: #e2e8f0; }
.hdu-probe-entry[data-theme="dark"] .hdu-probe-item:hover { background: rgba(148, 163, 184, 0.14); }
.hdu-probe-entry[data-theme="dark"] .hdu-probe-item svg { color: #94a3b8; }
@keyframes hdu-probe-menu-up { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
@keyframes hdu-probe-menu-down { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
`;

interface AnchorEntryProps {
  /** 取当前注入 host：shadow 内点击从 document 看会被重定向为 host，据此区分「点在入口上」与「点在外部」 */
  getHost: () => HTMLElement | null;
  /** 菜单弹出方向（由命中锚点种类决定） */
  direction: 'up' | 'down';
  /** 站点深浅模式（挂载时采样 + 低频跟随），dark 时切深色令牌 */
  theme: HostTheme;
}

function AnchorEntry(props: AnchorEntryProps) {
  const { getHost, direction, theme } = props;
  const [open, setOpen] = useState(false);

  // 点击外部关闭：菜单打开期间监听 document pointerdown（capture，先于站点自身逻辑）
  useEffect(() => {
    if (!open) return;
    const onDocPointerDown = (event: Event): void => {
      const hostEl = getHost();
      const target = event.target;
      if (hostEl && target instanceof Node && hostEl.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDocPointerDown, true);
    return () => document.removeEventListener('pointerdown', onDocPointerDown, true);
  }, [open, getHost]);

  const handlePanel = (): void => {
    setOpen(false);
    uiStore.actions.togglePanel();
  };

  const handleCenter = (): void => {
    setOpen(false);
    // 与 Dock 行为一致：学习中心被播放页面板压制时先恢复
    if (uiStore.getState().centerSuppressed) uiStore.actions.restoreCenter();
    else uiStore.actions.openCenter();
  };

  const handleFavorite = (): void => {
    setOpen(false);
    // 与 PlayPanel 头部「收藏当前时间点」同一 action：未识别课次/无会话时 action 内部
    // 直接返回（不发起、不弹错），成功后走既有 toast 通道（「已收藏当前时间点」）
    void uiStore.actions.addTimeFavorite();
  };

  const handleTopics = (): void => {
    setOpen(false);
    // 学习中心覆盖层与面板在 App 里二选一渲染：覆盖层开着时先收起，确保面板可见
    if (uiStore.getState().centerOpen) uiStore.actions.closeCenter();
    if (!uiStore.getState().panelOpen) uiStore.actions.setPanelOpen(true);
    // 只切到「标注」页签，不自动触发生成（生成仍由用户在面板内点按钮，避免误耗 AI 配额）
    uiStore.actions.setPanelTab('topics');
  };

  const menu = open
    ? createElement(
        'div',
        { key: 'menu', className: `hdu-probe-menu ${direction}`, role: 'menu' },
        createElement(
          'button',
          { key: 'item-panel', type: 'button', className: 'hdu-probe-item', role: 'menuitem', onClick: handlePanel },
          createElement(Icon, { key: 'item-panel-icon', name: 'panel', size: 15 }),
          createElement('span', { key: 'item-panel-label' }, '本节助手'),
        ),
        createElement(
          'button',
          { key: 'item-center', type: 'button', className: 'hdu-probe-item', role: 'menuitem', onClick: handleCenter },
          createElement(Icon, { key: 'item-center-icon', name: 'library', size: 15 }),
          createElement('span', { key: 'item-center-label' }, '学习中心'),
        ),
        createElement(
          'button',
          { key: 'item-favorite', type: 'button', className: 'hdu-probe-item', role: 'menuitem', onClick: handleFavorite },
          createElement(Icon, { key: 'item-favorite-icon', name: 'star', size: 15 }),
          createElement('span', { key: 'item-favorite-label' }, '收藏此时刻'),
        ),
        createElement(
          'button',
          { key: 'item-topics', type: 'button', className: 'hdu-probe-item', role: 'menuitem', onClick: handleTopics },
          createElement(Icon, { key: 'item-topics-icon', name: 'wand', size: 15 }),
          createElement('span', { key: 'item-topics-label' }, 'AI 标注'),
        ),
      )
    : null;

  return createElement(
    'div',
    { className: 'hdu-probe-entry', 'data-theme': theme },
    createElement(
      'button',
      {
        key: 'btn',
        type: 'button',
        className: open ? 'hdu-probe-btn is-open' : 'hdu-probe-btn',
        title: '学习助手',
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        onClick: () => setOpen((value) => !value),
      },
      createElement(Icon, { key: 'btn-icon', name: 'spark', size: 14 }),
      createElement('span', { key: 'btn-label' }, '学习助手'),
    ),
    menu,
  );
}

// ───────────────────────── 探针控制器 ─────────────────────────

interface AnchorHit {
  kind: AnchorProbeKind;
  selector: string;
  el: Element;
  direction: 'up' | 'down';
}

export interface AnchorProbe {
  /** 注入入口当前是否已挂载到某个候选锚点 */
  isMounted(): boolean;
  /** 当前命中的锚点（未挂载时 null；诊断/测试用） */
  getActive(): { kind: AnchorProbeKind; selector: string } | null;
  /** 全量摘除：unmount React、移除自身 host、停观察器、清诊断（站点 DOM 恢复原状） */
  dispose(): void;
}

export interface AnchorProbeOptions {
  /** 挂载状态变化回调（联动 uiStore.injectedEntryActive：true 时隐藏浮层 Dock） */
  onMountedChange?: (mounted: boolean) => void;
  /** 轮询兜底间隔（测试可注入小值；0 关闭轮询，仅靠首扫 + 去抖确认） */
  pollMs?: number;
}

export function createAnchorProbe(options: AnchorProbeOptions = {}): AnchorProbe {
  const { onMountedChange, pollMs = 2000 } = options;
  const installedAt = Date.now();
  let disposed = false;
  let mounted = false;
  let host: HTMLElement | null = null;
  let root: Root | null = null;
  let active: { kind: AnchorProbeKind; selector: string } | null = null;
  /** 稳定性确认：上一轮扫描命中的候选元素（连续两轮命中同一元素才挂载） */
  let pending: { el: Element; kind: AnchorProbeKind } | null = null;
  let debounceTimer: number | null = null;
  let pollTimer: number | null = null;
  let observer: MutationObserver | null = null;
  /** 入口菜单弹出方向（挂载时由命中锚点决定，主题重渲染时复用） */
  let direction: 'up' | 'down' = 'up';
  /** 站点深浅模式：挂载时采样一次，之后随扫描周期低频复采跟随 */
  let theme: HostTheme = 'light';
  let lastThemeSampleAt = 0;
  const diag: AnchorProbeSelectorDiag[] = CANDIDATES.map((spec) => ({
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
      log.warn('anchor probe 挂载状态回调异常', err);
    }
  };

  /** 锚点资格护栏：必须连接在文档上，且不能是 playHeader（chip 已占用，避免双入口）或本扩展自身 UI */
  const isEligibleAnchor = (el: Element): boolean => {
    try {
      if (!el.isConnected) return false;
      if (el.matches(SELECTORS.playHeader) || el.closest(SELECTORS.playHeader)) return false;
      if (el.closest(`#${HOST_ELEMENT_ID}`)) return false;
      return true;
    } catch {
      return false;
    }
  };

  /** 全量重评所有候选（不短路：诊断需要每个选择器的命中情况），返回最高优先级的合格命中 */
  const evaluate = (): AnchorHit | null => {
    let hit: AnchorHit | null = null;
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
        if (!hit) hit = { kind: spec.kind, selector: spec.selector, el, direction: spec.direction };
      } else {
        entry.hit = false;
      }
    });
    return hit;
  };

  const publishDiagnostics = (): void => {
    try {
      const snapshot: AnchorProbeDiagnostics = {
        installedAt,
        updatedAt: Date.now(),
        mounted,
        active: active ? { kind: active.kind, selector: active.selector } : null,
        candidates: diag.map((entry) => Object.freeze({ ...entry })),
      };
      Object.freeze(snapshot.candidates);
      window.__hduAnchorProbe = Object.freeze(snapshot);
    } catch (err) {
      log.debug('anchor probe 诊断快照写入失败', err);
    }
  };

  /** 以当前 direction/theme 渲染入口（主题变化只重渲染，不重挂、不动锚点状态） */
  const renderEntry = (): void => {
    if (!root) return;
    root.render(createElement(AnchorEntry, { getHost: () => host, direction, theme }));
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
      log.warn('anchor probe unmount 异常', err);
    }
    root = null;
    host.remove();
    host = null;
    setMounted(false);
  };

  const mountEntry = (hit: AnchorHit): void => {
    // 去重：锚点里已有本扩展的注入 host（可能刚被站点移动过）则不重复 append
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
      // all:initial 隔离站点样式；host 自身建立定位上下文（菜单 absolute 的基准）
      nextHost.style.cssText = 'all: initial;';
      // host 引用赋值前移（照 anchor.ts 第 16 轮 P3）：后续 attachShadow / appendChild /
      // createRoot / render 任一步同步抛错时，catch 路径的 unmountEntry 都能摘除这个
      // 已带标记的 nextHost，不残留孤儿节点到站点锚点里
      host = nextHost;
      active = { kind: hit.kind, selector: hit.selector };
      const shadow = nextHost.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = ANCHOR_ENTRY_CSS;
      shadow.appendChild(style);
      const mountPoint = document.createElement('div');
      shadow.appendChild(mountPoint);
      hit.el.appendChild(nextHost);
      root = createRoot(mountPoint);
      direction = hit.direction;
      // 挂载即采样一次站点深浅（后续由扫描周期低频复采跟随）
      theme = resolveHostTheme(document);
      lastThemeSampleAt = Date.now();
      renderEntry();
      setMounted(true);
    } catch (err) {
      log.warn('anchor probe 注入失败（保持浮层降级）', err);
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
    // 已挂在命中锚点上（host 被站点移动到锚点内部也算仍在位）
    if (host && host.isConnected && host.parentElement === hit.el) {
      pending = null;
      setMounted(true);
      return;
    }
    // 稳定性确认：连续两轮扫描命中同一元素才挂载（滤掉 KMedia 重建的瞬时节点）
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

  // 首次扫描（锚点可能已渲染；稳定性确认靠下一轮去抖/轮询扫描）
  scan();

  try {
    observer = new MutationObserver(() => scheduleScan());
    observer.observe(document.body, { childList: true, subtree: true });
  } catch (err) {
    log.warn('anchor probe MutationObserver 启动失败（仅靠轮询兜底）', err);
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
        delete window.__hduAnchorProbe;
      } catch {
        /* 诊断清理失败不影响摘除 */
      }
    },
  };
}
