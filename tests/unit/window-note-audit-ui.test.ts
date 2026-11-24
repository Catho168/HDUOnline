/**
 * 统计窗口说明卡文案审计修齐渲染测试（第 250 轮巡检，帮助域 / 文档一致性视角）。
 *
 * 修齐点（jsdom 渲染断言锁定）：
 *  1. 「趋势柱＝近 4 周」改为随 tagTrendWeeks 实时反映（第 135 轮起窗口可切 4/8/12 周，
 *     旧文案写死 4 周属过时）——默认档渲染「近 4 周」、切换 12 周后渲染「近 12 周」；
 *  2. 列清单补上「趋势」列（第 130/135 轮起的迷你柱列原清单漏列）——
 *     文案含「完成率 · 趋势 · 本周」。
 *
 * 照 library-review-entry.test.ts 桩模式：LearningCenter 整体 mock callOp（op → 查表桩），
 * patch centerView='library' 后点开「标签统计」面板（打开时经 review.list 现取）。
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
import { uiStore } from '@/entrypoints/content/ui/store';
import type { FavoriteEntity } from '@/core/shared/types';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;

const FAV = {
  id: 'fav-1',
  type: 'time',
  refId: null,
  courId: 1,
  teclId: 1,
  anchorTime: 0,
  snapshot: { title: '课', content: 'c' },
  folderId: null,
  tags: ['高数'],
  pinned: false,
  favoritedAt: 0,
  updatedAt: 0,
  metadata: {},
} as unknown as FavoriteEntity;

function stubOps(): void {
  const table: Record<string, unknown> = {
    'course.bundles': [],
    'stats.report': null,
    'schedule.missed': [],
    'fav.list': [FAV],
    'folder.list': [],
    'note.list': [],
    'schedule.list': [],
    'transcript.keys': [],
    'review.list': [],
  };
  callOpMock.mockImplementation(async (op: string) => {
    if (!(op in table)) throw new Error(`unexpected op: ${op}`);
    return table[op];
  });
}

let host: HTMLElement;
let root: Root;

async function renderElement(el: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => {
    root.render(el);
  });
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

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  uiStore.patch({ centerView: 'library' });
  stubOps();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  uiStore.patch({ centerView: 'overview' });
});

describe('统计窗口说明卡文案审计（第 250 轮巡检）', () => {
  it('默认趋势窗口（4 周）：文案随 tagTrendWeeks 渲染「趋势柱＝近 4 周」+ 列清单含「趋势」列', async () => {
    await renderElement(createElement(LearningCenter));
    const toggle = host.querySelector<HTMLButtonElement>('button[title="按标签查看收藏与复习完成情况"]');
    expect(toggle).toBeTruthy();
    await clickAsync(toggle as HTMLButtonElement);

    const note = host.querySelector('.hdu-window-note');
    expect(note).toBeTruthy();
    expect(note?.textContent).toContain('趋势柱＝近 4 周');
    expect(note?.textContent).toContain('健康度＝近 28 天（设置可调）');
    // 列清单与实际行内单元格一一对应（补「趋势」列）
    expect(note?.textContent).toContain('完成率 · 趋势 · 本周 · 最近完成');
  });

  it('趋势窗口切到 12 周：文案实时改「趋势柱＝近 12 周」（不再写死 4 周）', async () => {
    await renderElement(createElement(LearningCenter));
    const toggle = host.querySelector<HTMLButtonElement>('button[title="按标签查看收藏与复习完成情况"]');
    await clickAsync(toggle as HTMLButtonElement);

    // 文本寻址「近 12 周」切换钮（避免依赖 DOM 顺序）
    const target = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === '近 12 周');
    expect(target).toBeTruthy();
    await clickAsync(target as HTMLButtonElement);

    const note = host.querySelector('.hdu-window-note');
    expect(note?.textContent).toContain('趋势柱＝近 12 周');
    expect(note?.textContent).not.toContain('趋势柱＝近 4 周 ·');
  });
});
