/**
 * 顶栏统一搜索「课次跳转覆写」单测（第 77 轮巡检，jsdom，照 topbar-search-keys.test.ts
 * 的渲染/防抖模式）：TopBarSearch 新增可选 onSessionJump prop——
 *  1. 传入时：course 跳转条目点击走覆写回调（B 站学习中心宿主 = 新标签打开 HDU 深链），
 *     uiStore.actions.openSessionInSite 不被调用；
 *  2. 缺省时：维持既有行为（uiStore.actions.openSessionInSite，HDU 站内语义）。
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
      total: 1,
      items: [{ kind: 'transcript', title: '课次 A', snippet: '……【高数】……', jump: { type: 'course', courId: 11, teclId: 21 } }],
    },
  ],
  totalCount: 1,
  favoritesTruncated: false,
};

let host: HTMLElement;
let root: Root;

async function renderElement(el: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => {
    root.render(el);
  });
}

function inputEl(): HTMLInputElement {
  const el = host.querySelector<HTMLInputElement>('input[role="combobox"]');
  if (!el) throw new Error('combobox input not found');
  return el;
}

function typeText(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function searchFor(keyword: string): Promise<void> {
  callOpMock.mockImplementation(async (op: string) => {
    if (op === 'search.all') return RESULT;
    throw new Error(`unexpected op: ${op}`);
  });
  typeText(inputEl(), keyword);
  await act(async () => {
    vi.advanceTimersByTime(300);
  });
  await act(async () => {});
}

function pressKey(input: HTMLInputElement, key: string): void {
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

function firstCourseOption(): HTMLButtonElement {
  const el = host.querySelector<HTMLButtonElement>('[role="option"].hdu-search-item');
  if (!el) throw new Error('search option not found');
  return el;
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

describe('统一搜索课次跳转覆写（onSessionJump）', () => {
  it('传入覆写：Enter 激活 course 条目走覆写回调，不走 uiStore.openSessionInSite', async () => {
    const onSessionJump: (courId: number, teclId?: number) => void = vi.fn();
    const inSiteSpy = vi.spyOn(uiStore.actions, 'openSessionInSite');
    await renderElement(createElement(TopBarSearch, { onSessionJump }));
    await searchFor('高数');

    pressKey(inputEl(), 'ArrowDown');
    pressKey(inputEl(), 'Enter');
    await act(async () => {});

    expect(onSessionJump).toHaveBeenCalledTimes(1);
    expect(onSessionJump).toHaveBeenCalledWith(11, 21);
    expect(inSiteSpy).not.toHaveBeenCalled();
  });

  it('缺省（不传）：维持既有行为，走 uiStore.actions.openSessionInSite', async () => {
    const inSiteSpy = vi.spyOn(uiStore.actions, 'openSessionInSite');
    await renderElement(createElement(TopBarSearch));
    await searchFor('高数');

    pressKey(inputEl(), 'ArrowDown');
    pressKey(inputEl(), 'Enter');
    await act(async () => {});

    expect(inSiteSpy).toHaveBeenCalledWith(11, 21);
  });

  it('B 站宿主等价路径：直接点击 course 条目同样走覆写回调并收起面板', async () => {
    const onSessionJump: (courId: number, teclId?: number) => void = vi.fn();
    await renderElement(createElement(TopBarSearch, { onSessionJump }));
    await searchFor('高数');

    act(() => {
      firstCourseOption().click();
    });
    await act(async () => {});

    expect(onSessionJump).toHaveBeenCalledWith(11, 21);
    expect(host.querySelector('.hdu-search-pop')).toBeNull();
  });
});

describe('统一搜索秒级直达（第 104 轮巡检）', () => {
  const ANCHORED: UnifiedSearchResult = {
    groups: [
      {
        kind: 'transcript',
        label: '字幕',
        total: 1,
        items: [
          { kind: 'transcript', title: '课次 A', snippet: '……【高数】……', jump: { type: 'course', courId: 11, teclId: 21, anchorSec: 95 } },
        ],
      },
    ],
    totalCount: 1,
    favoritesTruncated: false,
  };

  async function searchAnchored(): Promise<void> {
    callOpMock.mockImplementation(async (op: string) => (op === 'search.all' ? ANCHORED : []));
    typeText(inputEl(), '高数');
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await act(async () => {});
  }

  it('B 站覆写路径：course 命中带 anchorSec 时透传给 onSessionJump', async () => {
    const onSessionJump = vi.fn();
    await renderElement(createElement(TopBarSearch, { onSessionJump }));
    await searchAnchored();
    act(() => {
      firstCourseOption().click();
    });
    await act(async () => {});
    expect(onSessionJump).toHaveBeenCalledWith(11, 21, 95);
  });

  it('HDU 缺省路径：openSessionInSite 收到 { anchorSec }', async () => {
    const inSiteSpy = vi.spyOn(uiStore.actions, 'openSessionInSite');
    await renderElement(createElement(TopBarSearch));
    await searchAnchored();
    act(() => {
      firstCourseOption().click();
    });
    await act(async () => {});
    expect(inSiteSpy).toHaveBeenCalledWith(11, 21, { anchorSec: 95 });
  });
});
