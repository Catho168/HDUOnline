/**
 * VideoFavCard（学习中心 / Dashboard 共用的知识库收藏卡片）单测。
 * jsdom + react-dom 客户端渲染，无 JSX、直接 createElement（照 fav-edit-modal.test.ts 模式）。
 *
 * 覆盖两份实现收敛为一份后的关键行为：
 *  1. 安全链路（第 17/18 轮收口口径，唯一样本）：metadata.url 非 http(s) 时
 *     「打开视频 / 从 N 续看」两入口一并隐藏，不回退假链接；
 *  2. 合法 url 原样透传为「打开视频」href；未看完（ratio<0.95）时续看 href =
 *     withTimeParam(url, lastPositionSec)（URL 已带 ?p= 时用 & 追加）；
 *  3. 已看完（ratio≥0.95）只出「已看完」徽标，无进度条与续看入口；
 *  4. 平台差异 prop：学习中心的字幕能力（subtitleReady + onViewSubtitle →
 *     「字幕已就绪」徽标 + 「查看字幕」入口，回调带 bvid 与分 P）；
 *  5. 平台差异 prop：Dashboard 的底部动作组（onReview / onTogglePin / onDelete +
 *     editPlacement='foot' 的编辑按钮）；
 *  6. 学习中心形态（仅 onEdit，默认头部角标位）不渲染动作组；无外链 url 且有
 *     courId 时按 onOpenSession 渲染「回到课堂」。
 */
// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VideoFavCard } from '@/entrypoints/content/ui/VideoFavCard';
import type { FavoriteEntity } from '@/core/shared/types';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VALID_URL = 'https://www.bilibili.com/video/BV1Kb411W82v/';

function makeFav(overrides: Partial<FavoriteEntity> = {}): FavoriteEntity {
  return {
    id: 'fav-1',
    type: 'video',
    refId: 'BV1Kb411W82v',
    snapshot: { title: '线性代数 第 1 讲', content: '从向量空间讲起' },
    folderId: null,
    tags: ['高数'],
    pinned: false,
    favoritedAt: 0,
    updatedAt: 0,
    metadata: { url: VALID_URL, uploader: '网课 UP 主', durationSec: 600 },
    ...overrides,
  } as FavoriteEntity;
}

let host: HTMLElement;
let root: Root | null = null;

/** 挂载（可多次调用：先卸载上一次的根再挂新的，便于单测内切换 props 形态） */
async function mount(el: ReturnType<typeof createElement>): Promise<HTMLElement> {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(el);
  });
  return host;
}

function buttons(): HTMLButtonElement[] {
  return Array.from(host.querySelectorAll('button'));
}

function links(): HTMLAnchorElement[] {
  return Array.from(host.querySelectorAll('a'));
}

function buttonByLabel(label: string): HTMLButtonElement | undefined {
  return buttons().find((b) => b.getAttribute('aria-label') === label);
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
});

afterEach(async () => {
  if (root) {
    const mounted = root;
    root = null;
    await act(async () => {
      mounted.unmount();
    });
  }
});

describe('VideoFavCard 安全链路（metadata.url 收口）', () => {
  it('脏 url（非 http(s)）时「打开视频 / 从 N 续看」两入口一并隐藏，不产生任何 anchor', async () => {
    await mount(createElement(VideoFavCard, {
      fav: makeFav({ metadata: { url: 'javascript:alert(1)', durationSec: 600, lastPositionSec: 120 } }),
    }));
    expect(host.textContent).not.toContain('打开视频');
    expect(host.textContent).not.toContain('续看');
    expect(links().length).toBe(0);
  });

  it('合法 url 透传为「打开视频」href；未看完时续看 href 按 withTimeParam 拼 ?t=（& 追加 ?p= 场景）', async () => {
    await mount(createElement(VideoFavCard, {
      fav: makeFav({ metadata: { url: `${VALID_URL}?p=2`, durationSec: 600, lastPositionSec: 120 } }),
    }));
    const open = links().find((a) => a.textContent?.includes('打开视频'));
    const resume = links().find((a) => a.textContent?.includes('续看'));
    expect(open?.getAttribute('href')).toBe(`${VALID_URL}?p=2`);
    expect(resume?.getAttribute('href')).toBe(`${VALID_URL}?p=2&t=120`);
    expect(resume?.textContent).toContain('从 02:00 续看');
    expect(host.textContent).not.toContain('已看完');
  });

  it('ratio ≥ 0.95 只出「已看完」徽标，无进度条续看入口', async () => {
    await mount(createElement(VideoFavCard, {
      fav: makeFav({ metadata: { url: VALID_URL, durationSec: 600, lastPositionSec: 580 } }),
    }));
    expect(host.textContent).toContain('已看完');
    expect(host.textContent).not.toContain('续看');
    expect(links().find((a) => a.textContent?.includes('打开视频'))).toBeTruthy();
  });
});

describe('VideoFavCard 平台差异 props', () => {
  it('学习中心字幕能力：subtitleReady + onViewSubtitle 出徽标与「查看字幕」，点击回调带 bvid 与分 P', async () => {
    const onViewSubtitle = vi.fn();
    await mount(createElement(VideoFavCard, {
      fav: makeFav({ metadata: { url: `${VALID_URL}?p=3` } }),
      subtitleReady: true,
      onViewSubtitle,
    }));
    expect(host.textContent).toContain('字幕已就绪');
    const btn = buttons().find((b) => b.textContent?.includes('查看字幕'));
    expect(btn).toBeTruthy();
    await clickAsync(btn!);
    expect(onViewSubtitle).toHaveBeenCalledWith('BV1Kb411W82v', 3);
  });

  it('Dashboard 形态：底部动作组四按钮齐全、编辑在底部（editPlacement=foot），点加入复习走回调；无字幕能力则无字幕徽标', async () => {
    const onReview = vi.fn();
    await mount(createElement(VideoFavCard, {
      fav: makeFav(),
      editPlacement: 'foot',
      onReview,
      onTogglePin: vi.fn(),
      onDelete: vi.fn(),
      onEdit: vi.fn(),
    }));
    expect(host.textContent).not.toContain('字幕已就绪');
    expect(buttonByLabel('加入复习')).toBeTruthy();
    expect(buttonByLabel('置顶')).toBeTruthy();
    expect(buttonByLabel('编辑')).toBeTruthy();
    expect(buttonByLabel('删除')).toBeTruthy();
    // 编辑按钮落在底部动作组（hdu-knowledge-foot）内
    expect(buttonByLabel('编辑')!.closest('.hdu-knowledge-foot')).toBeTruthy();
    await clickAsync(buttonByLabel('加入复习')!);
    expect(onReview).toHaveBeenCalledTimes(1);
  });

  it('学习中心形态：只传 onEdit 时编辑在头部角标位、无动作组；无 url 有 courId 时「回到课堂」回调 (courId, teclId)', async () => {
    const onOpenSession = vi.fn();
    await mount(createElement(VideoFavCard, {
      fav: makeFav({ metadata: {}, courId: 123, teclId: 456 }),
      onEdit: vi.fn(),
      onOpenSession,
    }));
    const edit = buttonByLabel('编辑');
    expect(edit).toBeTruthy();
    expect(edit!.closest('.hdu-knowledge-head')).toBeTruthy();
    expect(buttonByLabel('加入复习')).toBeUndefined();
    expect(buttonByLabel('置顶')).toBeUndefined();
    expect(buttonByLabel('删除')).toBeUndefined();
    const back = buttons().find((b) => b.textContent?.includes('回到课堂'));
    expect(back).toBeTruthy();
    await clickAsync(back!);
    expect(onOpenSession).toHaveBeenCalledWith(123, 456);

    // dashboard 形态（不传 onOpenSession）：同数据下不渲染「回到课堂」
    await mount(createElement(VideoFavCard, {
      fav: makeFav({ metadata: {}, courId: 123, teclId: 456 }),
      editPlacement: 'foot',
      onEdit: vi.fn(),
    }));
    expect(buttons().find((b) => b.textContent?.includes('回到课堂'))).toBeUndefined();
  });
});

describe('VideoFavCard 搜索关键词高亮（第 268 轮，检索域 / 三端一致）', () => {
  it('标题命中词渲染金色 mark（与统一搜索同规则）；无关键词按原文', async () => {
    await mount(createElement(VideoFavCard, { fav: makeFav(), highlight: '线性代数' }));
    const marks = host.querySelectorAll('.hdu-knowledge-title mark.hdu-search-mark');
    expect(marks).toHaveLength(1);
    expect(marks[0]?.textContent).toBe('线性代数');

    await mount(createElement(VideoFavCard, { fav: makeFav() }));
    expect(host.querySelectorAll('.hdu-knowledge-title mark')).toHaveLength(0);
    expect(host.querySelector('.hdu-knowledge-title')?.textContent).toBe('线性代数 第 1 讲');
  });

  it('大小写不敏感：标题英文关键词按原文形态标出', async () => {
    const fav = makeFav({ snapshot: { title: 'Matrix Basics', content: '' } } as Partial<FavoriteEntity>);
    await mount(createElement(VideoFavCard, { fav, highlight: 'matrix' }));
    const marks = host.querySelectorAll('.hdu-knowledge-title mark');
    expect(marks).toHaveLength(1);
    expect(marks[0]?.textContent).toBe('Matrix');
  });
});
