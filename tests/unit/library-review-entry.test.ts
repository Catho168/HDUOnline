/**
 * 学习中心知识库卡片「加入复习」入口（第 28 轮任务 B-2）冒烟测试。
 *
 * 背景：Dashboard 知识库的 VideoFavCard 一直传 onReview → review.plan，学习中心
 * LibraryView 的同一卡片此前未接该槽位。本文件验证接线后的行为：
 *  1. HDU 收藏（type='time'，带 courId）与 B 站视频收藏（type='video'）都渲染
 *     「加入复习」按钮（repo planReview 不校验 courId，两类收藏均可入计划）；
 *  2. 点击 → callOp('review.plan', { favoriteId }) 参数正确 + pushToast 成功文案
 *     「已加入复习计划」（与 Dashboard 侧 notify 文案一致）；
 *  3. review.plan 失败 → error toast「加入复习失败」，不出成功文案；
 *  4. 槽位一致性：按钮落在 VideoFavCard 的底部动作组（.hdu-knowledge-foot）内，
 *     与 Dashboard 形态同组件同槽位。
 *
 * jsdom + react-dom 客户端渲染，无 JSX、直接 createElement（照 plan-menu.test.ts 模式）；
 * LearningCenter 整体 mock callOp（op → 返回值查表桩），ToastHost 一并挂载以观察 toast。
 */
// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({
  callOp: vi.fn(),
  onBackgroundEvent: vi.fn(() => () => undefined),
}));

import { callOp } from '@/core/shared/client';
import { LearningCenter } from '@/entrypoints/content/ui/LearningCenter';
import { ToastHost } from '@/entrypoints/content/ui/components';
import { uiStore } from '@/entrypoints/content/ui/store';
import type { FavoriteEntity } from '@/core/shared/types';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;

/** 记录 callOp 的调用序列（断言「发起过哪些 op / 带什么参数」） */
let calls: Array<{ op: string; args: unknown }> = [];

/** HDU 课内收藏：时间点收藏（带 courId/teclId，无外链 url） */
const HDU_FAV = {
  id: 'fav-hdu',
  type: 'time',
  refId: null,
  courId: 123,
  teclId: 456,
  anchorTime: 60,
  snapshot: { title: '高等数学 1.1 极限', content: 'ε-δ 定义' },
  folderId: null,
  tags: ['高数'],
  pinned: false,
  favoritedAt: 0,
  updatedAt: 0,
  metadata: {},
} as unknown as FavoriteEntity;

/** B 站视频收藏（type='video'，refId=bvid，metadata.url 外链） */
const BILI_FAV = {
  id: 'fav-bili',
  type: 'video',
  refId: 'BV1Review01',
  snapshot: { title: '线性代数 第 1 讲', content: '向量空间' },
  folderId: null,
  tags: [],
  pinned: false,
  favoritedAt: 0,
  updatedAt: 0,
  metadata: { url: 'https://www.bilibili.com/video/BV1Review01', uploader: '网课 UP 主' },
} as unknown as FavoriteEntity;

/** 学习中心挂载期 op 桩（useCenterData 七路 + LibraryView 字幕键 + review.plan）；overrides 按 op 覆盖 */
function stubOps(overrides: Record<string, unknown> = {}): void {
  calls = [];
  const table: Record<string, unknown> = {
    'course.bundles': [],
    'stats.report': null,
    'schedule.missed': [],
    'fav.list': [HDU_FAV, BILI_FAV],
    'folder.list': [],
    'note.list': [],
    'schedule.list': [],
    'transcript.keys': [],
    'review.plan': [],
    ...overrides,
  };
  callOpMock.mockImplementation(async (op: string, args?: unknown) => {
    calls.push({ op, args });
    if (!(op in table)) throw new Error(`unexpected op: ${op}`);
    const value = table[op];
    return typeof value === 'function' ? value(args) : value;
  });
}

let host: HTMLElement;
let root: Root;

async function renderElement(el: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => {
    root.render(el);
  });
  // 让挂载触发的多级异步链（useCenterData 的 Promise.all / transcript.keys）完全落定
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {});
  }
}

async function clickAsync(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await act(async () => {});
}

/** 第 index 张收藏卡里的「加入复习」按钮（IconButton aria-label 寻址，同 video-fav-card.test.ts） */
function reviewButton(index: number): HTMLButtonElement {
  const cards = Array.from(host.querySelectorAll('.hdu-knowledge-card'));
  const btn = cards[index]?.querySelector<HTMLButtonElement>('button[aria-label="加入复习"]');
  if (!btn) throw new Error(`review button not found on card #${index}`);
  return btn;
}

function planCalls(): Array<{ args: unknown }> {
  return calls.filter((c) => c.op === 'review.plan');
}

/** 最后一条 toast 的文本（pushToast 的列表是模块级状态、跨用例共享且 TTL=3.6s，
 *  断言须收敛到最后一条，避免前面用例的成功 toast 泄漏进本用例的 not.toContain） */
function lastToastText(): string {
  const toasts = host.querySelectorAll('.hdu-toast');
  const last = toasts[toasts.length - 1];
  if (!last) throw new Error('no toast rendered');
  return last.textContent ?? '';
}

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  // 知识库视图：LibraryView 挂载（默认 overview，不 patch 则卡片不在文档流）
  uiStore.patch({ centerView: 'library' });
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  uiStore.patch({ centerView: 'overview' });
});

describe('学习中心知识库卡片「加入复习」入口（第 28 轮）', () => {
  it('HDU 收藏点击加入复习：review.plan 带 favoriteId 调用，toast 成功文案与 Dashboard 一致', async () => {
    stubOps();
    await renderElement(createElement('div', null, createElement(LearningCenter), createElement(ToastHost)));

    await clickAsync(reviewButton(0));
    expect(planCalls()).toHaveLength(1);
    expect(planCalls()[0]?.args).toEqual({ favoriteId: 'fav-hdu' });
    expect(host.textContent).toContain('已加入复习计划');
  });

  it('B 站视频收藏同样可加入复习（planReview 不校验 courId）', async () => {
    stubOps();
    await renderElement(createElement('div', null, createElement(LearningCenter), createElement(ToastHost)));

    await clickAsync(reviewButton(1));
    expect(planCalls()).toHaveLength(1);
    expect(planCalls()[0]?.args).toEqual({ favoriteId: 'fav-bili' });
    expect(host.textContent).toContain('已加入复习计划');
  });

  it('review.plan 失败：error toast「加入复习失败」（非 Error 异常走兜底文案），不出成功文案', async () => {
    // 以非 Error 值拒绝：errorTextOf 回退到语境化兜底文案「加入复习失败」
    stubOps({ 'review.plan': () => Promise.reject('boom') });
    await renderElement(createElement('div', null, createElement(LearningCenter), createElement(ToastHost)));

    await clickAsync(reviewButton(0));
    expect(planCalls()).toHaveLength(1);
    expect(lastToastText()).toBe('加入复习失败');
  });

  it('槽位一致性：按钮位于 VideoFavCard 底部动作组（.hdu-knowledge-foot），与 Dashboard 形态同槽位', async () => {
    stubOps();
    await renderElement(createElement('div', null, createElement(LearningCenter), createElement(ToastHost)));

    for (const card of Array.from(host.querySelectorAll('.hdu-knowledge-card'))) {
      const btn = card.querySelector('button[aria-label="加入复习"]');
      expect(btn, '每张收藏卡都应有加入复习入口').toBeTruthy();
      expect(btn!.closest('.hdu-knowledge-foot'), '按钮应在底部动作组内').toBeTruthy();
    }
  });
});
