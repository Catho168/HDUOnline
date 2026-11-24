/**
 * 注入式 UI 第二阶段：多锚点探针测试（jsdom + fake timers，照 play-header-anchor.test.ts 模式；
 * React 经 anchorProbe 内部 createRoot 渲染，用 act 包裹推进）。
 *
 * 覆盖第 24 轮探针框架的关键契约：
 *  1. 命中候选（连续两轮扫描稳定）→ append 带 data-hdu-anchor-entry 标记的 host + onMountedChange(true)；
 *  2. 优先级：controlBar > globalNav；controlBar 消失 → 降级到 globalNav 且不重复；
 *  3. aiCaptionWrapper 候选独立可用；
 *  4. 无候选 → 保持未挂载（浮层降级语义），不报错；
 *  5. dispose → 全量摘除、回调 false、诊断清除、轮询不复活；
 *  6. 站点重渲染（host 被移除）→ 重挂且不产生重复 host；
 *  7. playHeader 护栏：命中顶栏的候选被排除（chip 已占用，避免双入口）；
 *  8. 菜单交互（四项）：本节助手 → togglePanel；学习中心 → openCenter / centerSuppressed 时
 *     restoreCenter；收藏此时刻 → addTimeFavorite；AI 标注 → closeCenter（覆盖层开着时）+
 *     setPanelOpen(true) + setPanelTab('topics')；点击外部关闭；
 *  9. 诊断：window.__hduAnchorProbe 快照（候选命中情况 + active 锚点）；
 * 10. 主题跟随：挂载时采样站点深浅（深底 → data-theme="dark"），低频复采跟随换肤。
 */

// @vitest-environment jsdom

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAnchorProbe, type AnchorProbe, type AnchorProbeOptions } from '@/entrypoints/content/site/anchorProbe';
import { uiStore } from '@/entrypoints/content/ui/store';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 与站点/anchor.ts 的 marker 同思路：注入 host 的 DOM 自标识契约 */
const MARKER = 'data-hdu-anchor-entry';

/** 测试断言用的非空收窄（noUncheckedIndexedAccess 下取菜单项用） */
function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`测试前置缺失：${what}`);
  return value;
}

/** 造一个候选锚点（类名对应 ANCHOR_PROBE_SELECTORS 里的候选选择器） */
function makeAnchor(className: string): HTMLElement {
  const el = document.createElement('div');
  el.className = className;
  el.innerHTML = '<span class="site-thing">站点原生内容</span>';
  document.body.appendChild(el);
  return el;
}

/** 推进探针的轮询/去抖扫描（pollMs 驱动，不依赖 jsdom 的 MutationObserver 时序） */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('anchor probe（注入式 UI 第二阶段）', () => {
  // 断言失败也不能让探针泄漏到后续用例（MO/定时器越界触发会造成级联假失败）
  const live: AnchorProbe[] = [];

  async function createProbe(options: Partial<AnchorProbeOptions> = {}): Promise<AnchorProbe> {
    let probe!: AnchorProbe;
    await act(async () => {
      probe = createAnchorProbe({ pollMs: 50, ...options });
      await Promise.resolve();
    });
    live.push(probe);
    return probe;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    uiStore.patch({ injectedEntryActive: false, centerSuppressed: false });
  });

  afterEach(() => {
    for (const probe of live.splice(0)) {
      try {
        probe.dispose();
      } catch {
        /* 清理优先 */
      }
    }
    vi.useRealTimers();
    document.body.innerHTML = '';
    // 主题采样信号复位（html 上的内联背景/属性不随 body.innerHTML 清空）
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('class');
    document.documentElement.style.backgroundColor = '';
    document.body.removeAttribute('data-theme');
    document.body.removeAttribute('class');
    document.body.style.backgroundColor = '';
    uiStore.patch({ injectedEntryActive: false, centerSuppressed: false, centerOpen: false, panelOpen: false, panelTab: 'overview' });
  });

  it('命中候选（稳定两轮）→ append 带 marker 的 host + onMountedChange(true) + store 联动', async () => {
    const bar = makeAnchor('control-bar');
    const originalChildren = [...bar.children];
    const changes: boolean[] = [];
    const probe = await createProbe({
      onMountedChange: (m) => {
        changes.push(m);
        uiStore.patch({ injectedEntryActive: m });
      },
    });

    // 首扫只登记候选（稳定性确认语义），不应立即挂载
    expect(probe.isMounted()).toBe(false);
    expect(changes).toEqual([]);

    await advance(300);

    expect(probe.isMounted()).toBe(true);
    const host = bar.querySelector(`[${MARKER}]`);
    expect(host).not.toBeNull();
    // append-only：站点既有子节点原样保留、host 在末尾
    expect([...bar.children].slice(0, -1)).toEqual(originalChildren);
    expect(bar.lastElementChild).toBe(host);
    // 入口内容在独立 shadow 内（学习助手按钮）
    expect(must(host, 'host').shadowRoot?.textContent).toContain('学习助手');
    // 挂载状态联动（App 据此隐藏浮层 Dock，保持单入口）
    expect(uiStore.getState().injectedEntryActive).toBe(true);
    expect(changes).toEqual([true]);
  });

  it('优先级：controlBar 优先于 globalNav；controlBar 消失 → 降级 globalNav 且不重复', async () => {
    const bar = makeAnchor('control-bar');
    const nav = makeAnchor('nav');
    const probe = await createProbe();
    await advance(300);

    expect(probe.isMounted()).toBe(true);
    expect(probe.getActive()).toEqual({ kind: 'controlBar', selector: '.control-bar' });
    expect(bar.querySelectorAll(`[${MARKER}]`).length).toBe(1);
    expect(nav.querySelectorAll(`[${MARKER}]`).length).toBe(0);

    // 控制条被站点移除 → 降级到全局导航（重挂且全局只此一枚）
    bar.remove();
    await advance(300);

    expect(probe.isMounted()).toBe(true);
    expect(probe.getActive()?.kind).toBe('globalNav');
    expect(nav.querySelectorAll(`[${MARKER}]`).length).toBe(1);
    expect(document.querySelectorAll(`[${MARKER}]`).length).toBe(1);
  });

  it('aiCaptionWrapper 候选命中 → 挂载到站点 AI 字幕模块位', async () => {
    const wrap = makeAnchor('ai-caption-wrapper');
    const probe = await createProbe();
    await advance(300);

    expect(probe.isMounted()).toBe(true);
    expect(probe.getActive()).toEqual({ kind: 'aiCaptionWrapper', selector: '.ai-caption-wrapper' });
    expect(wrap.querySelectorAll(`[${MARKER}]`).length).toBe(1);
  });

  it('无候选命中 → 保持未挂载（浮层降级语义），不报错', async () => {
    const changes: boolean[] = [];
    const probe = await createProbe({ pollMs: 0, onMountedChange: (m) => changes.push(m) });
    await advance(300);

    expect(probe.isMounted()).toBe(false);
    expect(probe.getActive()).toBeNull();
    expect(document.querySelectorAll(`[${MARKER}]`).length).toBe(0);
    expect(changes).toEqual([]);
    expect(window.__hduAnchorProbe?.mounted).toBe(false);
  });

  it('站点重渲染：host 被站点移除 → 自动重挂且不产生重复 host', async () => {
    const bar = makeAnchor('control-bar');
    const probe = await createProbe();
    await advance(300);
    expect(probe.isMounted()).toBe(true);
    expect(bar.querySelectorAll(`[${MARKER}]`).length).toBe(1);

    // 模拟站点 Vue 重渲染：注入 host 被 diff 掉
    bar.querySelector(`[${MARKER}]`)?.remove();
    await advance(300);

    expect(probe.isMounted()).toBe(true);
    expect(bar.querySelectorAll(`[${MARKER}]`).length).toBe(1);
    expect(document.querySelectorAll(`[${MARKER}]`).length).toBe(1);
  });

  it('dispose → 全量摘除、回调 false、诊断清除、轮询不复活', async () => {
    const bar = makeAnchor('control-bar');
    const changes: boolean[] = [];
    const probe = await createProbe({ onMountedChange: (m) => changes.push(m) });
    await advance(300);
    expect(probe.isMounted()).toBe(true);
    expect(changes).toEqual([true]);

    await act(async () => {
      probe.dispose();
    });

    expect(probe.isMounted()).toBe(false);
    expect(bar.querySelector(`[${MARKER}]`)).toBeNull();
    expect(document.querySelectorAll(`[${MARKER}]`).length).toBe(0);
    expect(window.__hduAnchorProbe).toBeUndefined();
    expect(changes).toEqual([true, false]);

    // 摘除后再推进轮询：不应复活（观察器与定时器已清）
    await advance(300);
    expect(bar.querySelector(`[${MARKER}]`)).toBeNull();
    expect(probe.isMounted()).toBe(false);
  });

  it('playHeader 护栏：命中顶栏的候选被排除（chip 已占用，避免双入口）', async () => {
    // <header class="play-header"> 同时命中 globalNav 的 'header' 选择器与 playHeader 排除项
    const header = document.createElement('header');
    header.className = 'play-header';
    header.innerHTML = '<span class="title">线性代数（模拟课程）</span>';
    document.body.appendChild(header);

    const probe = await createProbe();
    await advance(300);

    expect(probe.isMounted()).toBe(false);
    expect(header.querySelectorAll(`[${MARKER}]`).length).toBe(0);
    // 诊断中该候选不视为命中
    const headerDiag = window.__hduAnchorProbe?.candidates.find((c) => c.kind === 'globalNav' && c.selector === 'header');
    expect(headerDiag?.hit).toBe(false);
  });

  it('菜单交互：四项菜单顺序固定；本节助手→togglePanel；学习中心→openCenter/restoreCenter；收藏此时刻→addTimeFavorite；AI 标注→切标注页签；点击外部关闭', async () => {
    const bar = makeAnchor('control-bar');
    const probe = await createProbe();
    await advance(300);
    expect(probe.isMounted()).toBe(true);

    const shadow = must(must(bar.querySelector(`[${MARKER}]`), 'host').shadowRoot, 'shadowRoot');
    const btn = must(shadow.querySelector('.hdu-probe-btn'), '入口按钮');
    const items = () => Array.from(shadow.querySelectorAll('.hdu-probe-item'));

    const calls: string[] = [];
    const originalActions = uiStore.actions;
    uiStore.actions = {
      ...originalActions,
      togglePanel: () => calls.push('togglePanel'),
      openCenter: () => calls.push('openCenter'),
      restoreCenter: () => calls.push('restoreCenter'),
      closeCenter: () => calls.push('closeCenter'),
      addTimeFavorite: () => {
        calls.push('addTimeFavorite');
        return Promise.resolve();
      },
      setPanelOpen: (open) => calls.push(`setPanelOpen:${open}`),
      setPanelTab: (tab) => calls.push(`setPanelTab:${tab}`),
    };
    try {
      // 打开菜单：四项按「本节助手 / 学习中心 / 收藏此时刻 / AI 标注」顺序渲染
      await act(async () => {
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      expect(shadow.querySelector('.hdu-probe-menu')).not.toBeNull();
      expect(items().length).toBe(4);
      expect(items().map((el) => el.textContent)).toEqual(['本节助手', '学习中心', '收藏此时刻', 'AI 标注']);

      // 本节助手 → togglePanel，选中后菜单收起
      await act(async () => {
        must(items()[0], '本节助手项').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      expect(calls).toEqual(['togglePanel']);
      expect(shadow.querySelector('.hdu-probe-menu')).toBeNull();

      // 学习中心 → openCenter
      await act(async () => {
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      await act(async () => {
        must(items()[1], '学习中心项').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      expect(calls).toEqual(['togglePanel', 'openCenter']);

      // centerSuppressed → restoreCenter（与 Dock 行为一致）
      uiStore.patch({ centerSuppressed: true });
      await act(async () => {
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      await act(async () => {
        must(items()[1], '学习中心项（抑制态）').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      expect(calls).toEqual(['togglePanel', 'openCenter', 'restoreCenter']);
      uiStore.patch({ centerSuppressed: false });

      // 收藏此时刻 → 与 PlayPanel 头部同一 action（addTimeFavorite），菜单收起
      await act(async () => {
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      await act(async () => {
        must(items()[2], '收藏此时刻项').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      expect(calls).toEqual(['togglePanel', 'openCenter', 'restoreCenter', 'addTimeFavorite']);
      expect(shadow.querySelector('.hdu-probe-menu')).toBeNull();

      // AI 标注 → 开面板 + 切「标注」页签；学习中心覆盖层开着时先收起
      uiStore.patch({ centerOpen: true, panelOpen: false });
      await act(async () => {
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      await act(async () => {
        must(items()[3], 'AI 标注项').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      expect(calls).toEqual(['togglePanel', 'openCenter', 'restoreCenter', 'addTimeFavorite', 'closeCenter', 'setPanelOpen:true', 'setPanelTab:topics']);
      expect(shadow.querySelector('.hdu-probe-menu')).toBeNull();

      // 面板已开时重复点 AI 标注：不重复 setPanelOpen(true)，仅切页签（不自动触发生成）
      calls.length = 0;
      uiStore.patch({ centerOpen: false, panelOpen: true });
      await act(async () => {
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      await act(async () => {
        must(items()[3], 'AI 标注项（面板已开）').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      expect(calls).toEqual(['setPanelTab:topics']);

      // 点击外部（pointerdown 落在注入 host 之外）→ 菜单关闭
      await act(async () => {
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      expect(shadow.querySelector('.hdu-probe-menu')).not.toBeNull();
      await act(async () => {
        document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
      });
      expect(shadow.querySelector('.hdu-probe-menu')).toBeNull();
      // 站点原生内容未受影响（append-only 契约）
      expect(bar.textContent).toContain('站点原生内容');
    } finally {
      uiStore.actions = originalActions;
    }
  });

  it('诊断：window.__hduAnchorProbe 记录各候选命中情况与 active 锚点', async () => {
    makeAnchor('control-bar');
    const probe = await createProbe();
    await advance(300);
    expect(probe.isMounted()).toBe(true);

    const diag = window.__hduAnchorProbe;
    expect(diag).toBeDefined();
    expect(must(diag, '诊断快照').mounted).toBe(true);
    expect(diag?.active).toEqual({ kind: 'controlBar', selector: '.control-bar' });
    // 候选全量登记：controlBar 6 + aiCaptionWrapper 3 + globalNav 5
    expect(diag?.candidates.length).toBe(14);
    const barDiag = diag?.candidates.find((c) => c.kind === 'controlBar' && c.selector === '.control-bar');
    expect(barDiag?.hit).toBe(true);
    expect(barDiag?.firstHitAt).not.toBeNull();
    expect(barDiag?.lastHitAt).not.toBeNull();
    const missDiag = diag?.candidates.find((c) => c.kind === 'aiCaptionWrapper' && c.selector === '.ai-caption-wrapper');
    expect(missDiag?.hit).toBe(false);
    expect(missDiag?.firstHitAt).toBeNull();
  });

  it('主题跟随：挂载时采样站点深底 → 入口根节点带 data-theme="dark"', async () => {
    // 深底信号：html 渲染背景亮度 < 0.35（jsdom 的 computed style 反映内联样式）
    document.documentElement.style.backgroundColor = 'rgb(17, 19, 24)';
    const bar = makeAnchor('control-bar');
    const probe = await createProbe();
    await advance(300);
    expect(probe.isMounted()).toBe(true);

    const shadow = must(must(bar.querySelector(`[${MARKER}]`), 'host').shadowRoot, 'shadowRoot');
    expect(shadow.querySelector('.hdu-probe-entry')?.getAttribute('data-theme')).toBe('dark');
  });

  it('主题跟随：站点换肤低频复采（5s 节流内不抖动，到点重渲染切换 dark/light）', async () => {
    const bar = makeAnchor('control-bar');
    const probe = await createProbe();
    await advance(300);
    expect(probe.isMounted()).toBe(true);
    const shadow = must(must(bar.querySelector(`[${MARKER}]`), 'host').shadowRoot, 'shadowRoot');
    const themeAttr = () => shadow.querySelector('.hdu-probe-entry')?.getAttribute('data-theme');
    expect(themeAttr()).toBe('light');

    // 站点切深色：5s 节流窗口内保持原样（不随扫描抖动）
    document.documentElement.style.backgroundColor = 'rgb(17, 19, 24)';
    await advance(1000);
    expect(themeAttr()).toBe('light');
    // 越过节流窗口 → 复采跟随为 dark
    await advance(4500);
    expect(themeAttr()).toBe('dark');

    // 站点切回亮色（移除内联背景）→ 下一采样窗口跟随回 light
    document.documentElement.style.backgroundColor = '';
    await advance(5500);
    expect(themeAttr()).toBe('light');
  });
});
