/**
 * search.all 收藏路截断标记（第 18 轮审计留观项「listFavorites 截断」）：
 * fake-indexeddb 全链路（op handler → listFavorites → 聚合器，照 unified-search-bili.test.ts 模式）。
 *
 * 语义核实（源码口径）：repo 的 listFavorites 本身无硬上限（缺省 MAX_SAFE_INTEGER），
 * 截断发生在 op 层——search.all 按 keyword 只取最近 SEARCH_FAVORITES_LIMIT(30) 条匹配
 * （favoritedAt 降序后截取），多取 1 条探测是否触顶；capPerSource=5 是每组展示条数上限，
 * 与查询截断是两回事。
 *
 * 覆盖：
 *  1. 匹配数 > 30（触顶）：favoritesTruncated=true，收藏组只考虑最近 30 条（total=30），
 *     更旧匹配不进入搜索；展示仍受 capPerSource=5 约束；
 *  2. 匹配数恰为 30：探测位为空，favoritesTruncated=false；
 *  3. 匹配数 < 30：favoritesTruncated=false；
 *  4. 空关键词：不查库，恒为未截断。
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '@/core/db';
import { dispatchOp } from '@/entrypoints/background/ops';
import { SEARCH_FAVORITES_LIMIT } from '@/core/search/unified';
import type { FavoriteEntity } from '@/core/shared/types';

const BASE = 1700000000000 - 100 * 86_400_000;

function makeFav(id: string, title: string, favoritedAt: number): FavoriteEntity {
  return {
    id,
    type: 'time',
    snapshot: { title, content: '' },
    folderId: null,
    tags: [],
    pinned: false,
    favoritedAt,
    updatedAt: favoritedAt,
  };
}

/** 批量写入 count 条标题含 keyword 的收藏：favoritedAt 随 i 递增，保证「最近 N 条」可断言 */
async function seedMatches(keyword: string, count: number): Promise<void> {
  const db = await getDb();
  for (let i = 0; i < count; i += 1) {
    await db.put('favorites', makeFav(`fav-${keyword}-${String(i).padStart(3, '0')}`, `${keyword} 收藏 ${i}`, BASE + i * 1000));
  }
}

beforeAll(async () => {
  await seedMatches('触顶词', SEARCH_FAVORITES_LIMIT + 2); // 32 条匹配 → 触顶
  await seedMatches('边界词', SEARCH_FAVORITES_LIMIT); // 恰 30 条 → 未触顶
  await seedMatches('少量词', 2); // 2 条 → 未触顶
  const db = await getDb();
  await db.put('favorites', makeFav('fav-noise', '与关键词无关', 1700000000000));
});

describe('search.all 收藏路截断标记（op 全链路）', () => {
  it('匹配数超上限：favoritesTruncated=true，收藏组只考虑最近 30 条，展示仍受 capPerSource=5', async () => {
    const res = await dispatchOp('search.all', { keyword: '触顶词' });
    expect(res.favoritesTruncated).toBe(true);
    const group = res.groups.find((g) => g.kind === 'favorite');
    // 查询截断：仅最近 SEARCH_FAVORITES_LIMIT 条匹配参与搜索（更旧 2 条不进入）
    expect(group?.total).toBe(SEARCH_FAVORITES_LIMIT);
    // 展示截断：每组最多 capPerSource=5 条（与查询截断是两回事）
    expect(group?.items).toHaveLength(5);
    // 排序不变：最新匹配排最前
    expect(group?.items[0]?.title).toBe('触顶词 收藏 31');
  });

  it('匹配数恰为上限（30）：多取的探测位为空，未触顶', async () => {
    const res = await dispatchOp('search.all', { keyword: '边界词' });
    expect(res.favoritesTruncated).toBe(false);
    const group = res.groups.find((g) => g.kind === 'favorite');
    expect(group?.total).toBe(SEARCH_FAVORITES_LIMIT);
  });

  it('匹配数低于上限：未触顶，条目齐全', async () => {
    const res = await dispatchOp('search.all', { keyword: '少量词' });
    expect(res.favoritesTruncated).toBe(false);
    const group = res.groups.find((g) => g.kind === 'favorite');
    expect(group?.total).toBe(2);
    expect(group?.items).toHaveLength(2);
  });

  it('空关键词：不查库，恒为未截断', async () => {
    const res = await dispatchOp('search.all', { keyword: '   ' });
    expect(res.groups).toEqual([]);
    expect(res.totalCount).toBe(0);
    expect(res.favoritesTruncated).toBe(false);
  });
});
