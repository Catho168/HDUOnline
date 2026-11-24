/**
 * 今日待办「全完成庆祝态」渲染测试（jsdom + react-dom 客户端渲染，无 JSX、直接 createElement，
 * 照 plan-menu.test.ts 模式；callOp 整体 mock，op → 返回值用查表桩）。
 *
 * 覆盖第 233 轮新增的行为约定：
 *  1. 今日待办全部勾完（doneCount === totalCount > 0）时，SectionHead 之下渲染
 *     .hdu-celebrate 庆祝条（role=status）：标题「今日待办全部完成」+ 明日到期预告
 *     （明日有到期 → 「明日还有 N 项到期，保持节奏」）；
 *  2. 明日无到期时提示语切换为「明日暂无到期作业，可自由安排」；取消任一勾选后庆祝条消失。
 */
// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({ callOp: vi.fn() }));

import { callOp } from '@/core/shared/client';
import { TodayTodoCard } from '@/entrypoints/content/ui/learning/TodayTodoCard';
import { localDayKey } from '@/core/shared/utils';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;

/** 四个未看完的视频收藏（watchedRatio=0 保证进入待学分区；键 = video:<bvid>） */
const VIDEO_FAVS = ['BV1A', 'BV2B', 'BV3C', 'BV4D'].map((bvid, i) => ({
  id: `fav-${i}`,
  type: 'video',
  refId: bvid,
  snapshot: { title: `视频 ${i}`, content: '' },
  folderId: null,
  tags: [],
  pinned: false,
  favoritedAt: 0,
  updatedAt: 0,
  metadata: { platform: 'bilibili', bvid, url: `https://www.bilibili.com/video/${bvid}`, uploader: 'UP 主' },
}));

/** 今日到期的两条复习作业（dueDate=今天 → 进今日待办且不算逾期；键 = review:<id>） */
const REVIEW_JOBS = [1, 2].map((n) => ({
  id: `job-${n}`,
  favoriteId: `fav-r${n}`,
  dueDate: localDayKey(),
  round: 1,
  template: 'regular',
  status: 'pending',
  createdAt: 0,
  updatedAt: 0,
  favorite: {
    id: `fav-r${n}`,
    type: 'video',
    refId: `BV9${n}X`,
    snapshot: { title: `复习条目${n}`, content: '' },
    folderId: null,
    tags: [],
    pinned: false,
    favoritedAt: 0,
    updatedAt: 0,
    metadata: { platform: 'bilibili', bvid: `BV9${n}X`, url: `https://www.bilibili.com/video/BV9${n}X` },
  },
}));

/** 全部条目的 todoKey（review 两条 + video 四条） */
const ALL_KEYS = ['review:job-1', 'review:job-2', ...VIDEO_FAVS.map((fav) => `video:${fav.metadata.bvid}`)];

/** 今日待办五路信号 + 勾选持久化的默认桩；overrides 按 op 覆盖 */
function stubOps(overrides: Record<string, unknown> = {}): void {
  const table: Record<string, unknown> = {
    'todo.today.get': [],
    'todo.today.set': [],
    'review.due': [],
    'schedule.missed': [],
    'fav.list': VIDEO_FAVS,
    'plan.weekly.get': { plans: [] },
    ...overrides,
  };
  callOpMock.mockImplementation(async (op: string) => {
    if (op in table) return table[op];
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

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
});

describe('今日待办全完成庆祝态（第 233 轮巡检）', () => {
  it('全部勾完时渲染庆祝条，明日有到期时预告「明日还有 N 项到期」', async () => {
    stubOps({
      // 6/6 全部勾完；review.due 同桩返回两条 → 今日 2 条复习 + 明日到期 2 条
      'todo.today.get': ALL_KEYS,
      'review.due': REVIEW_JOBS,
    });
    await renderElement(createElement(TodayTodoCard, { reloadKey: 0 }));

    const bar = host.querySelector('.hdu-celebrate');
    expect(bar).not.toBeNull();
    expect(bar?.getAttribute('role')).toBe('status');
    expect(bar?.textContent).toContain('今日待办全部完成');
    expect(bar?.textContent).toContain('明日还有 2 项到期，保持节奏');
    // 庆祝条位于进度 Chip（SectionHead actions）之后、待办主体之前
    expect(host.textContent).toContain('6 / 6 已完成');
    expect(host.querySelector('.hdu-today-body')).not.toBeNull();
  });

  it('明日无到期时提示「明日暂无到期作业」；取消一个勾选后庆祝条消失', async () => {
    stubOps({
      'todo.today.get': ['video:BV1A', 'video:BV2B', 'video:BV3C', 'video:BV4D'],
    });
    await renderElement(createElement(TodayTodoCard, { reloadKey: 0 }));

    expect(host.querySelector('.hdu-celebrate')?.textContent).toContain('明日暂无到期作业，可自由安排');

    // 取消第一个勾选 → 4/4 → 3/4，allDone 不再成立，庆祝条随之消失
    const firstCheck = host.querySelector<HTMLInputElement>('.hdu-todo-check');
    expect(firstCheck?.checked).toBe(true);
    await act(async () => {
      firstCheck?.click();
    });
    await act(async () => {});

    expect(host.querySelector('.hdu-celebrate')).toBeNull();
    expect(host.textContent).toContain('3 / 4 已完成');
    // 勾选状态持久化照常发起
    expect(callOpMock).toHaveBeenCalledWith('todo.today.set', {
      date: localDayKey(),
      keys: ['video:BV2B', 'video:BV3C', 'video:BV4D'],
    });
  });
});
