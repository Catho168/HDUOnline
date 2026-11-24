/**
 * 顶栏统一搜索方向键导航测试（jsdom + react-dom 客户端渲染，无 JSX、直接 createElement，
 * 照 plan-menu.test.ts 模式；callOp 整体 mock，search.all 返回固定结果表）。
 *
 * 覆盖第 10 轮 combobox 完整化的行为约定：
 *  1. ↓/↓ 在 option 间移动高亮（aria-activedescendant + aria-selected + is-active 视觉态），
 *     Enter 执行当前高亮项（course 跳转）并收起面板、清空输入；
 *  2. 循环边界：末项 ↓ 回绕首项、首项 ↑ 回绕末项；
 *  3. 无高亮时 Enter 维持既有行为（不触发跳转、面板不关）；
 *  4. 输入内容变化立即复位高亮；Esc 关闭面板。
 * 第 18 轮追加：收藏路触顶（favoritesTruncated）时收藏组末尾的中性降级提示冒烟。
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

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;

/** 搜索结果桩：2 条字幕（course 跳转）+ 1 条收藏（course 跳转）+ 1 条笔记（无 jump，静态条目） */
const RESULT: UnifiedSearchResult = {
  groups: [
    {
      kind: 'transcript',
      label: '字幕',
      total: 2,
      items: [
        { kind: 'transcript', title: '课次 A', snippet: '……【高数】……', jump: { type: 'course', courId: 11, teclId: 21 } },
        { kind: 'transcript', title: '课次 B', snippet: '……【高数】……', jump: { type: 'course', courId: 12, teclId: 22 } },
      ],
    },
    {
      kind: 'favorite',
      label: '收藏',
      total: 1,
      items: [{ kind: 'favorite', title: '收藏 C', snippet: '……', jump: { type: 'course', courId: 13, teclId: 23 } }],
    },
    { kind: 'note', label: '笔记', total: 1, items: [{ kind: 'note', title: '笔记 D', snippet: '……' }] },
  ],
  totalCount: 4,
  favoritesTruncated: false,
};

function stubSearch(result: UnifiedSearchResult = RESULT): void {
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

function query<T extends Element>(selector: string): T {
  const el = host.querySelector<T>(selector);
  if (!el) throw new Error(`element not found: ${selector}`);
  return el;
}

function inputEl(): HTMLInputElement {
  return query<HTMLInputElement>('input[role="combobox"]');
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

/** 输入 → 推进防抖 → 等 search.all 结果落定（防抖 300ms 用假定时器推进；result 可指定返回桩） */
async function searchFor(keyword: string, result: UnifiedSearchResult = RESULT): Promise<void> {
  stubSearch(result);
  typeText(inputEl(), keyword);
  await act(async () => {
    vi.advanceTimersByTime(300);
  });
  await act(async () => {});
}

function options(): Element[] {
  return Array.from(host.querySelectorAll('[role="option"]'));
}

function activeOption(): Element | null {
  return host.querySelector('[role="option"].is-active');
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
});

describe('顶栏统一搜索方向键导航（combobox）', () => {
  it('↓ 移动高亮（aria-activedescendant / aria-selected / is-active），Enter 执行当前高亮项并收起面板', async () => {
    await renderElement(createElement(TopBarSearch));
    await searchFor('高数');

    const items = options();
    expect(items).toHaveLength(4);
    // 初始无高亮
    expect(inputEl().getAttribute('aria-activedescendant')).toBeNull();
    expect(activeOption()).toBeNull();

    pressKey(inputEl(), 'ArrowDown');
    expect(activeOption()).toBe(items[0]);
    expect(items[0]?.getAttribute('aria-selected')).toBe('true');
    expect(inputEl().getAttribute('aria-activedescendant')).toBe(items[0]?.getAttribute('id'));

    pressKey(inputEl(), 'ArrowDown');
    expect(activeOption()).toBe(items[1]);
    expect(items[0]?.getAttribute('aria-selected')).toBe('false');

    // Enter 执行当前高亮项：course 跳转 + 面板收起 + 输入清空
    const openSpy = vi.spyOn(uiStore.actions, 'openSessionInSite');
    pressKey(inputEl(), 'Enter');
    await act(async () => {});
    expect(openSpy).toHaveBeenCalledWith(12, 22);
    expect(host.querySelector('.hdu-search-pop')).toBeNull();
    expect(inputEl().value).toBe('');
  });

  it('循环边界：末项 ↓ 回绕首项，首项 ↑ 回绕末项', async () => {
    await renderElement(createElement(TopBarSearch));
    await searchFor('高数');

    const items = options();
    // ↓×4 到末项（静态笔记条目也参与高亮），再 ↓ 回绕到首项
    for (let i = 0; i < 4; i += 1) pressKey(inputEl(), 'ArrowDown');
    expect(activeOption()).toBe(items[3]);
    pressKey(inputEl(), 'ArrowDown');
    expect(activeOption()).toBe(items[0]);

    // ↑ 从首项回绕到末项
    pressKey(inputEl(), 'ArrowUp');
    expect(activeOption()).toBe(items[3]);
    pressKey(inputEl(), 'ArrowUp');
    expect(activeOption()).toBe(items[2]);
  });

  it('无高亮时 Enter 维持既有行为：不触发跳转、面板不收起', async () => {
    await renderElement(createElement(TopBarSearch));
    await searchFor('高数');

    const openSpy = vi.spyOn(uiStore.actions, 'openSessionInSite');
    pressKey(inputEl(), 'Enter');
    await act(async () => {});
    expect(openSpy).not.toHaveBeenCalled();
    expect(host.querySelector('.hdu-search-pop')).not.toBeNull();
  });

  it('输入内容变化立即复位高亮；Esc 关闭面板', async () => {
    await renderElement(createElement(TopBarSearch));
    await searchFor('高数');

    pressKey(inputEl(), 'ArrowDown');
    expect(activeOption()).not.toBeNull();

    // 输入变化：高亮立刻复位（不等防抖结果）
    typeText(inputEl(), '高数2');
    expect(activeOption()).toBeNull();
    expect(inputEl().getAttribute('aria-activedescendant')).toBeNull();

    // 再次高亮后 Esc：面板关闭
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await act(async () => {});
    pressKey(inputEl(), 'ArrowDown');
    expect(activeOption()).not.toBeNull();
    pressKey(inputEl(), 'Escape');
    expect(host.querySelector('.hdu-search-pop')).toBeNull();
    expect(activeOption()).toBeNull();
  });
});

describe('顶栏统一搜索键位流盘点补齐（第 247 轮，键盘域）', () => {
  it('Home 跳到首条，End 跳到末条（跨分组扁平序号）', async () => {
    await renderElement(createElement(TopBarSearch));
    await searchFor('高数');

    const items = options();
    // End 直接到末项（静态笔记条目也参与高亮）
    pressKey(inputEl(), 'End');
    expect(activeOption()).toBe(items[3]);
    expect(inputEl().getAttribute('aria-activedescendant')).toBe(items[3]?.getAttribute('id'));
    // Home 回到首项
    pressKey(inputEl(), 'Home');
    expect(activeOption()).toBe(items[0]);
  });

  it('Enter 执行高亮项后焦点仍留在输入框（aria-activedescendant 方案的焦点管理）', async () => {
    await renderElement(createElement(TopBarSearch));
    await searchFor('高数');
    inputEl().focus();
    pressKey(inputEl(), 'ArrowDown');
    pressKey(inputEl(), 'Enter');
    await act(async () => {});
    expect(document.activeElement).toBe(inputEl());
    expect(inputEl().value).toBe('');
  });

  it('Enter 统一接管：面板打开时一律 preventDefault（无高亮也拦截宿主页默认行为）', async () => {
    await renderElement(createElement(TopBarSearch));
    await searchFor('高数');

    const openSpy = vi.spyOn(uiStore.actions, 'openSessionInSite');
    let prevented = false;
    act(() => {
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      inputEl().dispatchEvent(event);
      prevented = event.defaultPrevented;
    });
    await act(async () => {});
    expect(prevented).toBe(true);
    expect(openSpy).not.toHaveBeenCalled();
    expect(host.querySelector('.hdu-search-pop')).not.toBeNull();
  });

  it('空结果（无 option）：键位 hint 行不渲染，Enter preventDefault 且无操作（面板不关）', async () => {
    await renderElement(createElement(TopBarSearch));
    await searchFor('不存在的关键词XYZ', { groups: [], totalCount: 0, favoritesTruncated: false });

    expect(host.querySelector('.hdu-search-keys-hint')).toBeNull();
    expect(options()).toHaveLength(0);
    let prevented = false;
    act(() => {
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      inputEl().dispatchEvent(event);
      prevented = event.defaultPrevented;
    });
    await act(async () => {});
    expect(prevented).toBe(true);
    expect(host.querySelector('.hdu-search-pop')).not.toBeNull();
  });

  it('有结果时渲染键位 hint 行（浮层底部 muted 小字，固定文案）', async () => {
    await renderElement(createElement(TopBarSearch));
    await searchFor('高数');

    const hint = host.querySelector('.hdu-search-keys-hint');
    expect(hint).not.toBeNull();
    expect(hint?.textContent).toBe('↑↓ 选择 · Enter 打开 · Esc 关闭');
    // hint 行挂在结果面板（listbox）底部，位于统计脚注之后
    expect(hint?.closest('[role="listbox"]')).not.toBeNull();
  });
});

describe('顶栏统一搜索收藏截断提示（第 18 轮审计留观项）', () => {
  it('favoritesTruncated=true：收藏组末尾出现中性降级提示，不参与方向键导航', async () => {
    await renderElement(createElement(TopBarSearch));
    await searchFor('高数', { ...RESULT, favoritesTruncated: true });

    const hint = host.querySelector('.hdu-search-group-hint');
    expect(hint).not.toBeNull();
    expect(hint?.textContent).toBe('收藏较多，仅搜索最近 30 条');
    // 提示挂在收藏组末尾（aria-label=收藏 的 group 内）
    expect(hint?.closest('[role="group"]')?.getAttribute('aria-label')).toBe('收藏');
    // 不是 option：option 数不变（提示不进入方向键导航）
    expect(options()).toHaveLength(4);
  });

  it('favoritesTruncated=false（缺省）：不渲染提示', async () => {
    await renderElement(createElement(TopBarSearch));
    await searchFor('高数');
    expect(host.querySelector('.hdu-search-group-hint')).toBeNull();
  });
});
