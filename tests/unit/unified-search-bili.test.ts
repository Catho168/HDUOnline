/**
 * search.all 对 B 站字幕条目的收口（第 15 轮）：fake-indexeddb 全链路
 * （op handler → 收藏回查 → 聚合器，照 bili-subtitle-op.test.ts 模式）。
 *
 * 覆盖：
 *  1. 有收藏：标题取视频收藏 snapshot.title，url 取 metadata.url（兼容 ?p=），
 *     jump = `?t=<命中秒>` 的站外跳转，anchorSec / 摘要时钟与纯函数口径一致；
 *  2. 无收藏：兜底标题「B 站视频 <bvid>」+ 按 bvid 还原的 URL；
 *  3. 向后兼容：站内课次（有 courId）仍走 session 标题 + course 跳转，不受影响；
 *  4. 第 16 轮：p≥2 分 P 键跳转追加分 P 参数；收藏 url 过 http(s) 协议白名单。
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '@/core/db';
import { dispatchOp } from '@/entrypoints/background/ops';
import { hduMediaKey } from '@/core/shared/mediaRef';
import type { FavoriteEntity, TranscriptEntity } from '@/core/shared/types';

const NOW = 1700000000000;

function makeVideoFav(bvid: string, overrides: Partial<FavoriteEntity> = {}): FavoriteEntity {
  return {
    id: `fav-${bvid}`,
    type: 'video',
    refId: bvid,
    snapshot: { title: `视频 ${bvid}`, content: '' },
    folderId: null,
    tags: [],
    pinned: false,
    favoritedAt: NOW,
    updatedAt: NOW,
    metadata: { platform: 'bilibili', bvid, url: `https://www.bilibili.com/video/${bvid}` },
    ...overrides,
  } as FavoriteEntity;
}

function makeBiliTranscript(bvid: string, segments: TranscriptEntity['segments']): TranscriptEntity {
  return {
    mediaKey: `bili:${bvid}`,
    segments,
    model: 'bili-official-subtitle',
    lang: 'zh-CN',
    glossaryVersion: 0,
    createdAt: NOW,
    source: 'bili-official-subtitle',
  };
}

beforeAll(async () => {
  const db = await getDb();
  // 有收藏 + metadata.url 带 ?p= 分 P（收藏时页面 URL 原样保存的口径）
  await db.put('favorites', makeVideoFav('BVfav0000001', {
    snapshot: { title: '线性代数网课', content: '' },
    metadata: { platform: 'bilibili', bvid: 'BVfav0000001', url: 'https://www.bilibili.com/video/BVfav0000001?p=2' },
  }));
  await db.put('transcripts', makeBiliTranscript('BVfav0000001', [{ s: 75, e: 80, text: '行列式的性质很好用' }]));
  // 无收藏
  await db.put('transcripts', makeBiliTranscript('BVnofav00001', [{ s: 90, e: 95, text: '矩阵乘法要点' }]));
  // 站内课次（向后兼容基线）
  await db.put('sessions', {
    courId: 31001,
    teclId: 9301,
    beginTime: new Date(NOW - 3_600_000).toISOString(),
    endTime: new Date(NOW - 1_800_000).toISOString(),
    watchState: 'watching',
    courseName: '线性代数',
    courLabel: '第5周 / 线性代数 / 第12节课',
    updatedAt: NOW,
  });
  await db.put('transcripts', {
    mediaKey: hduMediaKey(31001),
    courId: 31001,
    segments: [{ s: 20, e: 25, text: '泰勒展开公式' }],
    model: 'fast',
    lang: 'zh',
    glossaryVersion: 1,
    createdAt: NOW,
    source: 'local-asr',
  });
});

describe('search.all：B 站字幕条目收口（op 全链路）', () => {
  it('有收藏：标题取收藏 snapshot，metadata.url（带 ?p=）拼 ?t= 命中秒', async () => {
    const res = await dispatchOp('search.all', { keyword: '行列式' });
    const group = res.groups.find((g) => g.kind === 'transcript');
    const item = group?.items.find((i) => i.title === '线性代数网课');
    expect(item).toMatchObject({
      kind: 'transcript',
      anchorSec: 75,
      jump: { type: 'url', url: 'https://www.bilibili.com/video/BVfav0000001?p=2&t=75' },
    });
    expect(item?.snippet.startsWith('01:15 · ')).toBe(true);
  });

  it('无收藏：兜底标题「B 站视频 <bvid>」+ 按 bvid 还原的 URL', async () => {
    const res = await dispatchOp('search.all', { keyword: '矩阵' });
    const group = res.groups.find((g) => g.kind === 'transcript');
    expect(group?.items).toHaveLength(1);
    expect(group?.items[0]).toMatchObject({
      title: 'B 站视频 BVnofav00001',
      anchorSec: 90,
      jump: { type: 'url', url: 'https://www.bilibili.com/video/BVnofav00001?t=90' },
    });
  });

  it('向后兼容：站内课次（有 courId）仍走 session 标题 + course 跳转', async () => {
    const res = await dispatchOp('search.all', { keyword: '泰勒' });
    const group = res.groups.find((g) => g.kind === 'transcript');
    expect(group?.items).toHaveLength(1);
    expect(group?.items[0]).toMatchObject({
      title: '线性代数 · 第5周 / 线性代数 / 第12节课',
      jump: { type: 'course', courId: 31001, teclId: 9301, anchorSec: 20 },
    });
  });
});

describe('search.all：多 P 键与站外 URL 协议白名单（第 16 轮）', () => {
  it('p≥2 分 P 键：无收藏时跳转按 bvid 还原并追加 ?p=N（与 ?t= 落到分 P 命中点）', async () => {
    const db = await getDb();
    await db.put('transcripts', {
      ...makeBiliTranscript('BVmultiP00001', [{ s: 120, e: 125, text: '分P行列式' }]),
      mediaKey: 'bili:BVmultiP00001:p2',
    });
    const res = await dispatchOp('search.all', { keyword: '分P行列式' });
    const item = res.groups.find((g) => g.kind === 'transcript')?.items[0];
    expect(item).toMatchObject({
      title: 'B 站视频 BVmultiP00001',
      anchorSec: 120,
      jump: { type: 'url', url: 'https://www.bilibili.com/video/BVmultiP00001?p=2&t=120' },
    });
  });

  it('收藏 metadata.url 为危险协议（javascript:）时丢弃，回退按 bvid 还原的官方 URL', async () => {
    const db = await getDb();
    await db.put('favorites', makeVideoFav('BVdirty000001', {
      snapshot: { title: '脏外链收藏', content: '' },
      metadata: { platform: 'bilibili', bvid: 'BVdirty000001', url: 'javascript:alert(1)' },
    }));
    await db.put('transcripts', makeBiliTranscript('BVdirty000001', [{ s: 40, e: 45, text: '脏外链行列式' }]));
    const res = await dispatchOp('search.all', { keyword: '脏外链' });
    const item = res.groups.find((g) => g.kind === 'transcript')?.items[0];
    expect(item).toMatchObject({
      title: '脏外链收藏',
      jump: { type: 'url', url: 'https://www.bilibili.com/video/BVdirty000001?t=40' },
    });
  });
});
