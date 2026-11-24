/**
 * 标签聚合单测（第 82 轮巡检）：collectTopTags——频次降序、同频字典序、limit 截断、
 * 脏数据防御。第 123 轮追加 collectTagCounts（标签看板：标签 + 次数）。
 */
import { describe, expect, it } from 'vitest';
import { collectTagCounts, collectTopTags } from '@/core/shared/tags';
import type { FavoriteEntity } from '@/core/shared/types';

function fav(tags: unknown): FavoriteEntity {
  return { id: 'f', type: 'video', tags } as unknown as FavoriteEntity;
}

describe('collectTopTags（知识库标签筛选，第 82 轮）', () => {
  it('按频次降序，同频按字典序；limit 截断', () => {
    const list = [
      fav(['高数', '线代']),
      fav(['高数']),
      fav(['高数', '概率论', '线代']),
      fav(['概率论']),
    ];
    expect(collectTopTags(list)).toEqual(['高数', '概率论', '线代']);
    expect(collectTopTags(list, 2)).toEqual(['高数', '概率论']);
  });

  it('脏数据防御：非对象/缺 tags/非字符串/空串标签逐条跳过', () => {
    const list = [
      fav(['  高数 ', '']),
      fav(undefined),
      { id: 'x' } as unknown as FavoriteEntity,
      null as unknown as FavoriteEntity,
    ];
    expect(collectTopTags(list)).toEqual(['高数']);
  });

  it('非数组入参返回空数组', () => {
    expect(collectTopTags(null as unknown as FavoriteEntity[])).toEqual([]);
    expect(collectTopTags('x' as unknown as FavoriteEntity[])).toEqual([]);
  });
});

describe('collectTagCounts（知识库标签看板，第 123 轮）', () => {
  it('返回标签 + 次数，频次降序、同频字典序；limit 截断', () => {
    const list = [
      fav(['高数', '线代']),
      fav(['高数']),
      fav(['高数', '概率论', '线代']),
      fav(['概率论']),
    ];
    expect(collectTagCounts(list)).toEqual([
      { tag: '高数', count: 3 },
      { tag: '概率论', count: 2 },
      { tag: '线代', count: 2 },
    ]);
    expect(collectTagCounts(list, 1)).toEqual([{ tag: '高数', count: 3 }]);
  });

  it('脏数据防御与 collectTopTags 同口径（名字列 = 看板的名字列）', () => {
    const list = [fav(['  高数 ', '']), fav(undefined), null as unknown as FavoriteEntity];
    expect(collectTagCounts(list)).toEqual([{ tag: '高数', count: 1 }]);
    expect(collectTagCounts(list).map((e) => e.tag)).toEqual(collectTopTags(list));
    expect(collectTagCounts(null as unknown as FavoriteEntity[])).toEqual([]);
  });
});
