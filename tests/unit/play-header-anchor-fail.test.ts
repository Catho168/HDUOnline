/**
 * 播放页顶栏注入锚点：挂载失败路径测试（jsdom，照 play-header-anchor.test.ts 模式）。
 *
 * 第 16 轮 P3 修复项：mountChip 的 `host = nextHost` 赋值前移到 createRoot 之前——
 * createRoot/render 同步抛错时，catch 路径的 unmountChip 能摘除已带标记注入的 host，
 * 不再残留孤儿节点到站点顶栏。stub createRoot 直接抛错模拟同步注入失败。
 */

// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

// createRoot stub：同步抛错（模拟 React 挂载失败的极端路径）
vi.mock('react-dom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-dom/client')>();
  return {
    ...actual,
    createRoot: () => {
      throw new Error('createRoot failed (stub)');
    },
  };
});

import { createPlayHeaderAnchor } from '@/entrypoints/content/site/anchor';

describe('play-header anchor：挂载失败路径不残留孤儿（第 16 轮 P3）', () => {
  it('createRoot 同步抛错 → catch 摘除带标记 host，站点顶栏无孤儿残留', () => {
    const header = document.createElement('div');
    header.className = 'play-header';
    header.innerHTML = '<span class="title">线性代数（模拟课程）</span>';
    document.body.appendChild(header);

    let anchor!: ReturnType<typeof createPlayHeaderAnchor>;
    expect(() => {
      anchor = createPlayHeaderAnchor({ pollMs: 0 });
    }).not.toThrow();

    // catch → unmountChip：挂载状态回退 false，带标记的注入节点整体摘除
    expect(anchor.isMounted()).toBe(false);
    expect(header.querySelectorAll('[data-hdu-anchor-chip]').length).toBe(0);
    expect(document.querySelectorAll('[data-hdu-anchor-chip]').length).toBe(0);
    // append-only 契约不受失败影响：站点既有节点原样保留
    expect(header.textContent).toContain('线性代数（模拟课程）');

    anchor.dispose();
    expect(anchor.isMounted()).toBe(false);
  });
});
