/**
 * 知识库仓储：favorites / folders / tags / notes / screenshots / reviewJobs。
 *
 * 收藏体系与站点原生收藏**并存但不双写**（§1.2 裁决）：本站内只维护自建体系，
 * 站点收藏状态仅用于只读星标展示。
 */

import { getDb, mapDbError } from '../index';
import { AppError } from '../../shared/errors';
import { localDayKey, summarize, uuid } from '../../shared/utils';
import type {
  FavoriteEntity,
  FolderEntity,
  NoteEntity,
  ReviewJobEntity,
  ReviewTemplate,
  ScreenshotEntity,
  TagEntity,
} from '../../shared/types';
import type { FavoriteFilter } from '../../shared/ops';
import { DEFAULT_SETTINGS } from '../../shared/constants';
import { moveToTrash, removeFromTrash } from './trash';

function wrap<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((err) => {
    throw mapDbError(err);
  });
}

function isLive<T extends { deletedAt?: number | null }>(entity: T): boolean {
  return entity.deletedAt == null;
}

// ───────────────────────── favorites ─────────────────────────

export async function putFavorite(input: Omit<FavoriteEntity, 'updatedAt'>): Promise<FavoriteEntity> {
  return wrap(async () => {
    const db = await getDb();
    // 去重：同一 refId 的同类收藏不允许重复（§7 B1 验收）
    if (input.refId) {
      const existing = await db.getAllFromIndex('favorites', 'type', input.type);
      const dup = existing.find((f) => f.refId === input.refId && isLive(f));
      if (dup) return dup;
    }
    const entity: FavoriteEntity = { ...input, updatedAt: Date.now() };
    await db.put('favorites', entity);
    return entity;
  });
}

export async function getFavorite(id: string): Promise<FavoriteEntity | null> {
  return wrap(async () => {
    const db = await getDb();
    return (await db.get('favorites', id)) ?? null;
  });
}

export async function listFavorites(filter: FavoriteFilter = {}): Promise<FavoriteEntity[]> {
  return wrap(async () => {
    const db = await getDb();
    let list: FavoriteEntity[];
    if (filter.courId !== undefined) {
      list = await db.getAllFromIndex('favorites', 'courId', filter.courId);
    } else if (filter.teclId !== undefined) {
      list = await db.getAllFromIndex('favorites', 'teclId', filter.teclId);
    } else if (filter.folderId) {
      list = await db.getAllFromIndex('favorites', 'folderId', filter.folderId);
    } else if (filter.tags && filter.tags.length > 0) {
      list = await db.getAllFromIndex('favorites', 'tags', filter.tags[0] as string);
    } else {
      list = await db.getAll('favorites');
    }
    let filtered = list.filter((f) => (filter.includeDeleted ? true : isLive(f)));
    if (filter.teclId !== undefined) filtered = filtered.filter((f) => f.teclId === filter.teclId);
    if (filter.courId !== undefined) filtered = filtered.filter((f) => f.courId === filter.courId);
    if (filter.type) filtered = filtered.filter((f) => f.type === filter.type);
    if (filter.folderId !== undefined) {
      filtered = filtered.filter((f) => (f.folderId ?? null) === (filter.folderId ?? null));
    }
    if (filter.tags && filter.tags.length > 0) {
      filtered = filtered.filter((f) => filter.tags?.every((t) => f.tags.includes(t)));
    }
    if (filter.dateFrom !== undefined) filtered = filtered.filter((f) => f.favoritedAt >= (filter.dateFrom as number));
    if (filter.dateTo !== undefined) filtered = filtered.filter((f) => f.favoritedAt <= (filter.dateTo as number));
    if (filter.keyword) {
      const kw = filter.keyword.toLowerCase();
      filtered = filtered.filter(
        (f) =>
          f.snapshot.title.toLowerCase().includes(kw) ||
          f.snapshot.content.toLowerCase().includes(kw) ||
          (f.note ?? '').toLowerCase().includes(kw),
      );
    }
    filtered.sort((a, b) => {
      if (filter.pinnedFirst && a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.favoritedAt - a.favoritedAt;
    });
    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? Number.MAX_SAFE_INTEGER;
    return filtered.slice(offset, offset + limit);
  });
}

export async function updateFavorite(id: string, patch: Partial<FavoriteEntity>): Promise<void> {
  return wrap(async () => {
    const db = await getDb();
    const existing = await db.get('favorites', id);
    if (!existing) return;
    await db.put('favorites', { ...existing, ...patch, id, updatedAt: Date.now() });
  });
}

export async function softDeleteFavorites(ids: string[]): Promise<void> {
  return wrap(async () => {
    const db = await getDb();
    const now = Date.now();
    for (const id of ids) {
      const fav = await db.get('favorites', id);
      if (!fav) continue;
      await db.put('favorites', { ...fav, deletedAt: now, updatedAt: now });
      await moveToTrash('favorite', id, fav.snapshot.title || '未命名收藏');
      // 关联复习计划一并取消
      const jobs = await db.getAllFromIndex('reviewJobs', 'favoriteId', id);
      for (const job of jobs) await db.delete('reviewJobs', job.id);
    }
  });
}

export async function restoreFavorites(ids: string[]): Promise<void> {
  return wrap(async () => {
    const db = await getDb();
    for (const id of ids) {
      const fav = await db.get('favorites', id);
      if (!fav) continue;
      await db.put('favorites', { ...fav, deletedAt: null, updatedAt: Date.now() });
      await removeFromTrash('favorite', id);
    }
  });
}

export async function favoriteCounts(teclId?: number): Promise<Record<string, number>> {
  return wrap(async () => {
    const db = await getDb();
    const list = teclId !== undefined ? await db.getAllFromIndex('favorites', 'teclId', teclId) : await db.getAll('favorites');
    const counts: Record<string, number> = { time: 0, ai: 0, outline: 0, screenshot: 0, note: 0, total: 0 };
    for (const f of list) {
      if (!isLive(f)) continue;
      counts[f.type] = (counts[f.type] ?? 0) + 1;
      counts.total = (counts.total ?? 0) + 1;
    }
    return counts;
  });
}

// ───────────────────────── folders ─────────────────────────

export async function listFolders(includeArchived = false): Promise<FolderEntity[]> {
  return wrap(async () => {
    const db = await getDb();
    const all = await db.getAll('folders');
    return all
      .filter((f) => isLive(f) && (includeArchived || !f.archived))
      .sort((a, b) => a.orderIndex - b.orderIndex);
  });
}

export async function upsertFolder(folder: FolderEntity): Promise<void> {
  return wrap(async () => {
    const db = await getDb();
    await db.put('folders', folder);
  });
}

/** 首次收藏时自动创建顶层课程文件夹（命名 = 课程名 + 学期，§7 B2） */
export async function ensureDefaultFolder(teclId: number, name: string): Promise<FolderEntity> {
  return wrap(async () => {
    const db = await getDb();
    const existing = (await db.getAllFromIndex('folders', 'teclId', teclId)).filter(isLive);
    if (existing.length > 0) return existing[0] as FolderEntity;
    const folder: FolderEntity = {
      id: uuid(),
      teclId,
      name,
      orderIndex: 0,
      archived: false,
      createdAt: Date.now(),
    };
    await db.put('folders', folder);
    return folder;
  });
}

export async function reorderFolders(ids: string[]): Promise<void> {
  return wrap(async () => {
    const db = await getDb();
    for (let i = 0; i < ids.length; i += 1) {
      const folder = await db.get('folders', ids[i] as string);
      if (!folder) continue;
      await db.put('folders', { ...folder, orderIndex: i });
    }
  });
}

export async function mergeFolders(fromId: string, toId: string): Promise<void> {
  return wrap(async () => {
    const db = await getDb();
    const from = await db.get('folders', fromId);
    const to = await db.get('folders', toId);
    if (!from || !to) throw new AppError('INVALID_INPUT', { detail: '文件夹不存在' });
    const favs = await db.getAllFromIndex('favorites', 'folderId', fromId);
    for (const fav of favs) await db.put('favorites', { ...fav, folderId: toId, updatedAt: Date.now() });
    await db.delete('folders', fromId);
    await removeFromTrash('folder', fromId);
  });
}

export async function renameFolder(id: string, name: string): Promise<void> {
  return wrap(async () => {
    const db = await getDb();
    const folder = await db.get('folders', id);
    if (!folder) return;
    await db.put('folders', { ...folder, name });
  });
}

export async function archiveFolder(id: string, archived: boolean): Promise<void> {
  return wrap(async () => {
    const db = await getDb();
    const folder = await db.get('folders', id);
    if (!folder) return;
    await db.put('folders', { ...folder, archived });
  });
}

/** 删除文件夹：条目转未分组（§7 B2） */
export async function softDeleteFolder(id: string): Promise<void> {
  return wrap(async () => {
    const db = await getDb();
    const folder = await db.get('folders', id);
    if (!folder) return;
    const favs = await db.getAllFromIndex('favorites', 'folderId', id);
    for (const fav of favs) await db.put('favorites', { ...fav, folderId: null, updatedAt: Date.now() });
    await db.put('folders', { ...folder, deletedAt: Date.now() });
    await moveToTrash('folder', id, folder.name);
  });
}

// ───────────────────────── tags ─────────────────────────

export async function listTags(): Promise<TagEntity[]> {
  return wrap(async () => {
    const db = await getDb();
    const all = await db.getAll('tags');
    return all.filter(isLive).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  });
}

export async function createTag(name: string, color?: string): Promise<TagEntity> {
  return wrap(async () => {
    const db = await getDb();
    const trimmed = name.trim();
    if (!trimmed) throw new AppError('INVALID_INPUT', { detail: '标签名不能为空' });
    const existing = (await db.getAllFromIndex('tags', 'name', trimmed)).filter(isLive);
    if (existing.length > 0) return existing[0] as TagEntity;
    const tag: TagEntity = { id: uuid(), name: trimmed, color };
    await db.put('tags', tag);
    return tag;
  });
}

export async function renameTag(id: string, name: string): Promise<void> {
  return wrap(async () => {
    const db = await getDb();
    const tag = await db.get('tags', id);
    if (!tag) return;
    const next = name.trim();
    if (!next) return;
    const old = tag.name;
    await db.put('tags', { ...tag, name: next });
    // 同步更新收藏条目中的标签名
    const favs = await db.getAllFromIndex('favorites', 'tags', old);
    for (const fav of favs) {
      const tags = fav.tags.map((t) => (t === old ? next : t));
      await db.put('favorites', { ...fav, tags, updatedAt: Date.now() });
    }
  });
}

export async function mergeTags(fromIds: string[], toId: string): Promise<void> {
  return wrap(async () => {
    const db = await getDb();
    const to = await db.get('tags', toId);
    if (!to) throw new AppError('INVALID_INPUT', { detail: '目标标签不存在' });
    for (const fromId of fromIds) {
      if (fromId === toId) continue;
      const from = await db.get('tags', fromId);
      if (!from) continue;
      const favs = await db.getAllFromIndex('favorites', 'tags', from.name);
      for (const fav of favs) {
        const tags = [...new Set(fav.tags.map((t) => (t === from.name ? to.name : t)))];
        await db.put('favorites', { ...fav, tags, updatedAt: Date.now() });
      }
      await db.delete('tags', fromId);
      await removeFromTrash('tag', fromId);
    }
  });
}

export async function softDeleteTag(id: string): Promise<void> {
  return wrap(async () => {
    const db = await getDb();
    const tag = await db.get('tags', id);
    if (!tag) return;
    await db.put('tags', { ...tag, deletedAt: Date.now() });
    await moveToTrash('tag', id, tag.name);
  });
}

// ───────────────────────── notes ─────────────────────────

export async function listNotes(filter: { courId?: number; teclId?: number } = {}): Promise<NoteEntity[]> {
  return wrap(async () => {
    const db = await getDb();
    let list: NoteEntity[];
    if (filter.courId !== undefined) list = await db.getAllFromIndex('notes', 'courId', filter.courId);
    else if (filter.teclId !== undefined) list = await db.getAllFromIndex('notes', 'teclId', filter.teclId);
    else list = await db.getAll('notes');
    return list.filter(isLive).sort((a, b) => a.anchorTime - b.anchorTime);
  });
}

export async function putNote(note: NoteEntity): Promise<void> {
  return wrap(async () => {
    const db = await getDb();
    await db.put('notes', note);
  });
}

export async function updateNote(id: string, text: string): Promise<void> {
  return wrap(async () => {
    const db = await getDb();
    const note = await db.get('notes', id);
    if (!note) return;
    await db.put('notes', { ...note, text, updatedAt: Date.now() });
  });
}

export async function softDeleteNote(id: string): Promise<void> {
  return wrap(async () => {
    const db = await getDb();
    const note = await db.get('notes', id);
    if (!note) return;
    await db.put('notes', { ...note, deletedAt: Date.now() });
    await moveToTrash('note', id, summarize(note.text, 30) || '未命名笔记');
  });
}

/** 笔记 → 收藏（单向转换，§7 D5） */
export async function noteToFavorite(id: string, folderId?: string | null): Promise<FavoriteEntity> {
  const db = await getDb();
  const note = await db.get('notes', id);
  if (!note) throw new AppError('INVALID_INPUT', { detail: '笔记不存在' });
  const fav = await putFavorite({
    id: uuid(),
    type: 'note',
    refId: note.id,
    snapshot: { title: `笔记 @${Math.floor(note.anchorTime)}s`, content: note.text },
    teclId: note.teclId,
    courId: note.courId,
    anchorTime: note.anchorTime,
    folderId: folderId ?? null,
    tags: [],
    pinned: false,
    favoritedAt: Date.now(),
  });
  await db.put('notes', { ...note, convertedFavoriteId: fav.id, updatedAt: Date.now() });
  return fav;
}

// ───────────────────────── screenshots ─────────────────────────

export async function putScreenshot(entity: ScreenshotEntity): Promise<void> {
  return wrap(async () => {
    const db = await getDb();
    await db.put('screenshots', entity);
  });
}

export async function listScreenshots(courId?: number): Promise<ScreenshotEntity[]> {
  return wrap(async () => {
    const db = await getDb();
    const list = courId !== undefined ? await db.getAllFromIndex('screenshots', 'courId', courId) : await db.getAll('screenshots');
    return list.filter(isLive).sort((a, b) => b.createdAt - a.createdAt);
  });
}

export async function softDeleteScreenshots(ids: string[]): Promise<void> {
  return wrap(async () => {
    const db = await getDb();
    for (const id of ids) {
      const shot = await db.get('screenshots', id);
      if (!shot) continue;
      await db.put('screenshots', { ...shot, deletedAt: Date.now() });
      await moveToTrash('screenshot', id, `${shot.meta.courLabel} @${Math.floor(shot.meta.anchorTime)}s`);
    }
  });
}

export async function restoreScreenshots(ids: string[]): Promise<void> {
  return wrap(async () => {
    const db = await getDb();
    for (const id of ids) {
      const shot = await db.get('screenshots', id);
      if (!shot) continue;
      await db.put('screenshots', { ...shot, deletedAt: null });
      await removeFromTrash('screenshot', id);
    }
  });
}

// ───────────────────────── reviewJobs（D2 复习） ─────────────────────────

export async function planReview(
  favoriteId: string,
  template: ReviewTemplate = 'regular',
  intervals?: Record<ReviewTemplate, number[]>,
  startDate = localDayKey(),
): Promise<ReviewJobEntity[]> {
  return wrap(async () => {
    const db = await getDb();
    const fav = await db.get('favorites', favoriteId);
    if (!fav) throw new AppError('INVALID_INPUT', { detail: '收藏不存在' });
    await cancelReview(favoriteId);
    const steps = (intervals ?? DEFAULT_SETTINGS.review.intervals)[template] ?? [1, 3, 7];
    const jobs: ReviewJobEntity[] = [];
    for (let i = 0; i < steps.length; i += 1) {
      const due = new Date(`${startDate}T00:00:00`);
      due.setDate(due.getDate() + (steps[i] ?? 1));
      const job: ReviewJobEntity = {
        id: uuid(),
        favoriteId,
        dueDate: localDayKey(due),
        round: i + 1,
        template,
        status: 'pending',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await db.put('reviewJobs', job);
      jobs.push(job);
    }
    return jobs;
  });
}

export async function cancelReview(favoriteId: string): Promise<void> {
  return wrap(async () => {
    const db = await getDb();
    const jobs = await db.getAllFromIndex('reviewJobs', 'favoriteId', favoriteId);
    for (const job of jobs) await db.delete('reviewJobs', job.id);
  });
}

export async function dueReviews(date = localDayKey()): Promise<Array<ReviewJobEntity & { favorite: FavoriteEntity | null }>> {
  return wrap(async () => {
    const db = await getDb();
    const jobs = (await db.getAllFromIndex('reviewJobs', 'dueDate', date)).filter((j) => j.status === 'pending');
    const out: Array<ReviewJobEntity & { favorite: FavoriteEntity | null }> = [];
    for (const job of jobs.sort((a, b) => a.round - b.round)) {
      const favorite = (await db.get('favorites', job.favoriteId)) ?? null;
      out.push({ ...job, favorite: favorite && isLive(favorite) ? favorite : null });
    }
    return out;
  });
}

/** 完成当日复习：顺延到下一轮（§7 D2） */
export async function completeReview(jobId: string, status: 'done' | 'skipped'): Promise<void> {
  return wrap(async () => {
    const db = await getDb();
    const job = await db.get('reviewJobs', jobId);
    if (!job) return;
    await db.put('reviewJobs', { ...job, status, updatedAt: Date.now() });
    if (status !== 'done') return;
    const all = (await db.getAllFromIndex('reviewJobs', 'favoriteId', job.favoriteId)).sort((a, b) => a.round - b.round);
    const next = all.find((j) => j.round === job.round + 1 && j.status === 'pending');
    if (!next) return;
    // 若下一轮已经过期，则把到期日提前到明天，避免"补复习"堆积
    const tomorrow = localDayKey(Date.now() + 24 * 3600 * 1000);
    if (next.dueDate < tomorrow) {
      await db.put('reviewJobs', { ...next, dueDate: tomorrow, updatedAt: Date.now() });
    }
  });
}

export async function reviewStats(date = localDayKey()): Promise<{ pending: number; todayDone: number; planned: number }> {
  return wrap(async () => {
    const db = await getDb();
    const all = await db.getAll('reviewJobs');
    const today = await db.getAllFromIndex('reviewJobs', 'dueDate', date);
    return {
      pending: all.filter((j) => j.status === 'pending').length,
      todayDone: today.filter((j) => j.status === 'done').length,
      planned: all.length,
    };
  });
}
