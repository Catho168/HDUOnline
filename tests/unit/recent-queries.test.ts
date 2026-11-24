/**
 * 最近搜索记录纯函数测试（第 246 轮巡检，搜索域 / 效率延续视角）。
 *
 * 覆盖 learning/recentQueries.ts 的行为约定：
 *  1. pushRecentQuery：去重前移（最新在前）/ cap 截断（默认 5）/ 空白与非法入参
 *     防御（trim 后空串、非字符串不记录）/ list 脏数据（非数组、含非字符串元素）
 *     / cap 非法回退默认 / 单条超长截断存储；
 *  2. removeRecentQuery：单条删除 / 不存在原样等价返回 / 非字符串入参防御；
 *  3. recentQueryLabel：超长截断加省略号、短词原样、非字符串空串。
 */

import { describe, expect, it } from 'vitest';
import {
  RECENT_QUERY_CAP,
  RECENT_QUERY_MAX_LEN,
  pushRecentQuery,
  recentQueryLabel,
  removeRecentQuery,
} from '@/entrypoints/content/ui/learning/recentQueries';

describe('pushRecentQuery（去重前移 + cap 截断 + 空白防御）', () => {
  it('新增词插到最前（最新在前）', () => {
    expect(pushRecentQuery(['高数', '线代'], '英语')).toEqual(['英语', '高数', '线代']);
    expect(pushRecentQuery([], '高数')).toEqual(['高数']);
  });

  it('重复词前移不重复：旧位置移除、置顶', () => {
    expect(pushRecentQuery(['线代', '高数', '英语'], '高数')).toEqual(['高数', '线代', '英语']);
    // 已在首位 = 无变化
    expect(pushRecentQuery(['高数', '线代'], '高数')).toEqual(['高数', '线代']);
  });

  it('cap 截断：超过 5 条淘汰最旧（默认 RECENT_QUERY_CAP）', () => {
    const next = pushRecentQuery(['a', 'b', 'c', 'd', 'e'], 'f');
    expect(next).toEqual(['f', 'a', 'b', 'c', 'd']);
    expect(next).toHaveLength(RECENT_QUERY_CAP);
  });

  it('重复词前移后不超 cap：5 条中前移中间词仍 5 条', () => {
    const list = ['a', 'b', 'c', 'd', 'e'];
    expect(pushRecentQuery(list, 'c')).toEqual(['c', 'a', 'b', 'd', 'e']);
    expect(pushRecentQuery(list, 'c')).toHaveLength(RECENT_QUERY_CAP);
  });

  it('空白与非法入参不记录：trim 后空串、非字符串返回规范化原列表', () => {
    expect(pushRecentQuery(['高数'], '   ')).toEqual(['高数']);
    expect(pushRecentQuery(['高数'], '')).toEqual(['高数']);
    expect(pushRecentQuery(['高数'], undefined)).toEqual(['高数']);
    expect(pushRecentQuery(['高数'], 42 as unknown as string)).toEqual(['高数']);
    expect(pushRecentQuery(['高数'], undefined)).toHaveLength(1);
  });

  it('入参前后空白 trim 后记录（语义按提交词归一）', () => {
    expect(pushRecentQuery(['高数'], '  线代  ')).toEqual(['线代', '高数']);
    // 与既有条目 trim 后相同 = 去重前移
    expect(pushRecentQuery(['线代', '高数'], ' 线代 ')).toEqual(['线代', '高数']);
  });

  it('list 脏数据防御：非数组按空表、混入非字符串元素被剔除', () => {
    expect(pushRecentQuery(null, '高数')).toEqual(['高数']);
    expect(pushRecentQuery(undefined, '高数')).toEqual(['高数']);
    expect(pushRecentQuery('高数' as unknown as string[], '线代')).toEqual(['线代']);
    expect(pushRecentQuery(['高数', 3, null, '线代'], '英语')).toEqual(['英语', '高数', '线代']);
  });

  it('cap 非法回退默认 5：0、负数、NaN、非数值', () => {
    expect(pushRecentQuery(['a', 'b'], 'c', 0)).toEqual(['c', 'a', 'b']);
    expect(pushRecentQuery(['a', 'b'], 'c', -1)).toEqual(['c', 'a', 'b']);
    expect(pushRecentQuery(['a', 'b'], 'c', Number.NaN)).toEqual(['c', 'a', 'b']);
    expect(pushRecentQuery(['a', 'b'], 'c', '3' as unknown as number)).toEqual(['c', 'a', 'b']);
    expect(pushRecentQuery(['a', 'b', 'c', 'd', 'e'], 'f', 2)).toEqual(['f', 'a']);
  });

  it('自定义 cap 生效（含 1 条的极小 cap）', () => {
    expect(pushRecentQuery(['a', 'b'], 'c', 1)).toEqual(['c']);
  });

  it('单条超长截断到存储上限（RECENT_QUERY_MAX_LEN）', () => {
    const long = 'k'.repeat(RECENT_QUERY_MAX_LEN + 50);
    const next = pushRecentQuery([], long);
    expect(next).toEqual([long.slice(0, RECENT_QUERY_MAX_LEN)]);
    expect(next[0]).toHaveLength(RECENT_QUERY_MAX_LEN);
  });
});

describe('removeRecentQuery（单条删除）', () => {
  it('删除存在的词；不存在原样等价返回（数量与顺序不变）', () => {
    expect(removeRecentQuery(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
    expect(removeRecentQuery(['a', 'b'], 'zzz')).toEqual(['a', 'b']);
    expect(removeRecentQuery([], 'a')).toEqual([]);
  });

  it('非法入参防御：非字符串 q / 非数组 list 不抛错', () => {
    expect(removeRecentQuery(['a'], undefined)).toEqual(['a']);
    expect(removeRecentQuery(['a'], 1 as unknown as string)).toEqual(['a']);
    expect(removeRecentQuery(null, 'a')).toEqual([]);
  });
});

describe('recentQueryLabel（chips 展示文本）', () => {
  it('超长截断加省略号；短词原样；非字符串空串', () => {
    expect(recentQueryLabel('一二三四五', 4)).toBe('一二三四…');
    expect(recentQueryLabel('短词', 16)).toBe('短词');
    expect(recentQueryLabel(undefined as unknown as string)).toBe('');
  });

  it('默认上限 16 字符', () => {
    const q = 'x'.repeat(20);
    expect(recentQueryLabel(q)).toBe(`${'x'.repeat(16)}…`);
    expect(recentQueryLabel('x'.repeat(16))).toHaveLength(16);
  });
});
