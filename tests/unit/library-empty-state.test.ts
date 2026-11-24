/**
 * 知识库搜索空态分流测试（第 281 轮巡检，检索域 / 三端空态对齐的断言落库）。
 * jsdom + react-dom 渲染 LibraryView（最小 BundleData + callOp 查表桩）：
 *  1. 搜索无匹配 → 空态含「试试更短的关键词」（与统一搜索 / B 站同款指引）；
 *  2. 清空搜索 → 恢复收藏卡片列表；
 *  3. 空库（无收藏）→ 「知识库还是空的」引导。
 */
// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/core/shared/client', () => ({ callOp: vi.fn() }));

import { callOp } from '@/core/shared/client';
import { LibraryView } from '@/entrypoints/content/ui/learning/LibraryView';
import type { BundleData } from '@/entrypoints/content/ui/learning/shared';
import type { FavoriteEntity } from '@/core/shared/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as ReturnType<typeof vi.fn>;

const FAV: FavoriteEntity = {
  id: 'fav-1',
  type: 'video',
  refId: 'BV1Kb411W82v',
  snapshot: { title: '线性代数 第 1 讲', content: '从向量空间讲起' },
  folderId: null,
  tags: ['高数'],
  pinned: false,
  favoritedAt: 0,
  updatedAt: 0,
  metadata: { url: 'https://www.bilibili.com/video/BV1Kb411W82v/' },
} as FavoriteEntity;

function makeData(overrides: Partial<BundleData> = {}): BundleData {
  return {
    bundles: [],
    report: null,
    missed: [],
    favorites: [FAV],
    folders: [],
    notes: [],
    schedule: [],
    reviewPending: 0,
    loading: false,
    error: null,
    ...overrides,
  } as BundleData;
}

let host: HTMLElement;
let root: Root | null = null;

async function mountLibrary(data: BundleData): Promise<void> {
  await act(async () => {
    root!.render(createElement(LibraryView, { data }));
  });
  await act(async () => {});
}

/** 向知识库搜索框输入关键词（React 受控输入：原生 setter + input 事件） */
async function typeQuery(text: string): Promise<void> {
  const input = host.querySelector<HTMLInputElement>('.hdu-search input');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input!, text);
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {});
}

beforeEach(() => {
  callOpMock.mockReset();
  callOpMock.mockImplementation(async (op: string) => {
    if (op === 'review.list') return [];
    if (op === 'stats.report') return { days: [], goal: { weeklyTargetSec: 0, weekSec: 0, hitDaysThisWeek: 0 } };
    if (op === 'stats.period') return { buckets: [] };
    if (op === 'stats.heatmap') return { weeks: [] };
    throw new Error(`unexpected op: ${op}`);
  });
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

describe('知识库搜索空态分流（第 281 轮）', () => {
  it('搜索无匹配：空态含「试试更短的关键词」建议（与统一搜索 / B 站同款）', async () => {
    await mountLibrary(makeData());
    await typeQuery('不存在的词条');
    const empty = host.querySelector('.hdu-empty');
    expect(empty?.textContent).toContain('没有匹配的条目');
    expect(empty?.textContent).toContain('试试更短的关键词');
    // 清除搜索 action（第 296 轮，可用性域）：空态建议的直达按钮
    const action = host.querySelector<HTMLButtonElement>('.hdu-empty button');
    expect(action?.textContent).toBe('清除搜索');
    await act(async () => {
      action!.click();
    });
    expect(host.querySelectorAll('.hdu-knowledge-title')).toHaveLength(1);
  });

  it('筛选态空结果：「重置筛选」action 恢复全量', async () => {
    await mountLibrary(makeData());
    // 点「笔记」类型筛选 pill（收藏为 video → 筛选后空）
    const pill = Array.from(host.querySelectorAll<HTMLButtonElement>('.hdu-filter-pill')).find(
      (b) => b.textContent === '笔记',
    );
    await act(async () => {
      pill!.click();
    });
    expect(host.textContent).toContain('没有匹配的条目');
    const action = host.querySelector<HTMLButtonElement>('.hdu-empty button');
    expect(action?.textContent).toBe('重置筛选');
    await act(async () => {
      action!.click();
    });
    expect(host.querySelectorAll('.hdu-knowledge-title')).toHaveLength(1);
  });

  it('清空搜索：恢复收藏卡片列表', async () => {
    await mountLibrary(makeData());
    await typeQuery('不存在的词条');
    expect(host.textContent).toContain('没有匹配的条目');
    // × 清空（第 285 轮）：焦点回归输入框（四端一致）
    const clear = host.querySelector<HTMLButtonElement>('.hdu-search-clear');
    expect(clear).toBeTruthy();
    await act(async () => {
      clear!.click();
    });
    expect(host.querySelectorAll('.hdu-knowledge-title')).toHaveLength(1);
    expect(document.activeElement).toBe(host.querySelector<HTMLInputElement>('.hdu-search input'));
  });

  it('空库（无收藏）：显示「知识库还是空的」引导', async () => {
    await mountLibrary(makeData({ favorites: [] }));
    expect(host.textContent).toContain('知识库还是空的');
  });
});
