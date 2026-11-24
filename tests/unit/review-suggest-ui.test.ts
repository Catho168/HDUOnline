/**
 * 复习完成「下次复习日期」建议 + 待完成渐进显示 渲染测试（jsdom + react-dom 客户端
 * 渲染，无 JSX、直接 createElement，照 review-reschedule-quick-ui.test.ts 桩模式；
 * callOp 整体 mock；ToastHost 一并挂载以观察 toast）。
 *
 * 覆盖第 245 轮新增的行为约定：
 *  1. 行内「完成」→ review.complete(done) → toast 升级「已完成 · 建议 M月D日 再看」
 *     （建议日期来自 suggestNextReviewDate：regular 模板 round 1 上一段间隔 1 天
 *     → 倍增序列推进到 3 天 = 完成日 + 3）+「排到 M月D日」action 按钮；
 *  2. 点「排到 M月D日」→ review.reopen（复活 done 作业）+ review.reschedule
 *     （dueDate = 建议日）→ 重拉 review.list；纯提示不自动写数据（不点不写）；
 *  3. 待完成列表渐进显示：61 条作业只渲染前 60 条 +「显示更多（还有 1 条）」，
 *     点按钮追加 60 条后全量可见、按钮消失（visibleRowsOf 共享切分）。
 */

// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({ callOp: vi.fn() }));

import { callOp } from '@/core/shared/client';
import { ToastHost } from '@/entrypoints/content/ui/components';
import { ReviewView } from '@/entrypoints/content/ui/learning/ReviewView';
import { addDaysKey, localDayKey } from '@/core/shared/utils';
import type { FavoriteEntity, ReviewJobEntity } from '@/core/shared/types';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;

const TODAY = localDayKey();

function makeFavorite(id: string, title: string): FavoriteEntity {
  return {
    id,
    type: 'video',
    refId: undefined,
    snapshot: { title, content: '' },
    folderId: null,
    tags: [],
    pinned: false,
    favoritedAt: 1000,
    updatedAt: 1000,
    metadata: undefined,
  };
}

function makeJob(id: string, dueDate: string, title: string, round = 1): ReviewJobEntity & { favorite: FavoriteEntity | null } {
  return {
    id,
    favoriteId: `fav-${id}`,
    dueDate,
    round,
    template: 'regular',
    status: 'pending',
    createdAt: 1000,
    updatedAt: 1000,
    favorite: makeFavorite(`fav-${id}`, title),
  };
}

let calls: Array<{ op: string; args: unknown }> = [];

function stubOps(table: Record<string, unknown> = {}): void {
  calls = [];
  const defaults: Record<string, unknown> = {
    'review.list': [],
    'course.bundles': [],
    'stats.report': { totalSec: 0, externalSeconds: 0, streakDays: 0 },
    'fav.list': [],
    'note.listAll': [],
    'review.complete': null,
    'review.reopen': null,
    'review.reschedule': null,
    ...table,
  };
  callOpMock.mockImplementation(async (op: string, args?: unknown) => {
    calls.push({ op, args });
    if (!(op in defaults)) throw new Error(`unexpected op: ${op}`);
    return defaults[op];
  });
}

let host: HTMLElement;
let root: Root;

/** 卸载旧实例后全新挂载：ReviewView + ToastHost 同树（pushToast 通道在 ToastHost 内展示） */
async function renderView(): Promise<void> {
  if (root) {
    await act(async () => {
      root.unmount();
    });
  }
  root = createRoot(host);
  await act(async () => {
    root.render(createElement('div', null, createElement(ReviewView), createElement(ToastHost)));
  });
  await act(async () => {});
}

async function clickAsync(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await act(async () => {});
}

function queryAll(selector: string): Element[] {
  return Array.from(document.querySelectorAll(selector));
}

/** 最新一条 toast（pushToast 追加在栈尾；断言一律看最新一条，避免读到旧条目） */
function lastToast(): string {
  return queryAll('.hdu-toast').at(-1)?.textContent ?? '';
}

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  stubOps();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('复习完成「下次复习日期」建议（第 245 轮）', () => {
  it('行内「完成」→ toast 升级「已完成 · 建议 M月D日 再看」+「排到」action；不点不写数据', async () => {
    stubOps({ 'review.list': [makeJob('job-1', TODAY, '线性代数 第 1 讲')] });
    await renderView();
    const row = queryAll('.hdu-todo-rows .hdu-todo-row')[0]!;
    const doneBtn = [...row.querySelectorAll('button')].find((b) => b.textContent === '完成') as HTMLButtonElement;
    await clickAsync(doneBtn);
    // review.complete 已发；建议日期 = 完成日 + 3（round 1 · regular [1,3,7,16] → 上一段 1 天 → 倍增至 3）
    expect(calls.some((c) => c.op === 'review.complete' && (c.args as { status?: string }).status === 'done')).toBe(true);
    const expectedLabel = `${Number(addDaysKey(TODAY, 3)!.slice(5, 7))}月${Number(addDaysKey(TODAY, 3)!.slice(8, 10))}日`;
    expect(lastToast()).toContain(`已完成 · 建议 ${expectedLabel} 再看`);
    // 纯提示不自动写数据：无 reopen / reschedule
    expect(calls.some((c) => c.op === 'review.reopen')).toBe(false);
    expect(calls.some((c) => c.op === 'review.reschedule')).toBe(false);
    // toast 内「排到 M月D日」轻按钮存在
    const toastAction = [...queryAll('.hdu-toast').at(-1)!.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('排到'),
    );
    expect(toastAction).toBeTruthy();
    expect(toastAction!.textContent).toContain(`排到 ${expectedLabel}`);
  });

  it('点「排到 M月D日」→ review.reopen + review.reschedule(dueDate=建议日) → 重拉 review.list', async () => {
    stubOps({ 'review.list': [makeJob('job-1', TODAY, '线性代数 第 1 讲')] });
    await renderView();
    const row = queryAll('.hdu-todo-rows .hdu-todo-row')[0]!;
    const doneBtn = [...row.querySelectorAll('button')].find((b) => b.textContent === '完成') as HTMLButtonElement;
    await clickAsync(doneBtn);
    const toastAction = [...queryAll('.hdu-toast').at(-1)!.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('排到'),
    ) as HTMLButtonElement;
    await clickAsync(toastAction);
    expect(calls.some((c) => c.op === 'review.reopen' && (c.args as { jobId?: string }).jobId === 'job-1')).toBe(true);
    const resched = calls.find((c) => c.op === 'review.reschedule');
    expect(resched).toBeTruthy();
    expect((resched!.args as { jobId: string; dueDate: string }).jobId).toBe('job-1');
    expect((resched!.args as { jobId: string; dueDate: string }).dueDate).toBe(addDaysKey(TODAY, 3));
    // 排期成功后重拉列表
    expect(calls.filter((c) => c.op === 'review.list').length).toBeGreaterThanOrEqual(2);
  });

  it('跳过维持普通文案（无建议日期）', async () => {
    stubOps({ 'review.list': [makeJob('job-1', TODAY, '线性代数 第 1 讲')] });
    await renderView();
    const row = queryAll('.hdu-todo-rows .hdu-todo-row')[0]!;
    const skipBtn = [...row.querySelectorAll('button')].find((b) => b.textContent === '跳过') as HTMLButtonElement;
    await clickAsync(skipBtn);
    expect(lastToast()).toContain('已跳过本次复习');
    expect(lastToast()).not.toContain('建议');
  });
});

describe('待完成列表渐进显示（第 245 轮）', () => {
  it('61 条只渲染前 60 条 +「显示更多（还有 1 条）」，点击追加后全量可见', async () => {
    const jobs = Array.from({ length: 61 }, (_, i) =>
      makeJob(`job-${i}`, addDaysKey(TODAY, i) ?? TODAY, `作业 ${i}`),
    );
    stubOps({ 'review.list': jobs });
    await renderView();
    expect(queryAll('.hdu-todo-rows .hdu-todo-row')).toHaveLength(60);
    const moreBtn = queryAll('button').find((b) => b.textContent === '显示更多（还有 1 条）') as HTMLButtonElement;
    expect(moreBtn).toBeTruthy();
    await clickAsync(moreBtn);
    expect(queryAll('.hdu-todo-rows .hdu-todo-row')).toHaveLength(61);
    // 全量可见后「显示更多」消失
    expect(queryAll('button').some((b) => b.textContent === '显示更多（还有 0 条）')).toBe(false);
    expect(queryAll('button').some((b) => b.textContent?.startsWith('显示更多'))).toBe(false);
  });

  it('60 条及以下不出现「显示更多」（恰好 60 = 无剩余）', async () => {
    const jobs = Array.from({ length: 60 }, (_, i) => makeJob(`job-${i}`, TODAY, `作业 ${i}`));
    stubOps({ 'review.list': jobs });
    await renderView();
    expect(queryAll('.hdu-todo-rows .hdu-todo-row')).toHaveLength(60);
    expect(queryAll('button').some((b) => b.textContent?.startsWith('显示更多'))).toBe(false);
  });
});
