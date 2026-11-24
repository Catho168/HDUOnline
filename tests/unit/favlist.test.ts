/** B 站收藏夹数据防御式映射测试：正常条目、缺字段、非视频条目、字段类型错误。 */

import { describe, expect, it } from 'vitest';
import { mapFavFolder, mapFavItem } from '@/core/bili/favlist';

describe('mapFavFolder', () => {
  it('正常条目映射为 { id, title, mediaCount }', () => {
    expect(mapFavFolder({ id: 608037, title: '高数网课', media_count: 42 })).toEqual({
      id: 608037,
      title: '高数网课',
      mediaCount: 42,
    });
  });

  it('缺字段：id / title 缺失返回 null，media_count 缺失回退 0', () => {
    expect(mapFavFolder({ id: 1 })).toBeNull();
    expect(mapFavFolder({ title: '只有标题' })).toBeNull();
    expect(mapFavFolder({ id: 1, title: '没有数量' })).toEqual({ id: 1, title: '没有数量', mediaCount: 0 });
  });

  it('非对象与字段类型错误返回 null', () => {
    expect(mapFavFolder(null)).toBeNull();
    expect(mapFavFolder(undefined)).toBeNull();
    expect(mapFavFolder([1, 2])).toBeNull();
    expect(mapFavFolder('folder')).toBeNull();
    expect(mapFavFolder({ id: '608037', title: '字符串 id' })).toBeNull();
    expect(mapFavFolder({ id: 1, title: 123 })).toBeNull();
    expect(mapFavFolder({ id: Number.NaN, title: 'NaN id' })).toBeNull();
  });

  it('title 去首尾空白；负数 media_count 钳制为 0', () => {
    expect(mapFavFolder({ id: 2, title: '  空白标题  ', media_count: -3 })).toEqual({
      id: 2,
      title: '空白标题',
      mediaCount: 0,
    });
  });
});

describe('mapFavItem', () => {
  it('正常视频条目：字段映射 + duration 秒数', () => {
    expect(
      mapFavItem({
        id: 521865104,
        type: 2,
        bvid: 'BV1Kb411W82v',
        title: '第 1 讲 线性代数入门',
        cover: 'https://i0.hdslb.com/bfs/archive/cover.jpg',
        upper: { mid: 9527, name: '网课 UP 主' },
        duration: 525,
        intro: '课程简介',
      }),
    ).toEqual({
      bvid: 'BV1Kb411W82v',
      title: '第 1 讲 线性代数入门',
      coverUrl: 'https://i0.hdslb.com/bfs/archive/cover.jpg',
      uploader: '网课 UP 主',
      durationSec: 525,
      intro: '课程简介',
    });
  });

  it('非视频条目（无 bvid）返回 null：音频 / 剧集 / 合集', () => {
    expect(mapFavItem({ id: 1, type: 1, title: '音频单曲' })).toBeNull();
    expect(mapFavItem({ id: 2, type: 21, title: '剧集' })).toBeNull();
    expect(mapFavItem({ id: 3, title: '合集占位' })).toBeNull();
  });

  it('兼容旧字段 bv_id', () => {
    expect(mapFavItem({ bv_id: 'BV1Kb411W82v', title: '旧字段条目' })?.bvid).toBe('BV1Kb411W82v');
  });

  it('缺字段：bvid 或 title 缺失返回 null，可选字段回退空值', () => {
    expect(mapFavItem({ bvid: 'BV1Kb411W82v' })).toBeNull();
    expect(mapFavItem({ title: '没有 bvid' })).toBeNull();
    expect(mapFavItem({ bvid: 'BV1Kb411W82v', title: '最简条目' })).toEqual({
      bvid: 'BV1Kb411W82v',
      title: '最简条目',
      coverUrl: '',
      uploader: '',
      durationSec: null,
      intro: '',
    });
  });

  it('字段类型错误返回 null / 回退空值', () => {
    expect(mapFavItem(null)).toBeNull();
    expect(mapFavItem('item')).toBeNull();
    expect(mapFavItem({ bvid: 123, title: '数字 bvid' })).toBeNull();
    const badDuration = mapFavItem({ bvid: 'BV1Kb411W82v', title: 't', duration: '600' });
    expect(badDuration?.durationSec).toBeNull();
    const negative = mapFavItem({ bvid: 'BV1Kb411W82v', title: 't', duration: -5 });
    expect(negative?.durationSec).toBeNull();
    const badUpper = mapFavItem({ bvid: 'BV1Kb411W82v', title: 't', upper: 'up' });
    expect(badUpper?.uploader).toBe('');
  });
});
