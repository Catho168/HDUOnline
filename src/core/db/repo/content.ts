/** 内容类实体仓储：courses / sessions / transcripts / aiResults / chats。 */

import { getDb, mapDbError } from '../index';
import type { AiResultEntity, ChatMessageEntity, CourseEntity, SessionEntity, SessionMeta, TranscriptEntity } from '../../shared/types';
import { AppError } from '../../shared/errors';
import { PROMPT_VERSION } from '../../shared/constants';
import { buildCourLabel, localDayKey, summarize } from '../../shared/utils';
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

export async function getTranscript(courId: number): Promise<TranscriptEntity | null> {
  return wrap(async () => {
    const db = await getDb();
    return (await db.get('transcripts', courId)) ?? null;
  });
}

export async function putTranscript(transcript: TranscriptEntity): Promise<void> {
  return wrap(async () => {
    const db = await getDb();
    await db.put('transcripts', { ...transcript, updatedAt: Date.now() });
  });
}

export async function clearTranscript(courId: number): Promise<void> {
  return wrap(async () => {
    const db = await getDb();
    const tx = db.transaction(['transcripts', 'asrChunks'], 'readwrite');
    await tx.objectStore('transcripts').delete(courId);
    const chunkKeys = await tx.objectStore('asrChunks').index('courId').getAllKeys(courId);
    for (const key of chunkKeys) await tx.objectStore('asrChunks').delete(key);
    await tx.done;
  });
}

/** 词表更新后重新应用纠错（不重跑 ASR，§5.5） */
export async function applyGlossary(courId: number): Promise<TranscriptEntity | null> {
  const transcript = await getTranscript(courId);
  if (!transcript) return null;
  const glossary = await loadMergedGlossary(courId);
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
  courId: number;
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
export async function searchTranscripts(query: string, courIds?: number[], limit = 100): Promise<TranscriptHit[]> {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return wrap(async () => {
    const db = await getDb();
    const targets: TranscriptEntity[] = [];
    if (courIds && courIds.length > 0) {
      for (const id of courIds) {
        const t = await db.get('transcripts', id);
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
        hits.push({ courId: t.courId, start: seg.s, end: seg.e, text: seg.text, score });
      }
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  });
}

// ───────────────────────── aiResults ─────────────────────────

export async function getAiResult(courId: number): Promise<{ result: AiResultEntity | null; stale: boolean }> {
  return wrap(async () => {
    const db = await getDb();
    const result = (await db.get('aiResults', courId)) ?? null;
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

export async function clearAiResult(courId: number): Promise<void> {
  return wrap(async () => {
    const db = await getDb();
    await db.delete('aiResults', courId);
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

export async function listChats(courId: number, groupId?: string): Promise<ChatMessageEntity[]> {
  return wrap(async () => {
    const db = await getDb();
    const list = groupId
      ? await db.getAllFromIndex('chats', 'groupId', groupId)
      : await db.getAllFromIndex('chats', 'courId', courId);
    return list
      .filter((m) => m.courId === courId)
      .sort((a, b) => a.createdAt - b.createdAt);
  });
}

/** 问答分组列表（同一时间点锚定的一组追问） */
export async function listChatGroups(courId: number): Promise<Array<{ groupId: string; title: string; lastAt: number; count: number }>> {
  return wrap(async () => {
    const db = await getDb();
    const list = await db.getAllFromIndex('chats', 'courId', courId);
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

export async function clearChats(courId: number, groupId?: string): Promise<void> {
  return wrap(async () => {
    const db = await getDb();
    const tx = db.transaction('chats', 'readwrite');
    const list = groupId ? await tx.store.index('groupId').getAll(groupId) : await tx.store.index('courId').getAll(courId);
    for (const m of list) {
      if (m.courId === courId) await tx.store.delete(m.id);
    }
    await tx.done;
  });
}

/** 会话标题（分组）——存 kv，避免额外表 */
export async function setChatGroupTitle(courId: number, groupId: string, title: string): Promise<void> {
  const db = await getDb();
  await db.put('kv', { key: `chatGroupTitle:${courId}:${groupId}`, value: title, updatedAt: Date.now() });
}

/** 统计某日活跃（连续天数计算用） */
export function sessionDayKey(session: SessionEntity): string {
  return localDayKey(new Date(session.beginTime));
}
