/**
 * 演示模式后台读取适配器（SW / web chromeShim 共用）。
 *
 * 将非规范 HDU 课次与 B 站视频/分 P 读取请求统一映射到规范演示模板
 * （HDU -> 1227052，B 站 -> BV1DEMO7X4Kq），并叠加用户在当前目标下的新建记录；
 * 学习中心的无过滤全量聚合查询（course.bundles / 无 filter note.list / 无 courId fav.list）
 * 不走此适配器，保留多课程演示全貌。
 */

import { getAiResult, getSession, getTranscript, listChatGroups, listChatGroupsByBvid, listChats, listChatsByBvid, searchTranscripts, type TranscriptHit } from '@/core/db/repo/content';
import { listFavorites, listNotes } from '@/core/db/repo/library';
import { isDemoActive } from '@/core/demo';
import {
  DEMO_BILI_CANONICAL_BVID,
  DEMO_HDU_CANONICAL_COUR_ID,
  canonicalDemoMediaKey,
  mergeChats,
  mergeFavorites,
  mergeNotes,
  rebaseAiResult,
  rebaseChats,
  rebaseExternalNotes,
  rebaseFavoritesForCour,
  rebaseNotesForCour,
  rebaseTranscript,
  searchTranscriptSegments,
  summarizeChatGroups,
  summarizeChatGroupsAll,
} from '@/core/demo/fallback';
import { biliMediaKey, type MediaKey } from '@/core/shared/mediaRef';
import type { FavoriteFilter } from '@/core/shared/ops';
import type {
  AiResultEntity,
  ChatGroupInfo,
  ChatMessageEntity,
  ExternalNoteEntity,
  FavoriteEntity,
  NoteEntity,
  TranscriptEntity,
} from '@/core/shared/types';

export async function getTranscriptWithDemo(mediaKey: MediaKey): Promise<TranscriptEntity | null> {
  if (!(await isDemoActive())) return getTranscript(mediaKey);
  const canonical = canonicalDemoMediaKey(mediaKey);
  if (!canonical || canonical === mediaKey) return getTranscript(mediaKey);
  const canonicalTx = await getTranscript(canonical);
  if (canonicalTx) return rebaseTranscript(canonicalTx, mediaKey);
  return getTranscript(mediaKey);
}

export async function searchTranscriptsWithDemo(
  query: string,
  mediaKeys?: MediaKey[],
  limit = 100,
): Promise<TranscriptHit[]> {
  if (!mediaKeys || mediaKeys.length === 0 || !(await isDemoActive())) {
    return searchTranscripts(query, mediaKeys, limit);
  }
  const uniqueKeys = [...new Set(mediaKeys)];
  const transcripts = (await Promise.all(uniqueKeys.map((key) => getTranscriptWithDemo(key)))).filter(
    (item): item is TranscriptEntity => item !== null,
  );
  return searchTranscriptSegments(transcripts, query, limit);
}

export async function getAiResultWithDemo(
  mediaKey: MediaKey,
): Promise<{ result: AiResultEntity | null; stale: boolean }> {
  if (!(await isDemoActive())) return getAiResult(mediaKey);
  const canonical = canonicalDemoMediaKey(mediaKey);
  if (!canonical || canonical === mediaKey) return getAiResult(mediaKey);
  const canonicalAi = await getAiResult(canonical);
  if (canonicalAi.result) {
    return { result: rebaseAiResult(canonicalAi.result, mediaKey), stale: canonicalAi.stale };
  }
  return getAiResult(mediaKey);
}

export async function listChatsWithDemo(mediaKey: MediaKey, groupId?: string): Promise<ChatMessageEntity[]> {
  if (!(await isDemoActive())) return listChats(mediaKey, groupId);
  const canonical = canonicalDemoMediaKey(mediaKey);
  if (!canonical || canonical === mediaKey) return listChats(mediaKey, groupId);
  const [canonicalChats, targetChats] = await Promise.all([listChats(canonical), listChats(mediaKey)]);
  if (canonicalChats.length === 0) return listChats(mediaKey, groupId);
  const merged = mergeChats(rebaseChats(canonicalChats, mediaKey), targetChats, canonical, mediaKey);
  return groupId ? merged.filter((m) => m.groupId === groupId) : merged;
}

export async function listChatGroupsWithDemo(mediaKey: MediaKey): Promise<ChatGroupInfo[]> {
  if (!(await isDemoActive())) return listChatGroups(mediaKey);
  const canonical = canonicalDemoMediaKey(mediaKey);
  if (!canonical || canonical === mediaKey) return listChatGroups(mediaKey);
  const canonicalChats = await listChats(canonical);
  if (canonicalChats.length === 0) return listChatGroups(mediaKey);
  const targetChats = await listChats(mediaKey);
  const merged = mergeChats(rebaseChats(canonicalChats, mediaKey), targetChats, canonical, mediaKey);
  return summarizeChatGroups(merged);
}

export async function listChatsByBvidWithDemo(bvid: string): Promise<ChatMessageEntity[]> {
  if (!bvid) return [];
  if (!(await isDemoActive()) || bvid === DEMO_BILI_CANONICAL_BVID) {
    return listChatsByBvid(bvid);
  }
  const canonicalKey = biliMediaKey(DEMO_BILI_CANONICAL_BVID);
  const targetKey = biliMediaKey(bvid);
  const [canonicalChats, targetChats] = await Promise.all([listChats(canonicalKey), listChatsByBvid(bvid)]);
  if (canonicalChats.length === 0) return targetChats;
  return mergeChats(rebaseChats(canonicalChats, targetKey), targetChats, canonicalKey, targetKey);
}

export async function listChatGroupsByBvidWithDemo(bvid: string): Promise<ChatGroupInfo[]> {
  if (!bvid) return [];
  if (!(await isDemoActive()) || bvid === DEMO_BILI_CANONICAL_BVID) {
    return listChatGroupsByBvid(bvid);
  }
  const canonicalKey = biliMediaKey(DEMO_BILI_CANONICAL_BVID);
  const canonicalChats = await listChats(canonicalKey);
  if (canonicalChats.length === 0) return listChatGroupsByBvid(bvid);
  const merged = await listChatsByBvidWithDemo(bvid);
  return summarizeChatGroupsAll(merged);
}

export async function listNotesWithDemo(
  filter: { courId?: number; teclId?: number; mediaKey?: string } = {},
): Promise<NoteEntity[]> {
  if (!(await isDemoActive())) return listNotes(filter);
  if (filter.mediaKey !== undefined) {
    const canonical = canonicalDemoMediaKey(filter.mediaKey);
    if (!canonical || canonical === filter.mediaKey) return listNotes(filter);
    const canonicalNotes = (await listNotes({ mediaKey: canonical })) as unknown as ExternalNoteEntity[];
    if (canonicalNotes.length === 0) return listNotes(filter);
    const targetNotes = (await listNotes({ mediaKey: filter.mediaKey })) as unknown as ExternalNoteEntity[];
    return mergeNotes(
      rebaseExternalNotes(canonicalNotes, filter.mediaKey),
      targetNotes,
      false,
    ) as unknown as NoteEntity[];
  }
  if (filter.courId !== undefined) {
    if (filter.courId === DEMO_HDU_CANONICAL_COUR_ID) return listNotes(filter);
    const [canonicalNotes, targetNotes, session] = await Promise.all([
      listNotes({ courId: DEMO_HDU_CANONICAL_COUR_ID }),
      listNotes({ courId: filter.courId }),
      getSession(filter.courId).catch(() => null),
    ]);
    if (canonicalNotes.length === 0) return targetNotes;
    return mergeNotes(
      rebaseNotesForCour(canonicalNotes, filter.courId, session?.teclId),
      targetNotes,
      false,
    );
  }
  return listNotes(filter);
}

export async function listFavoritesWithDemo(filter: FavoriteFilter = {}): Promise<FavoriteEntity[]> {
  if (filter.courId === undefined || filter.includeDeleted || !(await isDemoActive())) {
    return listFavorites(filter);
  }
  if (filter.courId === DEMO_HDU_CANONICAL_COUR_ID) {
    return listFavorites(filter);
  }
  const canonicalFilter: FavoriteFilter = {
    courId: DEMO_HDU_CANONICAL_COUR_ID,
    type: filter.type,
    tags: filter.tags,
    dateFrom: filter.dateFrom,
    dateTo: filter.dateTo,
    keyword: filter.keyword,
  };
  const targetFilter: FavoriteFilter = { ...filter, limit: undefined, offset: undefined };
  const [canonicalFavs, targetFavs, session] = await Promise.all([
    listFavorites(canonicalFilter),
    listFavorites(targetFilter),
    getSession(filter.courId).catch(() => null),
  ]);
  const offset = filter.offset ?? 0;
  const limit = filter.limit ?? Number.MAX_SAFE_INTEGER;
  if (canonicalFavs.length === 0) {
    return targetFavs.slice(offset, offset + limit);
  }
  const rebased = rebaseFavoritesForCour(canonicalFavs, filter.courId, session?.teclId);
  const merged = mergeFavorites(rebased, targetFavs, false, Boolean(filter.pinnedFirst));
  return merged.slice(offset, offset + limit);
}
