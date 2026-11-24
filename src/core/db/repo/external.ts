/**
 * 站外视频学习时长仓储（externalWatch）。
 *
 * B 站等站外视频的学习时长独立于站内 watchRecords 统计通道：同一天同一视频
 * 只保留一条累计记录（主键 `${date}:${bvid}`），每次上报把 seconds 累加进去。
 * 防御式约定：seconds 非有限正数视为噪声直接忽略，不落库也不清零已有累计。
 */

import { getDb, mapDbError } from '../index';
import type { ExternalWatchEntity } from '../../shared/types';

/** 通道键：`<YYYY-MM-DD>:<bvid>` */
export function externalWatchId(date: string, bvid: string): string {
  return `${date}:${bvid}`;
}

export interface AddExternalWatchInput {
  /** 'YYYY-MM-DD' 本地自然日（由 SW 端计算） */
  date: string;
  bvid: string;
  title?: string;
  /** 本次新增秒数（须为有限正数） */
  seconds: number;
}

/**
 * upsert 累加：同 id 已存在则 seconds 累加；title 仅在旧值缺失时补充，
 * 不覆盖已有标题（旧值优先）。输入无效（bvid/date 为空、seconds 非有限正数）时
 * 返回 null 且不产生任何写入。
 */
export async function addExternalWatch(input: AddExternalWatchInput): Promise<ExternalWatchEntity | null> {
  if (!input || typeof input.bvid !== 'string' || input.bvid.length === 0) return null;
  if (typeof input.date !== 'string' || input.date.length === 0) return null;
  if (!Number.isFinite(input.seconds) || input.seconds <= 0) return null;
  return wrap(async () => {
    const db = await getDb();
    const id = externalWatchId(input.date, input.bvid);
    const existing = await db.get('externalWatch', id);
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    const next: ExternalWatchEntity = {
      id,
      date: input.date,
      bvid: input.bvid,
      ...(existing?.title ? { title: existing.title } : title ? { title } : {}),
      seconds: Math.round((existing?.seconds ?? 0) + input.seconds),
    };
    await db.put('externalWatch', next);
    return next;
  });
}

/** 某一天的站外学习记录（按视频分组，每视频一条累计） */
export async function getExternalWatchByDate(date: string): Promise<ExternalWatchEntity[]> {
  return wrap(async () => {
    const db = await getDb();
    const list = await db.getAllFromIndex('externalWatch', 'date', date);
    return list.sort((a, b) => a.bvid.localeCompare(b.bvid));
  });
}

/** 按自然日区间取站外学习记录（含端点），报表聚合用 */
export async function getExternalByDateRange(fromDay: string, toDay: string): Promise<ExternalWatchEntity[]> {
  return wrap(async () => {
    const db = await getDb();
    const tx = db.transaction('externalWatch');
    const range = IDBKeyRange.bound(fromDay, toDay);
    const list = await tx.store.index('date').getAll(range);
    await tx.done;
    return list;
  });
}

/** 清除全部站外学习时长（E 模块"数据管理"的 stats 分类） */
export async function clearExternalWatch(): Promise<void> {
  return wrap(async () => {
    const db = await getDb();
    await db.clear('externalWatch');
  });
}

function wrap<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((err) => {
    throw mapDbError(err);
  });
}
