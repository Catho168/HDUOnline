/**
 * 复习倍增间隔刻度条渲染测试（jsdom + react-dom 客户端渲染，无 JSX、直接
 * createElement，照 review-suggest-ui.test.ts 桩模式；callOp 整体 mock）。
 *
 * 覆盖第 246 轮新增的行为约定：
 *  1. pending 列表行 hdu-list-sub 内渲染 4 格刻度条（.hdu-interval-scale）：
 *     round 2（regular 模板）→ 已完成档 is-done ×1、当前档 is-cur ×1、未来档 ×2；
 *  2. hover title「第 N 轮 · 间隔 X 天」+ 同口径说明；role="img" + aria-label；
 *  3. 模板间隔异常（脏数据，如非递增 steps）→ 该行不渲染刻度条（降级为既有
 *     「第 X/Y 轮」文本徽标）；round 超多轮封顶末档（30 天）。
 */

// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({ callOp: vi.fn() }));

import { callOp } from '@/core/shared/client';
import { ReviewView } from '@/entrypoints/content/ui/learning/ReviewView';
import { uiStore } from '@/entrypoints/content/ui/store';
import { DEFAULT_SETTINGS } from '@/core/shared/constants';
import type { FavoriteEntity, ReviewJobEntity, ReviewTemplate } from '@/core/shared/types';

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
  round = 1,
  template: ReviewTemplate = 'regular',
): ReviewJobEntity & { favorite: FavoriteEntity | null } {
  return {
    id,
    favoriteId: `fav-${id}`,
    dueDate: '2026-11-25',
    round,
    template,
    status: 'pending',
    createdAt: 1000,
    updatedAt: 1000,
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

function queryAll(selector: string): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(selector));
}

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  // 模板间隔恢复默认（其他用例可能污染全局 uiStore）
  const settings = uiStore.getState().settings;
  uiStore.patch({ settings: { ...settings, review: { ...DEFAULT_SETTINGS.review } } });
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  document.body.innerHTML = '';
});

describe('复习倍增间隔刻度条（第 246 轮）', () => {
  it('pending 行渲染 4 格刻度条：round 2 → 已完成 1 档 + 当前档 + 未来 2 档，title 含轮次与间隔', async () => {
    stubOps([makeJob('job-1', '线性代数 第 1 讲', 2)]);
    await renderView();
    const scales = queryAll('.hdu-interval-scale');
    expect(scales).toHaveLength(1);
    const scale = scales[0]!;
    expect(scale.getAttribute('role')).toBe('img');
    expect(scale.getAttribute('title')).toContain('第 2 轮');
    expect(scale.getAttribute('title')).toContain('间隔 7 天');
    expect(scale.getAttribute('aria-label')).toContain('第 2 轮');
    const cells = Array.from(scale.querySelectorAll('.hdu-interval-cell'));
    expect(cells).toHaveLength(4);
    expect(cells.filter((c) => c.classList.contains('is-done'))).toHaveLength(1);
    expect(cells.filter((c) => c.classList.contains('is-cur'))).toHaveLength(1);
    expect(cells.filter((c) => !c.classList.contains('is-done') && !c.classList.contains('is-cur'))).toHaveLength(2);
    // 当前档 = 第 2 格（index 1）
    expect(cells.findIndex((c) => c.classList.contains('is-cur'))).toBe(1);
  });

  it('round 1 → 首档为当前档（无已完成档）；round ≥5 封顶末档 30 天', async () => {
    stubOps([makeJob('job-1', '作业 A', 1), makeJob('job-2', '作业 B', 7)]);
    await renderView();
    const scales = queryAll('.hdu-interval-scale');
    expect(scales).toHaveLength(2);
    const first = Array.from(scales[0]!.querySelectorAll('.hdu-interval-cell'));
    expect(first.findIndex((c) => c.classList.contains('is-cur'))).toBe(0);
    expect(first.filter((c) => c.classList.contains('is-done'))).toHaveLength(0);
    expect(scales[0]!.getAttribute('title')).toContain('间隔 3 天');
    const second = Array.from(scales[1]!.querySelectorAll('.hdu-interval-cell'));
    // round ≥5：index 钳制末档（3）——末档为当前档，前 3 档已完成
    expect(second.filter((c) => c.classList.contains('is-cur'))).toHaveLength(1);
    expect(second.findIndex((c) => c.classList.contains('is-cur'))).toBe(3);
    expect(second.filter((c) => c.classList.contains('is-done'))).toHaveLength(3);
    expect(scales[1]!.getAttribute('title')).toContain('间隔 30 天');
  });

  it('模板间隔异常（非递增 steps）→ 该行不渲染刻度条，行内仍有轮次文本', async () => {
    const settings = uiStore.getState().settings;
    uiStore.patch({
      settings: { ...settings, review: { ...settings.review, intervals: { ...settings.review.intervals, custom: [7, 3] } } },
    });
    stubOps([makeJob('job-1', '常规作业', 2, 'regular'), makeJob('job-2', '自定义作业', 2, 'custom')]);
    await renderView();
    const scales = queryAll('.hdu-interval-scale');
    expect(scales).toHaveLength(1); // 仅 regular 行有刻度条
    expect(scales[0]!.getAttribute('title')).toContain('第 2 轮');
    // custom 行降级为既有轮次文本徽标（sub 行内无刻度条）
    const rows = queryAll('.hdu-todo-rows .hdu-todo-row');
    const customRow = rows.find((el) => el.textContent?.includes('自定义作业'));
    expect(customRow).toBeTruthy();
    expect(customRow!.querySelector('.hdu-interval-scale')).toBeNull();
    expect(customRow!.querySelector('.hdu-list-sub')?.textContent).toContain('第 2/3 轮');
  });

  it('done 行不渲染刻度条（仅 pending 列表行挂载）', async () => {
    const pending = makeJob('job-1', '作业 A', 2);
    const done: ReviewJobEntity & { favorite: FavoriteEntity | null } = {
      ...makeJob('job-2', '作业 B', 3),
      status: 'done',
    };
    stubOps([pending, done]);
    await renderView();
    expect(queryAll('.hdu-interval-scale')).toHaveLength(1);
  });
});
