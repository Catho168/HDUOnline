/**
 * 标签聚合（第 82 轮巡检）：从收藏列表统计高频标签，供知识库标签筛选 chips 使用。
 * 纯函数、防御式（脏数据逐条跳过）。
 */

import type { FavoriteEntity } from './types';

/**
 * 收藏列表 → 标签频次表（频次降序，同频按标签名字典序；limit 缺省 8，非法回退）。
 * 标签来源：fav.tags 数组（去空格首尾、跳过空串；大小写原样保留——筛选时大小写敏感
 * 与既有搜索过滤的 toLowerCase 口径不同，这里保持标签原样以便精确匹配）。
 * 第 123 轮巡检抽出共享：标签看板需要「标签 + 次数」，topTags 仅取名字列。
 */
export function collectTagCounts(favorites: FavoriteEntity[], limit: number = 8): Array<{ tag: string; count: number }> {
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 8;
  const counts = new Map<string, number>();
  for (const fav of Array.isArray(favorites) ? favorites : []) {
    if (!fav || typeof fav !== 'object' || !Array.isArray(fav.tags)) continue;
    for (const tag of fav.tags) {
      if (typeof tag !== 'string') continue;
      const value = tag.trim();
      if (!value) continue;
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0] < b[0] ? -1 : 1))
    .slice(0, max)
    .map(([tag, count]) => ({ tag, count }));
}

/** 收藏列表 → 高频标签名列表（频次降序；标签看板/筛选 chips 共用的聚合口径） */
export function collectTopTags(favorites: FavoriteEntity[], limit: number = 8): string[] {
  return collectTagCounts(favorites, limit).map((entry) => entry.tag);
}
