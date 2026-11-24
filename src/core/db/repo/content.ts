/** 内容类实体仓储：courses / sessions / transcripts / aiResults / chats。 */

import { getDb, mapDbError } from '../index';
import type { AiResultEntity, ChatGroupInfo, ChatMessageEntity, CourseEntity, SessionEntity, SessionMeta, TranscriptEntity } from '../../shared/types';
import type { MediaKey } from '../../shared/mediaRef';
import { hduCourIdOf, parseMediaKey } from '../../shared/mediaRef';
import { AppError } from '../../shared/errors';
import { PROMPT_VERSION } from '../../shared/constants';
import { buildCourLabel, summarize } from '../../shared/utils';
import { applyGlossaryToSegments, loadMergedGlossary, glossaryVersion } from '../../asr/glossary';

function wrap<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((err) => {
    throw mapDbError(err);
  });
}

// ───────────────────────── courses ─────────────────────────

export async function upsertCourse(course: CourseEntity): Promise<void> {
  return wrap(async () => {
    const db = await getDb();
    // 课程墙/课表同步拿不到教师等可选字段时，不能把播放页已经补全的数据清空
    const prev = await db.get('courses', course.teclId);
    await db.put('courses', {
      ...course,
      subjCode: course.subjCode ?? prev?.subjCode,
      teacherNames: course.teacherNames.length > 0 ? course.teacherNames : (prev?.teacherNames ?? []),
      clroName: course.clroName ?? prev?.clroName,
      semester: course.semester ?? prev?.semester,
      teclCode: course.teclCode ?? prev?.teclCode,
      coverUrl: course.coverUrl ?? prev?.coverUrl,
      updatedAt: Date.now(),
    });
  });
}

export async function getCourse(teclId: number): Promise<CourseEntity | null> {
  return wrap(async () => {
    const db = await getDb();
    return (await db.get('courses', teclId)) ?? null;
  });
}

export async function listCourses(): Promise<CourseEntity[]> {
  return wrap(async () => {
    const db = await getDb();
    const all = await db.getAll('courses');
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  });
}

export async function renameCourse(teclId: number, name: string): Promise<void> {
  return wrap(async () => {
    const db = await getDb();
    const course = await db.get('courses', teclId);
    if (!course) throw new AppError('INVALID_INPUT', { detail: `课程不存在：${teclId}` });
    await db.put('courses', { ...course, subjName: name, updatedAt: Date.now() });
  });
}

// ───────────────────────── sessions ─────────────────────────

export async function upsertSession(session: SessionEntity): Promise<void> {
  return wrap(async () => {
    const db = await getDb();
    const existing = await db.get('sessions', session.courId);
    await db.put('sessions', {
      ...existing,
      ...session,
      updatedAt: Date.now(),
    });
  });
}

export async function getSession(courId: number): Promise<SessionEntity | null> {
  return wrap(async () => {
    const db = await getDb();
    return (await db.get('sessions', courId)) ?? null;
  });
}

export async function listSessionsByCourse(teclId: number): Promise<SessionEntity[]> {
  return wrap(async () => {
    const db = await getDb();
    const list = await db.getAllFromIndex('sessions', 'teclId', teclId);
    return list.sort((a, b) => (a.beginTime < b.beginTime ? 1 : -1));
  });
}

export async function patchSession(courId: number, patch: Partial<SessionEntity>): Promise<void> {
  return wrap(async () => {
    const db = await getDb();
    const existing = await db.get('sessions', courId);
    if (!existing) {
      // 允许在没有元数据时创建最小记录（例如先看视频后补元数据失败）
      if (patch.teclId === undefined) return;
      await db.put('sessions', {
        courId,
        teclId: patch.teclId,
        beginTime: patch.beginTime ?? new Date().toISOString(),
        endTime: patch.endTime ?? new Date().toISOString(),
        watchState: patch.watchState ?? 'unwatched',
        ...patch,
        updatedAt: Date.now(),
      } as SessionEntity);
      return;
    }
    await db.put('sessions', { ...existing, ...patch, updatedAt: Date.now() });
  });
}

/** 站点元数据聚合结果一次性落库（courses + sessions，单事务） */
export async function saveSessionMeta(meta: SessionMeta, weekNumber?: number): Promise<void> {
  return wrap(async () => {
    const db = await getDb();
    const now = Date.now();
    const tx = db.transaction(['courses', 'sessions'], 'readwrite');
    const courseStore = tx.objectStore('courses');
    const prevCourse = await courseStore.get(meta.teclId);
    const course: CourseEntity = {
      teclId: meta.teclId,
      subjName: meta.courseName || prevCourse?.subjName || `教学班 ${meta.teclId}`,
      subjCode: meta.subjCode ?? prevCourse?.subjCode,
      teacherNames: meta.teacherNames.length > 0 ? meta.teacherNames : (prevCourse?.teacherNames ?? []),
      clroName: meta.clroName ?? prevCourse?.clroName,
      semester: prevCourse?.semester,
      teclCode: prevCourse?.teclCode,
      coverUrl: prevCourse?.coverUrl,
      updatedAt: now,
    };
    await courseStore.put(course);

    const sessionStore = tx.objectStore('sessions');
    const prev = await sessionStore.get(meta.courId);
    const label =
      meta.courLabel ||
      buildCourLabel({ weekNumber, beginTime: meta.beginTime, letiNumber: meta.letiNumber, clroName: meta.clroName });
    const session: SessionEntity = {
      ...(prev ?? {
        courId: meta.courId,
        teclId: meta.teclId,
        beginTime: meta.beginTime ? new Date(meta.beginTime).toISOString() : new Date().toISOString(),
        endTime: meta.endTime ? new Date(meta.endTime).toISOString() : new Date().toISOString(),
        watchState: 'unwatched' as const,
      }),
      courId: meta.courId,
      teclId: meta.teclId,
      beginTime: meta.beginTime ? new Date(meta.beginTime).toISOString() : (prev?.beginTime ?? new Date().toISOString()),
      endTime: meta.endTime ? new Date(meta.endTime).toISOString() : (prev?.endTime ?? new Date().toISOString()),
      letiNumber: meta.letiNumber ?? prev?.letiNumber,
      letyName: meta.letyName ?? prev?.letyName,
      durationSec: meta.durationSec || prev?.durationSec,
      courseName: course.subjName,
      courLabel: label,
      // 统计回写的完看度必须保留：元数据刷新不能重置学习进度
      watchRatio: prev?.watchRatio,
      updatedAt: now,
    };
    await sessionStore.put(session);
    await tx.done;
  });
}

// ───────────────────────── transcripts ─────────────────────────

export async function getTranscript(mediaKey: MediaKey): Promise<TranscriptEntity | null> {
  return wrap(async () => {
    const db = await getDb();
    return (await db.get('transcripts', mediaKey)) ?? null;
  });
}

/**
 * 全库 transcript 主键（getAllKeys，仅键不载正文）。
 * 第 16 轮知识库「字幕已就绪」徽标的前缀匹配用：多 P 后 `bili:<bvid>:p<N>` 分 P 键
 * 与裸键并存，逐个 transcript.get 精确查会漏掉分 P 记录，改在 UI 侧对键集合做前缀匹配。
 */
export async function listTranscriptMediaKeys(): Promise<MediaKey[]> {
  return wrap(async () => {
    const db = await getDb();
    return await db.getAllKeys('transcripts');
  });
}

export async function putTranscript(transcript: TranscriptEntity): Promise<void> {
  return wrap(async () => {
    const db = await getDb();
    await db.put('transcripts', { ...transcript, updatedAt: Date.now() });
  });
}

export async function clearTranscript(mediaKey: MediaKey): Promise<void> {
  return wrap(async () => {
    const db = await getDb();
    const tx = db.transaction(['transcripts', 'asrChunks'], 'readwrite');
    await tx.objectStore('transcripts').delete(mediaKey);
    // 分片主键以 `${mediaKey}:` 为前缀，按前缀区间清除（与 listAsrChunks 同口径）
    const chunkKeys = await tx
      .objectStore('asrChunks')
      .getAllKeys(IDBKeyRange.bound(`${mediaKey}:`, `${mediaKey}:\uffff`));
    for (const key of chunkKeys) await tx.objectStore('asrChunks').delete(key);
    await tx.done;
  });
}

/** 词表更新后重新应用纠错（不重跑 ASR，§5.5；课程级词表仍按 courId 存 kv） */
export async function applyGlossary(mediaKey: MediaKey): Promise<TranscriptEntity | null> {
  const transcript = await getTranscript(mediaKey);
  if (!transcript) return null;
  const glossary = await loadMergedGlossary(hduCourIdOf(mediaKey));
  const segments = applyGlossaryToSegments(transcript.segments, glossary);
  const next: TranscriptEntity = {
    ...transcript,
    segments,
    glossaryVersion: glossaryVersion(glossary),
    updatedAt: Date.now(),
  };
  await putTranscript(next);
  return next;
}

export interface TranscriptHit {
  mediaKey: MediaKey;
  /** 站内课次 ID（记录体保留字段；B 站记录缺省） */
  courId?: number;
  start: number;
  end: number;
  text: string;
  score: number;
}

/** 与共享操作契约（'transcript.search'）保持同名的返回类型别名 */
export type TranscriptSearchHit = TranscriptHit;

/**
 * 本地关键词检索（A4）：对 segments 做子串匹配 + 简单打分。
 * 打分 = 命中次数 ×2 + 命中位置权重（越靠前越高）+ 段落长度惩罚。
 * 数据量级预期 <10k 段/课次，内存过滤足够（§7 B3）。
 */
export async function searchTranscripts(query: string, mediaKeys?: MediaKey[], limit = 100): Promise<TranscriptHit[]> {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return wrap(async () => {
    const db = await getDb();
    const targets: TranscriptEntity[] = [];
    if (mediaKeys && mediaKeys.length > 0) {
      for (const mediaKey of mediaKeys) {
        const t = await db.get('transcripts', mediaKey);
        if (t) targets.push(t);
      }
    } else {
      targets.push(...(await db.getAll('transcripts')));
    }
    const hits: TranscriptHit[] = [];
    for (const t of targets) {
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
        // 打分：命中次数为主，命中位置越靠前越高，段落过长略降权
        const positionWeight = 1 - firstIdx / Math.max(1, text.length);
        const lengthPenalty = Math.min(1, text.length / 400);
        const score = count * 2 + positionWeight - lengthPenalty;
        hits.push({ mediaKey: t.mediaKey, courId: t.courId, start: seg.s, end: seg.e, text: seg.text, score });
      }
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  });
}

/** 跨课次字幕聚合命中的单媒体结果（统一搜索入口 `search.all` 用） */
export interface TranscriptCourseHit {
  mediaKey: MediaKey;
  /** 站内课次 ID（记录体保留字段；由 sessions 表回查补齐 teclId 用；B 站记录缺省） */
  courId?: number;
  /** 由 sessions 表按 courId 回查补齐（transcripts 不冗余存储 teclId） */
  teclId?: number;
  /** 该媒体内的命中段数（受 limitPerCourse 截断，用于跨媒体排序） */
  hitCount: number;
  /** 评分最高的命中段（供摘要展示与锚点信息） */
  best: { startSec: number; text: string } | null;
  /**
   * 命中段列表（第 257 轮，检索域）：按字幕时间序收集的命中段（与 hitCount 同受
   * limitPerCourse 封顶），供统一搜索结果「命中 N 段」展开定位用。text 截断至
   * 120 字符（展开行展示用，不承载全文）；hitCount ≤ 1 时为空数组。
   */
  segments: Array<{ startSec: number; text: string }>;
}

/**
 * 跨课次字幕聚合检索（统一搜索入口）：IDB cursor 全量遍历 transcripts store，
 * 对 segments 的 text 做不区分大小写包含匹配，按课次聚合命中计数。
 *
 * 性能边界：本地库规模（一个学期几十节课、单课次 <10k 段）下 cursor 全扫 +
 * 子串匹配可接受（毫秒级），不做倒排索引；limitPerCourse 限制单课次参与统计
 * 的命中段数（避免超长课次拖慢整体），totalLimit 限制返回的课次数。
 * 评分与 transcript.search 同向：命中次数为主，位置越靠前越高，过长段落略降权。
 */
export async function searchTranscriptsByCourse(
  keyword: string,
  opts: { limitPerCourse?: number; totalLimit?: number } = {},
): Promise<TranscriptCourseHit[]> {
  const needle = keyword.trim().toLowerCase();
  if (!needle) return [];
  const perCourse = Math.max(1, opts.limitPerCourse ?? 20);
  const totalLimit = Math.max(1, opts.totalLimit ?? 10);
  return wrap(async () => {
    const db = await getDb();
    const aggregated = new Map<
      MediaKey,
      {
        mediaKey: MediaKey;
        courId?: number;
        hitCount: number;
        best: { startSec: number; text: string; score: number } | null;
        segments: Array<{ startSec: number; text: string }>;
      }
    >();
    const tx = db.transaction('transcripts', 'readonly');
    let cursor = await tx.store.openCursor();
    while (cursor) {
      const transcript = cursor.value as TranscriptEntity | undefined;
      if (transcript && typeof transcript.mediaKey === 'string' && Array.isArray(transcript.segments)) {
        let entry = aggregated.get(transcript.mediaKey);
        if (!entry) {
          entry = { mediaKey: transcript.mediaKey, ...(typeof transcript.courId === 'number' ? { courId: transcript.courId } : {}), hitCount: 0, best: null, segments: [] };
          aggregated.set(transcript.mediaKey, entry);
        }
        let counted = 0;
        for (const seg of transcript.segments) {
          // 单课次命中段数到上限后提前结束扫描（hitCount 相应封顶）
          if (counted >= perCourse) break;
          const text = typeof seg?.text === 'string' ? seg.text : '';
          const lower = text.toLowerCase();
          const firstIdx = lower.indexOf(needle);
          if (firstIdx < 0) continue;
          counted += 1;
          entry.hitCount += 1;
          // 命中段收集（第 257 轮）：字幕时间序天然升序；text 截断 120 字符（展开行展示用）
          const segStart = typeof seg.s === 'number' && Number.isFinite(seg.s) ? seg.s : 0;
          entry.segments.push({ startSec: segStart, text: text.length > 120 ? `${text.slice(0, 120)}…` : text });
          let occurrences = 0;
          let idx = firstIdx;
          while (idx >= 0) {
            occurrences += 1;
            idx = lower.indexOf(needle, idx + needle.length);
          }
          const positionWeight = 1 - firstIdx / Math.max(1, text.length);
          const lengthPenalty = Math.min(1, text.length / 400);
          const score = occurrences * 2 + positionWeight - lengthPenalty;
          if (!entry.best || score > entry.best.score) {
            entry.best = { startSec: segStart, text, score };
          }
        }
      }
      cursor = await cursor.continue();
    }
    // 只读事务随循环结束完成；teclId 回查走独立隐式事务
    await tx.done;
    const hits: TranscriptCourseHit[] = [];
    for (const entry of aggregated.values()) {
      if (entry.hitCount <= 0) continue;
      const session =
        entry.courId !== undefined ? await db.get('sessions', entry.courId).catch(() => null) : null;
      const { score: _score, ...best } = entry.best ?? { startSec: 0, text: '', score: 0 };
      hits.push({
        mediaKey: entry.mediaKey,
        ...(entry.courId !== undefined ? { courId: entry.courId } : {}),
        ...(session && typeof session.teclId === 'number' && Number.isFinite(session.teclId)
          ? { teclId: session.teclId }
          : {}),
        hitCount: entry.hitCount,
        best: entry.best ? best : null,
        segments: entry.segments,
      });
    }
    return hits.sort((a, b) => b.hitCount - a.hitCount).slice(0, totalLimit);
  });
}

// ───────────────────────── aiResults ─────────────────────────

export async function getAiResult(mediaKey: MediaKey): Promise<{ result: AiResultEntity | null; stale: boolean }> {
  return wrap(async () => {
    const db = await getDb();
    const result = (await db.get('aiResults', mediaKey)) ?? null;
    if (!result) return { result: null, stale: false };
    return { result, stale: result.promptVersion !== PROMPT_VERSION };
  });
}

export async function putAiResult(result: AiResultEntity): Promise<void> {
  return wrap(async () => {
    const db = await getDb();
    await db.put('aiResults', result);
  });
}

export async function clearAiResult(mediaKey: MediaKey): Promise<void> {
  return wrap(async () => {
    const db = await getDb();
    await db.delete('aiResults', mediaKey);
  });
}

// ───────────────────────── chats ─────────────────────────

export async function putChat(message: ChatMessageEntity): Promise<void> {
  return wrap(async () => {
    const db = await getDb();
    await db.put('chats', message);
  });
}

export async function updateChat(id: string, patch: Partial<ChatMessageEntity>): Promise<void> {
  return wrap(async () => {
    const db = await getDb();
    const existing = await db.get('chats', id);
    if (!existing) return;
    await db.put('chats', { ...existing, ...patch });
  });
}

export async function listChats(mediaKey: MediaKey, groupId?: string): Promise<ChatMessageEntity[]> {
  return wrap(async () => {
    const db = await getDb();
    const list = groupId
      ? await db.getAllFromIndex('chats', 'groupId', groupId)
      : await db.getAllFromIndex('chats', 'mediaKey', mediaKey);
    return list
      .filter((m) => m.mediaKey === mediaKey)
      .sort((a, b) => a.createdAt - b.createdAt);
  });
}

/** 问答分组列表（同一时间点锚定的一组追问） */
export async function listChatGroups(mediaKey: MediaKey): Promise<Array<{ groupId: string; title: string; lastAt: number; count: number }>> {
  return wrap(async () => {
    const db = await getDb();
    const list = await db.getAllFromIndex('chats', 'mediaKey', mediaKey);
    const map = new Map<string, { groupId: string; title: string; lastAt: number; count: number; anchor?: number }>();
    for (const m of list) {
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
  });
}

/** 跨 P 聚合的问答分组（第 104 轮巡检）：前缀匹配 bvid 的全部分 P 键（`bili:<bvid>` 与
 *  `bili:<bvid>:p<N>`），按组合并并回填所属 mediaKey/p，供 B 站会话历史跨 P 查看/删除。 */
export async function listChatGroupsByBvid(bvid: string): Promise<ChatGroupInfo[]> {
  if (!bvid) return [];
  return wrap(async () => {
    const db = await getDb();
    const list = await db.getAllFromIndex('chats', 'mediaKey');
    const base = `bili:${bvid}`;
    const map = new Map<
      string,
      { groupId: string; title: string; lastAt: number; count: number; anchor?: number; mediaKey: MediaKey; p: number }
    >();
    for (const m of list) {
      if (m.mediaKey !== base && !m.mediaKey.startsWith(`${base}:p`)) continue;
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
  });
}

/** 跨 P 全部问答消息（第 105 轮巡检）：前缀匹配 bvid 的全部分 P 键，按时间升序合并，
 *  供 B 站会话历史跨 P「导出全部」一次取全。 */
export async function listChatsByBvid(bvid: string): Promise<ChatMessageEntity[]> {
  if (!bvid) return [];
  return wrap(async () => {
    const db = await getDb();
    const list = await db.getAllFromIndex('chats', 'mediaKey');
    const base = `bili:${bvid}`;
    return list
      .filter((m) => m.mediaKey === base || m.mediaKey.startsWith(`${base}:p`))
      .sort((a, b) => a.createdAt - b.createdAt);
  });
}

export async function clearChats(mediaKey: MediaKey, groupId?: string): Promise<void> {
  return wrap(async () => {
    const db = await getDb();
    const tx = db.transaction('chats', 'readwrite');
    const list = groupId ? await tx.store.index('groupId').getAll(groupId) : await tx.store.index('mediaKey').getAll(mediaKey);
    for (const m of list) {
      if (m.mediaKey === mediaKey) await tx.store.delete(m.id);
    }
    await tx.done;
  });
}
