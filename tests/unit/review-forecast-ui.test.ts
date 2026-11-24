/**
 * 复习 7 日到期预测小柱图渲染测试（jsdom + react-dom 客户端渲染，无 JSX、直接
 * createElement，照 review-month-cell-ui.test.ts 桩模式；callOp 整体 mock）。
 *
 * 覆盖第 241 轮新增的行为约定：
 *  1. 列表视图（默认）在待完成作业 >0 时渲染 .hdu-review-forecast 柱组：
 *     有逾期时含逾期列（共 9 根），无逾期 8 根；逾期柱 .is-overdue、今日柱 .is-today；
 *  2. 最高柱 .is-peak（今日柱 3 项为峰）；hover/aria-label = forecastBarTitle
 *     「N 月 N 日 · M 项」；
 *  3. 点日柱 → 复用按日过滤：清除日期过滤 chip 出现（「查看 N月N日 到期（M 项）」）；
 *     点逾期柱 → chip「查看 逾期到期 到期（M 项）」；
 *  4. 「以后」柱恒禁用（跨多日无单一筛选键）；
 *  5. 全 0（如脏 dueDate 全部跳过）→ 轻量空态「未来 7 天暂无到期作业」而非空图；
 *  6. 月视图不渲染预测图（与周历条同条件）。
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
const FAR_FUTURE = addDaysKey(TODAY, 30)!;
const PAST = '2020-01-01';

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

describe('ReviewView 7 日到期预测小柱图（第 241 轮）', () => {
  it('列表视图渲染预测柱组：有逾期 9 根（逾期列 is-overdue + 今日列 is-today），无逾期 8 根', async () => {
    stubOps({
      'review.list': [makeJob('job-a', PAST, '逾期作业'), makeJob('job-b', TODAY, '今日作业')],
    });
    await renderView();
    const cols = queryAll('.hdu-forecast-col');
    expect(cols).toHaveLength(9); // 逾期 + 7 天 + 以后
    expect(cols[0]!.classList.contains('is-overdue')).toBe(true);
    expect(cols[0]!.getAttribute('aria-label')).toBe('逾期 · 1 项');
    const todayCol = cols.find((c) => c.classList.contains('is-today'));
    expect(todayCol).toBeDefined();
    expect(todayCol!.getAttribute('aria-label')).toBe(
      `${Number(TODAY.slice(5, 7))} 月 ${Number(TODAY.slice(8))} 日 · 1 项`,
    );
    // 无逾期场景：8 根，首列今日
    stubOps({ 'review.list': [makeJob('job-b', TODAY, '今日作业')] });
    await renderView();
    expect(queryAll('.hdu-forecast-col')).toHaveLength(8);
    expect(queryAll('.hdu-forecast-col')[0]!.classList.contains('is-today')).toBe(true);
  });

  it('最高柱 is-peak（今日 3 项）；点日柱复用按日过滤出 chip', async () => {
    stubOps({
      'review.list': [
        makeJob('job-1', TODAY, '今日一'),
        makeJob('job-2', TODAY, '今日二'),
        makeJob('job-3', TODAY, '今日三'),
        makeJob('job-4', TOMORROW, '明日一'),
      ],
    });
    await renderView();
    const todayCol = queryAll('.hdu-forecast-col').find((c) => c.classList.contains('is-today'))!;
    expect(todayCol.classList.contains('is-peak')).toBe(true);
    expect(queryAll('.hdu-forecast-col.is-peak')).toHaveLength(1);
    await clickAsync(todayCol);
    const chip = document.querySelector('.hdu-day-filter-chip');
    expect(chip?.textContent).toContain(`查看 ${Number(TODAY.slice(5, 7))}月${Number(TODAY.slice(8))}日 到期（3 项）`);
    // 列表只剩今日 3 行
    expect(queryAll('.hdu-todo-row')).toHaveLength(3);
  });

  it('点逾期柱 → 逾期过滤 chip；「以后」柱恒禁用', async () => {
    stubOps({
      'review.list': [
        makeJob('job-a', PAST, '逾期作业'),
        makeJob('job-b', TODAY, '今日作业'),
        makeJob('job-c', FAR_FUTURE, '远期作业'),
      ],
    });
    await renderView();
    const cols = queryAll('.hdu-forecast-col');
    const overdueCol = cols.find((c) => c.classList.contains('is-overdue')) as HTMLButtonElement | undefined;
    expect(overdueCol).toBeDefined();
    expect(overdueCol!.disabled).toBe(false);
    await clickAsync(overdueCol!);
    const chip = document.querySelector('.hdu-day-filter-chip');
    expect(chip?.textContent).toContain('查看 逾期到期 到期（1 项）');
    // 「以后」列恒禁用（跨多日无单一筛选键，仅展示）
    const laterCol = queryAll('.hdu-forecast-col').find((c) => c.getAttribute('aria-label') === '以后 · 1 项') as HTMLButtonElement | undefined;
    expect(laterCol).toBeDefined();
    expect(laterCol!.disabled).toBe(true);
  });

  it('全 0（脏 dueDate 全跳过）→ 轻量空态而非空图', async () => {
    stubOps({ 'review.list': [makeJob('job-x', '2026/01/01', '脏日期作业')] });
    await renderView();
    expect(document.querySelector('.hdu-forecast-empty')?.textContent).toContain('未来 7 天暂无到期作业');
    expect(queryAll('.hdu-forecast-col')).toHaveLength(0);
  });

  it('月视图不渲染预测图（与周历条同条件）', async () => {
    stubOps({ 'review.list': [makeJob('job-a', TODAY, '今日作业')] });
    await renderView();
    expect(queryAll('.hdu-review-forecast')).toHaveLength(1);
    // 切月视图
    const monthBtn = queryAll('button').find((b) => b.textContent === '月视图');
    await clickAsync(monthBtn!);
    expect(queryAll('.hdu-review-forecast')).toHaveLength(0);
    expect(document.querySelector('.hdu-forecast-empty')).toBeNull();
  });
});
