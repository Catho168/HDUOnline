/**
 * 破坏性操作视觉权重审计落地测试（第 247 轮巡检，数据安全域 / 一致性延续视角，
 * 第 232 轮按钮文案分类 + 第 243 轮语义色审计的延续）。jsdom + react-dom 客户端
 * 渲染，照 library-view-batch.test.ts 桩模式（callOp 整体 mock）。
 *
 * 审计落地项（purge 类「不可恢复」操作的 danger 语义补强 + 清空后确认反馈）：
 *  1. ConfirmButton danger 变体（共享组件）：静态态带 .hdu-btn.danger 类；两步确认
 *     机制不变——第一次点击切确认文案（is-confirm 类），第二次点击才执行 onConfirm；
 *  2. 回收站行级「彻底删除」两步流：第一步变「确认删除」且带 danger 类，第二步才发
 *     trash.purge（keys=[key]）；
 *  3. 「清空回收站」确认横幅：is-danger is-purge 类 + 10s 倒计时条（hdu-confirm-timer）
 *     + 文案含「（不可恢复）」+「确认清空」按钮带 danger 类；确认后发 trash.purge（无
 *     keys = 清空全部）；
 *  4. 清空成功后的空态反馈：「回收站已清空，原内容已永久删除（不可恢复）…」替代常规
 *     空态引导；常规空态（还原路径）文案保持不变。
 */
// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({ callOp: vi.fn() }));

import { callOp } from '@/core/shared/client';
import { ConfirmButton } from '@/entrypoints/content/ui/components';
import { LibraryView } from '@/entrypoints/content/ui/learning/LibraryView';
import { ToastHost } from '@/entrypoints/content/ui/components';
import type { BundleData } from '@/entrypoints/content/ui/learning/shared';
import type { FavoriteEntity } from '@/core/shared/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;

const FAV_ID = 'fav-purge';
const SEED_KEY = `favorite:${FAV_ID}`;

function makeFav(): FavoriteEntity {
  return {
    id: FAV_ID,
    type: 'video',
    refId: 'BV1Purge01',
    snapshot: { title: '数据结构：二叉树的遍历', content: '' },
    folderId: null,
    tags: [],
    pinned: false,
    favoritedAt: 1000,
    updatedAt: 1000,
  };
}

function makeTrashRow() {
  const now = Date.now();
  return { key: SEED_KEY, kind: 'favorite', id: FAV_ID, title: '数据结构：二叉树的遍历', deletedAt: now, expiresAt: now + 30 * 86400000 };
}

let calls: Array<{ op: string; args: unknown }> = [];
let trashListHits = 0;

/** trash.list 首次返回种子条目、其后返回空；其余 op 走查表或安全空值 */
function stubOps(): void {
  calls = [];
  trashListHits = 0;
  callOpMock.mockImplementation(async (op: string, args?: unknown) => {
    calls.push({ op, args });
    if (op === 'trash.list') {
      trashListHits += 1;
      return trashListHits === 1 ? [makeTrashRow()] : [];
    }
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

function allButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('button'));
}

function buttonByText(text: string): HTMLButtonElement {
  const el = allButtons().find((b) => (b.textContent ?? '').trim() === text);
  if (!el) throw new Error(`button not found: ${text}`);
  return el;
}

function panelText(): string {
  return document.querySelector('[aria-label="回收站"]')?.textContent ?? '';
}

beforeEach(() => {
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
});

describe('ConfirmButton danger 变体（第 247 轮）', () => {
  it('静态态带 danger 类；两步确认机制不变：首击切确认文案（is-confirm），二击才执行', async () => {
    const onConfirm = vi.fn(async () => undefined);
    await act(async () => {
      root.render(
        createElement(ConfirmButton, { variant: 'danger', confirmLabel: '再点一次确认删除', onConfirm }, '彻底删除'),
      );
    });
    const btn = buttonByText('彻底删除');
    expect(btn.classList.contains('hdu-btn')).toBe(true);
    expect(btn.classList.contains('danger')).toBe(true);
    expect(btn.classList.contains('is-confirm')).toBe(false);

    await clickAsync(btn);
    const confirming = buttonByText('再点一次确认删除');
    expect(confirming.classList.contains('is-confirm')).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();

    await clickAsync(confirming);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe('回收站 purge 入口视觉权重（第 247 轮）', () => {
  it('行级「彻底删除」两步流：确认态带 danger 类，第二步才发 trash.purge（keys=[key]）', async () => {
    await renderView();
    await clickAsync(allButtons().find((b) => (b.textContent ?? '').includes('🗑 回收站'))!);
    expect(panelText()).toContain('数据结构：二叉树的遍历');

    await clickAsync(buttonByText('彻底删除'));
    // 第一步：变「确认删除」，带 danger 语义类；尚未发 purge
    const confirmBtn = buttonByText('确认删除');
    expect(confirmBtn.classList.contains('danger')).toBe(true);
    expect(calls.filter((c) => c.op === 'trash.purge')).toHaveLength(0);

    await clickAsync(confirmBtn);
    const purges = calls.filter((c) => c.op === 'trash.purge');
    expect(purges).toHaveLength(1);
    expect(purges[0]?.args).toEqual({ keys: [SEED_KEY] });
    expect(panelText()).toContain('回收站为空');
  });

  it('「清空回收站」横幅：is-danger is-purge + 倒计时条 +「（不可恢复）」+ 确认清空按钮 danger 类', async () => {
    await renderView();
    await clickAsync(allButtons().find((b) => (b.textContent ?? '').includes('🗑 回收站'))!);

    await clickAsync(buttonByText('清空回收站'));
    const banner = document.querySelector('.hdu-window-note.is-danger');
    expect(banner).not.toBeNull();
    expect(banner?.classList.contains('is-purge')).toBe(true);
    expect(banner?.querySelector('.hdu-confirm-timer')).not.toBeNull();
    expect(banner?.textContent ?? '').toContain('不可恢复');

    const confirmBtn = buttonByText('确认清空');
    expect(confirmBtn.classList.contains('danger')).toBe(true);

    await clickAsync(confirmBtn);
    const purges = calls.filter((c) => c.op === 'trash.purge');
    expect(purges).toHaveLength(1);
    expect(purges[0]?.args).toEqual({});
  });

  it('清空成功后空态反馈切换为「已永久删除」（just-purged 空态）', async () => {
    await renderView();
    await clickAsync(allButtons().find((b) => (b.textContent ?? '').includes('🗑 回收站'))!);

    await clickAsync(buttonByText('清空回收站'));
    await clickAsync(buttonByText('确认清空'));
    // 清空后 trash.list 重拉为空 → just-purged 空态（区别于常规「回收站为空」引导）
    expect(panelText()).toContain('回收站已清空，原内容已永久删除');
    expect(panelText()).toContain('保留 30 天');
  });

  it('还原路径的常规空态文案保持不变（「回收站为空——」引导）', async () => {
    await renderView();
    await clickAsync(allButtons().find((b) => (b.textContent ?? '').includes('🗑 回收站'))!);
    await clickAsync(buttonByText('还原'));
    expect(panelText()).toContain('回收站为空');
    expect(panelText()).not.toContain('已永久删除');
  });
});
