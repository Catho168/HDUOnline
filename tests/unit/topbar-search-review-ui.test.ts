/**
 * 顶栏统一搜索「复习组」渲染测试（jsdom + react-dom 客户端渲染，无 JSX、直接
 * createElement，照 topbar-search-keys.test.ts 桩模式；callOp 整体 mock，
 * search.all 返回含复习组的固定结果表）。
 *
 * 覆盖第 245 轮新增的行为约定：
 *  1. search.all 四组结果在面板中按序渲染：字幕 → 收藏 → 笔记 → 复习；
 *     复习组带组头（label「复习」+ 截断前计数）与描边徽标（.hdu-search-badge.review）；
 *  2. 复习条目为 button（course 跳转）：键盘 ↓ 高亮可跨组移动到复习条目
 *     （aria-selected + is-active），Enter 触发 openSessionInSite（经 uiStore 桩观察）；
 *  3. 「全部 N 条」脚注计入复习组命中。
 */

// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({ callOp: vi.fn() }));

import { callOp } from '@/core/shared/client';
import { TopBarSearch } from '@/entrypoints/content/ui/learning/TopBarSearch';
import type { UnifiedSearchResult } from '@/core/search/unified';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;

/** 搜索结果桩：字幕/收藏/笔记/复习 各 1 条（复习条目 = course 跳转的 pending 作业）；
 *  第 260 轮起 UnifiedSearchGroup 带 all 全量字段（未截断组 all=items） */
const RESULT: UnifiedSearchResult = {
  groups: [
    {
      kind: 'transcript',
      label: '字幕',
      total: 1,
      items: [{ kind: 'transcript', title: '课次 A', snippet: '……【高数】……', jump: { type: 'course', courId: 11, teclId: 21 } }],
      all: [{ kind: 'transcript', title: '课次 A', snippet: '……【高数】……', jump: { type: 'course', courId: 11, teclId: 21 } }],
    },
    {
      kind: 'favorite',
      label: '收藏',
      total: 1,
      items: [{ kind: 'favorite', title: '收藏 C', snippet: '……', jump: { type: 'course', courId: 13, teclId: 23 } }],
      all: [{ kind: 'favorite', title: '收藏 C', snippet: '……', jump: { type: 'course', courId: 13, teclId: 23 } }],
    },
    {
      kind: 'note',
      label: '笔记',
      total: 1,
      items: [{ kind: 'note', title: '笔记 D', snippet: '……' }],
      all: [{ kind: 'note', title: '笔记 D', snippet: '……' }],
    },
    {
      kind: 'review',
      label: '复习',
      total: 2,
      items: [{ kind: 'review', title: '复习 E', snippet: '第 2 轮 · 2026-11-25 到期', jump: { type: 'course', courId: 15, teclId: 25 } }],
      all: [
        { kind: 'review', title: '复习 E', snippet: '第 2 轮 · 2026-11-25 到期', jump: { type: 'course', courId: 15, teclId: 25 } },
        { kind: 'review', title: '复习 F', snippet: '第 1 轮 · 2026-11-26 到期', jump: { type: 'course', courId: 16, teclId: 26 } },
      ],
    },
  ],
  totalCount: 5,
  favoritesTruncated: false,
};

function stubSearch(result: UnifiedSearchResult): void {
  callOpMock.mockImplementation(async (op: string) => {
    if (op === 'search.all') return result;
    throw new Error(`unexpected op: ${op}`);
  });
}

let host: HTMLElement;
let root: Root;

async function renderElement(el: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => {
    root.render(el);
  });
}

function inputEl(): HTMLInputElement {
  return host.querySelector<HTMLInputElement>('input[role="combobox"]')!;
}

/** React 受控输入赋值：必须走原生 value setter 再派发 input 事件，onChange 才会触发 */
function typeText(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function pressKey(input: HTMLInputElement, key: string): void {
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

/** 输入 → 推进防抖 → 等 search.all 结果落定 */
async function searchFor(keyword: string): Promise<void> {
  stubSearch(RESULT);
  typeText(inputEl(), keyword);
  await act(async () => {
    vi.advanceTimersByTime(300);
  });
  await act(async () => {});
}

function options(): Element[] {
  return Array.from(host.querySelectorAll('[role="option"]'));
}

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('顶栏统一搜索复习组（第 245 轮）', () => {
  it('四组按序渲染：复习组组头（复习 + 截断前计数）+ 描边徽标 + course 跳转按钮', async () => {
    const openSessionSpy = vi.fn();
    await renderElement(createElement(TopBarSearch, { onSessionJump: openSessionSpy }));
    await searchFor('高数');

    const groups = Array.from(host.querySelectorAll('.hdu-search-group'));
    expect(groups).toHaveLength(4);
    const reviewGroup = groups[3]!;
    expect(reviewGroup.getAttribute('aria-label')).toBe('复习');
    expect(reviewGroup.querySelector('.hdu-search-group-head span')?.textContent).toBe('复习');
    expect(reviewGroup.querySelector('.hdu-search-group-count')?.textContent).toBe('2');
    // 描边徽标（.hdu-search-badge.review）+ 条目为 button（course 跳转）
    const badge = reviewGroup.querySelector('.hdu-search-badge.review');
    expect(badge).toBeTruthy();
    expect(badge?.textContent).toBe('复习');
    const reviewItem = reviewGroup.querySelector('button.hdu-search-item');
    expect(reviewItem).toBeTruthy();
    expect(reviewItem!.textContent).toContain('复习 E');
    expect(reviewItem!.textContent).toContain('第 2 轮 · 2026-11-25 到期');
    // 脚注总计数含复习组（4 展示 + 笔记组 1 条 + 复习组截断前 2 → totalCount 5）
    expect(host.querySelector('.hdu-search-foot')?.textContent).toContain('全部 5 条');
  });

  it('键盘 ↓ 高亮跨组移动到复习条目，Enter 触发课次跳转并收起面板', async () => {
    const openSessionSpy = vi.fn();
    await renderElement(createElement(TopBarSearch, { onSessionJump: openSessionSpy }));
    await searchFor('高数');

    // ↓ ×4 移动到第 4 组的复习条目（跨组连续编号）
    for (let i = 0; i < 4; i += 1) pressKey(inputEl(), 'ArrowDown');
    const items = options();
    expect(items).toHaveLength(4);
    expect(items[3]?.classList.contains('is-active')).toBe(true);
    expect(items[3]?.getAttribute('aria-selected')).toBe('true');

    pressKey(inputEl(), 'Enter');
    expect(openSessionSpy).toHaveBeenCalledTimes(1);
    expect(openSessionSpy).toHaveBeenCalledWith(15, 25);
    // 点击后收起面板并清空输入
    expect(host.querySelector('.hdu-search-pop')).toBeNull();
    expect(inputEl().value).toBe('');
  });
});
