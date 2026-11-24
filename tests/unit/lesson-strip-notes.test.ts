/**
 * 本课学习小条「本课笔记」行渲染测试（LessonStudyStrip.tsx，第 243 轮巡检）。
 *
 * 覆盖：
 *  1. note.listAll 返回本课笔记（courId 匹配）→ 展开态出现「本课笔记 N 条」行
 *     （.hdu-lesson-note.is-info），可点 → actions.openCenter('library') 跳知识库；
 *  2. 行尾附「最近一条 X」（favoritedAgoLabel 相对时间分桶，updatedAt 取最大）；
 *  3. 本课 0 条笔记 → 弱化轻入口（.hdu-lesson-note.is-empty）；他课笔记不计入
 *     （courId 过滤、B 站外部笔记无 courId 天然排除、deletedAt 软删除排除）；
 *  4. note.listAll 拒绝（旧测试桩未覆盖该 op 的场景）→ 笔记行静默隐藏，
 *     主条（今日已学 / 本课累计 / 待办行）照常渲染（callOp 防御包装）；
 *  5. 收起态不出现笔记行；待办行（第 241 轮既有行为）回归确认。
 *
 * jsdom + react-dom 客户端渲染，无 JSX、直接 createElement（照 bili-hub-today-card.test.ts
 * 模式；callOp 整体 mock，op → 返回值查表桩）；uiStore.patch 驱动 resolution/watchedSec，
 * actions.openCenter 以 spy 覆盖（默认 noop 动作集，断言跳转参数）。
 */
// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({ callOp: vi.fn() }));

import { callOp } from '@/core/shared/client';
import { LessonStudyStrip } from '@/entrypoints/content/ui/panel/LessonStudyStrip';
import { uiStore } from '@/entrypoints/content/ui/store';
import { localDayKey } from '@/core/shared/utils';

// React 18 并发渲染下 act() 需要显式声明环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;

const COUR_ID = 9001;
const NOW = Date.now();
const DAY = 86_400_000;

/** 本课笔记（courId 匹配） */
function makeNote(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'note-1',
    courId: COUR_ID,
    teclId: 7001,
    anchorTime: 120,
    text: '这里的推导要看第二遍',
    createdAt: NOW - DAY,
    updatedAt: NOW - 2 * 3600_000,
    deletedAt: null,
    ...overrides,
  };
}

let calls: Array<{ op: string; args: unknown }> = [];

function stubOps(table: Record<string, unknown> = {}): void {
  calls = [];
  const defaults: Record<string, unknown> = {
    'stats.records': [],
    'review.due': [],
    'note.listAll': [],
    ...table,
  };
  callOpMock.mockImplementation(async (op: string, args?: unknown) => {
    calls.push({ op, args });
    if (!(op in defaults)) throw new Error(`unexpected op: ${op}`);
    const value = defaults[op];
    return typeof value === 'function' ? value(args) : value;
  });
}

let host: HTMLElement;
let root: Root;
let openCenterSpy: ReturnType<typeof vi.fn>;

async function renderStrip(): Promise<void> {
  await act(async () => {
    root.render(createElement(LessonStudyStrip));
  });
  // 挂载期三路 callOp 异步链落定
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {});
  }
}

/** 展开（点击头部摘要按钮）后的条体 */
function expand(): Promise<void> {
  const head = host.querySelector<HTMLButtonElement>('.hdu-lesson-strip-head');
  if (!head) throw new Error('strip head not found');
  return act(async () => {
    head.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

function noteRow(): HTMLButtonElement | null {
  return host.querySelector<HTMLButtonElement>('.hdu-lesson-note');
}

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  stubOps();
  uiStore.patch({ resolution: { phase: 'resolved', courId: COUR_ID }, watchedSec: 125 });
  openCenterSpy = vi.fn();
  uiStore.actions.openCenter = openCenterSpy as unknown as typeof uiStore.actions.openCenter;
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  document.body.innerHTML = '';
  // 还原默认 noop 动作集，避免 spy 泄漏进其他用例
  uiStore.actions.openCenter = () => undefined;
  uiStore.patch({ resolution: { phase: 'idle' } });
});

describe('本课学习小条「本课笔记」行（第 243 轮）', () => {
  it('有本课笔记：展开态出现 info 行「本课笔记 N 条 · 最近一条 X」，可点跳知识库', async () => {
    stubOps({
      'note.listAll': [
        makeNote(),
        makeNote({ id: 'note-2', updatedAt: NOW - 3 * DAY, createdAt: NOW - 3 * DAY }),
      ],
    });
    await renderStrip();
    await expand();

    const row = noteRow();
    expect(row).not.toBeNull();
    expect(row?.className).toContain('is-info');
    expect(row?.textContent).toContain('本课笔记 2 条');
    // 最近一条取 updatedAt 最大者（2 小时前 → 今天分桶）
    expect(row?.textContent).toContain('最近一条 今天');

    await act(async () => {
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await act(async () => {});
    expect(openCenterSpy).toHaveBeenCalledWith('library');
  });

  it('本课 0 条：弱化轻入口 is-empty「记一条」，点击同样跳知识库', async () => {
    stubOps({ 'note.listAll': [] });
    await renderStrip();
    await expand();

    const row = noteRow();
    expect(row?.className).toContain('is-empty');
    expect(row?.textContent).toContain('记一条');
    await act(async () => {
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(openCenterSpy).toHaveBeenCalledWith('library');
  });

  it('口径过滤：他课笔记 / 外部笔记（无 courId）/ 软删除笔记不计入本课', async () => {
    stubOps({
      'note.listAll': [
        makeNote({ id: 'other-cour', courId: 8888 }),
        makeNote({ id: 'external', courId: undefined, mediaKey: 'bili:BV1Abcdefg' }),
        makeNote({ id: 'deleted', deletedAt: NOW - 3600_000 }),
        makeNote({ id: 'live-1' }),
      ],
    });
    await renderStrip();
    await expand();
    expect(noteRow()?.textContent).toContain('本课笔记 1 条');
  });

  it('note.listAll 拒绝（旧桩未覆盖该 op）：笔记行静默隐藏，主条照常渲染', async () => {
    stubOps({
      'note.listAll': () => Promise.reject(new Error('unexpected op: note.listAll')),
      'review.due': [
        {
          id: 'job-1',
          favoriteId: 'fav-1',
          dueDate: localDayKey(),
          round: 1,
          template: 'regular',
          status: 'pending',
          createdAt: 0,
          updatedAt: 0,
          favorite: { id: 'fav-1', courId: COUR_ID, snapshot: { title: '收藏 A', content: '' } },
        },
      ],
    });
    await renderStrip();
    await expand();

    expect(noteRow()).toBeNull();
    // 主条不受影响：统计行 + 待办行（danger）均在
    expect(host.textContent).toContain('本课今日已学');
    expect(host.querySelector('.hdu-lesson-todo.is-danger')?.textContent).toContain('本课今日有 1 项复习到期');
  });

  it('收起态不出现笔记行；stats.records / note.listAll 均已发起', async () => {
    stubOps({ 'note.listAll': [makeNote()] });
    await renderStrip();
    expect(noteRow()).toBeNull();
    const ops = calls.map((c) => c.op);
    expect(ops).toContain('stats.records');
    expect(ops).toContain('note.listAll');
    expect(ops).toContain('review.due');
  });
});
