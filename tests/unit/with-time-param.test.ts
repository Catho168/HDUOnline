/**
 * withTimeParam 专项测试。
 *
 * 第 18 轮既有口径（回归）：无查询串用 ? 追加、有查询串用 & 追加（兼容 ?p= 分 P）、
 * 秒数向下取整并钳制非负。
 * 第 28 轮 P3-4（单点去重）：追加前先剥离 query 中已存在的 t= 参数——B 站收藏的
 * metadata.url 取自动作时的 location.href，可能已带 ?t=（从分享链接/进度跳转进入
 * 再收藏的场景），重复追加会让播放器只认其中一个 t=，续看落点产生歧义。
 * 消费方：unified 搜索跳转 / 今日待办 / 复习跳转 / VideoFavCard / LearningCenter。
 */

import { describe, expect, it } from 'vitest';
import { withTimeParam } from '@/core/shared/utils';

describe('withTimeParam（第 18 轮既有口径回归）', () => {
  it('无查询串 → ?t=；秒数向下取整并钳制非负', () => {
    expect(withTimeParam('https://www.bilibili.com/video/BV1abc', 95.7)).toBe(
      'https://www.bilibili.com/video/BV1abc?t=95',
    );
    expect(withTimeParam('https://www.bilibili.com/video/BV1abc', -5)).toBe(
      'https://www.bilibili.com/video/BV1abc?t=0',
    );
  });

  it('有查询串（?p= 分 P）→ &t= 追加', () => {
    expect(withTimeParam('https://www.bilibili.com/video/BV1abc?p=2', 120)).toBe(
      'https://www.bilibili.com/video/BV1abc?p=2&t=120',
    );
  });
});

describe('withTimeParam 已带 t= 时剥离再追加（第 28 轮 P3-4）', () => {
  it('仅 t= 参数：剥离后以 ?t= 重建（不残留旧值，也不多出 &）', () => {
    expect(withTimeParam('https://www.bilibili.com/video/BV1abc?t=100', 30)).toBe(
      'https://www.bilibili.com/video/BV1abc?t=30',
    );
  });

  it('t= 与其他参数混排：只剥离 t=，其余参数与相对顺序原样保留', () => {
    expect(withTimeParam('https://www.bilibili.com/video/BV1abc?p=2&t=100', 55)).toBe(
      'https://www.bilibili.com/video/BV1abc?p=2&t=55',
    );
    expect(withTimeParam('https://www.bilibili.com/video/BV1abc?t=100&p=2', 55)).toBe(
      'https://www.bilibili.com/video/BV1abc?p=2&t=55',
    );
    expect(withTimeParam('https://www.bilibili.com/video/BV1abc?spm=a1&t=100&p=2', 0)).toBe(
      'https://www.bilibili.com/video/BV1abc?spm=a1&p=2&t=0',
    );
  });

  it('重复 t= 的脏 URL 归一为单个 t=', () => {
    expect(withTimeParam('https://www.bilibili.com/video/BV1abc?t=100&t=200', 66)).toBe(
      'https://www.bilibili.com/video/BV1abc?t=66',
    );
  });

  it('at= 等形似参数不误删（仅精确剥离名为 t 的参数）', () => {
    expect(withTimeParam('https://www.bilibili.com/video/BV1abc?at=9&p=2', 7)).toBe(
      'https://www.bilibili.com/video/BV1abc?at=9&p=2&t=7',
    );
  });

  it('hash 片段原样保留（有 query / 无 query 皆然）', () => {
    expect(withTimeParam('https://www.bilibili.com/video/BV1abc?p=2&t=100#reply', 8)).toBe(
      'https://www.bilibili.com/video/BV1abc?p=2&t=8#reply',
    );
    expect(withTimeParam('https://www.bilibili.com/video/BV1abc#top', 8)).toBe(
      'https://www.bilibili.com/video/BV1abc?t=8#top',
    );
  });
});
