/**
 * 统一搜索测试：摘要窗口（buildSnippet）、聚合归并（mergeSearchResults）与
 * 仓储层检索（searchTranscriptsByCourse / searchNotes）。
 *
 * 纯函数部分与今日待办聚合器（today-plan.test.ts）同一套防御式口径；
 * 仓储部分使用 fake-indexeddb（每个测试文件独立实例，与 db.test.ts 不共享数据）。
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildSnippet,
  mergeSearchResults,
  normalizeKeyword,
  UNIFIED_GROUP_LABELS,
  DEFAULT_CAP_PER_SOURCE,
  SEARCH_FAVORITES_LIMIT,
  type UnifiedSearchParts,
  type UnifiedTranscriptPart,
} from '@/core/search/unified';
import { getDb } from '@/core/db';
import { searchTranscriptsByCourse } from '@/core/db/repo/content';
import { hduMediaKey } from '@/core/shared/mediaRef';
import { listFavorites, searchNotes } from '@/core/db/repo/library';
import type { FavoriteEntity, NoteEntity, TranscriptEntity } from '@/core/shared/types';

// ───────────────────────── 测试数据工厂 ─────────────────────────

function makeFav(id: string, overrides: Partial<FavoriteEntity> = {}): FavoriteEntity {
  return {
    id,
    type: 'video',
    refId: `BV${id}`,
    snapshot: { title: `视频 ${id}`, content: '' },
    tags: [],
    pinned: false,
    favoritedAt: 0,
    updatedAt: 0,
    ...overrides,
  } as FavoriteEntity;
}

function makeNote(id: string, overrides: Partial<NoteEntity> = {}): NoteEntity {
  return {
    id,
    courId: 101,
    teclId: 9,
    anchorTime: 30,
    text: `笔记 ${id}`,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeTranscriptPart(courId: number, overrides: Record<string, unknown> = {}): UnifiedTranscriptPart {
  return {
    courId,
    teclId: 9,
    hitCount: 1,
    best: { startSec: 10, text: '命中行列式的性质' },
    title: `课次 ${courId}`,
    ...overrides,
  } as UnifiedTranscriptPart;
}

const PARTS: UnifiedSearchParts = {
  transcripts: [makeTranscriptPart(101, { hitCount: 2 })],
  favorites: [
    makeFav('f1', { snapshot: { title: '行列式入门', content: '' }, updatedAt: 100 }),
    makeFav('f2', { snapshot: { title: '旧收藏', content: '讲讲行列式' }, updatedAt: 50 }),
  ],
  notes: [makeNote('n1', { text: '行列式的性质', updatedAt: 300 }), makeNote('n2', { text: '无关笔记', updatedAt: 999 })],
};

// ───────────────────────── buildSnippet ─────────────────────────

describe('buildSnippet（摘要窗口）', () => {
  it('命中时取 ±radius 窗口并以【】标注命中词，两侧截断补省略号', () => {
    const content = 'x'.repeat(50) + '今天讲行列式的定义' + 'y'.repeat(50);
    const snippet = buildSnippet(content, '行列式', 6);
    expect(snippet).toBe(`…${'x'.repeat(3)}今天讲【行列式】的定义${'y'.repeat(3)}…`);
  });

  it('内容较短时窗口覆盖全文，原样返回（无省略号）', () => {
    expect(buildSnippet('讲讲行列式', '行列式', 40)).toBe('讲讲【行列式】');
  });

  it('无命中时返回前 radius*2 字符；过短原样返回', () => {
    const content = 'ab'.repeat(60); // 120 字符
    expect(buildSnippet(content, '不存在', 5)).toBe(`${content.slice(0, 10)}…`);
    expect(buildSnippet('短内容', '不存在', 5)).toBe('短内容');
  });

  it('空输入返回空串；空关键词按无命中处理', () => {
    expect(buildSnippet('', '行列式')).toBe('');
    expect(buildSnippet('任意内容', '   ')).toBe('任意内容');
    expect(buildSnippet('a'.repeat(100), '')).toBe(`${'a'.repeat(80)}…`);
  });

  it('大小写不敏感，且命中词保留原文大小写', () => {
    expect(buildSnippet('The Determinant matters', 'determinant', 40)).toBe('The 【Determinant】 matters');
    expect(buildSnippet('THE DETERMINANT', 'determinant')).toBe('THE 【DETERMINANT】');
  });

  it('超长内容按窗口截断', () => {
    const content = 'x'.repeat(100) + 'needle' + 'y'.repeat(100);
    expect(buildSnippet(content, 'needle', 3)).toBe(`…${'x'.repeat(3)}【needle】${'y'.repeat(3)}…`);
  });
});

// ───────────────────────── mergeSearchResults ─────────────────────────

describe('mergeSearchResults（分组与映射）', () => {
  it('组顺序固定 transcript → favorite → note，空组不输出，标签与徽标同源', () => {
    const res = mergeSearchResults(PARTS, '行列式');
    expect(res.groups.map((g) => g.kind)).toEqual(['transcript', 'favorite', 'note']);
    expect(res.groups.map((g) => g.label)).toEqual(['字幕', '收藏', '笔记']);
    expect(res.groups.map((g) => g.label)).toEqual(
      res.groups.map((g) => UNIFIED_GROUP_LABELS[g.kind]),
    );
    expect(res.totalCount).toBe(4);
  });

  it('字幕条目：标题、锚点摘要与 course 跳转（teclId / anchorSec 齐全）', () => {
    const res = mergeSearchResults(
      { transcripts: [makeTranscriptPart(201, { hitCount: 3, best: { startSec: 75, text: '讲行列式的性质' } })], favorites: [], notes: [] },
      '行列式',
    );
    const item = res.groups[0]?.items[0];
    expect(item).toMatchObject({
      kind: 'transcript',
      title: '课次 201',
      anchorSec: 75,
      jump: { type: 'course', courId: 201, teclId: 9, anchorSec: 75 },
    });
    expect(item?.snippet.startsWith('01:15 · ')).toBe(true);
    expect(item?.snippet).toContain('【行列式】');
  });

  it('笔记条目：标题取内容首行，锚点秒数入摘要；video 收藏按 ?t= 续看规则出外链', () => {
    const res = mergeSearchResults(
      {
        transcripts: [],
        favorites: [
          makeFav('v1', {
            snapshot: { title: '行列式网课', content: '' },
            metadata: { url: 'https://www.bilibili.com/video/BV1?p=2', lastPositionSec: 90 },
          }),
        ],
        notes: [makeNote('n9', { courId: 301, teclId: 8, anchorTime: 45, text: '第一行 行列式\n第二行' })],
      },
      '行列式',
    );
    expect(res.groups[0]?.items[0]?.jump).toEqual({ type: 'url', url: 'https://www.bilibili.com/video/BV1?p=2&t=90' });
    const note = res.groups[1]?.items[0];
    expect(note).toMatchObject({
      kind: 'note',
      title: '第一行 行列式',
      anchorSec: 45,
      jump: { type: 'course', courId: 301, teclId: 8, anchorSec: 45 },
    });
    expect(note?.snippet.startsWith('00:45 · ')).toBe(true);
  });

  it('video 收藏无进度时从片头开始（不带 t 参数）；非 video 收藏走课次跳转', () => {
    const res = mergeSearchResults(
      {
        transcripts: [],
        favorites: [
          makeFav('fresh', { snapshot: { title: '行列式课程', content: '' }, metadata: { url: 'https://www.bilibili.com/video/BVf' } }),
          makeFav('fav-course', {
            type: 'time',
            snapshot: { title: '时间点 行列式', content: '' },
            courId: 401,
            teclId: 7,
            anchorTime: 120,
          }),
        ],
        notes: [],
      },
      '行列式',
    );
    expect(res.groups[0]?.items.map((i) => i.jump)).toEqual([
      { type: 'url', url: 'https://www.bilibili.com/video/BVf' },
      { type: 'course', courId: 401, teclId: 7, anchorSec: 120 },
    ]);
  });

  it('非 video 收藏无 courId 时回退 metadata.url；teclId / anchorSec 非有限数值时不带上', () => {
    const res = mergeSearchResults(
      {
        transcripts: [
          makeTranscriptPart(501, { hitCount: 1, teclId: 'oops', best: { startSec: Number.NaN, text: '行列式命中' } }),
        ],
        favorites: [makeFav('link', { type: 'time', snapshot: { title: '外链 行列式', content: '' }, metadata: { url: 'https://example.com/x' } })],
        notes: [],
      },
      '行列式',
    );
    expect(res.groups[0]?.items[0]?.jump).toEqual({ type: 'course', courId: 501 });
    expect(res.groups[1]?.items[0]?.jump).toEqual({ type: 'url', url: 'https://example.com/x' });
  });
});

describe('mergeSearchResults（B 站字幕条目收口，mediaKey-only）', () => {
  const BILI_PART_BASE = { courId: undefined, teclId: undefined };

  it('有收藏信息（op 层补齐 title/url）：标题取收藏 snapshot，命中秒数带进 ?t= 锚点', () => {
    const res = mergeSearchResults(
      {
        transcripts: [
          {
            ...BILI_PART_BASE,
            mediaKey: 'bili:BV1abc000001',
            hitCount: 2,
            best: { startSec: 75, text: '讲行列式的性质' },
            title: '线性代数网课',
            url: 'https://www.bilibili.com/video/BV1abc000001',
          } as never,
        ],
        favorites: [],
        notes: [],
      },
      '行列式',
    );
    expect(res.groups[0]?.items[0]).toMatchObject({
      kind: 'transcript',
      title: '线性代数网课',
      anchorSec: 75,
      jump: { type: 'url', url: 'https://www.bilibili.com/video/BV1abc000001?t=75' },
    });
    expect(res.groups[0]?.items[0]?.snippet.startsWith('01:15 · ')).toBe(true);
    expect(res.groups[0]?.items[0]?.snippet).toContain('【行列式】');
  });

  it('无收藏兜底：标题「B 站视频 <bvid>」，按 bvid 还原 URL 并带 ?t=', () => {
    const res = mergeSearchResults(
      {
        transcripts: [
          {
            ...BILI_PART_BASE,
            mediaKey: 'bili:BV1xyz000001',
            hitCount: 1,
            best: { startSec: 30, text: '矩阵乘法要点' },
          } as never,
        ],
        favorites: [],
        notes: [],
      },
      '矩阵',
    );
    expect(res.groups[0]?.items[0]).toMatchObject({
      title: 'B 站视频 BV1xyz000001',
      jump: { type: 'url', url: 'https://www.bilibili.com/video/BV1xyz000001?t=30' },
    });
  });

  it('?p= 分 P 兼容：URL 已带查询串时 ?t= 用 & 追加（与收藏续看同口径）', () => {
    const res = mergeSearchResults(
      {
        transcripts: [
          {
            ...BILI_PART_BASE,
            mediaKey: 'bili:BV1p00000001',
            hitCount: 1,
            best: { startSec: 90, text: '第二讲的行列式' },
            title: '多 P 网课',
            url: 'https://www.bilibili.com/video/BV1p00000001?p=2',
          } as never,
        ],
        favorites: [],
        notes: [],
      },
      '行列式',
    );
    expect(res.groups[0]?.items[0]?.jump).toEqual({
      type: 'url',
      url: 'https://www.bilibili.com/video/BV1p00000001?p=2&t=90',
    });
  });

  it('命中秒数换算：超过 1 小时按 h:mm:ss 展示并原值带入 ?t=', () => {
    const res = mergeSearchResults(
      {
        transcripts: [
          {
            ...BILI_PART_BASE,
            mediaKey: 'bili:BV1long00001',
            hitCount: 1,
            best: { startSec: 3661, text: '长视频里的行列式' },
            title: '长视频',
            url: 'https://www.bilibili.com/video/BV1long00001',
          } as never,
        ],
        favorites: [],
        notes: [],
      },
      '行列式',
    );
    expect(res.groups[0]?.items[0]?.snippet.startsWith('1:01:01 · ')).toBe(true);
    expect(res.groups[0]?.items[0]?.jump).toEqual({
      type: 'url',
      url: 'https://www.bilibili.com/video/BV1long00001?t=3661',
    });
  });

  it('best 缺失时跳转退化为不带 ?t= 的纯 URL；小数秒向下取整', () => {
    const res = mergeSearchResults(
      {
        transcripts: [
          { ...BILI_PART_BASE, mediaKey: 'bili:BV1best00001', hitCount: 1, best: null, title: '无锚点', url: 'https://www.bilibili.com/video/BV1best00001' } as never,
          { ...BILI_PART_BASE, mediaKey: 'bili:BV1frac00001', hitCount: 1, best: { startSec: 61.9, text: '行列式小数秒' } } as never,
        ],
        favorites: [],
        notes: [],
      },
      '行列式',
    );
    // 排序：有锚点的在前（次级键 startSec 升序），best 缺失（order=MAX_SAFE_INTEGER）垫底
    expect(res.groups[0]?.items[0]?.jump).toEqual({
      type: 'url',
      url: 'https://www.bilibili.com/video/BV1frac00001?t=61',
    });
    expect(res.groups[0]?.items[1]?.jump).toEqual({ type: 'url', url: 'https://www.bilibili.com/video/BV1best00001' });
  });

  it('courId 缺省且非 bili 键不崩：标题占位、不生成 jump（全链路防御）', () => {
    const res = mergeSearchResults(
      {
        transcripts: [
          { ...BILI_PART_BASE, mediaKey: 'hdu:888', hitCount: 1, best: { startSec: 5, text: '行列式' } } as never,
          { ...BILI_PART_BASE, mediaKey: 'weird-key', hitCount: 1, best: { startSec: 5, text: '行列式' } } as never,
          { ...BILI_PART_BASE, mediaKey: 'bili:BV1ok0000001', hitCount: 1, best: { startSec: 5, text: '行列式' }, url: 42 } as never,
        ],
        favorites: [],
        notes: [],
      },
      '行列式',
    );
    const items = res.groups[0]?.items ?? [];
    expect(items[0]).toMatchObject({ title: '课次 hdu:888' });
    expect(items[0]?.jump).toBeUndefined();
    expect(items[1]).toMatchObject({ title: '课次 weird-key' });
    expect(items[1]?.jump).toBeUndefined();
    // 非 bili 键且 url 字段不是字符串：不信任脏 url 字段，仍按 bvid 还原可跳转目标
    expect(items[2]).toMatchObject({ title: 'B 站视频 BV1ok0000001' });
    expect(items[2]?.jump).toEqual({ type: 'url', url: 'https://www.bilibili.com/video/BV1ok0000001?t=5' });
  });
});

describe('mergeSearchResults（多 P 跳转与站外 URL 协议白名单，第 16 轮）', () => {
  const BILI_PART_BASE = { courId: undefined, teclId: undefined };

  it('p≥2 分 P 键：跳转 URL 追加 ?p=N 再带 ?t= 命中秒（无收藏 url 时按 bvid 还原）', () => {
    const res = mergeSearchResults(
      {
        transcripts: [
          {
            ...BILI_PART_BASE,
            mediaKey: 'bili:BV1multi0001:p2',
            hitCount: 1,
            best: { startSec: 75, text: '第二讲的行列式' },
          } as never,
        ],
        favorites: [],
        notes: [],
      },
      '行列式',
    );
    expect(res.groups[0]?.items[0]?.jump).toEqual({
      type: 'url',
      url: 'https://www.bilibili.com/video/BV1multi0001?p=2&t=75',
    });
  });

  it('p≥2 分 P 键 + 收藏 url 已带查询串：p 与 t 均用 & 追加', () => {
    const res = mergeSearchResults(
      {
        transcripts: [
          {
            ...BILI_PART_BASE,
            mediaKey: 'bili:BV1multi0001:p3',
            hitCount: 1,
            best: { startSec: 90, text: '第三讲的行列式' },
            url: 'https://www.bilibili.com/video/BV1multi0001?spm=x',
          } as never,
        ],
        favorites: [],
        notes: [],
      },
      '行列式',
    );
    expect(res.groups[0]?.items[0]?.jump).toEqual({
      type: 'url',
      url: 'https://www.bilibili.com/video/BV1multi0001?spm=x&p=3&t=90',
    });
  });

  it('p≥2 分 P 键 + 收藏 url 已带 ?p=：不重复追加分 P 参数', () => {
    const res = mergeSearchResults(
      {
        transcripts: [
          {
            ...BILI_PART_BASE,
            mediaKey: 'bili:BV1multi0001:p2',
            hitCount: 1,
            best: { startSec: 30, text: '第二讲的行列式' },
            url: 'https://www.bilibili.com/video/BV1multi0001?p=2',
          } as never,
        ],
        favorites: [],
        notes: [],
      },
      '行列式',
    );
    expect(res.groups[0]?.items[0]?.jump).toEqual({
      type: 'url',
      url: 'https://www.bilibili.com/video/BV1multi0001?p=2&t=30',
    });
  });

  it('协议白名单：字幕条的脏 url（javascript:/ftp:）丢弃回退按 bvid 还原', () => {
    const res = mergeSearchResults(
      {
        transcripts: [
          {
            ...BILI_PART_BASE,
            mediaKey: 'bili:BV1safe000001',
            hitCount: 1,
            best: { startSec: 5, text: '行列式' },
            url: 'javascript:alert(1)',
          } as never,
          {
            ...BILI_PART_BASE,
            mediaKey: 'bili:BV1safe000002:p2',
            hitCount: 1,
            best: { startSec: 5, text: '行列式' },
            url: 'ftp://evil.example/BV1safe000002',
          } as never,
        ],
        favorites: [],
        notes: [],
      },
      '行列式',
    );
    const items = res.groups[0]?.items ?? [];
    expect(items[0]?.jump).toEqual({ type: 'url', url: 'https://www.bilibili.com/video/BV1safe000001?t=5' });
    expect(items[1]?.jump).toEqual({ type: 'url', url: 'https://www.bilibili.com/video/BV1safe000002?p=2&t=5' });
  });

  it('协议白名单：video 收藏的脏 metadata.url 丢弃回退按 bvid 还原；非 video 收藏不生成跳转', () => {
    const res = mergeSearchResults(
      {
        transcripts: [],
        favorites: [
          makeFav('evil-video', {
            snapshot: { title: '脏外链视频 行列式', content: '' },
            metadata: { platform: 'bilibili', bvid: 'BV1evil00001', url: 'javascript:alert(1)' },
          }),
          makeFav('evil-link', {
            type: 'time',
            snapshot: { title: '脏外链收藏 行列式', content: '' },
            metadata: { url: 'javascript:alert(1)' },
          }),
        ],
        notes: [],
      },
      '行列式',
    );
    const items = res.groups.find((g) => g.kind === 'favorite')?.items ?? [];
    expect(items).toHaveLength(2);
    expect(items[0]?.jump).toEqual({ type: 'url', url: 'https://www.bilibili.com/video/BV1evil00001' });
    expect(items[1]?.jump).toBeUndefined();
  });
});

describe('mergeSearchResults（排序与截断）', () => {
  it('字幕按课次命中数降序，并列时最佳锚点靠前的在前', () => {
    const res = mergeSearchResults(
      {
        transcripts: [
          makeTranscriptPart(1, { hitCount: 1, best: { startSec: 30, text: 'x 段行列式' } }),
          makeTranscriptPart(2, { hitCount: 5, best: { startSec: 90, text: 'y 段行列式' } }),
          makeTranscriptPart(3, { hitCount: 1, best: { startSec: 10, text: 'z 段行列式' } }),
        ],
        favorites: [],
        notes: [],
      },
      '行列式',
    );
    expect(res.groups[0]?.items.map((i) => i.title)).toEqual(['课次 2', '课次 3', '课次 1']);
  });

  it('收藏按 updatedAt 降序、笔记按 updatedAt 降序', () => {
    const res = mergeSearchResults(PARTS, '行列式');
    expect(res.groups[1]?.items.map((i) => i.title)).toEqual(['行列式入门', '旧收藏']);
    expect(res.groups[2]?.items.map((i) => i.title)).toEqual(['行列式的性质']);
  });

  it('每组截断至 capPerSource，total 保留截断前计数，totalCount 为截断前总和', () => {
    const favorites = Array.from({ length: 7 }, (_, i) =>
      makeFav(`c${i}`, { snapshot: { title: `行列式 ${i}`, content: '' }, updatedAt: 100 - i }),
    );
    const res = mergeSearchResults({ transcripts: [], favorites, notes: [] }, '行列式', { capPerSource: 3 });
    expect(res.groups).toHaveLength(1);
    expect(res.groups[0]?.items).toHaveLength(3);
    expect(res.groups[0]?.total).toBe(7);
    expect(res.totalCount).toBe(7);
    expect(res.groups[0]?.items.map((i) => i.title)).toEqual(['行列式 0', '行列式 1', '行列式 2']);
  });

  it('capPerSource 缺省取 DEFAULT_CAP_PER_SOURCE', () => {
    expect(DEFAULT_CAP_PER_SOURCE).toBe(5);
    const favorites = Array.from({ length: 8 }, (_, i) =>
      makeFav(`d${i}`, { snapshot: { title: `行列式 ${i}`, content: '' }, updatedAt: i }),
    );
    const res = mergeSearchResults({ transcripts: [], favorites, notes: [] }, '行列式');
    expect(res.groups[0]?.items).toHaveLength(5);
  });

  it('all 字段（第 260 轮）：截断组带全量条目（与 items 同序），未截断组 all 与 items 等长', () => {
    const favorites = Array.from({ length: 7 }, (_, i) =>
      makeFav(`e${i}`, { snapshot: { title: `行列式 ${i}`, content: '' }, updatedAt: 100 - i }),
    );
    const res = mergeSearchResults({ transcripts: [], favorites, notes: [] }, '行列式', { capPerSource: 3 });
    const group = res.groups[0];
    expect(group?.all).toHaveLength(7);
    expect(group?.all?.map((i) => i.title)).toEqual([
      '行列式 0', '行列式 1', '行列式 2', '行列式 3', '行列式 4', '行列式 5', '行列式 6',
    ]);
    expect(group?.items).toHaveLength(3);
    // 未截断组：all 与 items 同长同序
    const single = mergeSearchResults(
      { transcripts: [], favorites: [makeFav('f0', { snapshot: { title: '唯一的收藏', content: '' } })], notes: [] },
      '收藏',
    );
    expect(single.groups[0]?.all).toHaveLength(1);
    expect(single.groups[0]?.all?.[0]?.title).toBe(single.groups[0]?.items[0]?.title);
  });
});

describe('mergeSearchResults（关键词与防御式解析）', () => {
  it('空关键词 / 纯空白直接返回空结果', () => {
    expect(mergeSearchResults(PARTS, '')).toEqual({ groups: [], totalCount: 0, favoritesTruncated: false });
    expect(mergeSearchResults(PARTS, '   ')).toEqual({ groups: [], totalCount: 0, favoritesTruncated: false });
    expect(normalizeKeyword(undefined)).toBe('');
  });

  it('脏数据不抛错：非对象条目、字段类型不对、已删除条目被剔除或安全降级', () => {
    const res = mergeSearchResults(
      {
        transcripts: [
          null,
          42,
          {},
          { courId: 'x', hitCount: 3 },
          { courId: 601, hitCount: 2, best: null },
          makeTranscriptPart(602, { hitCount: 0 }) as never,
        ],
        favorites: [
          null,
          5,
          {},
          makeFav('gone', { snapshot: { title: '行列式已删', content: '' }, deletedAt: 123 }),
          makeFav('nokey', { snapshot: { title: '与关键词无关', content: '' } }),
          makeFav('ok', { snapshot: { title: '行列式', content: '' }, updatedAt: 1 }),
        ],
        notes: [null, {}, makeNote('notext', { text: '' }), makeNote('gone', { text: '行列式已删', deletedAt: 9 }), makeNote('ok', { text: '行列式', updatedAt: 2 })],
      } as never,
      '行列式',
    );
    expect(res.groups.map((g) => g.kind)).toEqual(['transcript', 'favorite', 'note']);
    // 仅 courId 为有限数值且 hitCount > 0 的字幕条目存活（best 缺失时退回标题做摘要）
    expect(res.groups[0]?.items.map((i) => i.title)).toEqual(['课次 601']);
    expect(res.groups[1]?.items.map((i) => i.title)).toEqual(['行列式']);
    expect(res.groups[2]?.items.map((i) => i.title)).toEqual(['行列式']);
    expect(res.totalCount).toBe(3);
  });

  it('parts 缺失或整体不合法时返回空结果', () => {
    expect(() => mergeSearchResults(undefined as never, '行列式')).not.toThrow();
    expect(mergeSearchResults(undefined as never, '行列式')).toEqual({ groups: [], totalCount: 0, favoritesTruncated: false });
    expect(mergeSearchResults({} as never, '行列式')).toEqual({ groups: [], totalCount: 0, favoritesTruncated: false });
  });
});

describe('mergeSearchResults（收藏截断标记 favoritesTruncated，第 18 轮）', () => {
  it('SEARCH_FAVORITES_LIMIT 契约：op 层收藏路查询上限与 UI 提示文案共用 30', () => {
    expect(SEARCH_FAVORITES_LIMIT).toBe(30);
  });

  it('parts.favoritesTruncated 原样透传（true → true；缺省 / 显式 false → false）', () => {
    expect(mergeSearchResults({ ...PARTS, favoritesTruncated: true }, '行列式').favoritesTruncated).toBe(true);
    expect(mergeSearchResults(PARTS, '行列式').favoritesTruncated).toBe(false);
    expect(mergeSearchResults({ ...PARTS, favoritesTruncated: false }, '行列式').favoritesTruncated).toBe(false);
  });

  it('脏标记（非 true 值）按未截断处理；空关键词恒为 false', () => {
    expect(mergeSearchResults({ ...PARTS, favoritesTruncated: 'yes' } as never, '行列式').favoritesTruncated).toBe(false);
    expect(mergeSearchResults({ ...PARTS, favoritesTruncated: 1 } as never, '行列式').favoritesTruncated).toBe(false);
    expect(mergeSearchResults({ ...PARTS, favoritesTruncated: true }, '').favoritesTruncated).toBe(false);
  });

  it('标记不改变分组内容与排序（只加如实提示，不改搜索行为）', () => {
    const withFlag = mergeSearchResults({ ...PARTS, favoritesTruncated: true }, '行列式');
    const without = mergeSearchResults(PARTS, '行列式');
    expect(withFlag.groups).toEqual(without.groups);
    expect(withFlag.totalCount).toBe(without.totalCount);
    expect(withFlag.favoritesTruncated).toBe(true);
  });
});

// ───────────────────────── 仓储层检索 ─────────────────────────

describe('统一搜索仓储检索', () => {
  beforeAll(async () => {
    await getDb();
    const db = await getDb();
    const now = Date.now();
    await db.put('sessions', {
      courId: 31001,
      teclId: 9301,
      beginTime: new Date(now - 3_600_000).toISOString(),
      endTime: new Date(now - 1_800_000).toISOString(),
      watchState: 'watching',
      courseName: '线性代数',
      courLabel: '第5周 / 线性代数 / 第12节课',
      updatedAt: now,
    });
    await db.put('sessions', {
      courId: 31002,
      teclId: 9302,
      beginTime: new Date(now - 7 * 86_400_000).toISOString(),
      endTime: new Date(now - 6 * 86_400_000).toISOString(),
      watchState: 'unwatched',
      courseName: '线性代数',
      courLabel: '第4周 / 线性代数 / 第11节课',
      updatedAt: now,
    });
    const transcripts: TranscriptEntity[] = [
      {
        mediaKey: hduMediaKey(31001),
        courId: 31001,
        segments: [
          { s: 10, e: 15, text: '今天讲行列式的定义' },
          { s: 20, e: 25, text: '行列式有三个性质' },
          { s: 30, e: 35, text: '无关内容' },
        ],
        model: 'fast',
        lang: 'zh',
        glossaryVersion: 1,
        createdAt: now,
        source: 'local-asr',
      },
      {
        mediaKey: hduMediaKey(31002),
        courId: 31002,
        segments: [{ s: 5, e: 9, text: '回顾行列式' }],
        model: 'fast',
        lang: 'zh',
        glossaryVersion: 1,
        createdAt: now,
        source: 'local-asr',
      },
      {
        mediaKey: hduMediaKey(31003),
        courId: 31003,
        segments: [{ s: 0, e: 6, text: 'The determinant is key' }],
        model: 'fast',
        lang: 'en',
        glossaryVersion: 1,
        createdAt: now,
        source: 'local-asr',
      },
    ];
    for (const transcript of transcripts) await db.put('transcripts', transcript);
    await db.put('notes', makeNote('rn1', { courId: 31001, teclId: 9301, anchorTime: 15, text: '行列式这里注意符号', updatedAt: 100 }));
    await db.put('notes', makeNote('rn2', { courId: 31001, teclId: 9301, anchorTime: 40, text: '无关笔记', updatedAt: 200 }));
    await db.put('notes', makeNote('rn3', { text: '行列式已删除', updatedAt: 300, deletedAt: 5 }));
  });

  it('searchTranscriptsByCourse：按课次聚合命中数、回查 teclId、按命中数降序', async () => {
    const hits = await searchTranscriptsByCourse('行列式');
    expect(hits.map((h) => h.courId)).toEqual([31001, 31002]);
    expect(hits[0]?.hitCount).toBe(2);
    expect(hits[0]?.teclId).toBe(9301);
    // best 取评分最高的命中段：位置越靠前越高（第二段开头即命中，胜过第一段中部）
    expect(hits[0]?.best?.startSec).toBe(20);
    expect(hits[0]?.best?.text).toBe('行列式有三个性质');
    expect(hits[1]?.hitCount).toBe(1);
  });

  it('searchTranscriptsByCourse：大小写不敏感；totalLimit 截断；空关键词返回空', async () => {
    expect(await searchTranscriptsByCourse('  ')).toEqual([]);
    const en = await searchTranscriptsByCourse('DETERMINANT');
    expect(en).toHaveLength(1);
    expect(en[0]?.courId).toBe(31003);
    const capped = await searchTranscriptsByCourse('行列式', { totalLimit: 1 });
    expect(capped).toHaveLength(1);
    expect(capped[0]?.courId).toBe(31001);
  });

  it('searchNotes：正文包含匹配、按 updatedAt 降序、剔除已删除', async () => {
    const notes = await searchNotes('行列式');
    expect(notes.map((n) => n.id)).toEqual(['rn1']);
    expect(await searchNotes('  ')).toEqual([]);
    expect(await searchNotes('不存在词')).toEqual([]);
  });

  it('listFavorites keyword：标题 / 内容 / 备注任一命中即返回', async () => {
    const db = await getDb();
    await db.put('favorites', makeFav('kw-title', { snapshot: { title: '行列式卡片', content: '' } }));
    await db.put('favorites', makeFav('kw-content', { snapshot: { title: '卡片', content: '关于行列式' } }));
    await db.put('favorites', makeFav('kw-note', { snapshot: { title: '卡片', content: '' }, note: '行列式备注' }));
    const hits = await listFavorites({ keyword: '行列式' });
    expect(hits.map((f) => f.id).sort()).toEqual(['kw-content', 'kw-note', 'kw-title']);
    // 标题 + 内容之外的 note 字段也在匹配范围（listFavorites 既有语义）
    expect(hits.find((f) => f.id === 'kw-note')?.note).toBe('行列式备注');
  });
});

describe('mergeSearchResults（置顶收藏，第 287 轮）', () => {
  it('pinnedFirst 排序优先 + 条目携带 pinned 徽标数据', () => {
    // 输入顺序模拟 repo listFavorites({ pinnedFirst: true }) 的返回（置顶在前）
    const favorites = [
      makeFav('p2', { snapshot: { title: '置顶收藏', content: '' }, updatedAt: 50, pinned: true }),
      makeFav('p1', { snapshot: { title: '普通收藏', content: '' }, updatedAt: 100 }),
    ];
    const res = mergeSearchResults({ transcripts: [], favorites, notes: [] }, '收藏');
    expect(res.groups[0]?.items.map((i) => i.title)).toEqual(['置顶收藏', '普通收藏']);
    expect(res.groups[0]?.items[0]?.pinned).toBe(true);
    expect(res.groups[0]?.items[1]?.pinned).toBeUndefined();
  });
});
