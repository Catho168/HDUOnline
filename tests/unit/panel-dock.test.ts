/**
 * PlayPanel 右栏停靠定位纯函数测试（第 15 轮注入主项方案 A）。
 * rect 缺失/非法 → undefined（回落 CSS 硬编码定位）；合法 → 顶/右缘对齐右栏 + 宽度 clamp。
 */

import { describe, expect, it } from 'vitest';

import { panelDockStyle } from '@/entrypoints/content/ui/panel/dock';

const RAIL = { left: 1560, top: 96, width: 340, height: 600 };

describe('panelDockStyle（PlayPanel 右栏停靠）', () => {
  it('rect 缺失 → undefined（回落 CSS 硬编码定位）', () => {
    expect(panelDockStyle(null, 1920)).toBeUndefined();
  });

  it('非法矩形（零宽/零高/异常视口）→ undefined', () => {
    expect(panelDockStyle({ ...RAIL, width: 0 }, 1920)).toBeUndefined();
    expect(panelDockStyle({ ...RAIL, height: 0 }, 1920)).toBeUndefined();
    expect(panelDockStyle(RAIL, 0)).toBeUndefined();
    expect(panelDockStyle(RAIL, -100)).toBeUndefined();
  });

  it('常规右栏：顶/右缘对齐，宽度跟随', () => {
    expect(panelDockStyle(RAIL, 1920)).toEqual({ top: 96, right: 20, width: 340 });
  });

  it('过宽右栏 → 宽度 clamp 到上限，右缘仍对齐', () => {
    expect(panelDockStyle({ ...RAIL, left: 1300, width: 500 }, 1920)).toEqual({ top: 96, right: 120, width: 420 });
  });

  it('过窄右栏 → 宽度 clamp 到下限', () => {
    expect(panelDockStyle({ ...RAIL, width: 200 }, 1920)).toEqual({ top: 96, right: 160, width: 300 });
  });

  it('右栏越出视口 → right clamp 到 0；负 top → 0', () => {
    expect(panelDockStyle({ ...RAIL, left: 1800, width: 340 }, 1920)).toEqual({ top: 96, right: 0, width: 340 });
    expect(panelDockStyle({ ...RAIL, top: -30 }, 1920)).toEqual({ top: 0, right: 20, width: 340 });
  });
});
