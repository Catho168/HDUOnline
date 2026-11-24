/**
 * 复习月历格直达清单渲染测试（jsdom + react-dom 客户端渲染，无 JSX、直接
 * createElement，照 checkin-month-cell-ui.test.ts 桩模式；callOp 整体 mock）。
 *
 * 覆盖第 240 轮新增的行为约定：
 *  1. 月视图有到期作业的格头渲染为 button.hdu-month-cell-btn：aria-label
 *     「N 月 N 日有 M 项到期，点击查看」；无作业格无按钮；
 *  2. 点击格头 → 切列表视图：清除日期过滤 chip 出现（「查看 N月N日 到期（M 项）」），
 *     命中行加 .is-day-target 高亮，且只显示该日到期行；
 *  3. 点 chip ×（清除日期过滤）→ chip 消失、恢复全量（两行都回，高亮移除）；
 *  4. 选中格 is-selected 标注（回月视图可见；本测直接断言 chip 数据链路）。
 *
 * 注：组件以 localDayKey() 现取「今天」，月视图默认渲染当前月——桩数据用
 * 本月 15 / 28 日（任何月份都存在，与今天错开）构造，任意日期运行均稳定。
 */
// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({ callOp: vi.fn() }));

import { callOp } from '@/core/shared/client';
import { ReviewView } from '@/entrypoints/content/ui/learning/ReviewView';
import { localDayKey } from '@/core/shared/utils';
import type { FavoriteEntity, ReviewJobEntity } from '@/core/shared/types';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;

const TODAY = localDayKey();

/** 本月某日（'YYYY-MM-DD'）：15 号与 28 号任何月份都存在；today 撞上时取另一个 */
const MID_DAY = (() => {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const day15 = `${y}-${m}-15`;
  const day28 = `${y}-${m}-28`;
  return TODAY.endsWith('-15') ? day28 : day15;
})();

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

async function renderView(): Promise<void> {
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

function buttonWithText(text_: string): HTMLButtonElement {
  const el = queryAll('button').find((b) => b.textContent === text_);
  if (!el) throw new Error(`button not found: ${text_}`);
  return el as HTMLButtonElement;
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

describe('ReviewView 月历格直达清单（第 240 轮）', () => {
  it('月视图有到期作业的格头是按钮且带「N 月 N 日有 M 项到期」aria-label，空格无按钮', async () => {
    stubOps({ 'review.list': [makeJob('job-a', TODAY, '今日到期的作业'), makeJob('job-b', MID_DAY, '本月中旬的作业')] });
    await renderView();
    await clickAsync(buttonWithText('月视图'));
    const cellButtons = queryAll('.hdu-month-cell-btn');
    expect(cellButtons).toHaveLength(2);
    const countOf = (day: string) => Number(day.slice(-2));
    const labels = cellButtons.map((b) => b.getAttribute('aria-label') ?? '');
    expect(labels).toContain(`${Number(TODAY.slice(5, 7))}月${countOf(TODAY)}日有 1 项到期，点击查看`);
    expect(labels).toContain(`${Number(MID_DAY.slice(5, 7))}月${countOf(MID_DAY)}日有 1 项到期，点击查看`);
  });

  it('点击格头 → 切列表视图：chip 出现 + 只显示该日到期行 + is-day-target 高亮', async () => {
    stubOps({ 'review.list': [makeJob('job-a', TODAY, '今日到期的作业'), makeJob('job-b', MID_DAY, '本月中旬的作业')] });
    await renderView();
    await clickAsync(buttonWithText('月视图'));
    const target = queryAll('.hdu-month-cell-btn').find(
      (b) => b.getAttribute('aria-label')?.includes(`${Number(MID_DAY.slice(5, 7))}月${Number(MID_DAY.slice(-2))}日`),
    );
    expect(target).toBeDefined();
    await clickAsync(target!);
    // chip 出现：label + 命中项数
    const chip = document.querySelector('.hdu-day-filter-chip');
    expect(chip?.textContent).toContain(`查看 ${Number(MID_DAY.slice(5, 7))}月${Number(MID_DAY.slice(-2))}日 到期（1 项）`);
    // 列表只剩该日到期行，且带高亮类
    const rows = queryAll('.hdu-todo-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.classList.contains('is-day-target')).toBe(true);
    expect(rows[0]!.textContent).toContain('本月中旬的作业');
  });

  it('点 chip × 清除日期过滤 → chip 消失、恢复全量两行、高亮移除', async () => {
    stubOps({ 'review.list': [makeJob('job-a', TODAY, '今日到期的作业'), makeJob('job-b', MID_DAY, '本月中旬的作业')] });
    await renderView();
    await clickAsync(buttonWithText('月视图'));
    const target = queryAll('.hdu-month-cell-btn').find(
      (b) => b.getAttribute('aria-label')?.includes(`${Number(MID_DAY.slice(5, 7))}月${Number(MID_DAY.slice(-2))}日`),
    );
    await clickAsync(target!);
    expect(document.querySelector('.hdu-day-filter-chip')).not.toBeNull();
    await clickAsync(document.querySelector<HTMLButtonElement>('button[aria-label="清除日期过滤"]')!);
    expect(document.querySelector('.hdu-day-filter-chip')).toBeNull();
    expect(queryAll('.hdu-todo-row')).toHaveLength(2);
    expect(queryAll('.hdu-todo-row.is-day-target')).toHaveLength(0);
  });
});
