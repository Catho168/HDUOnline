/**
 * 统一搜索结果呈现增强 · 渲染测试（第 256 轮巡检，检索域；jsdom + react-dom 客户端渲染，
 * 照 topbar-search-keys.test.ts 桩模式：callOp 整体 mock + 假定时器推进防抖）。
 *
 * 覆盖：
 *  1. snippet 的【命中词】渲染为 <mark class="hdu-search-mark">（视觉高亮）；
 *  2. transcript 条目 hitCount>1 渲染「命中 N 段」meta 行；单段不渲染；
 *  3. 高亮不改变条目可交互性（course 跳转 button 仍在、点击触发 onSessionJump）。
 */
// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({ callOp: vi.fn() }));

import { callOp } from '@/core/shared/client';
import { TopBarSearch } from '@/entrypoints/content/ui/learning/TopBarSearch';
import { uiStore } from '@/entrypoints/content/ui/store';
import type { UnifiedSearchResult } from '@/core/search/unified';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;

const RESULT: UnifiedSearchResult = {
  groups: [
    {
      kind: 'transcript',
      label: '字幕',
      total: 2,
      items: [
        {
          kind: 'transcript',
          title: '高等数学 A · 第 3 讲',
          snippet: '05:12 · 对【矩阵】做初等行变换',
          anchorSec: 312,
          hitCount: 3,
          hitSegments: [
            { startSec: 96, text: '矩阵的第一种定义' },
            { startSec: 200, text: '矩阵的初等行变换' },
            { startSec: 312, text: '对矩阵做初等行变换' },
          ],
          jump: { type: 'course', courId: 11, teclId: 21, anchorSec: 312 },
        },
        {
          kind: 'transcript',
          title: '线性代数 B · 第 1 讲',
          snippet: '02:00 · 矩阵乘法满足结合律',
          anchorSec: 120,
          jump: { type: 'course', courId: 12, teclId: 22, anchorSec: 120 },
        },
      ],
    },
  ],
  totalCount: 2,
  favoritesTruncated: false,
};

let host: HTMLElement;
let root: Root;
const onSessionJump = vi.fn();

function renderElement(): Promise<void> {
  return act(async () => {
    root.render(createElement(TopBarSearch, { onSessionJump }));
  });
}

function inputEl(): HTMLInputElement {
  const el = host.querySelector<HTMLInputElement>('input[role="combobox"]');
  if (!el) throw new Error('input not found');
  return el;
}

function typeText(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function searchFor(keyword: string, result: UnifiedSearchResult = RESULT): Promise<void> {
  callOpMock.mockResolvedValue(result);
  typeText(inputEl(), keyword);
  await act(async () => {
    vi.advanceTimersByTime(300);
  });
  await act(async () => {});
}

beforeEach(async () => {
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await renderElement();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  host.remove();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('TopBarSearch 结果高亮与 meta 行（第 256 轮）', () => {
  it('命中词渲染为 <mark class="hdu-search-mark">，文本与关键词一致', async () => {
    await searchFor('矩阵');
    const marks = host.querySelectorAll('mark.hdu-search-mark');
    expect(marks.length).toBeGreaterThanOrEqual(1);
    expect(marks[0]?.textContent).toBe('矩阵');
  });

  it('transcript 多段命中：渲染「命中 3 段」展开开关；单段条目不渲染', async () => {
    await searchFor('矩阵');
    const toggles = Array.from(host.querySelectorAll('.hdu-search-hits-toggle'));
    expect(toggles).toHaveLength(1);
    expect(toggles[0]?.textContent).toContain('命中 3 段');
  });

  it('搜索中骨架（第 261 轮）：loading 且无结果时渲染三行阶梯骨架，结果到达后消失', async () => {
    // 受控 promise：让 loading 态可观察（mockResolvedValue 会立即落定为 done）
    let resolveSearch: (value: UnifiedSearchResult) => void = () => {};
    callOpMock.mockImplementation(
      () => new Promise<UnifiedSearchResult>((resolve) => { resolveSearch = resolve; }),
    );
    typeText(inputEl(), '矩阵');
    await act(async () => {
      vi.advanceTimersByTime(300); // 防抖到点 → runSearch 发起，promise 挂起
    });
    expect(host.querySelector('.hdu-search-loading')).not.toBeNull();
    expect(host.querySelectorAll('.hdu-search-loading .hdu-skeleton').length).toBeGreaterThanOrEqual(3);
    await act(async () => {
      resolveSearch(RESULT);
    });
    await act(async () => {});
    expect(host.querySelector('.hdu-search-loading')).toBeNull();
  });

  it('组内展开全部（第 260 轮）：total>上限的组尾出现「展开全部 N 条」，点击 option 数变全量、再点收起', async () => {
    // scrollIntoView 探针（第 262 轮：展开后滚回组头；jsdom 缺省无此 API，挂桩验证防御式调用）
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    const large: UnifiedSearchResult = {
      groups: [
        {
          kind: 'favorite',
          label: '收藏',
          total: 7,
          items: Array.from({ length: 5 }, (_, i) => ({
            kind: 'favorite' as const,
            title: `收藏 ${i}`,
            snippet: '',
            jump: { type: 'url' as const, url: `https://example.com/${i}` },
          })),
          all: Array.from({ length: 7 }, (_, i) => ({
            kind: 'favorite' as const,
            title: `收藏 ${i}`,
            snippet: '',
            jump: { type: 'url' as const, url: `https://example.com/${i}` },
          })),
        },
      ],
      totalCount: 7,
      favoritesTruncated: false,
    };
    await searchFor('收藏', large);
    const more = () => host.querySelector<HTMLButtonElement>('.hdu-search-group-more');
    expect(more()?.textContent).toContain('展开全部 7 条');
    expect(more()?.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(5);
    await act(async () => {
      more()!.click();
    });
    expect(more()?.textContent).toContain('收起');
    expect(more()?.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(7);
    // 展开态组容器 aria-label 标注「已展开全部」（第 269 轮，读屏可感知）
    expect(host.querySelector('.hdu-search-group')?.getAttribute('aria-label')).toContain('已展开全部 7 条');
    // 展开后滚回组头（第 262 轮）：scrollIntoView 被防御式调用
    expect(scrollSpy).toHaveBeenCalled();
    await act(async () => {
      more()!.click();
    });
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(5);
    expect(host.querySelector('.hdu-search-group')?.getAttribute('aria-label')).toBe('收藏');
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it('高亮不破坏条目可交互性：点击带锚点条目仍触发 onSessionJump 三参透传', async () => {
    await searchFor('矩阵');
    const buttons = Array.from(host.querySelectorAll('[role="option"]button, button[role="option"]'));
    const target = buttons.find((b) => b.textContent?.includes('高等数学 A'));
    expect(target).toBeTruthy();
    await act(async () => {
      target!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSessionJump).toHaveBeenCalledWith(11, 21, 312);
  });

  it('空结果引导（第 259 轮）：建议句 + 最近搜索 chips，点击 chip 填词重搜', async () => {
    // 预置最近搜索（settings.ui.recentQueries，跨打开持久化字段）
    const settings = uiStore.getState().settings;
    uiStore.patch({ settings: { ...settings, ui: { ...settings.ui, recentQueries: ['高数', '线性代数'] } } });
    await act(async () => {});
    const empty: UnifiedSearchResult = { groups: [], totalCount: 0, favoritesTruncated: false };
    await searchFor('不存在的词', empty);

    expect(host.textContent).toContain('没有匹配的字幕、收藏、笔记或复习');
    expect(host.textContent).toContain('试试更短的关键词');
    // 刚搜过的空词也入最近搜索（第 246 轮「非空提交即记录」口径），回放前 3 个
    const chips = Array.from(host.querySelectorAll<HTMLButtonElement>('.hdu-search-empty-recent .hdu-recent-q'));
    expect(chips.map((c) => c.textContent)).toEqual(['不存在的词', '高数', '线性代数']);

    // 点击 chip：填入关键词走既有防抖搜索链路（第二次 search.all）
    await act(async () => {
      vi.advanceTimersByTime(0);
      chips[1]!.click();
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await act(async () => {});
    expect(inputEl().value).toBe('高数');
    const searchCalls = callOpMock.mock.calls.filter((args) => args[0] === 'search.all');
    expect(searchCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('标题命中词高亮（第 267 轮）：搜索词出现在条目标题中时标题同样渲染 mark', async () => {
    await searchFor('高等');
    const titleMarks = host.querySelectorAll('.hdu-search-item-title mark.hdu-search-mark');
    expect(titleMarks.length).toBeGreaterThanOrEqual(1);
    expect(titleMarks[0]?.textContent).toBe('高等');
  });

  it('清除输入按钮（第 265 轮）：有输入时出现 ×，点击清空并收起面板，焦点回归输入框，清空后按钮消失', async () => {
    await searchFor('矩阵');
    const clear = host.querySelector<HTMLButtonElement>('.hdu-search-clear');
    expect(clear).toBeTruthy();
    await act(async () => {
      clear!.click();
    });
    expect(inputEl().value).toBe('');
    expect(host.querySelector('.hdu-search-pop')).toBeNull();
    expect(host.querySelector('.hdu-search-clear')).toBeNull();
    // 焦点回归输入框（第 266 轮）：清空后继续输入不丢焦点
    expect(document.activeElement).toBe(inputEl());
  });

  it('收藏触顶提示顺序（第 265 轮）：hint 在展开按钮之前（先数据范围后展开动作）', async () => {
    const truncated: UnifiedSearchResult = {
      groups: [
        {
          kind: 'favorite',
          label: '收藏',
          total: 31,
          items: Array.from({ length: 5 }, (_, i) => ({
            kind: 'favorite' as const,
            title: `收藏 ${i}`,
            snippet: '',
            jump: { type: 'url' as const, url: `https://example.com/${i}` },
          })),
          all: Array.from({ length: 31 }, (_, i) => ({
            kind: 'favorite' as const,
            title: `收藏 ${i}`,
            snippet: '',
            jump: { type: 'url' as const, url: `https://example.com/${i}` },
          })),
        },
      ],
      totalCount: 31,
      favoritesTruncated: true,
    };
    await searchFor('收藏', truncated);
    const group = host.querySelector('.hdu-search-group');
    const children = Array.from(group!.children).map((el) => el.className);
    const hintIdx = children.findIndex((c) => c.includes('hdu-search-group-hint'));
    const moreIdx = children.findIndex((c) => c.includes('hdu-search-group-more'));
    expect(hintIdx).toBeGreaterThan(-1);
    expect(moreIdx).toBeGreaterThan(-1);
    expect(hintIdx).toBeLessThan(moreIdx);
  });
});
