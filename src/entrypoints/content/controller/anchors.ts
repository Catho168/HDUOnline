import { createPlayHeaderAnchor, type PlayHeaderAnchor } from '../site/anchor';
import { createAnchorProbe, type AnchorProbe } from '../site/anchorProbe';
import { uiStore } from '../ui/store';
import type { ControllerContext } from './context';

/** 播放页顶栏 chip 注入锚点（nativeAnchor 开关；随页面级 teardown 摘除） */
let playHeaderAnchor: PlayHeaderAnchor | null = null;
/** 注入式 UI 第二阶段：多锚点探针入口（nativeAnchor 开关；随页面级 teardown 摘除） */
let anchorProbe: AnchorProbe | null = null;

/** 顶栏 chip 注入锚点（nativeAnchor 开关控制；锚点缺失时 anchor 内部静默降级，浮窗胶囊照旧） */
export function ensurePlayHeaderAnchor(ctx: ControllerContext): void {
  if (ctx.disposed) return;
  if (!ctx.settings.ui.nativeAnchor) {
    destroyPlayHeaderAnchor();
    return;
  }
  if (playHeaderAnchor) return;
  playHeaderAnchor = createPlayHeaderAnchor({
    onMountedChange: (active) => uiStore.patch({ anchorChipActive: active }),
  });
  ctx.registerPageCleanup(() => destroyPlayHeaderAnchor());
}

export function destroyPlayHeaderAnchor(): void {
  playHeaderAnchor?.dispose();
  playHeaderAnchor = null;
  if (uiStore.getState().anchorChipActive) uiStore.patch({ anchorChipActive: false });
}

/**
 * 注入式 UI 第二阶段：多锚点探针入口（nativeAnchor 开关控制；候选全不命中时
 * 探针内部保持未挂载，浮层 Dock 照旧——与 chip 锚点同款静默降级）。
 */
export function ensureAnchorProbe(ctx: ControllerContext): void {
  if (ctx.disposed) return;
  if (!ctx.settings.ui.nativeAnchor) {
    destroyAnchorProbe();
    return;
  }
  if (anchorProbe) return;
  anchorProbe = createAnchorProbe({
    onMountedChange: (active) => uiStore.patch({ injectedEntryActive: active }),
  });
  ctx.registerPageCleanup(() => destroyAnchorProbe());
}

export function destroyAnchorProbe(): void {
  anchorProbe?.dispose();
  anchorProbe = null;
  if (uiStore.getState().injectedEntryActive) uiStore.patch({ injectedEntryActive: false });
}
