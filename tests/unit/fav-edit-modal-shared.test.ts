/**
 * 共享收藏编辑弹层（FavoriteEditModal.tsx）差异裁决测试（jsdom + react-dom 客户端渲染，
 * 无 JSX、直接 createElement，照 fav-edit-modal.test.ts 模式；callOp 整体 mock）。
 *
 * 覆盖第 20 轮两份实现收口为一份后的裁决点：
 *  1. Dashboard 能力关断（allowDelete/allowPin/allowCreateFolder=false）：弹层无删除按钮、
 *     无置顶勾选、无「新建文件夹…」选项，保存 patch 不携带 pinned 键（不误改卡片置顶态），
 *     成功经 onDone('已保存') 回传（替代原 onSaved()）；
 *  2. 学习中心默认能力（全开）：置顶勾选存在，勾选后保存 patch.pinned=true；
 *  3. 单一实现：LearningCenter 的具名导出与共享模块是同一个函数（re-export 兼容测试路径）。
 */
// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({ callOp: vi.fn() }));

import { callOp } from '@/core/shared/client';
import { FavoriteEditModal } from '@/entrypoints/content/ui/FavoriteEditModal';
import { FavoriteEditModal as FavoriteEditModalFromLearningCenter } from '@/entrypoints/content/ui/LearningCenter';
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
    return {};
  });
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

/** 点击 + 让点击触发的异步链（callOp → setState → 重渲染）完全落定 */
async function clickAsync(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await act(async () => {});
}

function buttonWithText(text: string): HTMLButtonElement {
  const el = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === text);
  if (!el) throw new Error(`button not found: ${text}`);
  return el;
}

/** 取 fav.update 的 patch（找不到即抛错） */
function updatePatch(): Record<string, unknown> {
  const call = calls.find((c) => c.op === 'fav.update');
  if (!call) throw new Error('fav.update not called');
  return (call.args as { patch: Record<string, unknown> }).patch;
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

describe('共享收藏编辑弹层：Dashboard 能力关断', () => {
  it('关断删除/置顶/新建文件夹后不渲染对应入口，保存 patch 不携带 pinned', async () => {
    const onDone = vi.fn();
    await renderElement(createElement(FavoriteEditModal, {
      favorite: makeFav('fav-1'),
      folders: [],
      onClose: () => {},
      onDone,
      allowDelete: false,
      allowPin: false,
      allowCreateFolder: false,
    }));

    // 无弹层内删除按钮（Dashboard 的删除入口在卡片 ConfirmIconButton 上）
    expect(Array.from(host.querySelectorAll('button')).some((b) => b.textContent === '移入回收站')).toBe(false);
    // 无置顶勾选、无「新建文件夹…」选项
    expect(host.querySelector('input[type="checkbox"]')).toBeNull();
    expect(Array.from(host.querySelectorAll('option')).map((o) => o.textContent)).toEqual(['未分组']);

    await clickAsync(buttonWithText('保存'));

    const patch = updatePatch();
    expect(patch).toEqual({ note: undefined, tags: [], folderId: null });
    // 关键裁决：Dashboard 路径 patch 不携带 pinned，避免保存时把卡片置顶态改写
    expect(patch).not.toHaveProperty('pinned');
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith('已保存');
  });
});

describe('共享收藏编辑弹层：学习中心默认能力', () => {
  it('默认渲染置顶勾选，勾选后保存 patch.pinned=true 并回调 onDone(已保存)', async () => {
    const onDone = vi.fn();
    await renderElement(createElement(FavoriteEditModal, {
      favorite: makeFav('fav-1'),
      folders: [],
      onClose: () => {},
      onDone,
    }));

    const pin = host.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!pin) throw new Error('pin checkbox not found');
    expect(pin.checked).toBe(false);

    await act(async () => {
      pin.click();
    });
    await clickAsync(buttonWithText('保存'));

    expect(updatePatch().pinned).toBe(true);
    expect(onDone).toHaveBeenCalledWith('已保存');
  });
});

describe('共享收藏编辑弹层：单一实现', () => {
  it('LearningCenter 具名导出与共享模块为同一函数（re-export 兼容既有测试路径）', () => {
    expect(FavoriteEditModalFromLearningCenter).toBe(FavoriteEditModal);
  });
});
