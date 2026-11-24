/**
 * 统一搜索「命中 N 段」展开定位 · 渲染测试（第 257 轮巡检，检索域；jsdom + react-dom
 * 客户端渲染，照 search-highlight-ui.test.ts 桩模式：callOp 整体 mock + 假定时器推进防抖）。
 *
 * 覆盖：
 *  1. 多段命中条目：toggle 点击展开时间列表（时钟 + 截断文本），再点收起（aria-expanded）；
 *  2. 展开行点击（course 跳转）：onSessionJump 透传该段 startSec 为 anchorSec；
 *  3. 展开行点击（站外 url 跳转）：window.open 带 ?t= 命中秒；
 *  4. 单段命中 / 无 jump 条目：不渲染展开开关（防不可用交互）。
 */
// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({ callOp: vi.fn() }));

import { callOp } from '@/core/shared/client';
import { TopBarSearch } from '@/entrypoints/content/ui/learning/TopBarSearch';
import type { UnifiedSearchResult } from '@/core/search/unified';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;

function resultWith(items: UnifiedSearchResult['groups'][number]['items']): UnifiedSearchResult {
  return { groups: [{ kind: 'transcript', label: '字幕', total: items.length, items }], totalCount: items.length, favoritesTruncated: false };
}

const MULTI_COURSE = resultWith([
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
]);

const MULTI_EXTERNAL = resultWith([
  {
    kind: 'transcript',
    title: 'B 站视频 BV1xx411c7mD',
    snippet: '02:00 · 【矩阵】乘法满足结合律',
    anchorSec: 120,
    hitCount: 2,
    hitSegments: [
      { startSec: 45, text: '什么是矩阵' },
      { startSec: 120, text: '矩阵乘法满足结合律' },
    ],
    jump: { type: 'url', url: 'https://www.bilibili.com/video/BV1xx411c7mD' },
  },
]);

const SINGLE = resultWith([
  {
    kind: 'transcript',
    title: '线性代数 B · 第 1 讲',
    snippet: '02:00 · 矩阵乘法满足结合律',
    anchorSec: 120,
    hitCount: 1,
    jump: { type: 'course', courId: 12, teclId: 22, anchorSec: 120 },
  },
]);

let host: HTMLElement;
let root: Root;
const onSessionJump = vi.fn();

async function renderElement(): Promise<void> {
  await act(async () => {
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

async function searchFor(keyword: string, result: UnifiedSearchResult): Promise<void> {
  callOpMock.mockResolvedValue(result);
  typeText(inputEl(), keyword);
  await act(async () => {
    vi.advanceTimersByTime(300);
  });
  await act(async () => {});
}

function toggleEl(): HTMLButtonElement {
  const el = host.querySelector<HTMLButtonElement>('.hdu-search-hits-toggle');
  if (!el) throw new Error('hits toggle not found');
  return el;
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

describe('「命中 N 段」展开定位（第 257 轮）', () => {
  it('toggle 展开时间列表（时钟 + 文本），再点收起；aria-expanded 跟随', async () => {
    await searchFor('矩阵', MULTI_COURSE);
    expect(toggleEl().getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('.hdu-search-hits')).toBeNull();
    await act(async () => {
      toggleEl().click();
    });
    expect(toggleEl().getAttribute('aria-expanded')).toBe('true');
    const rows = Array.from(host.querySelectorAll('.hdu-search-hit-row'));
    expect(rows).toHaveLength(3);
    expect(rows[0]?.querySelector('.hdu-search-hit-time')?.textContent).toBe('01:36');
    expect(rows[2]?.querySelector('.hdu-search-hit-time')?.textContent).toBe('05:12');
    expect(rows[1]?.querySelector('.hdu-search-hit-text')?.textContent).toBe('矩阵的初等行变换');
    await act(async () => {
      toggleEl().click();
    });
    expect(host.querySelector('.hdu-search-hits')).toBeNull();
  });

  it('站内 course 条目行点击：onSessionJump 透传该段 startSec 为 anchorSec 并收起面板', async () => {
    await searchFor('矩阵', MULTI_COURSE);
    await act(async () => {
      toggleEl().click();
    });
    const row = host.querySelector<HTMLButtonElement>('.hdu-search-hit-row');
    expect(row).toBeTruthy();
    await act(async () => {
      row!.click();
    });
    expect(onSessionJump).toHaveBeenCalledWith(11, 21, 96);
    // onDone：点击命中段后面板收起、输入清空
    expect(inputEl().value).toBe('');
    expect(host.querySelector('.hdu-search-pop')).toBeNull();
  });

  it('站外 url 条目行点击：window.open 带 ?t= 命中秒（新标签续看）', async () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    await searchFor('矩阵', MULTI_EXTERNAL);
    await act(async () => {
      toggleEl().click();
    });
    const row = host.querySelector<HTMLButtonElement>('.hdu-search-hit-row');
    await act(async () => {
      row!.click();
    });
    expect(openSpy).toHaveBeenCalledTimes(1);
    const url = String(openSpy.mock.calls[0]?.[0]);
    expect(url).toContain('https://www.bilibili.com/video/BV1xx411c7mD');
    expect(url).toContain('t=45');
    openSpy.mockRestore();
  });

  it('单段命中条目：不渲染展开开关（单段无定位列表价值）', async () => {
    await searchFor('矩阵', SINGLE);
    expect(host.querySelector('.hdu-search-hits-toggle')).toBeNull();
  });

  it('段内命中词二次高亮（第 258 轮）：展开行的段文本里命中词渲染为 mark', async () => {
    await searchFor('矩阵', MULTI_COURSE);
    await act(async () => {
      toggleEl().click();
    });
    const rowMarks = host.querySelectorAll('.hdu-search-hit-row mark.hdu-search-mark');
    // 三段均含「矩阵」：每段各一个 mark（与 snippet 高亮同一解析规则）
    expect(rowMarks.length).toBe(3);
    expect(rowMarks[0]?.textContent).toBe('矩阵');
  });

  it('展开态不跨搜索残留（第 258 轮）：换关键词发起新搜索后展开区自动收起', async () => {
    await searchFor('矩阵', MULTI_COURSE);
    await act(async () => {
      toggleEl().click();
    });
    expect(host.querySelector('.hdu-search-hits')).not.toBeNull();
    // 新一轮搜索（关键词变化 → 新结果）即使仍是多段命中条目，展开态也应复位
    await searchFor('极限', MULTI_COURSE);
    expect(host.querySelector('.hdu-search-hits')).toBeNull();
    expect(toggleEl().getAttribute('aria-expanded')).toBe('false');
  });
});
