/**
 * 错误文案修齐点·组件级断言（第 255 轮，错误文案域 / 用户体验视角；jsdom 渲染，
 * 照 data-export-ui / library-view-batch / review-forecast-ui 桩模式，callOp 整体 mock）。
 *
 * 全仓错误出口盘点结论（对照表见 docs/巡检日志.md 第 255 轮）：errorTextOf 消费面已
 * 覆盖全部面板 toast / setError 出口，无「直接 err.message 上 UI」的残留；本轮修齐
 * 四类信息损失 / 泛化兜底，逐处断言：
 *  1. dashboard downloadJob 记录过期：此前抛普通 Error → errorTextOf 吞成「导出失败」，
 *     现改抛 AppError(userMessage) —— 具体原因「导出文件已过期，请重新导出」直达用户；
 *  2. dashboard export.build 普通异常：非 AppError 回退语境化兜底「导出失败」；
 *  3. BiliImportModal 收藏夹列表读取失败：缺省兜底补上下文词；
 *  4. LibraryView「还原并复习」失败：泛化「操作失败，请重试」→「还原失败，请重试」（同族句式）；
 *  5. ReviewView 完成/跳过失败：泛化兜底 →「完成复习失败，请重试」（与 B 站今日卡同 op 同句）。
 */

// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({ callOp: vi.fn() }));
vi.mock('@/core/db', () => ({ getDb: vi.fn() }));

import { callOp } from '@/core/shared/client';
import { getDb } from '@/core/db';
import { Data } from '@/entrypoints/dashboard/App';
import { BiliImportModal } from '@/entrypoints/content/ui/BiliImportModal';
import { LibraryView } from '@/entrypoints/content/ui/learning/LibraryView';
import { ReviewView } from '@/entrypoints/content/ui/learning/ReviewView';
import { ToastHost } from '@/entrypoints/content/ui/components';
import type { BundleData } from '@/entrypoints/content/ui/learning/shared';
import type { FavoriteEntity, ReviewJobEntity } from '@/core/shared/types';
import { localDayKey } from '@/core/shared/utils';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;
const getDbMock = getDb as unknown as Mock;

let host: HTMLElement;
let root: Root;

async function renderElement(el: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => {
    root.render(el);
  });
  await act(async () => {});
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

function lastToast(): string {
  return queryAll('.hdu-toast').at(-1)?.textContent ?? '';
}

function buttonByText(label: string): HTMLButtonElement {
  const btn = queryAll('button').find((b) => (b.textContent ?? '').trim() === label);
  if (!btn) throw new Error(`button not found: ${label}`);
  return btn as HTMLButtonElement;
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  callOpMock.mockReset();
  getDbMock.mockReset();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  document.body.innerHTML = '';
});

// ───────────────────────── dashboard 导出链路 ─────────────────────────

describe('dashboard 导出错误文案（结构化透传 + 语境化兜底）', () => {
  function stubExportBase(): void {
    callOpMock.mockImplementation(async (op: string, args?: unknown) => {
      if (op === 'export.build') return { jobId: 'job-exp-1' };
      if (op === 'storage.usage') return null;
      if (op === 'trash.list') return [];
      throw new Error(`unexpected op: ${op} ${JSON.stringify(args ?? {})}`);
    });
  }

  it('导出记录已过期：AppError userMessage 直达用户（不再被兜底吞成「导出失败」）', async () => {
    stubExportBase();
    // downloadJob 读不到 exportJobs 记录 → 抛 AppError('INVALID_INPUT', userMessage)
    getDbMock.mockResolvedValue({ get: vi.fn(async () => undefined) });
    const notify = vi.fn();
    await renderElement(createElement(Data, { notify }));

    await clickAsync(buttonByText('全量备份 ZIP'));
    // 结构化 userMessage 透传：errorTextOf(AppError) → userMessage
    const errorCall = notify.mock.calls.find((c) => c[1] === true);
    expect(errorCall?.[0]).toBe('导出文件已过期，请重新导出');
  });

  it('export.build 普通异常：非 AppError 回退语境化兜底「导出失败」（技术文案不泄漏）', async () => {
    callOpMock.mockImplementation(async (op: string) => {
      if (op === 'export.build') throw new Error('TypeError: x is not a function');
      if (op === 'storage.usage') return null;
      if (op === 'trash.list') return [];
      throw new Error(`unexpected op: ${op}`);
    });
    const notify = vi.fn();
    await renderElement(createElement(Data, { notify }));

    await clickAsync(buttonByText('复习卡片'));
    const errorCall = notify.mock.calls.find((c) => c[1] === true);
    expect(errorCall?.[0]).toBe('导出失败');
    expect(notify.mock.calls.some((c) => String(c[0]).includes('TypeError'))).toBe(false);
  });
});

// ───────────────────────── BiliImportModal ─────────────────────────

describe('BiliImportModal 收藏夹列表读取失败文案', () => {
  it('普通异常（非 AppError）→ 语境化兜底「B 站收藏夹列表读取失败，请重试」', async () => {
    callOpMock.mockImplementation(async (op: string) => {
      if (op === 'bili.nav.get') return { isLogin: true };
      if (op === 'bili.favlist.folders') throw new Error('Unexpected token < in JSON');
      throw new Error(`unexpected op: ${op}`);
    });
    await renderElement(createElement(BiliImportModal, { open: true, onClose: () => {} }));

    expect(host.textContent).toContain('B 站收藏夹列表读取失败，请重试');
    expect(host.textContent).not.toContain('Unexpected token');
  });
});

// ───────────────────────── LibraryView 还原并复习 ─────────────────────────

describe('LibraryView「还原并复习」失败文案（泛化兜底修齐）', () => {
  const FAV_ID = 'fav-fix-1';

  function makeFav(): FavoriteEntity {
    return {
      id: FAV_ID,
      type: 'video',
      refId: 'BV1CopyFix01',
      snapshot: { title: '概率论第 4 讲', content: '' },
      folderId: null,
      tags: [],
      pinned: false,
      favoritedAt: 1000,
      updatedAt: 1000,
    };
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

  it('trash.restore 成功但 review.plan 抛普通异常 → toast「还原失败，请重试」（不再是「操作失败，请重试」）', async () => {
    let trashHits = 0;
    callOpMock.mockImplementation(async (op: string) => {
      if (op === 'trash.list') {
        trashHits += 1;
        return trashHits === 1
          ? [{ key: `favorite:${FAV_ID}`, kind: 'favorite', id: FAV_ID, title: '概率论第 4 讲', deletedAt: Date.now(), expiresAt: Date.now() + 30 * 86400_000 }]
          : [];
      }
      if (op === 'trash.restore') return { restored: 1 };
      if (op === 'review.plan') throw new Error('QuotaExceededError');
      return [];
    });
    await renderElement(createElement('div', null, createElement(LibraryView, { data: makeData() }), createElement(ToastHost)));

    // 先进回收站视图（与 library-view-batch.test.ts 同口径的入口按钮），再点「还原并复习」
    const trashEntry = queryAll('button').find((b) => (b.textContent ?? '').includes('🗑 回收站'));
    expect(trashEntry).toBeDefined();
    await clickAsync(trashEntry!);
    await clickAsync(buttonByText('还原并复习'));
    expect(lastToast()).toContain('还原失败，请重试');
    expect(lastToast()).not.toContain('操作失败');
  });
});

// ───────────────────────── ReviewView 完成/跳过 ─────────────────────────

describe('ReviewView 完成失败文案（与 B 站今日卡同 op 同句）', () => {
  function makeJob(id: string): ReviewJobEntity & { favorite: FavoriteEntity | null } {
    return {
      id,
      favoriteId: `fav-${id}`,
      dueDate: localDayKey(),
      round: 1,
      template: 'regular',
      status: 'pending',
      createdAt: 0,
      updatedAt: 0,
      favorite: { id: `fav-${id}`, type: 'time', snapshot: { title: `收藏 ${id}`, content: '' }, tags: [], pinned: false, favoritedAt: 0, updatedAt: 0 },
    };
  }

  it('review.complete 抛普通异常 → toast「完成复习失败，请重试」', async () => {
    callOpMock.mockImplementation(async (op: string) => {
      if (op === 'review.list') return [makeJob('job-fix-1')];
      if (op === 'review.complete') throw new Error('rpc down');
      if (op === 'course.bundles') return [];
      if (op === 'stats.report') return { totalSec: 0, externalSeconds: 0, streakDays: 0 };
      return [];
    });
    await renderElement(createElement('div', null, createElement(ReviewView), createElement(ToastHost)));

    await clickAsync(buttonByText('完成'));
    expect(lastToast()).toContain('完成复习失败，请重试');
    expect(lastToast()).not.toContain('rpc down');
  });
});
