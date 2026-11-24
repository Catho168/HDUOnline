/**
 * 顶栏统一搜索「最近搜索 chips」渲染测试（jsdom + react-dom 客户端渲染，无 JSX、
 * 直接 createElement，照 topbar-search-review-ui.test.ts 桩模式；callOp 整体 mock，
 * uiStore 真实例 + settings.ui.recentQueries 预置/断言）。
 *
 * 覆盖第 246 轮新增的行为约定：
 *  1. 聚焦且输入为空 → chips 行渲染（「最近搜索」标签 + chip + 后缀 × + 「清空」）；
 *     无记录时不渲染；chip 超长词展示截断、title 给全文；
 *  2. chip 点击 → 填入关键词并（经既有 300ms 防抖）发起 search.all，chips 行隐藏；
 *  3. chip 后缀 × → 单条删除（settings.ui.recentQueries 更新 + saveSetting 落盘）；
 *     「清空」→ 全部清空、chips 行消失（无记录不渲染）；
 *  4. 非空提交记录：输入新词防抖搜索后 recentQueries 首位插入该词（去重前移）；
 *  5. Esc 关闭面板时 chips 行一并隐藏。
 */

// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({ callOp: vi.fn() }));

import { callOp } from '@/core/shared/client';
import { TopBarSearch } from '@/entrypoints/content/ui/learning/TopBarSearch';
import { uiStore } from '@/entrypoints/content/ui/store';
import { DEFAULT_SETTINGS } from '@/core/shared/constants';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;

const SEARCH_RESULT = {
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

let saveSettingMock: ReturnType<typeof vi.fn>;

/** 预置最近搜索记录（仿用户已搜过的持久化状态） */
function seedRecent(list: string[]): void {
  const settings = uiStore.getState().settings;
  uiStore.patch({ settings: { ...settings, ui: { ...settings.ui, recentQueries: list } } });
}

function currentRecent(): string[] {
  return uiStore.getState().settings.ui?.recentQueries ?? [];
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

function focusInput(): void {
  act(() => {
    inputEl().dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  });
}

function pressKey(input: HTMLInputElement, key: string): void {
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

function recentRow(): HTMLElement | null {
  return host.querySelector<HTMLElement>('.hdu-recent-row');
}

function chipButtons(): HTMLButtonElement[] {
  return Array.from(host.querySelectorAll<HTMLButtonElement>('.hdu-recent-chip .hdu-recent-q'));
}

function delButtons(): HTMLButtonElement[] {
  return Array.from(host.querySelectorAll<HTMLButtonElement>('.hdu-recent-chip .hdu-recent-del'));
}

async function clickAsync(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await act(async () => {});
}

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  // saveSetting 打桩观察落盘（默认 noopAsync 不落任何真存储）
  saveSettingMock = vi.fn(async () => undefined);
  uiStore.bindActions({ saveSetting: saveSettingMock });
  callOpMock.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => root.unmount());
  // 还原全局 uiStore，避免污染同文件后续用例
  uiStore.patch({ settings: { ...DEFAULT_SETTINGS } });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('最近搜索 chips（第 246 轮）', () => {
  it('聚焦且输入为空 → chips 行渲染；无记录时不渲染', async () => {
    seedRecent(['高数', '线代']);
    await renderElement(createElement(TopBarSearch, {}));
    // 未聚焦：不渲染
    expect(recentRow()).toBeNull();
    focusInput();
    expect(recentRow()).toBeTruthy();
    expect(recentRow()!.getAttribute('aria-label')).toBe('最近搜索');
    expect(recentRow()!.textContent).toContain('最近搜索');
    const chips = chipButtons();
    expect(chips.map((b) => b.textContent)).toEqual(['高数', '线代']);
    expect(host.querySelector('.hdu-recent-clear')?.textContent).toBe('清空');
    // 删除 × 与 chip 一一对应
    expect(delButtons()).toHaveLength(2);
  });

  it('无记录（空数组）聚焦不渲染 chips 行', async () => {
    seedRecent([]);
    await renderElement(createElement(TopBarSearch, {}));
    focusInput();
    expect(recentRow()).toBeNull();
  });

  it('chip 超长词展示截断、title 给全文', async () => {
    seedRecent(['x'.repeat(30)]);
    await renderElement(createElement(TopBarSearch, {}));
    focusInput();
    const chip = chipButtons()[0]!;
    expect(chip.textContent!.length).toBeLessThanOrEqual(17); // 16 字 + 省略号
    expect(chip.textContent!.endsWith('…')).toBe(true);
    expect(chip.getAttribute('title')).toHaveLength(30);
  });

  it('chip 点击 → 填入关键词并经防抖发起 search.all，chips 行隐藏', async () => {
    seedRecent(['高数', '线代']);
    callOpMock.mockImplementation(async (op: string) => {
      if (op === 'search.all') return SEARCH_RESULT;
      throw new Error(`unexpected op: ${op}`);
    });
    await renderElement(createElement(TopBarSearch, {}));
    focusInput();
    await clickAsync(chipButtons()[1]!); // 点「线代」
    expect(inputEl().value).toBe('线代');
    // 有 query 时 chips 行隐藏（与结果面板互斥）
    expect(recentRow()).toBeNull();
    // 防抖 300ms 后发起搜索
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await act(async () => {});
    expect(callOpMock).toHaveBeenCalledWith('search.all', { keyword: '线代' });
    expect(host.querySelector('.hdu-search-pop')).toBeTruthy();
  });

  it('chip 后缀 × → 单条删除并落盘；「清空」→ 全部清空、行消失', async () => {
    seedRecent(['高数', '线代']);
    await renderElement(createElement(TopBarSearch, {}));
    focusInput();
    await clickAsync(delButtons()[0]!); // 删「高数」
    expect(currentRecent()).toEqual(['线代']);
    expect(saveSettingMock).toHaveBeenCalledWith('ui', expect.objectContaining({ recentQueries: ['线代'] }));
    expect(chipButtons().map((b) => b.textContent)).toEqual(['线代']);
    await clickAsync(host.querySelector('.hdu-recent-clear')!);
    expect(currentRecent()).toEqual([]);
    expect(recentRow()).toBeNull(); // 无记录不渲染
  });

  it('非空提交记录最近搜索：新词首位插入、重复词前移不重复', async () => {
    seedRecent(['高数']);
    callOpMock.mockImplementation(async (op: string) => {
      if (op === 'search.all') return SEARCH_RESULT;
      throw new Error(`unexpected op: ${op}`);
    });
    await renderElement(createElement(TopBarSearch, {}));
    focusInput();
    typeText(inputEl(), '新词');
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await act(async () => {});
    expect(currentRecent()).toEqual(['新词', '高数']);

    // 重复词「高数」前移（输入带尾随空白触发新一次提交，trim 后语义同词）
    typeText(inputEl(), '高数 ');
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await act(async () => {});
    expect(currentRecent()).toEqual(['高数', '新词']);
    // 已在首位再搜不重复追加
    typeText(inputEl(), '高数  ');
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await act(async () => {});
    expect(currentRecent()).toEqual(['高数', '新词']);
  });

  it('Esc 关闭面板时 chips 行一并隐藏', async () => {
    seedRecent(['高数']);
    await renderElement(createElement(TopBarSearch, {}));
    focusInput();
    expect(recentRow()).toBeTruthy();
    pressKey(inputEl(), 'Escape');
    expect(recentRow()).toBeNull();
  });

  it('点击面板外 → chips 行与面板一并收起（同一生命周期）', async () => {
    seedRecent(['高数']);
    await renderElement(createElement(TopBarSearch, {}));
    focusInput();
    expect(recentRow()).toBeTruthy();
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
    });
    expect(recentRow()).toBeNull();
  });
});
