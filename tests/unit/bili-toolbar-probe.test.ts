/**
 * B 站工具栏注入探针测试（jsdom + fake timers，照 anchor-probe.test.ts 模式；
 * React 经 biliToolbarProbe 内部 createRoot 渲染，用 act 包裹推进）。
 *
 * 覆盖第 33 轮探针框架的关键契约：
 *  1. 无候选命中 → 保持未挂载（浮层 FAB 降级语义），不报错；
 *  2. 命中候选（连续两轮扫描稳定）→ append 带 data-hdu-bili-toolbar-entry 标记的 host
 *     + shadow 内「学习助手」按钮在场 + onMountedChange(true)；
 *  3. 优先级：候选数组顺序即优先级（left-main 优先于容器兜底）；
 *  4. 瞬时节点重建不误挂（第一轮命中、第二轮换元素 → 不挂；新元素连续两轮才挂）；
 *  5. 站点 diff 掉 host → 自动重挂且不产生重复 host；
 *  6. onMountedChange 回调序列（挂载 true / 候选消失 false）；
 *  7. dispose → 全量摘除、回调 false、诊断删除、轮询不复活；
 *  8. onActivate：shadow 内按钮点击触发（title/aria-label=学习助手）；
 *  9. 诊断：window.__hduBiliToolbarProbe 快照（候选命中情况 + active）；
 * 10. 主题跟随：挂载时采样站点深底 → 入口根节点 data-theme="dark"。
 */

// @vitest-environment jsdom

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createBiliToolbarProbe,
  type BiliToolbarProbe,
  type BiliToolbarProbeOptions,
} from '@/entrypoints/content/site/biliToolbarProbe';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 与探针/constants 的契约：注入 host 的 DOM 自标识 */
const MARKER = 'data-hdu-bili-toolbar-entry';

/** 测试断言用的非空收窄（noUncheckedIndexedAccess 下取候选诊断用） */
function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`测试前置缺失：${what}`);
  return value;
}

/** 造一个候选工具栏元素（类名对应 BILI_TOOLBAR_PROBE_SELECTORS 里的候选选择器） */
function makeToolbar(className: string): HTMLElement {
  const el = document.createElement('div');
  el.className = className;
  el.innerHTML = '<button class="site-like">站点原生点赞按钮</button>';
  document.body.appendChild(el);
  return el;
}

/** 推进探针的轮询/去抖扫描（pollMs 驱动，不依赖 jsdom 的 MutationObserver 时序） */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('bili toolbar probe（注入式 UI 第三阶段，框架先行）', () => {
  // 断言失败也不能让探针泄漏到后续用例（MO/定时器越界触发会造成级联假失败）
  const live: BiliToolbarProbe[] = [];

  async function createProbe(options: Partial<BiliToolbarProbeOptions> = {}): Promise<BiliToolbarProbe> {
    let probe!: BiliToolbarProbe;
    await act(async () => {
      probe = createBiliToolbarProbe({ pollMs: 50, ...options });
      await Promise.resolve();
    });
    live.push(probe);
    return probe;
  }

  beforeEach(() => {
    vi.useFakeTimers();
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
    // 主题采样信号复位（html 上的内联背景不随 body.innerHTML 清空）
    document.documentElement.style.backgroundColor = '';
    document.body.style.backgroundColor = '';
    delete window.__hduBiliToolbarProbe;
  });

  it('无候选命中 → 保持未挂载（浮层 FAB 降级语义），不报错', async () => {
    const changes: boolean[] = [];
    const probe = await createProbe({ pollMs: 0, onMountedChange: (m) => changes.push(m) });
    await advance(300);

    expect(probe.isMounted()).toBe(false);
    expect(probe.getActive()).toBeNull();
    expect(document.querySelectorAll(`[${MARKER}]`).length).toBe(0);
    expect(changes).toEqual([]);
    expect(window.__hduBiliToolbarProbe?.mounted).toBe(false);
  });

  it('命中候选（稳定两轮）→ append 带 marker 的 host + shadow 内学习助手按钮 + onMountedChange(true)', async () => {
    const toolbar = makeToolbar('video-toolbar-left-main');
    const originalChildren = [...toolbar.children];
    const changes: boolean[] = [];
    const probe = await createProbe({ onMountedChange: (m) => changes.push(m) });

    // 首扫只登记候选（稳定性确认语义），不应立即挂载
    expect(probe.isMounted()).toBe(false);
    expect(changes).toEqual([]);

    await advance(300);

    expect(probe.isMounted()).toBe(true);
    const host = toolbar.querySelector(`[${MARKER}]`);
    expect(host).not.toBeNull();
    // append-only：站点既有子节点原样保留、host 在末尾
    expect([...toolbar.children].slice(0, -1)).toEqual(originalChildren);
    expect(toolbar.lastElementChild).toBe(host);
    // 入口内容在独立 shadow 内（学习助手按钮）
    const shadow = must(must(host, 'host').shadowRoot, 'shadowRoot');
    const btn = shadow.querySelector('.hdu-bili-toolbar-btn');
    expect(btn).not.toBeNull();
    expect(btn?.getAttribute('title')).toBe('学习助手');
    expect(btn?.getAttribute('aria-label')).toBe('学习助手');
    // 图标按钮（无文字标签，学习助手语义在 title/aria-label 上）
    expect(shadow.querySelector('svg')).not.toBeNull();
    expect(changes).toEqual([true]);
  });

  it('优先级：候选数组顺序即优先级（left-main 优先于容器兜底）', async () => {
    const main = makeToolbar('video-toolbar-left-main');
    const container = makeToolbar('video-toolbar');
    const probe = await createProbe();
    await advance(300);

    expect(probe.isMounted()).toBe(true);
    expect(probe.getActive()).toEqual({ kind: 'toolbar', selector: '.video-toolbar-left-main' });
    expect(main.querySelectorAll(`[${MARKER}]`).length).toBe(1);
    expect(container.querySelectorAll(`[${MARKER}]`).length).toBe(0);
  });

  it('瞬时节点重建不误挂：第一轮命中、第二轮换元素 → 不挂；新元素连续两轮才挂', async () => {
    const first = makeToolbar('video-toolbar-left-main');
    // pollMs: 0：只靠首扫 + 去抖扫描，精确控制扫描轮次
    const probe = await createProbe({ pollMs: 0 });
    expect(probe.isMounted()).toBe(false);

    // 模拟站点重建瞬时节点：第一轮命中的元素被替换为同选择器的新元素
    first.remove();
    const second = makeToolbar('video-toolbar-left-main');

    // 第二轮扫描命中新元素（≠第一轮）→ 稳定性确认不通过，不挂载
    await advance(120);
    expect(probe.isMounted()).toBe(false);
    expect(document.querySelectorAll(`[${MARKER}]`).length).toBe(0);

    // 第三轮扫描仍命中同一新元素 → 连续两轮稳定，挂载到新元素
    await advance(120);
    expect(probe.isMounted()).toBe(true);
    expect(probe.getActive()?.selector).toBe('.video-toolbar-left-main');
    expect(second.querySelectorAll(`[${MARKER}]`).length).toBe(1);
    expect(first.querySelectorAll(`[${MARKER}]`).length).toBe(0);
  });

  it('站点 diff 掉 host → 自动重挂且不产生重复 host', async () => {
    const toolbar = makeToolbar('video-toolbar-left-main');
    const probe = await createProbe();
    await advance(300);
    expect(probe.isMounted()).toBe(true);
    expect(toolbar.querySelectorAll(`[${MARKER}]`).length).toBe(1);

    // 模拟站点 diff：注入 host 被移除
    toolbar.querySelector(`[${MARKER}]`)?.remove();
    await advance(300);

    expect(probe.isMounted()).toBe(true);
    expect(toolbar.querySelectorAll(`[${MARKER}]`).length).toBe(1);
    expect(document.querySelectorAll(`[${MARKER}]`).length).toBe(1);
    // 站点原生内容未受影响（append-only 契约）
    expect(toolbar.textContent).toContain('站点原生点赞按钮');
  });

  it('onMountedChange 回调序列：挂载 true → 候选整体消失 false', async () => {
    const toolbar = makeToolbar('video-toolbar-left');
    const changes: boolean[] = [];
    const probe = await createProbe({ onMountedChange: (m) => changes.push(m) });
    await advance(300);
    expect(probe.isMounted()).toBe(true);
    expect(changes).toEqual([true]);

    // 候选元素被站点整体移除 → 探针摘除并回调 false（FAB 恢复语义由内容脚本侧承接）
    toolbar.remove();
    await advance(300);

    expect(probe.isMounted()).toBe(false);
    expect(document.querySelectorAll(`[${MARKER}]`).length).toBe(0);
    expect(changes).toEqual([true, false]);
  });

  it('dispose → 全量摘除、回调 false、诊断删除、轮询不复活', async () => {
    const toolbar = makeToolbar('video-toolbar-left-main');
    const changes: boolean[] = [];
    const probe = await createProbe({ onMountedChange: (m) => changes.push(m) });
    await advance(300);
    expect(probe.isMounted()).toBe(true);
    expect(changes).toEqual([true]);

    await act(async () => {
      probe.dispose();
    });

    expect(probe.isMounted()).toBe(false);
    expect(toolbar.querySelector(`[${MARKER}]`)).toBeNull();
    expect(document.querySelectorAll(`[${MARKER}]`).length).toBe(0);
    expect(window.__hduBiliToolbarProbe).toBeUndefined();
    expect(changes).toEqual([true, false]);

    // 摘除后再推进轮询：不应复活（观察器与定时器已清）
    await advance(300);
    expect(toolbar.querySelector(`[${MARKER}]`)).toBeNull();
    expect(probe.isMounted()).toBe(false);
  });

  it('onActivate：shadow 内按钮点击触发（等价打开学习助手面板的路径）', async () => {
    const toolbar = makeToolbar('video-toolbar-left-main');
    let activated = 0;
    const probe = await createProbe({ onActivate: () => (activated += 1) });
    await advance(300);
    expect(probe.isMounted()).toBe(true);

    const shadow = must(must(toolbar.querySelector(`[${MARKER}]`), 'host').shadowRoot, 'shadowRoot');
    const btn = must(shadow.querySelector('.hdu-bili-toolbar-btn'), '入口按钮');
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(activated).toBe(1);
  });

  it('诊断：window.__hduBiliToolbarProbe 记录各候选命中情况与 active 候选', async () => {
    makeToolbar('video-toolbar-left-main');
    const probe = await createProbe();
    await advance(300);
    expect(probe.isMounted()).toBe(true);

    const diag = window.__hduBiliToolbarProbe;
    expect(diag).toBeDefined();
    expect(must(diag, '诊断快照').mounted).toBe(true);
    expect(diag?.active).toEqual({ kind: 'toolbar', selector: '.video-toolbar-left-main' });
    // 候选全量登记：toolbar 5 项
    expect(diag?.candidates.length).toBe(5);
    const mainDiag = diag?.candidates.find((c) => c.selector === '.video-toolbar-left-main');
    expect(mainDiag?.hit).toBe(true);
    expect(mainDiag?.firstHitAt).not.toBeNull();
    expect(mainDiag?.lastHitAt).not.toBeNull();
    // 模糊选择器按子串匹配，命中同一元素（类名含 "video-toolbar" 字样）
    const fuzzyDiag = diag?.candidates.find((c) => c.selector === '[class*="video-toolbar"]');
    expect(fuzzyDiag?.hit).toBe(true);
    // 类 token 精确匹配的选择器不命中（元素类名是 video-toolbar-left-main）
    const exactDiag = diag?.candidates.find((c) => c.selector === '.video-toolbar');
    expect(exactDiag?.hit).toBe(false);
    expect(exactDiag?.firstHitAt).toBeNull();
  });

  it('主题跟随：挂载时采样站点深底 → 入口根节点带 data-theme="dark"', async () => {
    // 深底信号：html 渲染背景亮度 < 0.35（jsdom 的 computed style 反映内联样式）
    document.documentElement.style.backgroundColor = 'rgb(17, 19, 24)';
    const toolbar = makeToolbar('video-toolbar-left-main');
    const probe = await createProbe();
    await advance(300);
    expect(probe.isMounted()).toBe(true);

    const shadow = must(must(toolbar.querySelector(`[${MARKER}]`), 'host').shadowRoot, 'shadowRoot');
    expect(shadow.querySelector('.hdu-bili-toolbar-entry')?.getAttribute('data-theme')).toBe('dark');
  });
});
