/**
 * 收藏编辑弹层删除两步确认测试（jsdom + react-dom 客户端渲染，无 JSX、直接 createElement，
 * 照 plan-menu.test.ts 模式；callOp 整体 mock）。
 *
 * 覆盖第 10 轮去 window.confirm 后的行为约定：
 *  1. 第一次点「移入回收站」只进入确认态（文案变「再点一次确认移入回收站」+ is-confirm 类），
 *     不发起 fav.softDelete；
 *  2. 第二次点击才真正删除：fav.softDelete 带 ids 调用、onDone('已移入回收站') 触发；
 *  3. 切换编辑对象（favorite prop 变化）时确认态复位。
 */
// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({ callOp: vi.fn() }));

import { callOp } from '@/core/shared/client';
import { FavoriteEditModal } from '@/entrypoints/content/ui/LearningCenter';
import type { FavoriteEntity } from '@/core/shared/types';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;

/** 记录 callOp 的调用序列 */
let calls: Array<{ op: string; args: unknown }> = [];

function stubOps(): void {
  calls = [];
  callOpMock.mockImplementation(async (op: string, args?: unknown) => {
    calls.push({ op, args });
    if (op === 'fav.softDelete') return { ok: true };
    return {};
  });
}

function countCalls(op: string): number {
  return calls.filter((c) => c.op === op).length;
}

function makeFav(id: string): FavoriteEntity {
  return {
    id,
    type: 'video',
    refId: 'BV1A',
    snapshot: { title: `视频 ${id}`, content: '' },
    folderId: null,
    tags: [],
    pinned: false,
    favoritedAt: 0,
    updatedAt: 0,
    metadata: { platform: 'bilibili', bvid: 'BV1A', url: 'https://www.bilibili.com/video/BV1A' },
  } as FavoriteEntity;
}

let host: HTMLElement;
let root: Root;

async function renderElement(el: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => {
    root.render(el);
  });
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

/** 点击 + 让点击触发的异步链（callOp → setState → 重渲染）完全落定 */
async function clickAsync(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await act(async () => {});
}

function deleteButton(): HTMLButtonElement {
  const el = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === '移入回收站' || b.textContent === '再点一次确认移入回收站');
  if (!el) throw new Error('删除按钮未找到');
  return el;
}

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  stubOps();
});

afterEach(() => {
  act(() => root.unmount());
});

describe('收藏编辑弹层删除两步确认', () => {
  it('第一次点击只进入确认态（红色文案 + is-confirm 类），不发起删除', async () => {
    const onDone = vi.fn();
    await renderElement(createElement(FavoriteEditModal, { favorite: makeFav('fav-1'), folders: [], onClose: () => {}, onDone }));

    const btn = deleteButton();
    click(btn);
    expect(btn.textContent).toBe('再点一次确认移入回收站');
    expect(btn.className).toContain('is-confirm');
    expect(countCalls('fav.softDelete')).toBe(0);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('确认后调用 fav.softDelete（带 ids）并触发 onDone', async () => {
    const onDone = vi.fn();
    await renderElement(createElement(FavoriteEditModal, { favorite: makeFav('fav-1'), folders: [], onClose: () => {}, onDone }));

    const btn = deleteButton();
    click(btn); // 第一次：进入确认态
    await clickAsync(btn); // 第二次：确认删除

    expect(countCalls('fav.softDelete')).toBe(1);
    expect(calls.find((c) => c.op === 'fav.softDelete')?.args).toEqual({ ids: ['fav-1'] });
    expect(onDone).toHaveBeenCalledWith('已移入回收站');
  });

  it('切换编辑对象（favorite 变化）时确认态复位', async () => {
    const onDone = vi.fn();
    await renderElement(createElement(FavoriteEditModal, { favorite: makeFav('fav-1'), folders: [], onClose: () => {}, onDone }));
    click(deleteButton());
    expect(deleteButton().textContent).toBe('再点一次确认移入回收站');

    // 父级切换到另一条收藏：确认态应回到初始（文案复原），不残留 is-confirm
    await renderElement(createElement(FavoriteEditModal, { favorite: makeFav('fav-2'), folders: [], onClose: () => {}, onDone }));
    const btn = deleteButton();
    expect(btn.textContent).toBe('移入回收站');
    expect(btn.className).not.toContain('is-confirm');
  });
});
