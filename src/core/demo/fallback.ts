/**
 * 演示模式侧栏规范数据集纯逻辑（无 IndexedDB / DOM / Chrome API 依赖）。
 *
 * 规则：
 *  - 当演示模式开启时，进入任意 HDU 课次（`hdu:<courId>`）或任意 B 站视频/分 P
 *    （`bili:<bvid>[:pN]`），侧栏（速览 / 标注 / 大纲 / 问答 / 笔记 / 收藏 / 搜索 / 字幕）
 *    统一呈现同一套完整的规范假数据（HDU 以 `DS_W1` 为模板，B 站以 `BV1DEMO7X4Kq` 为模板）；
 *  - 模板实体重定位到当前目标 `mediaKey` / `courId`，并与用户在当前视频/课次下新产生的记录
 *    （非 `demo-` 前缀 ID）合并；多课程模板自带的其余课次 `demo-*` 仅保留给学习中心多课聚合与全局搜索，
 *    不混入其他课次侧栏。
 */

import { biliMediaKey, hduMediaKey, parseMediaKey, type MediaKey } from '../shared/mediaRef';
import type { TranscriptSearchHit } from '../shared/ops';
import type {
  AiResultEntity,
  ChatGroupInfo,
  ChatMessageEntity,
  ExternalNoteEntity,
  FavoriteEntity,
  NoteEntity,
  TranscriptEntity,
} from '../shared/types';
import { summarize } from '../shared/utils';
import { DEMO_BILI_CANONICAL_BVID, DEMO_HDU_CANONICAL_COUR_ID } from './data';

export { DEMO_BILI_CANONICAL_BVID, DEMO_HDU_CANONICAL_COUR_ID };

/** 种子预设条目统一带 `demo-` 前缀；用户现场新建的条目（UUID 等）不带此前缀 */
export function isSeededDemoId(id: string): boolean {
  return typeof id === 'string' && id.startsWith('demo-');
}

/** 映射任意合法 mediaKey 到其演示规范源键；非法键返回 null */
export function canonicalDemoMediaKey(mediaKey: MediaKey): MediaKey | null {
  const parsed = parseMediaKey(mediaKey);
  if (!parsed) return null;
  if (parsed.kind === 'hdu') return hduMediaKey(DEMO_HDU_CANONICAL_COUR_ID);
  return biliMediaKey(DEMO_BILI_CANONICAL_BVID);
}

/** 是否本来就是规范源主键 */
export function isCanonicalDemoMediaKey(mediaKey: MediaKey): boolean {
  const canonical = canonicalDemoMediaKey(mediaKey);
  return canonical !== null && canonical === mediaKey;
}

/** 将规范转写实体重定位到目标 mediaKey（HDU 写入 courId，B 站删除 courId） */
export function rebaseTranscript(source: TranscriptEntity, targetMediaKey: MediaKey): TranscriptEntity {
  const parsed = parseMediaKey(targetMediaKey);
  const { courId: _droppedCourId, ...rest } = source;
  return {
    ...rest,
    mediaKey: targetMediaKey,
    ...(parsed?.kind === 'hdu' ? { courId: parsed.courId } : {}),
    segments: source.segments.map((seg) => ({ ...seg })),
    ...(source.coverage ? { coverage: source.coverage.map((c) => ({ ...c })) } : {}),
    ...(source.window ? { window: { ...source.window } } : {}),
  };
}

/** 在指定转写集合上做本地关键词检索（评分口径与 repo/content.ts searchTranscripts 一致） */
export function searchTranscriptSegments(
  transcripts: TranscriptEntity[],
  query: string,
  limit = 100,
): TranscriptSearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const hits: TranscriptSearchHit[] = [];
  for (const t of transcripts) {
    for (const seg of t.segments) {
      const text = seg.text.toLowerCase();
      const firstIdx = text.indexOf(needle);
      if (firstIdx < 0) continue;
      let count = 0;
      let idx = firstIdx;
      while (idx >= 0) {
        count += 1;
        idx = text.indexOf(needle, idx + needle.length);
      }
      const positionWeight = 1 - firstIdx / Math.max(1, text.length);
      const lengthPenalty = Math.min(1, text.length / 400);
      const score = count * 2 + positionWeight - lengthPenalty;
      hits.push({
        mediaKey: t.mediaKey,
        ...(t.courId !== undefined ? { courId: t.courId } : {}),
        start: seg.s,
        end: seg.e,
        text: seg.text,
        score,
      });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

/** 将规范 AI 标注/大纲实体重定位到目标 mediaKey */
export function rebaseAiResult(source: AiResultEntity, targetMediaKey: MediaKey): AiResultEntity {
  const parsed = parseMediaKey(targetMediaKey);
  const { courId: _droppedCourId, ...rest } = source;
  return {
    ...rest,
    mediaKey: targetMediaKey,
    ...(parsed?.kind === 'hdu' ? { courId: parsed.courId } : {}),
    topics: source.topics.map((t) => ({
      ...t,
      intervals: t.intervals.map(([s, e]) => [s, e] as [number, number]),
    })),
    outline: source.outline.map((node) => ({ ...node })),
    ...(source.warnings ? { warnings: [...source.warnings] } : {}),
  };
}

/** 将规范问答消息列表重定位到目标 mediaKey */
export function rebaseChats(source: ChatMessageEntity[], targetMediaKey: MediaKey): ChatMessageEntity[] {
  const parsed = parseMediaKey(targetMediaKey);
  return source.map((m) => {
    const { courId: _droppedCourId, ...rest } = m;
    return {
      ...rest,
      mediaKey: targetMediaKey,
      ...(parsed?.kind === 'hdu' ? { courId: parsed.courId } : {}),
      ...(m.contextActual ? { contextActual: [m.contextActual[0], m.contextActual[1]] as [number, number] } : {}),
      ...(m.evidence ? { evidence: { ...m.evidence } } : {}),
    };
  });
}

/**
 * 合并规范问答与目标课次/视频消息：
 *  - 当目标本身就是规范主键时，直接返回 targetExisting 按 createdAt 升序；
 *  - 否则保留 canonicalRebased，并叠加目标下用户新发起（非 `demo-`）的消息（同 id 目标优先）。
 */
export function mergeChats(
  canonicalRebased: ChatMessageEntity[],
  targetExisting: ChatMessageEntity[],
  canonicalKey: MediaKey,
  targetMediaKey: MediaKey,
): ChatMessageEntity[] {
  if (canonicalKey === targetMediaKey) {
    return [...targetExisting].sort((a, b) => a.createdAt - b.createdAt);
  }
  const byId = new Map<string, ChatMessageEntity>();
  for (const m of canonicalRebased) byId.set(m.id, m);
  for (const m of targetExisting) {
    if (!isSeededDemoId(m.id)) byId.set(m.id, m);
  }
  return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
}

/** 将消息列表聚合为问答分组摘要（口径与 repo/content.ts listChatGroups 一致） */
export function summarizeChatGroups(messages: ChatMessageEntity[]): ChatGroupInfo[] {
  const map = new Map<string, { groupId: string; title: string; lastAt: number; count: number; anchor?: number }>();
  for (const m of messages) {
    const entry = map.get(m.groupId) ?? { groupId: m.groupId, title: '', lastAt: 0, count: 0 };
    entry.count += 1;
    entry.lastAt = Math.max(entry.lastAt, m.createdAt);
    if (m.role === 'user' && !entry.title) {
      entry.title = summarize(m.content, 40);
      entry.anchor = m.anchorTime;
    }
    if (entry.anchor === undefined && m.anchorTime !== undefined) entry.anchor = m.anchorTime;
    map.set(m.groupId, entry);
  }
  return [...map.values()]
    .map((e) => ({
      groupId: e.groupId,
      title: e.title || (e.anchor !== undefined ? `@${Math.floor(e.anchor)}s 的提问` : '未命名会话'),
      lastAt: e.lastAt,
      count: e.count,
    }))
    .sort((a, b) => b.lastAt - a.lastAt);
}

/** 跨 P 聚合分组摘要（口径与 repo/content.ts listChatGroupsByBvid 一致，附带 mediaKey / p） */
export function summarizeChatGroupsAll(messages: ChatMessageEntity[]): ChatGroupInfo[] {
  const map = new Map<
    string,
    { groupId: string; title: string; lastAt: number; count: number; anchor?: number; mediaKey: MediaKey; p: number }
  >();
  for (const m of messages) {
    const parsed = parseMediaKey(m.mediaKey);
    const p = parsed?.kind === 'bili' && parsed.p !== undefined ? parsed.p : 1;
    const entry = map.get(m.groupId) ?? {
      groupId: m.groupId,
      title: '',
      lastAt: 0,
      count: 0,
      mediaKey: m.mediaKey,
      p,
    };
    entry.count += 1;
    entry.lastAt = Math.max(entry.lastAt, m.createdAt);
    if (m.role === 'user' && !entry.title) {
      entry.title = summarize(m.content, 40);
      entry.anchor = m.anchorTime;
    }
    if (entry.anchor === undefined && m.anchorTime !== undefined) entry.anchor = m.anchorTime;
    map.set(m.groupId, entry);
  }
  return [...map.values()]
    .map((e) => ({
      groupId: e.groupId,
      title: e.title || (e.anchor !== undefined ? `@${Math.floor(e.anchor)}s 的提问` : '未命名会话'),
      lastAt: e.lastAt,
      count: e.count,
      mediaKey: e.mediaKey,
      p: e.p,
    }))
    .sort((a, b) => b.lastAt - a.lastAt);
}

/** 将规范站内笔记重定位到目标 courId（保留原 id 以兼容更新/删除/转藏） */
export function rebaseNotesForCour(source: NoteEntity[], targetCourId: number, targetTeclId?: number): NoteEntity[] {
  return source.map((n) => ({
    ...n,
    courId: targetCourId,
    ...(targetTeclId !== undefined ? { teclId: targetTeclId } : {}),
  }));
}

/** 将规范外部媒体笔记重定位到目标 mediaKey（保留原 id 以兼容删除/转藏） */
export function rebaseExternalNotes(source: ExternalNoteEntity[], targetMediaKey: MediaKey): ExternalNoteEntity[] {
  return source.map((n) => ({
    ...n,
    mediaKey: targetMediaKey,
  }));
}

/** 合并笔记列表并按 anchorTime 升序排列 */
export function mergeNotes<T extends { id: string; anchorTime: number }>(
  canonicalRebased: T[],
  targetExisting: T[],
  isSameTarget: boolean,
): T[] {
  if (isSameTarget) {
    return [...targetExisting].sort((a, b) => a.anchorTime - b.anchorTime);
  }
  const byId = new Map<string, T>();
  for (const n of canonicalRebased) byId.set(n.id, n);
  for (const n of targetExisting) {
    if (!isSeededDemoId(n.id)) byId.set(n.id, n);
  }
  return [...byId.values()].sort((a, b) => a.anchorTime - b.anchorTime);
}

/** 将规范课次收藏重定位到目标 courId */
export function rebaseFavoritesForCour(
  source: FavoriteEntity[],
  targetCourId: number,
  targetTeclId?: number,
): FavoriteEntity[] {
  return source.map((f) => ({
    ...f,
    courId: targetCourId,
    ...(targetTeclId !== undefined ? { teclId: targetTeclId } : {}),
    snapshot: { ...f.snapshot },
    tags: [...f.tags],
    ...(f.metadata ? { metadata: { ...f.metadata, courId: targetCourId } } : {}),
  }));
}

/** 合并收藏列表并沿用 repo/library.ts 排序口径 */
export function mergeFavorites(
  canonicalRebased: FavoriteEntity[],
  targetExisting: FavoriteEntity[],
  isSameTarget: boolean,
  pinnedFirst = false,
): FavoriteEntity[] {
  const list = isSameTarget
    ? [...targetExisting]
    : (() => {
        const byId = new Map<string, FavoriteEntity>();
        for (const f of canonicalRebased) byId.set(f.id, f);
        for (const f of targetExisting) {
          if (!isSeededDemoId(f.id)) byId.set(f.id, f);
        }
        return [...byId.values()];
      })();
  return list.sort((a, b) => {
    if (pinnedFirst && a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.favoritedAt - a.favoritedAt;
  });
}

/** 演示模式 B 站官方字幕获取兜底响应（绝不触发外部网络请求） */
export function buildDemoSubtitleFetchResult(transcript: TranscriptEntity): {
  status: 'ok';
  cached: true;
  segments: number;
  lan: string;
  lanDoc: string;
} {
  return {
    status: 'ok',
    cached: true,
    segments: transcript.segments.length,
    lan: transcript.lang || 'zh-CN',
    lanDoc: '中文（演示字幕）',
  };
}
