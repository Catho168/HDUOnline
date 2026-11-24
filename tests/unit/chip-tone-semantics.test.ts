/**
 * Chip 语义色审计配套测试（第 243 轮巡检，一致性域 / 设计系统视角）：
 *  1. Chip 组件 tone → class 映射完整性：语义速查表约定的 5 个 tone
 *     （default/accent/jade/danger/info）各产出对应 class，default 不落 tone class；
 *  2. 逾期徽标语义修正回归：BiliHubTodayCard 有逾期作业时，「逾期 N」从完成度
 *     chip 的 info 后缀拆出独立 `.hdu-chip.danger`（风险语义用 danger，不再藏
 *     在信息色里）；无逾期时不出 danger chip。
 *
 * jsdom + react-dom 客户端渲染，无 JSX、直接 createElement（照 bili-hub-today-card.test.ts 模式）。
 */
// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({ callOp: vi.fn() }));

import { callOp } from '@/core/shared/client';
import { Chip } from '@/entrypoints/content/ui/components';
import { BiliHubTodayCard } from '@/entrypoints/content/ui/BiliHubTodayCard';
import type { FavoriteEntity, ReviewJobEntity } from '@/core/shared/types';
import { localDayKey } from '@/core/shared/utils';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;

describe('Chip tone → class 映射（语义色速查表，第 243 轮）', () => {
  let host: HTMLElement;
  let root: Root;

  /** 渲染指定 tone 的 Chip，返回落地的 class 字符串 */
  function renderChip(tone: 'default' | 'accent' | 'jade' | 'danger' | 'info'): string | null {
    const el = createElement(Chip, tone === 'default' ? { children: 'x' } : { tone, children: 'x' });
    act(() => {
      root.render(el);
    });
    return document.querySelector('.hdu-chip')?.className ?? null;
  }

  beforeEach(() => {
    document.body.innerHTML = '';
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
  });

  it('5 个语义 tone 各产出对应 class；default 不落 tone class', () => {
    expect(renderChip('default')).toBe('hdu-chip');
    expect(renderChip('accent')).toContain('hdu-chip accent');
    expect(renderChip('jade')).toContain('hdu-chip jade');
    expect(renderChip('danger')).toContain('hdu-chip danger');
    expect(renderChip('info')).toContain('hdu-chip info');
  });
});

describe('逾期徽标语义修正（BiliHubTodayCard，第 243 轮）', () => {
  let host: HTMLElement;
  let root: Root;

  const BVID = 'BV1ChipTone1';

  function makeJob(dueDate: string, id: string): ReviewJobEntity & { favorite: FavoriteEntity | null } {
    return {
      id,
      favoriteId: `fav-${id}`,
      dueDate,
      round: 1,
      template: 'regular',
      status: 'pending',
      createdAt: 1000,
      updatedAt: 1000,
      favorite: {
        id: `fav-${id}`,
        type: 'video',
        refId: BVID,
        snapshot: { title: `复习条目 ${id}`, content: '' },
        folderId: null,
        tags: [],
        pinned: false,
        favoritedAt: 1000,
        updatedAt: 1000,
        metadata: { platform: 'bilibili', bvid: BVID, url: `https://www.bilibili.com/video/${BVID}` },
      } as unknown as FavoriteEntity,
    };
  }

  function stubOps(table: Record<string, unknown> = {}): void {
    const defaults: Record<string, unknown> = { 'review.due': [], ...table };
    callOpMock.mockImplementation(async (op: string) => {
      if (!(op in defaults)) throw new Error(`unexpected op: ${op}`);
      return defaults[op];
    });
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

  it('有逾期作业：完成度 chip 不再内联「逾期 N」，拆出独立 .hdu-chip.danger「逾期 N」', async () => {
    const overdueDay = localDayKey(Date.now() - 2 * 86_400_000);
    stubOps({ 'review.due': [makeJob(overdueDay, 'job-overdue')] });
    await act(async () => {
      root.render(createElement(BiliHubTodayCard));
    });
    for (let i = 0; i < 3; i += 1) await act(async () => {});

    const chips = Array.from(host.querySelectorAll('.hdu-chip'));
    const overdueChip = chips.find((chip) => chip.classList.contains('danger'));
    expect(overdueChip?.textContent).toContain('逾期 1');
    // 完成度 chip 恢复纯进度语义，不含风险后缀
    const progressChip = chips.find((chip) => chip.textContent?.includes('已完成'));
    expect(progressChip?.classList.contains('danger')).toBe(false);
    expect(progressChip?.textContent).not.toContain('逾期');
  });

  it('无逾期作业：不出 danger chip，完成度 chip 仍在', async () => {
    stubOps({ 'review.due': [makeJob(localDayKey(), 'job-today')] });
    await act(async () => {
      root.render(createElement(BiliHubTodayCard));
    });
    for (let i = 0; i < 3; i += 1) await act(async () => {});

    const chips = Array.from(host.querySelectorAll('.hdu-chip'));
    expect(chips.some((chip) => chip.classList.contains('danger'))).toBe(false);
    expect(chips.some((chip) => chip.textContent?.includes('已完成'))).toBe(true);
  });
});
