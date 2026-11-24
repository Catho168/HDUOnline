/**
 * 回收站（§4.3：软删除 + 30 天）。
 *
 * 策略：实体就地软删除（`deletedAt` 置位），trash store 只存轻量索引。
 *  - 列表查询默认过滤 `deletedAt == null`；
 *  - 还原 = 清除 `deletedAt` 并删除索引；
 *  - 到期清理 = 删除实体与索引（由 SW alarms 每日触发）。
 */

import { getDb } from '../index';
import { TRASH_RETENTION_DAYS } from '../../shared/constants';
import type { TrashEntity, TrashKind } from '../../shared/types';

const DAY_MS = 24 * 3600 * 1000;

export function trashKey(kind: TrashKind, id: string): string {
  return `${kind}:${id}`;
}

export async function moveToTrash(kind: TrashKind, id: string, title: string): Promise<void> {
  const db = await getDb();
  const now = Date.now();
  const record: TrashEntity = {
    key: trashKey(kind, id),
    kind,
    id,
    title,
    deletedAt: now,
    expiresAt: now + TRASH_RETENTION_DAYS * DAY_MS,
  };
  await db.put('trash', record);
}

export async function removeFromTrash(kind: TrashKind, id: string): Promise<void> {
  const db = await getDb();
  await db.delete('trash', trashKey(kind, id));
}

/** 续期后的自动清理时间（第 233 轮巡检）：now + days 天；days 非法回退 30，钳制 1..365 */
export function extendedExpiresAt(now: number, days: number): number {
  const added = Number.isFinite(days) ? Math.min(Math.max(Math.floor(days), 1), 365) : 30;
  return now + added * DAY_MS;
}

export async function listTrash(): Promise<TrashEntity[]> {
  const db = await getDb();
  const all = await db.getAll('trash');
  return all.sort((a, b) => b.deletedAt - a.deletedAt);
}

/** 立即彻底删除（回收站"永久删除"或到期清理） */
export async function purgeTrashEntries(keys: string[]): Promise<number> {
  const db = await getDb();
  const tx = db.transaction(['trash', 'favorites', 'folders', 'notes', 'screenshots', 'tags'], 'readwrite');
  let removed = 0;
  for (const key of keys) {
    const entry = await tx.objectStore('trash').get(key);
    if (!entry) continue;
    switch (entry.kind) {
      case 'favorite':
        await tx.objectStore('favorites').delete(entry.id);
        break;
      case 'folder':
        await tx.objectStore('folders').delete(entry.id);
        break;
      case 'note':
        await tx.objectStore('notes').delete(entry.id);
        break;
      case 'screenshot':
        await tx.objectStore('screenshots').delete(entry.id);
        break;
      case 'tag':
        await tx.objectStore('tags').delete(entry.id);
        break;
      default:
        break;
    }
    await tx.objectStore('trash').delete(key);
    removed += 1;
  }
  await tx.done;
  return removed;
}

/** 清理已到期的回收站条目；返回清理数量 */
export async function purgeExpiredTrash(now = Date.now()): Promise<number> {
  const db = await getDb();
  const expired = (await db.getAll('trash')).filter((e) => e.expiresAt <= now);
  if (expired.length === 0) return 0;
  return purgeTrashEntries(expired.map((e) => e.key));
}

export async function emptyTrash(): Promise<number> {
  const db = await getDb();
  const all = await db.getAll('trash');
  return purgeTrashEntries(all.map((e) => e.key));
}
