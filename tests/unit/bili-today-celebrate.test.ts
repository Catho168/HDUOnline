/**
 * B 站今日待办「全完成庆祝态」渲染测试（jsdom + react-dom 客户端渲染，无 JSX、
 * 直接 createElement，照 bili-hub-today-card.test.ts 模式；callOp 整体 mock）。
 *
 * 覆盖第 234 轮新增的行为约定（对齐 HDU 今日待办卡第 233 轮庆祝条）：
 *  1. 待办全部勾完（doneCount === totalCount > 0）时渲染 .hdu-celebrate 庆祝条
 *     （role=status）：标题「今日待办全部完成」+ 明日到期预告（明日有到期 →
 *     「明日还有 N 项到期，保持节奏」）；
 *  2. 明日无到期时提示切换为「明日暂无到期作业，可自由安排」；
 *  3. 取消任一勾选后庆祝条消失；
 *  4. 空态（totalCount = 0）与加载中不触发庆祝条。
 */
// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({ callOp: vi.fn() }));

import { callOp } from '@/core/shared/client';
import { BiliHubTodayCard } from '@/entrypoints/content/ui/BiliHubTodayCard';
import { localDayKey } from '@/core/shared/utils';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;

const BVID = 'BV1CelebTest1';

/** 一个未完看的 B 站视频收藏（进待学视频分区；键 = video:<bvid>） */
function makeVideoFavorite(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'fav-1',
    type: 'video',
    refId: BVID,
    snapshot: { title: '线性代数公开课：矩阵乘法', content: '' },
    folderId: null,
    tags: [],
    pinned: false,
    favoritedAt: 0,
    updatedAt: 0,
    metadata: { platform: 'bilibili', bvid: BVID, url: `https://www.bilibili.com/video/${BVID}`, uploader: 'UP 主' },
    ...overrides,
  };
}

/** 明日到期的复习作业（只喂给带 date 参数的 review.due 调用 → tomorrowCount 口径） */
const TOMORROW_JOBS = [1, 2].map((n) => ({
  id: `job-tomorrow-${n}`,
  favoriteId: `fav-t${n}`,
  dueDate: localDayKey(Date.now() + 86_400_000),
  round: 1,
  template: 'regular',
  status: 'pending',
  createdAt: 0,
  updatedAt: 0,
  favorite: null,
}));

/** B 站今日卡五路信号的默认桩；overrides 按 op 覆盖（review.due 按 date 参数分流） */
function stubOps(overrides: Record<string, unknown> = {}): void {
  const base: Record<string, unknown> = {
    'fav.list': [makeVideoFavorite()],
    'plan.weekly.get': { plans: [] },
    'todo.today.get': [],
    'todo.today.set': undefined,
    ...overrides,
  };
  callOpMock.mockImplementation(async (op: string, args?: { date?: string }) => {
    if (op === 'review.due') {
      // 带 date 的调用 = 明日到期预告；无 date = 今日到期（默认无）
      const tomorrowTable = overrides['review.due.tomorrow'];
      const todayTable = overrides['review.due'];
      if (args?.date) return tomorrowTable ?? [];
      return todayTable ?? [];
    }
    if (op in base) return base[op];
    throw new Error(`unexpected op: ${op}`);
  });
}

let host: HTMLElement;
let root: Root;

async function renderCard(): Promise<void> {
  await act(async () => {
    root.render(createElement(BiliHubTodayCard));
  });
  await act(async () => {});
}

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = '';
});

describe('B 站今日卡全完成庆祝态（第 234 轮巡检）', () => {
  it('待办全部勾完时渲染庆祝条，明日有到期时预告「明日还有 N 项到期」', async () => {
    stubOps({
      // 唯一待办已勾完：1/1 → allDone
      'todo.today.get': [`video:${BVID}`],
      // 明日到期 2 条（走带 date 的 review.due 调用）
      'review.due.tomorrow': TOMORROW_JOBS,
    });
    await renderCard();

    const bar = host.querySelector('.hdu-celebrate');
    expect(bar).not.toBeNull();
    expect(bar?.getAttribute('role')).toBe('status');
    expect(bar?.textContent).toContain('今日待办全部完成');
    expect(bar?.textContent).toContain('明日还有 2 项到期，保持节奏');
    // 进度徽标同为 jade 完成态；待办主体照常渲染
    expect(host.textContent).toContain('1 / 1 已完成');
    expect(host.querySelector('.hdu-todo-row')).not.toBeNull();
  });

  it('明日无到期时提示「明日暂无到期作业，可自由安排」', async () => {
    stubOps({ 'todo.today.get': [`video:${BVID}`] });
    await renderCard();
    expect(host.querySelector('.hdu-celebrate')?.textContent).toContain('明日暂无到期作业，可自由安排');
  });

  it('取消勾选后庆祝条消失（1/1 → 0/1）', async () => {
    stubOps({ 'todo.today.get': [`video:${BVID}`] });
    await renderCard();
    expect(host.querySelector('.hdu-celebrate')).not.toBeNull();

    const check = host.querySelector<HTMLInputElement>('.hdu-todo-check');
    expect(check?.checked).toBe(true);
    await act(async () => {
      check?.click();
    });
    await act(async () => {});

    expect(host.querySelector('.hdu-celebrate')).toBeNull();
    expect(host.textContent).toContain('0 / 1 已完成');
  });

  it('空态（totalCount = 0）不触发庆祝条', async () => {
    stubOps({ 'fav.list': [] });
    await renderCard();
    expect(host.querySelector('.hdu-celebrate')).toBeNull();
    // 复习分区空态文案照常
    expect(host.textContent).toContain('今日无到期复习');
  });
});
