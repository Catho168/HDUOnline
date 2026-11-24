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
  ExternalNoteEntity,
  FavoriteEntity,
  FolderEntity,
  NoteEntity,
  NoteInput,
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
    const counts: Record<string, number> = { time: 0, ai: 0, outline: 0, screenshot: 0, note: 0, video: 0, total: 0 };
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

export async function listNotes(filter: { courId?: number; teclId?: number; mediaKey?: string } = {}): Promise<NoteEntity[]> {
  return wrap(async () => {
    const db = await getDb();
    let list: NoteEntity[];
    if (filter.mediaKey !== undefined) {
      // B 站等外部媒体笔记按 mediaKey 过滤。零迁移方案（第 26 轮裁决）：notes 是用户
      // 手写笔记而非流水数据，量级小，全表扫描 + 内存过滤足够；不为它新增索引/升 DB
      // 版本（v5 保持不变，避免一次仅为一个低频查询的升级迁移成本）。
      // mediaKey 字段只存在于外部媒体笔记记录体上（NoteEntity 类型未声明），这里按
      // 实际存储形状读取（store 是无类型键值层，联合形状经 unknown 中转收窄）。
      list = (await db.getAll('notes')).filter((n) => (n as unknown as ExternalNoteEntity).mediaKey === filter.mediaKey);
    } else if (filter.courId !== undefined) list = await db.getAllFromIndex('notes', 'courId', filter.courId);
    else if (filter.teclId !== undefined) list = await db.getAllFromIndex('notes', 'teclId', filter.teclId);
    else {
      // 无过滤（学习中心/仪表盘的站内聚合视图）：只返回站内笔记——外部媒体笔记没有
      // courId/teclId，混入后「打开课次」类操作无从落地，须经 mediaKey 显式查询获取。
      list = (await db.getAll('notes')).filter((n) => n.courId !== undefined);
    }
    return list.filter(isLive).sort((a, b) => a.anchorTime - b.anchorTime);
  });
}

/** 全库笔记（第 112 轮巡检）：站内 + B 站外部笔记一并返回（知识库笔记汇编导出用；软删除剔除） */
export async function listAllNotes(): Promise<Array<NoteEntity | ExternalNoteEntity>> {
  return wrap(async () => {
    const db = await getDb();
    return (await db.getAll('notes')).filter(isLive) as Array<NoteEntity | ExternalNoteEntity>;
  });
}

export async function putNote(note: NoteInput): Promise<void> {
  return wrap(async () => {
    // 归属校验（第 26 轮放宽后的新矩阵）：站内（courId+teclId 成组）与外部媒体
    // （mediaKey）至少一组，两者皆缺拒绝写入，避免产生无法检索/归档的孤儿笔记。
    // HDU 既有路径两 id 都传，校验恒通过，行为逐字节不变。
    const hasCourseRef =
      'courId' in note &&
      'teclId' in note &&
      typeof note.courId === 'number' &&
      Number.isFinite(note.courId) &&
      typeof note.teclId === 'number' &&
      Number.isFinite(note.teclId);
    const hasMediaRef = 'mediaKey' in note && typeof note.mediaKey === 'string' && note.mediaKey.length > 0;
    if (!hasCourseRef && !hasMediaRef) {
      throw new AppError('INVALID_INPUT', { detail: '笔记缺少归属信息：courId+teclId 与 mediaKey 至少提供一组' });
    }
    const db = await getDb();
    // 两种归属形状共用 notes store；IDB 按记录体实际形状存取，这里按入参原样落库
    await db.put('notes', note as NoteEntity);
  });
}

/**
 * 关键词检索笔记（统一搜索入口 `search.all` 用）：正文不区分大小写包含匹配，
 * 按 updatedAt 降序取前 limit 条。笔记没有独立标题，摘要由聚合器从正文截取。
 */
export async function searchNotes(keyword: string, opts: { limit?: number } = {}): Promise<NoteEntity[]> {
  const needle = keyword.trim().toLowerCase();
  if (!needle) return [];
  return wrap(async () => {
    const db = await getDb();
    const limit = Math.max(1, opts.limit ?? 30);
    return (await db.getAll('notes'))
      .filter((n) => isLive(n) && typeof n.text === 'string' && n.text.toLowerCase().includes(needle))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, limit);
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
  // 归属守卫（第 29 轮审计#6，口径同 putNote）：courId+teclId 成组与 mediaKey 至少
  // 一组，两者皆缺拒绝转藏——否则会产生既进不了课次视图、也无法按媒体检索的孤儿收藏。
  // mediaKey 只存在于外部媒体笔记记录体上（notes store 的 value 类型仍声明为
  // NoteEntity，零迁移方案），照 listNotes 惯例经 ExternalNoteEntity 形状读取。
  const mediaKey = (note as unknown as ExternalNoteEntity).mediaKey;
  const hasCourseRef =
    typeof note.courId === 'number' &&
    Number.isFinite(note.courId) &&
    typeof note.teclId === 'number' &&
    Number.isFinite(note.teclId);
  const hasMediaRef = typeof mediaKey === 'string' && mediaKey.length > 0;
  if (!hasCourseRef && !hasMediaRef) {
    throw new AppError('INVALID_INPUT', { detail: '笔记缺少归属信息：courId+teclId 与 mediaKey 至少提供一组' });
  }
  // 归属落位：站内笔记 courId/teclId 走实体字段（HDU 既有路径，行为不变、不写
  // metadata）；仅 mediaKey 的站外笔记把 mediaKey 带进收藏 metadata（与
  // buildMomentFavorite 的 B 站 metadata 惯例一致），知识库侧可按 mediaKey 检索回跳。
  const metadata = hasCourseRef ? undefined : { mediaKey };
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
    ...(metadata ? { metadata } : {}),
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

/** 撤销完成/跳过（第 116 轮巡检）：done/skipped 作业回到 pending；到期日早于今天时
 *  拉回今天（避免重开即逾期）。非 pending 以外状态不动，非法 jobId 静默返回。 */
export async function reopenReview(jobId: string): Promise<void> {
  return wrap(async () => {
    const db = await getDb();
    const job = await db.get('reviewJobs', jobId);
    if (!job || job.status === 'pending') return;
    const today = localDayKey();
    const dueDate = job.dueDate >= today ? job.dueDate : today;
    await db.put('reviewJobs', { ...job, status: 'pending', dueDate, updatedAt: Date.now() });
  });
}

/** 全量复习作业（学习月报的复习保持率聚合用；store 小，一次读取，避免逐条查询） */
export async function listReviewJobs(): Promise<ReviewJobEntity[]> {
  return wrap(async () => {
    const db = await getDb();
    return db.getAll('reviewJobs');
  });
}

/** 顺延复习作业（第 107 轮巡检）：把 pending 作业改期到指定日；已完成/已跳过不动，
 *  到期日格式非法时抛 INVALID_INPUT。第 111 轮起留痕 rescheduleLog（零迁移可选字段）。 */
export async function rescheduleReview(jobId: string, dueDate: string): Promise<void> {
  return wrap(async () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      throw new AppError('INVALID_INPUT', { detail: `rescheduleReview 非法到期日：${dueDate}` });
    }
    const db = await getDb();
    const job = await db.get('reviewJobs', jobId);
    if (!job || job.status !== 'pending') return;
    if (job.dueDate === dueDate) return;
    const log = Array.isArray(job.rescheduleLog) ? job.rescheduleLog : [];
    await db.put('reviewJobs', {
      ...job,
      dueDate,
      rescheduleLog: [...log, { from: job.dueDate, to: dueDate, at: Date.now() }].slice(-20),
      updatedAt: Date.now(),
    });
  });
}
