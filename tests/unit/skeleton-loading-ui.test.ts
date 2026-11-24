/**
 * 六视图数据加载骨架一致性渲染测试（第 253 轮，视图域 / 反馈一致性视角；
 * jsdom + react-dom 客户端渲染，无 JSX 直接 createElement，callOp 整体 mock，
 * 照 library-view-batch.test.ts 桩模式）。
 *
 * 六视图加载态盘点结论（对照表见 docs/巡检日志.md 第 253 轮）：Overview / Courses /
 * Review / Stats 已有骨架或自有加载态；本轮补齐最明显两处缺口——
 *  1. ScheduleView：BundleData 异步装载期间「尚未同步课表」提示与「没有待补看的
 *     课次」空态先行渲染（误导闪现）→ 补骨架占位；
 *  2. LibraryView：收藏列表装载期间闪现「知识库还是空的」空态 → 补骨架卡。
 * 另覆盖第 253 轮补的 MissedList「已到课」失败反馈（callOp 唯一 catch 缺口）：
 * schedule.exclude 拒绝 → errorTextOf 兜底 toast。
 */

// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({ callOp: vi.fn() }));

import { callOp } from '@/core/shared/client';
import { ToastHost } from '@/entrypoints/content/ui/components';
import { ScheduleView } from '@/entrypoints/content/ui/learning/ScheduleView';
import { LibraryView } from '@/entrypoints/content/ui/learning/LibraryView';
import { MissedList, type BundleData } from '@/entrypoints/content/ui/learning/shared';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;

function makeData(overrides: Partial<BundleData> = {}): BundleData {
  return {
    bundles: [],
    report: null,
    missed: [],
    favorites: [],
    folders: [],
    notes: [],
    schedule: [],
    reviewPending: 0,
    loading: false,
    error: null,
    reload: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as BundleData;
}


let host: HTMLElement;
let root: Root;

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  callOpMock.mockReset();
  callOpMock.mockImplementation(async () => []);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  document.body.innerHTML = '';
});

async function renderNode(node: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => {
    root.render(createElement('div', null, node, createElement(ToastHost)));
  });
  await act(async () => {});
}

function skeletonCount(): number {
  return document.querySelectorAll('.hdu-skeleton').length;
}

function bodyText(): string {
  return document.body.textContent ?? '';
}

describe('ScheduleView 装载骨架（第 253 轮补缺口）', () => {
  it('loading=true：课表提示区与补看清单以骨架占位，不闪现「尚未同步课表」/「没有待补看的课次」', async () => {
    await renderNode(createElement(ScheduleView, { data: makeData({ loading: true }) }));
    expect(skeletonCount()).toBeGreaterThan(0);
    expect(bodyText()).not.toContain('尚未同步课表');
    expect(bodyText()).not.toContain('没有待补看的课次');
  });

  it('补看清单骨架行复用 .hdu-missed 卡壳（同构占位防跳版）', async () => {
    await renderNode(createElement(ScheduleView, { data: makeData({ loading: true }) }));
    expect(document.querySelectorAll('.hdu-missed .hdu-skeleton').length).toBeGreaterThan(0);
  });

  it('loading=false + 空数据：空态文案恢复（骨架退场）', async () => {
    await renderNode(createElement(ScheduleView, { data: makeData({ loading: false }) }));
    expect(skeletonCount()).toBe(0);
    expect(bodyText()).toContain('尚未同步课表');
    expect(bodyText()).toContain('没有待补看的课次');
  });
});

describe('LibraryView 装载骨架（第 253 轮补缺口）', () => {
  it('loading=true：收藏列表以骨架卡占位，不闪现「知识库还是空的」', async () => {
    await renderNode(createElement(LibraryView, { data: makeData({ loading: true }) }));
    expect(skeletonCount()).toBeGreaterThan(0);
    expect(bodyText()).not.toContain('知识库还是空的');
  });

  it('loading=false + 空库：空态恢复（骨架退场）', async () => {
    await renderNode(createElement(LibraryView, { data: makeData({ loading: false, favorites: [] }) }));
    expect(skeletonCount()).toBe(0);
    expect(bodyText()).toContain('知识库还是空的');
  });
});

describe('MissedList「已到课」失败反馈（第 253 轮 callOp 审计唯一 catch 缺口）', () => {
  it('schedule.exclude 拒绝 → errorTextOf 兜底 toast（非 AppError 原始错误不上屏）', async () => {
    callOpMock.mockImplementation(async (op: string) => {
      if (op === 'schedule.exclude') throw new Error('db connection lost');
      return [];
    });
    await renderNode(
      createElement(MissedList, {
        items: [
          {
            courId: 7,
            teclId: 1,
            courseName: '高等数学（下）',
            courLabel: '第3节课',
            beginTime: Date.now() - 4 * 86_400_000,
            watchedSec: 0,
            watchRatio: 0,
            excluded: false,
          },
        ],
        onExcluded: () => undefined,
      }),
    );
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('已到课'));
    expect(btn).toBeDefined();
    await act(async () => {
      btn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await act(async () => {});
    const toasts = [...document.querySelectorAll('.hdu-toast')].map((t) => t.textContent ?? '');
    expect(toasts.some((t) => t.includes('标记到课失败，请重试'))).toBe(true);
    // 内部技术文案不得透出（errorTextOf 收紧口径，第 222 轮）
    expect(toasts.some((t) => t.includes('db connection lost'))).toBe(false);
  });

  it('成功路径仍走 success toast + onExcluded 回调（既有行为不变）', async () => {
    callOpMock.mockImplementation(async (op: string) => {
      if (op === 'schedule.exclude') return { ok: true };
      return [];
    });
    const onExcluded = vi.fn();
    await renderNode(
      createElement(MissedList, {
        items: [
          {
            courId: 8,
            teclId: 2,
            courseName: '大学英语',
            courLabel: '第1节课',
            beginTime: Date.now() - 2 * 86_400_000,
            watchedSec: 0,
            watchRatio: 0,
            excluded: false,
          },
        ],
        onExcluded,
      }),
    );
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('已到课'));
    await act(async () => {
      btn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await act(async () => {});
    expect(onExcluded).toHaveBeenCalledTimes(1);
    const toasts = [...document.querySelectorAll('.hdu-toast')].map((t) => t.textContent ?? '');
    expect(toasts.some((t) => t.includes('已标记为到课'))).toBe(true);
  });
});
