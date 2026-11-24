/**
 * 骨架 → 内容布局稳定性渲染测试（第 254 轮，布局稳定性域 / 防跳版视角；
 * jsdom + react-dom 客户端渲染，无 JSX 直接 createElement，callOp 整体 mock，
 * 照 skeleton-loading-ui.test.ts 桩模式）。
 *
 * 跳版核对结论（对照表见 docs/巡检日志.md 第 254 轮）：六视图骨架中两处高度差
 * 最明显——①Overview「继续你的课程」骨架 3×38px vs 真实列表 4 行 ≈59px/行
 * （数据到达容器长高 ~100px，下方「待补看」区下坠）；②知识库骨架卡单行 68px vs
 * 真实网格首屏 ≈313px（页面塌陷感）。本轮修齐：Overview 骨架 4×52px（行距 62px ≈
 * 真实 59px 行距）、知识库骨架卡 min-height 300px。其余骨架（Courses / Review /
 * Stats / Schedule 同构卡壳）高度接近真实首屏，评估不动。
 */

// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({ callOp: vi.fn() }));

import { callOp } from '@/core/shared/client';
import { OverviewView } from '@/entrypoints/content/ui/learning/OverviewView';
import { LibraryView } from '@/entrypoints/content/ui/learning/LibraryView';
import { type BundleData } from '@/entrypoints/content/ui/learning/shared';

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
    root.render(node);
  });
  await act(async () => {});
}

describe('Overview「继续你的课程」骨架行对齐（第 254 轮防跳版）', () => {
  it('loading 期骨架 4 行 × 52px（行数对齐 slice(0,4)、行距 ≈ 真实列表行）', async () => {
    await renderNode(createElement(OverviewView, { data: makeData({ loading: true }), todoReloadKey: 0 }));
    const rows = [...document.querySelectorAll<HTMLElement>('.hdu-skeleton')].filter(
      (el) => el.style.height === '52px',
    );
    expect(rows).toHaveLength(4);
  });

  it('数据到达后骨架退场、真实列表行渲染（容器高度衔接，无空窗）', async () => {
    const bundle = {
      course: { teclId: 1, subjName: '高等数学（下）', teacherNames: ['张三'], teclCode: 'T1' },
      sessions: [{ courId: 901, watchState: 'watching' }],
      sessionCount: 5,
      watchedSec: 3600,
      finishedCount: 2,
      transcriptCount: 0,
      topicCount: 0,
    };
    await renderNode(
      createElement(OverviewView, {
        data: makeData({ loading: false, bundles: [bundle] as never[] }),
        todoReloadKey: 0,
      }),
    );
    expect(document.querySelectorAll('.hdu-skeleton').length).toBe(0);
    expect(host.textContent).toContain('高等数学（下）');
  });
});

describe('知识库骨架卡 min-height（第 254 轮防跳版）', () => {
  it('loading 期骨架卡带 min-height 300px（对齐真实网格首屏 ≈2 行卡高）', async () => {
    await renderNode(createElement(LibraryView, { data: makeData({ loading: true }) }));
    const card = [...document.querySelectorAll<HTMLElement>('.hdu-card')].find((el) =>
      el.querySelector('.hdu-skeleton'),
    );
    expect(card).toBeDefined();
    expect(card!.style.minHeight).toBe('300px');
  });

  it('loading=false + 空库：min-height 卡退场，空态恢复（既有行为不变）', async () => {
    await renderNode(createElement(LibraryView, { data: makeData({ loading: false, favorites: [] }) }));
    expect(host.textContent).toContain('知识库还是空的');
    const card = [...document.querySelectorAll<HTMLElement>('.hdu-card')].find(
      (el) => el.style.minHeight === '300px',
    );
    expect(card).toBeUndefined();
  });
});
