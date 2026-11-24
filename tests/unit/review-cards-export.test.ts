/**
 * 复习卡片导出（第 37 轮巡检）单测：buildReviewCardsMarkdown 纯函数 md 口径 +
 * exportReviewCards 组合入口（下载触发 + 成功 toast）。
 *
 * 覆盖：
 *  1. md 纯函数对 time / ai / note / video 收藏的逐行输出——标题/正文/备注引用/
 *     时间点/类型标签，与 HDU 学习中心既有内联实现（抽空前）逐行同构；
 *  2. 空列表只出标题行；入参只读不重排；
 *  3. exportReviewCards：生成 → Blob 下载（objectURL + a[download] 点击）+ toast。
 */
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// pushToast 换桩（exportReviewCards 的成功提示断言）；其余导出保持原实现
vi.mock('@/entrypoints/content/ui/components', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/entrypoints/content/ui/components')>();
  return { ...actual, pushToast: vi.fn() };
});

import { pushToast } from '@/entrypoints/content/ui/components';
import { buildReviewCardsMarkdown, exportReviewCards } from '@/entrypoints/content/ui/reviewCards';
import { localDayKey } from '@/core/shared/utils';
import type { FavoriteEntity } from '@/core/shared/types';

const pushToastMock = pushToast as unknown as ReturnType<typeof vi.fn>;

/** 记录 new Blob(parts, options) 的入参（jsdom Blob 无 text()/arrayBuffer()，改为捕获构造入参） */
const blobCtorCalls: Array<{ parts: unknown[]; type: string }> = [];
const OriginalBlob = globalThis.Blob;

function makeFav(overrides: Partial<FavoriteEntity> = {}): FavoriteEntity {
  return {
    id: 'fav-1',
    type: 'time',
    snapshot: { title: '线性代数 · 03:00', content: '矩阵乘法的时间点收藏' },
    anchorTime: 180,
    folderId: null,
    tags: [],
    note: '期末重点',
    pinned: false,
    favoritedAt: 1000,
    updatedAt: 1000,
    ...overrides,
  } as FavoriteEntity;
}

beforeEach(() => {
  pushToastMock.mockClear();
  blobCtorCalls.length = 0;
  // jsdom 未实现 Blob URL：直接赋桩（覆盖本文件全部用例；测试间复用无碍）；
  // Blob 换成仅记录入参的桩，下载内容经构造入参断言（不依赖 jsdom 未实现的 text()）
  (URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(() => 'blob:review-cards-test');
  (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();
  class FakeBlob {
    parts: unknown[];
    type: string;
    constructor(parts: unknown[], options?: { type?: string }) {
      this.parts = parts;
      this.type = options?.type ?? '';
      blobCtorCalls.push({ parts, type: this.type });
    }
  }
  (globalThis as unknown as Record<string, unknown>).Blob = FakeBlob;
});

afterEach(() => {
  (globalThis as unknown as Record<string, unknown>).Blob = OriginalBlob;
  vi.restoreAllMocks();
});

describe('buildReviewCardsMarkdown 纯函数（第 37 轮抽共享）', () => {
  it('time 收藏：标题/正文/备注引用/时间点/类型 逐行同构', () => {
    const md = buildReviewCardsMarkdown([makeFav()]);
    expect(md).toBe(
      [
        '# 智慧课堂复习卡片',
        '',
        '## 线性代数 · 03:00',
        '',
        '矩阵乘法的时间点收藏',
        '',
        '> 期末重点',
        '',
        '- 时间点：03:00',
        '- 类型：时间点',
        '',
      ].join('\n'),
    );
  });

  it('ai 收藏：类型标签「AI 回答」，无备注时不出引用行', () => {
    const md = buildReviewCardsMarkdown([
      makeFav({
        id: 'fav-ai',
        type: 'ai',
        note: undefined,
        snapshot: { title: '特征值有什么直观含义', content: '特征值描述线性变换的不变方向' },
        anchorTime: 300,
      }),
    ]);
    expect(md).toContain('## 特征值有什么直观含义');
    expect(md).toContain('特征值描述线性变换的不变方向');
    expect(md).toContain('- 时间点：05:00');
    expect(md).toContain('- 类型：AI 回答');
    expect(md).not.toContain('>');
  });

  it('note 收藏：类型标签「笔记」，正文为笔记原文（noteToFavorite 落 snapshot.content）', () => {
    const md = buildReviewCardsMarkdown([
      makeFav({
        id: 'fav-note',
        type: 'note',
        snapshot: { title: '笔记 @120s', content: '矩阵乘法不满足交换律' },
        anchorTime: 120,
      }),
    ]);
    expect(md).toContain('## 笔记 @120s');
    expect(md).toContain('矩阵乘法不满足交换律');
    expect(md).toContain('- 时间点：02:00');
    expect(md).toContain('- 类型：笔记');
  });

  it('video 收藏：无锚点时间不出「时间点」行，类型标签「视频」', () => {
    const md = buildReviewCardsMarkdown([
      makeFav({ id: 'fav-video', type: 'video', anchorTime: undefined, note: undefined, snapshot: { title: '线性代数公开课', content: 'B 站收藏的网课视频' } }),
    ]);
    expect(md).toContain('## 线性代数公开课');
    expect(md).toContain('- 类型：视频');
    expect(md).not.toContain('- 时间点：');
  });

  it('空列表只出标题行；多收藏按入参顺序拼接，不改写入参数组', () => {
    expect(buildReviewCardsMarkdown([])).toBe('# 智慧课堂复习卡片\n');
    const a = makeFav({ id: 'a', snapshot: { title: 'A', content: 'a' } });
    const b = makeFav({ id: 'b', snapshot: { title: 'B', content: 'b' } });
    const list = [a, b];
    const md = buildReviewCardsMarkdown(list);
    expect(md.indexOf('## A')).toBeGreaterThanOrEqual(0);
    expect(md.indexOf('## A')).toBeLessThan(md.indexOf('## B'));
    expect(list.map((f) => f.id)).toEqual(['a', 'b']);
  });
});

describe('exportReviewCards 组合入口（生成 + 下载 + toast）', () => {
  it('生成 md 并触发 a[download] 下载，文件名沿用既有口径，提示复习卡片已导出', () => {
    const createObjectURL = URL.createObjectURL as unknown as ReturnType<typeof vi.fn>;
    const clicked: string[] = [];
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function mockClick(this: HTMLAnchorElement) {
      clicked.push(`${this.download} ${this.href}`);
    });
    const favorites = [makeFav()];
    exportReviewCards(favorites);
    // 下载触发：Blob → objectURL → 隐式锚点点击，文件名 = 智慧课堂-复习卡片-<本地日键>.md
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(clicked[0]).toContain(`智慧课堂-复习卡片-${localDayKey()}.md`);
    expect(clicked[0]).toContain('blob:review-cards-test');
    // 下载内容与纯函数口径一致（经 Blob 构造入参断言），mime 为 markdown
    expect(blobCtorCalls).toHaveLength(1);
    expect(blobCtorCalls[0]?.type).toBe('text/markdown;charset=utf-8');
    expect(blobCtorCalls[0]?.parts[0]).toBe(buildReviewCardsMarkdown(favorites));
    // 成功提示（与 HDU 学习中心同文案）
    expect(pushToastMock).toHaveBeenCalledWith('复习卡片已导出', 'success');
  });
});
