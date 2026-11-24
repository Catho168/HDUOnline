/** 视频进度仓储测试：normalize 规则、upsert 覆盖写、收藏 metadata 回写。 */

import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '@/core/db';
import {
  MIN_REPORT_POSITION_SEC,
  WATCHED_RATIO_THRESHOLD,
  getVideoProgress,
  normalizeProgressReport,
  putVideoProgress,
  reportVideoProgress,
} from '@/core/db/repo/video';
import { listFavorites, putFavorite } from '@/core/db/repo/library';
import type { VideoProgressEntity } from '@/core/shared/types';

beforeAll(async () => {
  await getDb();
});

describe('normalizeProgressReport（纯函数）', () => {
  const base = { platform: 'bilibili' as const, videoId: 'BV1xx411c7mD' };

  it('positionSec < 5 的噪声被过滤', () => {
    expect(normalizeProgressReport({ ...base, positionSec: 0 })).toBeNull();
    expect(normalizeProgressReport({ ...base, positionSec: 4.9 })).toBeNull();
    expect(normalizeProgressReport({ ...base, positionSec: MIN_REPORT_POSITION_SEC })).not.toBeNull();
  });

  it('非有限数值与空 videoId 也被过滤', () => {
    expect(normalizeProgressReport({ ...base, positionSec: Number.NaN })).toBeNull();
    expect(normalizeProgressReport({ platform: 'bilibili', videoId: '', positionSec: 100 })).toBeNull();
  });

  it('durationSec 有效时 clamp positionSec ≤ durationSec', () => {
    const normalized = normalizeProgressReport({ ...base, positionSec: 9999, durationSec: 600 });
    expect(normalized?.lastPositionSec).toBe(600);
    expect(normalized?.durationSec).toBe(600);
    expect(normalized?.watched).toBe(true);
  });

  it('比率 ≥0.95 视为看完', () => {
    expect(WATCHED_RATIO_THRESHOLD).toBe(0.95);
    expect(normalizeProgressReport({ ...base, positionSec: 570, durationSec: 600 })?.watched).toBe(true);
    expect(normalizeProgressReport({ ...base, positionSec: 569, durationSec: 600 })?.watched).toBe(false);
  });

  it('durationSec 缺失/无效时不计算看完，保留原始位置', () => {
    const withoutDuration = normalizeProgressReport({ ...base, positionSec: 120 });
    expect(withoutDuration?.durationSec).toBeNull();
    expect(withoutDuration?.lastPositionSec).toBe(120);
    expect(withoutDuration?.watched).toBe(false);
    expect(normalizeProgressReport({ ...base, positionSec: 120, durationSec: null })?.durationSec).toBeNull();
    expect(normalizeProgressReport({ ...base, positionSec: 120, durationSec: 0 })?.durationSec).toBeNull();
    expect(normalizeProgressReport({ ...base, positionSec: 120, durationSec: -1 })?.durationSec).toBeNull();
    expect(normalizeProgressReport({ ...base, positionSec: 120, durationSec: Number.NaN })?.durationSec).toBeNull();
  });

  it('生成 `${platform}:${videoId}` 主键并携带去空白标题', () => {
    const normalized = normalizeProgressReport({ ...base, positionSec: 60, title: '  测试视频 ' });
    expect(normalized?.id).toBe('bilibili:BV1xx411c7mD');
    expect(normalized?.platform).toBe('bilibili');
    expect(normalized?.videoId).toBe('BV1xx411c7mD');
    expect(normalized?.title).toBe('测试视频');
    expect(normalized?.updatedAt).toBeTypeOf('number');
  });
});

describe('videoProgress 仓储', () => {
  const entity: VideoProgressEntity = {
    id: 'bilibili:BVtest0000001',
    platform: 'bilibili',
    videoId: 'BVtest0000001',
    title: '测试视频',
    durationSec: 600,
    lastPositionSec: 120,
    updatedAt: Date.now(),
  };

  it('putVideoProgress 覆盖写（upsert）', async () => {
    await putVideoProgress(entity);
    expect(await getVideoProgress('bilibili', 'BVtest0000001')).toMatchObject({ lastPositionSec: 120, durationSec: 600 });
    await putVideoProgress({ ...entity, lastPositionSec: 300, updatedAt: entity.updatedAt + 1000 });
    const stored = await getVideoProgress('bilibili', 'BVtest0000001');
    expect(stored?.lastPositionSec).toBe(300);
    expect(stored?.updatedAt).toBe(entity.updatedAt + 1000);
  });

  it('getVideoProgress 不存在时返回 null', async () => {
    expect(await getVideoProgress('bilibili', 'BVmissing000001')).toBeNull();
  });

  it('reportVideoProgress 回写同 refId 收藏的 metadata', async () => {
    await putFavorite({
      id: 'fav-video-progress',
      type: 'video',
      refId: 'BVtest0000002',
      snapshot: { title: 'B 站网课', content: 'https://www.bilibili.com/video/BVtest0000002' },
      folderId: null,
      tags: [],
      pinned: false,
      favoritedAt: Date.now(),
      metadata: { platform: 'bilibili', coverUrl: 'https://i0.hdslb.com/x.jpg', uploader: 'UP 主' },
    });
    const reported = await reportVideoProgress({
      platform: 'bilibili',
      videoId: 'BVtest0000002',
      positionSec: 300,
      durationSec: 900,
      title: 'B 站网课',
    });
    expect(reported?.lastPositionSec).toBe(300);
    const target = (await listFavorites({ type: 'video' })).find((f) => f.refId === 'BVtest0000002');
    expect(target?.metadata?.durationSec).toBe(900);
    expect(target?.metadata?.lastPositionSec).toBe(300);
    expect(target?.metadata?.watchedRatio).toBeCloseTo(300 / 900, 5);
    // 原有 metadata 字段不被覆盖丢失
    expect(target?.metadata?.uploader).toBe('UP 主');
  });

  it('reportVideoProgress 被噪声过滤时不落库、不回写', async () => {
    expect(await reportVideoProgress({ platform: 'bilibili', videoId: 'BVtest0000003', positionSec: 2 })).toBeNull();
    expect(await getVideoProgress('bilibili', 'BVtest0000003')).toBeNull();
  });

  it('没有对应收藏时仍正常落库', async () => {
    const reported = await reportVideoProgress({ platform: 'bilibili', videoId: 'BVtest0000004', positionSec: 30, durationSec: 100 });
    expect(reported?.lastPositionSec).toBe(30);
    expect(await getVideoProgress('bilibili', 'BVtest0000004')).not.toBeNull();
  });

  it('updatedAt 索引可用于按时间查询', async () => {
    const db = await getDb();
    const hits = await db.getAllFromIndex('videoProgress', 'updatedAt');
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });
});
