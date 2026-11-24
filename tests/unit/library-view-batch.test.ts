/**
 * LibraryView 回收站批量操作反馈·组件级行为测试（第 223 轮巡检）。
 *
 * 背景：第 221 轮定位的 showBatchResult 无限递归 bug「编译期合法、运行时必炸」，
 * 此前只有 e2e 覆盖；这里照 bili-hub-today-card.test.ts 模式（jsdom + createRoot，
 * 无 JSX 直接 createElement，callOp 整体 mock）补组件级行为防线：
 *  1. 单条还原成功 → 「✅ 已还原…（HH:MM）」结果条出现（role=status），且回收站
 *     列表重拉后回空态（正是该 bug 曾破坏的 loadTrash 刷新链路）；
 *  2. 点击后先出现「⏳ 还原中…」中间态（restore 响应挂起期间）；
 *  3. 搜索无匹配 → 「🔍 无匹配条目」空态（第 220 轮功能）；
 *  4. 失败路径 → toast「还原失败，请重试」，不出现成功结果条。
 */
// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({ callOp: vi.fn() }));

import { callOp } from '@/core/shared/client';
import { LibraryView } from '@/entrypoints/content/ui/learning/LibraryView';
import { ToastHost } from '@/entrypoints/content/ui/components';
import type { BundleData } from '@/entrypoints/content/ui/learning/shared';
import type { FavoriteEntity } from '@/core/shared/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;

const FAV_ID = 'fav-1';
const SEED_KEY = `favorite:${FAV_ID}`;

function makeFav(): FavoriteEntity {
  return {
    id: FAV_ID,
    type: 'video',
    refId: 'BV1LibView01',
    snapshot: { title: '线性代数公开课：矩阵乘法', content: '' },
    folderId: null,
    tags: [],
    pinned: false,
    favoritedAt: 1000,
    updatedAt: 1000,
  };
}

function makeTrashRow() {
  const now = Date.now();
  return { key: SEED_KEY, kind: 'favorite', id: FAV_ID, title: '线性代数公开课：矩阵乘法', deletedAt: now, expiresAt: now + 30 * 86400000 };
}

let calls: Array<{ op: string; args: unknown }> = [];
let trashListHits = 0;

/** 宽松 stub：table 命中的 op 返回预置值，其余 op 给安全空值（挂载期旁路请求不炸）。
 *  trash.list 特殊：首次返回种子条目，其后返回空（模拟「还原后列表刷新为空」）。 */
function stubOps(table: Record<string, unknown> = {}): void {
  calls = [];
  trashListHits = 0;
  callOpMock.mockImplementation(async (op: string, args?: unknown) => {
    calls.push({ op, args });
    if (op === 'trash.list') {
      trashListHits += 1;
      return trashListHits === 1 ? [makeTrashRow()] : [];
    }
    if (op in table) return table[op];
    return [];
  });
}

function makeData(): BundleData {
  return {
    bundles: [],
    report: null,
    missed: [],
    favorites: [makeFav()],
    folders: [],
    notes: [],
    schedule: [],
    reviewPending: 0,
    loading: false,
    error: null,
    reload: vi.fn(async () => undefined),
  } as unknown as BundleData;
}

let host: HTMLElement;
let root: Root;

async function renderView(): Promise<void> {
  await act(async () => {
    root.render(
      createElement(
        'div',
        null,
        createElement(LibraryView, { data: makeData() }),
        createElement(ToastHost),
      ),
    );
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

function text(selector: string): string {
  return document.querySelector(selector)?.textContent ?? '';
}

/** 回收站入口按钮（与 e2e 同口径：文本含「🗑 回收站」） */
function trashEntryButton(): HTMLButtonElement {
  const el = queryAll('button').find((b) => (b.textContent ?? '').includes('🗑 回收站'));
  if (!el) throw new Error('回收站入口按钮未找到');
  return el as HTMLButtonElement;
}

/** 面板内单条「还原」按钮（与 e2e 同口径：按钮文本精确等于「还原」） */
function restoreButton(): HTMLButtonElement {
  const el = queryAll('[aria-label="回收站"] button').find((b) => (b.textContent ?? '').trim() === '还原');
  if (!el) throw new Error('还原按钮未找到');
  return el as HTMLButtonElement;
}

function setSearchValue(value: string): void {
  const input = document.querySelector('input[aria-label="搜索回收站"]') as HTMLInputElement | null;
  if (!input) throw new Error('搜索框未找到');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function lastToast(): string {
  return queryAll('.hdu-toast').at(-1)?.textContent ?? '';
}

beforeEach(() => {
  // jsdom 无 scrollIntoView：结果条出现时会触发滚动定位（第 198 轮），这里打桩
  Element.prototype.scrollIntoView = vi.fn();
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

describe('LibraryView 回收站批量反馈（组件级，第 223 轮）', () => {
  it('单条还原成功：结果条出现「✅ 已还原…（HH:MM）」，列表重拉后回空态', async () => {
    await renderView();
    await clickAsync(trashEntryButton());
    expect(text('[aria-label="回收站"]')).toContain('线性代数公开课：矩阵乘法');
    await clickAsync(restoreButton());
    const note = queryAll('.hdu-window-note').map((el) => el.textContent ?? '').join('|');
    expect(note).toContain('已还原');
    expect(note).toMatch(/（\d{2}:\d{2}）/);
    // 第 221 轮 bug 破坏的正是这条链路：还原成功后 loadTrash 必须重拉（第二次 trash.list）
    expect(trashListHits).toBeGreaterThanOrEqual(2);
    expect(text('[aria-label="回收站"]')).toContain('回收站为空');
  });

  it('点击还原后先出现「⏳ 还原中…」中间态（restore 响应挂起期间）', async () => {
    let resolveRestore!: (value: unknown) => void;
    callOpMock.mockImplementation(async (op: string, args?: unknown) => {
      calls.push({ op, args });
      if (op === 'trash.restore') return new Promise((resolve) => { resolveRestore = resolve; });
      if (op === 'trash.list') return trashListHits++ === 0 ? [makeTrashRow()] : [];
      return [];
    });
    await renderView();
    await clickAsync(trashEntryButton());
    await clickAsync(restoreButton());
    expect(text('[aria-label="回收站"]')).toContain('还原中');
    await act(async () => {
      resolveRestore(undefined);
    });
    await act(async () => {});
    expect(queryAll('.hdu-window-note').map((el) => el.textContent ?? '').join('|')).toContain('已还原');
  });

  it('搜索无匹配 → 「🔍 无匹配条目」空态（第 220 轮功能）', async () => {
    await renderView();
    await clickAsync(trashEntryButton());
    expect(text('[aria-label="回收站"]')).toContain('线性代数公开课：矩阵乘法');
    await act(async () => {
      setSearchValue('不存在的标题XYZ');
    });
    // 搜索有 150ms 防抖（TRASH_SEARCH_DEBOUNCE_MS）：等防抖落地后再断言
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(text('[aria-label="回收站"]')).toContain('无匹配条目');
    expect(text('[aria-label="回收站"]')).not.toContain('线性代数公开课：矩阵乘法');
  });

  it('失败路径：toast「还原失败，请重试」，不出现成功结果条', async () => {
    stubOps({ __restoreError: true });
    callOpMock.mockImplementation(async (op: string, args?: unknown) => {
      calls.push({ op, args });
      if (op === 'trash.restore') throw new Error('db down');
      if (op === 'trash.list') return trashListHits++ === 0 ? [makeTrashRow()] : [];
      return [];
    });
    await renderView();
    await clickAsync(trashEntryButton());
    await clickAsync(restoreButton());
    expect(lastToast()).toContain('还原失败，请重试');
    const notes = queryAll('.hdu-window-note').map((el) => el.textContent ?? '').join('|');
    expect(notes).not.toContain('已还原');
  });

  it('确认横幅出现时结果条隐藏，取消后结果条恢复（三态互斥，第 224 轮）', async () => {
    // 3 条种子：单条还原造出成功结果条（列表仍剩条目，操作区保留），
    // 再点「清空回收站」触发确认横幅 → 断言结果条被互斥隐藏；取消后恢复。
    const rows = Array.from({ length: 3 }, (_, i) => ({
      key: `favorite:fid-${i}`,
      kind: 'favorite',
      id: `fid-${i}`,
      title: `批量条目 ${i}`,
      deletedAt: Date.now(),
      expiresAt: Date.now() + 86400000,
    }));
    callOpMock.mockImplementation(async (op: string, args?: unknown) => {
      calls.push({ op, args });
      if (op === 'trash.list') return rows;
      return [];
    });
    await renderView();
    await clickAsync(trashEntryButton());
    await clickAsync(restoreButton());
    expect(queryAll('.hdu-window-note').some((el) => (el.textContent ?? '').includes('已还原'))).toBe(true);
    // 触发清空确认横幅
    await clickAsync(queryAll('button').find((b) => (b.textContent ?? '').trim() === '清空回收站')!);
    const during = queryAll('.hdu-window-note').map((el) => el.textContent ?? '');
    expect(during.join('|')).toContain('确认清空回收站全部 3 项');
    expect(during.some((t) => t.includes('已还原'))).toBe(false);
    // 取消：横幅消失，结果条恢复可见
    await clickAsync(queryAll('button').find((b) => (b.textContent ?? '').trim() === '取消')!);
    const after = queryAll('.hdu-window-note').map((el) => el.textContent ?? '');
    expect(after.some((t) => t.includes('已还原'))).toBe(true);
    expect(after.some((t) => t.includes('确认清空回收站'))).toBe(false);
  });
});
