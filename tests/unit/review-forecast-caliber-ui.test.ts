/**
 * 复习预测「同口径」互认渲染测试（jsdom + react-dom 客户端渲染，无 JSX、直接
 * createElement，照 review-forecast-ui.test.ts 桩模式；callOp 整体 mock）。
 *
 * 覆盖第 242 轮新增的行为约定：
 *  1. 有明日到期作业时，「明」柱 hover/aria-label 附口径互认后缀
 *     「与今日待办「明日到期」同口径」（今日柱 / 逾期柱 / 以后柱不带）；
 *  2. 预测图下渲染 .hdu-caliber-hint 口径标注行（.hdu-caliber-tag「同口径」pill
 *     + .hdu-hint 说明文字），复用第 239 轮分布卡口径句式；
 *  3. 明日无到期作业时不出现互认后缀（说明行仍渲染——口径标注与有无明日作业无关）。
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

function stubOps(table: Record<string, unknown> = {}): void {
  const defaults: Record<string, unknown> = {
    'review.list': [],
    'course.bundles': [],
    'stats.report': { totalSec: 0, externalSeconds: 0, streakDays: 0 },
    'fav.list': [],
    'note.listAll': [],
    ...table,
  };
  callOpMock.mockImplementation(async (op: string) => {
    if (!(op in defaults)) throw new Error(`unexpected op: ${op}`);
    return defaults[op];
  });
}

let host: HTMLElement;
let root: Root;

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

describe('ReviewView 预测图口径互认（第 242 轮）', () => {
  it('「明」柱 aria-label 附同口径后缀；其余柱不带；图下渲染同口径标注行', async () => {
    stubOps({
      'review.list': [makeJob('job-a', PAST, '逾期作业'), makeJob('job-b', TOMORROW, '明日作业')],
    });
    await renderView();
    const cols = queryAll('.hdu-forecast-col');
    expect(cols.length).toBeGreaterThanOrEqual(8);
    const tomorrowCol = cols.find((c) => c.querySelector('.hdu-forecast-label')?.textContent === '明日');
    expect(tomorrowCol).toBeDefined();
    expect(tomorrowCol!.getAttribute('aria-label')).toBe(
      `${Number(TOMORROW.slice(5, 7))} 月 ${Number(TOMORROW.slice(8))} 日 · 1 项，与今日待办「明日到期」同口径`,
    );
    const todayCol = cols.find((c) => c.classList.contains('is-today'));
    expect(todayCol!.getAttribute('aria-label')).not.toContain('同口径');
    const overdueCol = cols.find((c) => c.classList.contains('is-overdue'));
    expect(overdueCol!.getAttribute('aria-label')).not.toContain('同口径');
    // 口径标注行：复用第 239 轮句式（tag + hint），位于预测图之后
    const caliber = queryAll('.hdu-forecast-caliber');
    expect(caliber).toHaveLength(1);
    expect(caliber[0]!.querySelector('.hdu-caliber-tag')?.textContent).toBe('同口径');
    expect(caliber[0]!.querySelector('.hdu-hint')?.textContent).toContain('明日到期');
  });

  it('明日无到期作业：互认后缀不出现，标注行照常渲染', async () => {
    stubOps({ 'review.list': [makeJob('job-b', TODAY, '今日作业')] });
    await renderView();
    const cols = queryAll('.hdu-forecast-col');
    for (const col of cols) {
      expect(col.getAttribute('aria-label')).not.toContain('同口径');
    }
    const caliber = queryAll('.hdu-forecast-caliber');
    expect(caliber).toHaveLength(1);
  });
});
