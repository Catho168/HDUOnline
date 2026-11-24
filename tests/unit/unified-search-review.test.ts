/**
 * 统一搜索第四组（复习）与匹配归一化测试（第 245 轮巡检，搜索域 / 效率视角）。
 *
 * 覆盖 core/search/unified.ts 的行为约定：
 *  1. normalizeQueryText / matchNoteQuery：归一化（大小写、连续空白折叠、特殊字符
 *     按字面）、空 query 恒 false、已删除/无正文笔记 false；
 *  2. buildReviewEntries：只收 pending、标题+标签归一化包含匹配、同收藏多轮去重
 *     （留最早到期）、favorite 缺失/已删除不成条、跳转复用收藏规则（video → ?t=
 *     外链，站内 → course）、脏 dueDate 排后；
 *  3. mergeSearchResults：复习组追加在字幕/收藏/笔记之后（既有组的序号不受影响），
 *     空复习组不输出，capPerSource 截断与 total 保留。
 */

import { describe, expect, it } from 'vitest';
import type { FavoriteEntity, NoteEntity } from '@/core/shared/types';
import {
  buildReviewEntries,
  matchNoteQuery,
  mergeSearchResults,
  normalizeQueryText,
  UNIFIED_GROUP_LABELS,
  type UnifiedSearchParts,
} from '@/core/search/unified';

// ───────────────────────── normalizeQueryText / matchNoteQuery ─────────────────────────

describe('normalizeQueryText（查询归一化）', () => {
  it('大小写不敏感', () => {
    expect(normalizeQueryText('Linear Algebra')).toBe('linear algebra');
    expect(normalizeQueryText('LINEAR')).toBe('linear');
  });

  it('连续空白折叠为单个空格；首尾空白去除', () => {
    expect(normalizeQueryText('  行  列式\t性质 \n')).toBe('行 列式 性质');
  });

  it('非字符串返回空串；空串 / 纯空白 → 空串', () => {
    expect(normalizeQueryText(undefined)).toBe('');
    expect(normalizeQueryText(123 as unknown as string)).toBe('');
    expect(normalizeQueryText('   ')).toBe('');
    expect(normalizeQueryText('')).toBe('');
  });
});

describe('matchNoteQuery（笔记归一化匹配）', () => {
  const note = { id: 'n1', text: 'The Determinant  properties', updatedAt: 1 };

  it('大小写 / 空白不敏感的包含匹配', () => {
    expect(matchNoteQuery(note, 'determinant')).toBe(true);
    expect(matchNoteQuery(note, 'DETERMINANT')).toBe(true);
    expect(matchNoteQuery(note, 'determinant  properties')).toBe(true); // 双空格 query
  });

  it('空 query / 纯空白 query 恒 false（不当全量命中）', () => {
    expect(matchNoteQuery(note, '')).toBe(false);
    expect(matchNoteQuery(note, '   ')).toBe(false);
    expect(matchNoteQuery(note, undefined)).toBe(false);
  });

  it('未命中 / 已删除 / 无正文 / 脏输入 → false', () => {
    expect(matchNoteQuery(note, '矩阵')).toBe(false);
    expect(matchNoteQuery({ ...note, deletedAt: 1 }, 'determinant')).toBe(false);
    expect(matchNoteQuery({ id: 'n2' }, 'determinant')).toBe(false);
    expect(matchNoteQuery(null, 'determinant')).toBe(false);
    expect(matchNoteQuery('text', 'text')).toBe(false);
  });

  it('特殊字符按字面匹配（不做正则解析）', () => {
    const math = { text: 'f(x) = a.b + (c|d)' };
    expect(matchNoteQuery(math, 'a.b')).toBe(true);
    expect(matchNoteQuery(math, '(c|d)')).toBe(true);
    expect(matchNoteQuery(math, '(cx')).toBe(false);
  });
});

// ───────────────────────── buildReviewEntries ─────────────────────────

function makeFav(id: string, title: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    type: 'video',
    refId: `BV${id}`,
    snapshot: { title, content: '' },
    tags: [],
    favoritedAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'job-1',
    favoriteId: 'f1',
    dueDate: '2026-11-25',
    round: 2,
    template: 'regular',
    status: 'pending',
    favorite: makeFav('f1', '行列式入门'),
    ...overrides,
  };
}

describe('buildReviewEntries（复习组条目构造）', () => {
  it('pending 作业命中收藏标题：kind=review、摘要带轮次与到期日', () => {
    const hits = buildReviewEntries([makeJob()], '行列式');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: 'review', title: '行列式入门', snippet: '第 2 轮 · 2026-11-25 到期' });
  });

  it('标签命中：标题不含关键词但标签含时命中', () => {
    const job = makeJob({ favorite: makeFav('f1', '第 3 讲', { tags: ['线性代数', '重点'] }) });
    const hits = buildReviewEntries([job], '重点');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.title).toBe('第 3 讲');
  });

  it('归一化匹配：大小写 / 多余空白不敏感', () => {
    const job = makeJob({ favorite: makeFav('f1', 'Linear Algebra L1') });
    expect(buildReviewEntries([job], 'linear algebra')).toHaveLength(1);
    expect(buildReviewEntries([job], 'LINEAR   algebra')).toHaveLength(1);
  });

  it('只收 pending：done / skipped 作业不成条', () => {
    const jobs = [makeJob({ status: 'done' }), makeJob({ id: 'job-2', status: 'skipped' })];
    expect(buildReviewEntries(jobs, '行列式')).toHaveLength(0);
  });

  it('favorite 缺失 / 已删除 / 无标题的作业不成条', () => {
    const jobs = [
      makeJob({ favorite: null }),
      makeJob({ id: 'job-2', favorite: makeFav('f1', 'x', { deletedAt: 1 }) }),
      makeJob({ id: 'job-3', favorite: makeFav('f1', '', { snapshot: {} }) }),
      makeJob({ id: 'job-4', favorite: {} }),
    ];
    expect(buildReviewEntries(jobs, '行列式')).toHaveLength(0);
  });

  it('同收藏多轮 pending 去重：只留最早到期一条', () => {
    const jobs = [
      makeJob({ id: 'job-3', dueDate: '2026-12-01', round: 3 }),
      makeJob({ id: 'job-1', dueDate: '2026-11-25', round: 2 }),
      makeJob({ id: 'job-2', dueDate: '2026-11-26', round: 2 }),
    ];
    const hits = buildReviewEntries(jobs, '行列式');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet).toContain('2026-11-25');
  });

  it('video 收藏 → url 跳转（带 ?t= 续看）；站内收藏 → course 跳转', () => {
    const videoJob = makeJob({ favorite: makeFav('f1', '行列式', { metadata: { url: 'https://www.bilibili.com/video/BV1', lastPositionSec: 90 } }) });
    const internalJob = makeJob({ favorite: makeFav('f2', '高数', { type: 'note', refId: undefined, courId: 501, teclId: 9 }) });
    const [videoHit] = buildReviewEntries([videoJob], '行列式');
    const [internalHit] = buildReviewEntries([internalJob], '高数');
    expect(videoHit?.jump).toEqual({ type: 'url', url: 'https://www.bilibili.com/video/BV1?t=90' });
    expect(internalHit?.jump).toEqual({ type: 'course', courId: 501, teclId: 9 });
  });

  it('空关键词 / 无匹配 → 空数组；脏输入不抛错', () => {
    expect(buildReviewEntries([makeJob()], '')).toHaveLength(0);
    expect(buildReviewEntries([makeJob()], '   ')).toHaveLength(0);
    expect(buildReviewEntries([makeJob()], '不存在的关键词')).toHaveLength(0);
    expect(buildReviewEntries([null, 'x', 42, {}], '行列式')).toHaveLength(0);
    expect(buildReviewEntries(undefined as unknown as unknown[], '行列式')).toHaveLength(0);
  });

  it('脏 dueDate 条目排最后且不覆盖有效条目', () => {
    const jobs = [
      makeJob({ id: 'job-bad', dueDate: 'bad-date' }),
      makeJob({ id: 'job-ok', dueDate: '2026-11-25' }),
    ];
    const hits = buildReviewEntries(jobs, '行列式');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet).toContain('2026-11-25');
  });
});

// ───────────────────────── mergeSearchResults（复习组接入） ─────────────────────────

describe('mergeSearchResults（复习组接入聚合）', () => {
  const PARTS: UnifiedSearchParts = {
    transcripts: [],
    favorites: [],
    notes: [],
    reviews: [makeJob()],
  };

  it('复习组输出在最后，组标题=复习；既有三组为空时不输出', () => {
    const res = mergeSearchResults(PARTS, '行列式');
    expect(res.groups.map((g) => UNIFIED_GROUP_LABELS[g.kind])).toEqual(['复习']);
    expect(res.totalCount).toBe(1);
    expect(res.groups[0]?.total).toBe(1);
  });

  it('四组齐全时顺序固定：字幕 → 收藏 → 笔记 → 复习（既有组序号不受影响）', () => {
    const res = mergeSearchResults(
      {
        transcripts: [{ courId: 101, teclId: 9, hitCount: 1, best: { startSec: 10, text: '讲行列式' } }],
        favorites: [makeFav('f9', '行列式习题', { updatedAt: 10 }) as unknown as FavoriteEntity],
        notes: [{ id: 'n1', text: '行列式的性质', updatedAt: 5 } as unknown as NoteEntity],
        reviews: [makeJob()],
      },
      '行列式',
    );
    expect(res.groups.map((g) => g.kind)).toEqual(['transcript', 'favorite', 'note', 'review']);
    expect(res.groups[3]?.items[0]?.title).toBe('行列式入门');
  });

  it('复习组同样受 capPerSource 截断，total 保留截断前计数', () => {
    const manyFavs = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((ch, i) => makeFav(`fav-${ch}`, `行列式 ${i}`));
    const jobs = manyFavs.map((fav, i) => makeJob({ id: `job-${i}`, favoriteId: `fav-${fav.id}`, favorite: fav, dueDate: `2026-11-${String(10 + i).padStart(2, '0')}` }));
    const res = mergeSearchResults({ transcripts: [], favorites: [], notes: [], reviews: jobs }, '行列式', { capPerSource: 3 });
    expect(res.groups[0]?.items).toHaveLength(3);
    expect(res.groups[0]?.total).toBe(7);
    expect(res.totalCount).toBe(7);
  });

  it('reviews 路脏输入（非数组）安全降级为无复习组', () => {
    const res = mergeSearchResults({ transcripts: [], favorites: [], notes: [], reviews: 'garbage' as unknown as unknown[] }, '行列式');
    expect(res.groups).toHaveLength(0);
  });
});
