/**
 * 复习作业「顺延到指定日」行内浮层渲染测试（jsdom + react-dom 客户端渲染，无 JSX、
 * 直接 createElement，照 review-forecast-ui.test.ts 桩模式；callOp 整体 mock）。
 *
 * 覆盖第 244 轮新增的行为约定：
 *  1. 列表行「改期」按钮先展开行内轻量浮层（.hdu-resched-pop）：标题「顺延到指定日」
 *     + 快捷 chips 网格（buildRescheduleOptions 8 档：明天/后天/周X…/下周同一日/
 *     下月同一日）+「其他日期…」+ 钳制口径提示；aria-expanded 联动；
 *  2. 点「明天」chip → 直接 review.reschedule（dueDate = 明日日键）+ 收起浮层 +
 *     重拉 review.list（少一步弹层确认）；
 *  3. 周视图行的「改期」仍直达完整改期弹层（Modal，含同款 chips 网格与日期输入），
 *     点弹层内「下周同一日」chip 设值后「确认改期」→ review.reschedule 同口径。
 */

// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({ callOp: vi.fn() }));

import { callOp } from '@/core/shared/client';
import { ReviewView } from '@/entrypoints/content/ui/learning/ReviewView';
import { addDaysKey, localDayKey } from '@/core/shared/utils';
import type { FavoriteEntity, ReviewJobEntity } from '@/core/shared/types';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;

const TODAY = localDayKey();
const TOMORROW = addDaysKey(TODAY, 1)!;

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

function makeJob(id: string, dueDate: string, title: string): ReviewJobEntity & { favorite: FavoriteEntity | null } {
  return {
    id,
    favoriteId: `fav-${id}`,
    dueDate,
    round: 1,
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

/** 卸载旧实例后全新挂载：ReviewView 的 load 只在挂载时跑，重挂才吃到新 stub */
async function renderView(): Promise<void> {
  if (root) {
    await act(async () => {
      root.unmount();
    });
  }
  root = createRoot(host);
  await act(async () => {
    root.render(createElement(ReviewView));
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
});

describe('ReviewView 顺延到指定日（第 244 轮）', () => {
  it('列表行「改期」展开行内浮层：8 档快捷 chips + 其他日期… + 钳制口径提示；aria-expanded 联动', async () => {
    stubOps({ 'review.list': [makeJob('job-1', TODAY, '线性代数 第 1 讲')] });
    await renderView();
    const rows = queryAll('.hdu-todo-rows .hdu-todo-row');
    expect(rows.length).toBe(1);
    const reschedBtn = [...rows[0]!.querySelectorAll('button')].find((b) => b.textContent === '改期') as HTMLButtonElement;
    expect(reschedBtn.getAttribute('aria-expanded')).toBe('false');
    await clickAsync(reschedBtn);
    const pop = document.querySelector('.hdu-resched-pop');
    expect(pop).not.toBeNull();
    expect(reschedBtn.getAttribute('aria-expanded')).toBe('true');
    expect(pop!.textContent).toContain('顺延到指定日');
    const chips = [...pop!.querySelectorAll('.hdu-resched-chip')];
    expect(chips.length).toBe(8);
    expect(chips[0]!.textContent).toContain('明天');
    expect(chips[1]!.textContent).toContain('后天');
    expect(chips[6]!.textContent).toContain('下周同一日');
    expect(chips[7]!.textContent).toContain('下月同一日');
    expect(chips[0]!.textContent).toContain('周'); // 副行 M月D日 周X
    expect(pop!.textContent).toContain('其他日期…');
    expect(pop!.textContent).toContain('不早于今日');
    // 再点一次「改期」= 收起（toggle）
    await clickAsync(reschedBtn);
    expect(document.querySelector('.hdu-resched-pop')).toBeNull();
  });

  it('点「明天」chip → 直接 review.reschedule 到明日日键 + 收起浮层 + 重拉 review.list', async () => {
    stubOps({ 'review.list': [makeJob('job-1', TODAY, '线性代数 第 1 讲')] });
    await renderView();
    const row = queryAll('.hdu-todo-rows .hdu-todo-row')[0]!;
    const reschedBtn = [...row.querySelectorAll('button')].find((b) => b.textContent === '改期') as HTMLButtonElement;
    await clickAsync(reschedBtn);
    const chip = document.querySelector('.hdu-resched-pop .hdu-resched-chip') as HTMLButtonElement;
    expect(chip.textContent).toContain('明天');
    await clickAsync(chip);
    const resched = calls.find((c) => c.op === 'review.reschedule');
    expect(resched).toBeDefined();
    expect(resched!.args).toEqual({ jobId: 'job-1', dueDate: TOMORROW });
    // 成功后浮层收起并重拉列表（初始 load + reschedule 后 load ≥ 2 次）
    expect(document.querySelector('.hdu-resched-pop')).toBeNull();
    expect(calls.filter((c) => c.op === 'review.list').length).toBeGreaterThanOrEqual(2);
  });

  it('周视图行「改期」仍直达完整改期弹层；弹层内点「下周同一日」设值确认后同口径提交', async () => {
    stubOps({ 'review.list': [makeJob('job-1', TODAY, '线性代数 第 1 讲')] });
    await renderView();
    // 切周视图（hdu-folder 组：列表 / 周视图 / 月视图）
    const weekBtn = queryAll('.hdu-folder').find((b) => b.textContent === '周视图') as HTMLButtonElement;
    await clickAsync(weekBtn);
    const weekJob = queryAll('.hdu-week-job')[0]!;
    const reschedBtn = [...weekJob.querySelectorAll('button')].find((b) => b.textContent === '改期') as HTMLButtonElement;
    await clickAsync(reschedBtn);
    // 完整改期弹层（Modal）出现，含同款 chips 网格 + 日期输入 + 口径提示
    const modal = document.querySelector('.hdu-modal');
    expect(modal).not.toBeNull();
    expect(modal!.textContent).toContain('当前到期');
    expect(modal!.textContent).toContain('选今天等于保持不变');
    const chips = [...modal!.querySelectorAll('.hdu-resched-chip')];
    expect(chips.length).toBe(8);
    const nextWeekChip = chips[6] as HTMLButtonElement;
    expect(nextWeekChip.textContent).toContain('下周同一日');
    await clickAsync(nextWeekChip);
    const confirmBtn = [...modal!.querySelectorAll('button')].find((b) => b.textContent === '确认改期') as HTMLButtonElement;
    await clickAsync(confirmBtn);
    const resched = calls.find((c) => c.op === 'review.reschedule');
    expect(resched).toBeDefined();
    expect(resched!.args).toEqual({ jobId: 'job-1', dueDate: addDaysKey(TODAY, 7) });
  });
});
