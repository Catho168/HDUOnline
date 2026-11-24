/**
 * 站外视频学习进度仓储（videoProgress）。
 *
 * B 站等站外视频无法进入站点统计口径，单独记录「上次看到哪里」，并在上报时
 * 把进度回写到同 refId 的视频收藏 metadata（供知识库卡片渲染进度条/续看链接）。
 */

import { getDb, mapDbError } from '../index';
import type { VideoProgressEntity } from '../../shared/types';
import { updateFavorite } from './library';

/** 噪声过滤：不足 5 秒的播放视为误触，不落库 */
export const MIN_REPORT_POSITION_SEC = 5;

/** 比率 ≥0.95 视为看完 */
export const WATCHED_RATIO_THRESHOLD = 0.95;

/** `video.progress.report` 的入参（与 ops 注册表保持一致） */
export interface VideoProgressReportInput {
  platform: VideoProgressEntity['platform'];
  videoId: string;
  positionSec: number;
  durationSec?: number | null;
  title?: string;
}

/** 规范化结果：实体 + 是否看完（不落库，仅用于调用方展示/回写） */
export interface NormalizedVideoProgress extends VideoProgressEntity {
  watched: boolean;
}

/**
 * 纯函数：把一次进度上报规范化为可落库实体。
 *  - positionSec 非 有限数值 或 < 5s → null（噪声过滤）；
 *  - durationSec 有效时 clamp positionSec ≤ durationSec，比率 ≥0.95 视为看完。
 */
export function normalizeProgressReport(input: VideoProgressReportInput): NormalizedVideoProgress | null {
  if (!input.videoId) return null;
  if (!Number.isFinite(input.positionSec) || input.positionSec < MIN_REPORT_POSITION_SEC) return null;
  const durationSec =
    input.durationSec != null && Number.isFinite(input.durationSec) && input.durationSec > 0
      ? Math.floor(input.durationSec)
      : null;
  const lastPositionSec =
    durationSec != null ? Math.min(Math.floor(input.positionSec), durationSec) : Math.floor(input.positionSec);
  const watched = durationSec != null && lastPositionSec / durationSec >= WATCHED_RATIO_THRESHOLD;
  const title = input.title?.trim();
  return {
    id: `${input.platform}:${input.videoId}`,
    platform: input.platform,
    videoId: input.videoId,
    ...(title ? { title } : {}),
    durationSec,
    lastPositionSec,
    updatedAt: Date.now(),
    watched,
  };
}

/** 覆盖写（upsert）：不做软删除，旧记录直接被新进度取代 */
export async function putVideoProgress(entity: VideoProgressEntity): Promise<void> {
  return wrap(async () => {
    const db = await getDb();
    await db.put('videoProgress', entity);
  });
}

export async function getVideoProgress(
  platform: VideoProgressEntity['platform'],
  videoId: string,
): Promise<VideoProgressEntity | null> {
  return wrap(async () => {
    const db = await getDb();
    return (await db.get('videoProgress', `${platform}:${videoId}`)) ?? null;
  });
}

/**
 * 一次完整的进度上报：规范化 → 落库 → 回写同 refId 视频收藏的 metadata。
 * 返回 upsert 后的实体；被噪声过滤（<5s）时返回 null。
 */
export async function reportVideoProgress(input: VideoProgressReportInput): Promise<VideoProgressEntity | null> {
  const normalized = normalizeProgressReport(input);
  if (!normalized) return null;
  const { watched, ...entity } = normalized;
  await putVideoProgress(entity);
  await syncFavoriteProgress(entity);
  return entity;
}

/** 把进度回写到 type='video' 且 refId=videoId 的收藏（供学习中心/看板渲染进度条） */
async function syncFavoriteProgress(entity: VideoProgressEntity): Promise<void> {
  return wrap(async () => {
    const db = await getDb();
    const favs = await db.getAllFromIndex('favorites', 'type', 'video');
    const target = favs.find((f) => f.refId === entity.videoId && f.deletedAt == null);
    if (!target) return;
    const metadata: Record<string, unknown> = { ...(target.metadata ?? {}) };
    metadata.durationSec = entity.durationSec;
    metadata.lastPositionSec = entity.lastPositionSec;
    if (entity.durationSec != null && entity.durationSec > 0) {
      metadata.watchedRatio = Math.min(1, entity.lastPositionSec / entity.durationSec);
    }
    await updateFavorite(target.id, { metadata });
  });
}

function wrap<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((err) => {
    throw mapDbError(err);
  });
}
