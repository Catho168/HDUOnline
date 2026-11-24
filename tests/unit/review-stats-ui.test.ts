/**
 * 复习统计摘要行渲染测试（jsdom + react-dom 客户端渲染，无 JSX、直接 createElement，
 * 照 interval-scale-ui.test.ts 桩模式；callOp 整体 mock）。
 *
 * 覆盖第 247 轮新增的行为约定：
 *  1. 有完成/跳过记录 → 「复习统计」摘要行（.hdu-review-stats-summary）渲染四 mini
 *     指标：累计完成 / 本周完成 / 连续天数 / 跳过率（数值 + muted 标签两行式）；
 *  2. 无跳过记录时跳过率格不渲染（skipRate null 不显示）；
 *  3. 全 pending（无任何完成/跳过记录）→ 轻量空态文案（is-empty role=status），
 *     不渲染空骨架格。
 */
// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({ callOp: vi.fn() }));

import { callOp } from '@/core/shared/client';
import { ReviewView } from '@/entrypoints/content/ui/learning/ReviewView';
import type { FavoriteEntity, ReviewJobEntity } from '@/core/shared/types';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;

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

function makeJob(
  id: string,
  title: string,
  status: ReviewJobEntity['status'],
  updatedAt = 1000,
): ReviewJobEntity & { favorite: FavoriteEntity | null } {
  return {
    id,
    favoriteId: `fav-${id}`,
    dueDate: '2026-11-25',
    round: 1,
    template: 'regular',
    status,
    createdAt: 1000,
    updatedAt,
    favorite: makeFavorite(`fav-${id}`, title),
  };
}

function stubOps(jobs: Array<ReviewJobEntity & { favorite: FavoriteEntity | null }>): void {
  callOpMock.mockImplementation(async (op: string) => {
    switch (op) {
      case 'review.list':
        return jobs;
      case 'course.bundles':
        return [];
      case 'stats.report':
        return { totalSec: 0, externalSeconds: 0, streakDays: 0 };
      case 'fav.list':
        return [];
      case 'note.listAll':
        return [];
      default:
        throw new Error(`unexpected op: ${op}`);
    }
  });
}

let host: HTMLElement;
let root: Root;

async function renderView(): Promise<void> {
  await act(async () => {
    root.render(createElement(ReviewView));
  });
  await act(async () => {});
}

function query(): HTMLElement {
  const el = document.querySelector<HTMLElement>('.hdu-review-stats-summary');
  if (!el) throw new Error('review stats summary not found');
  return el;
}

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  document.body.innerHTML = '';
});

describe('复习统计摘要行（第 247 轮）', () => {
  it('有完成/跳过记录：渲染四 mini 指标（累计完成 / 本周完成 / 连续天数 / 跳过率），数值 tabular 格', async () => {
    const now = Date.now();
    stubOps([
      makeJob('done-1', '已完成的作业 A', 'done', now),
      makeJob('done-2', '已完成的作业 B', 'done', now - 86_400_000),
      makeJob('skip-1', '已跳过的作业 C', 'skipped', now),
      makeJob('pending-1', '待完成的作业 D', 'pending'),
    ]);
    await renderView();
    const summary = query();
    expect(summary.getAttribute('role')).toBe('group');
    expect(summary.getAttribute('aria-label')).toBe('复习统计');
    const minis = Array.from(summary.querySelectorAll('.hdu-review-stat-mini'));
    expect(minis).toHaveLength(4);
    const labels = minis.map((m) => m.querySelector('.hdu-review-stat-label')?.textContent);
    expect(labels).toEqual(['累计完成', '本周完成', '连续天数', '跳过率']);
    const values = minis.map((m) => m.querySelector('.hdu-review-stat-value')?.textContent);
    // 累计 2；本周 ≥1（今天完成的那次，昨天按本地周界可能计入）；连续 2（今天+昨天）；跳过率 1/3 → 33%
    expect(values[0]).toBe('2');
    expect(Number(values[1])).toBeGreaterThanOrEqual(1);
    expect(values[2]).toBe('2');
    expect(values[3]).toBe('33%');
    // 跳过率格 danger 淡色档
    expect(minis[3]?.classList.contains('is-skip')).toBe(true);
  });

  it('无跳过记录但有完成：跳过率格渲染为 0% 档（有记录即有分母，仅全空才 null 不显示）', async () => {
    stubOps([makeJob('done-1', '已完成的作业 A', 'done', Date.now()), makeJob('pending-1', '待完成的作业 B', 'pending')]);
    await renderView();
    const minis = Array.from(query().querySelectorAll('.hdu-review-stat-mini'));
    expect(minis).toHaveLength(4);
    const skipValue = minis[3]?.querySelector('.hdu-review-stat-value')?.textContent;
    expect(skipValue).toBe('0%');
    expect(minis[3]?.classList.contains('is-skip')).toBe(true);
  });

  it('全 pending（无完成/跳过记录）：轻量空态文案（is-empty role=status），不渲染指标格', async () => {
    stubOps([makeJob('pending-1', '待完成的作业 A', 'pending')]);
    await renderView();
    const summary = query();
    expect(summary.classList.contains('is-empty')).toBe(true);
    expect(summary.getAttribute('role')).toBe('status');
    expect(summary.textContent).toContain('暂无复习完成记录');
    expect(summary.querySelectorAll('.hdu-review-stat-mini')).toHaveLength(0);
  });
});
