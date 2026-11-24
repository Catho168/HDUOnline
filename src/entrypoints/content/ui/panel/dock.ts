/**
 * PlayPanel 右栏停靠定位（第 48 轮自 PlayPanel.tsx 纯搬移拆分，逻辑逐行未变）：
 * 注入式 UI 第一阶段——站点右栏矩形存在时面板顶/右缘对齐右栏、宽度跟随右栏
 * （clamp 到可读区间），视觉上成为右栏的一部分；rect 缺失返回 undefined，
 * 回落 CSS 类的硬编码定位（top:84 right:20 width:384）。
 */

import type { CSSProperties } from 'react';

/** 右栏停靠定位的宽度区间：不窄于可读下限，不吞占过宽右栏 */
const DOCK_MIN_WIDTH = 300;
const DOCK_MAX_WIDTH = 420;

export function panelDockStyle(
  rect: { left: number; top: number; width: number; height: number } | null,
  viewportWidth: number,
): CSSProperties | undefined {
  if (!rect) return undefined;
  if (!(rect.width > 0) || !(rect.height > 0)) return undefined;
  if (!(viewportWidth > 0)) return undefined;
  const width = Math.max(DOCK_MIN_WIDTH, Math.min(rect.width, DOCK_MAX_WIDTH));
  const right = Math.max(0, viewportWidth - (rect.left + rect.width));
  return { top: Math.max(0, rect.top), right, width };
}
