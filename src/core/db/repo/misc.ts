/** 低层 KV、课表与 D4 补看清单仓储。 */

import { getDb, mapDbError } from '../index';
import { loadSettings } from '../../shared/settings';
import { buildCourLabel, ratio } from '../../shared/utils';
import type { CurriculumItem } from '../../shared/types';
import type { MissedItem } from '../../shared/ops';
import type { CurriculumRecord } from '../schema';

function wrap<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((err) => {
    throw mapDbError(err);
  });
}

export async function kvGet<T>(key: string): Promise<T | null> {
  const db = await getDb();
  const record = await db.get('kv', key);
  return (record?.value as T) ?? null;
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  const db = await getDb();
  await db.put('kv', { key, value, updatedAt: Date.now() });
}

export async function kvDelete(key: string): Promise<void> {
  const db = await getDb();
  await db.delete('kv', key);
}

/** 已知 KV 键（集中声明，避免字符串散落） */
export const KV_KEYS = {
  hiddenTopics: (courId: number) => `aiHidden:${courId}`,
  /** 旧版逐课次排除键：仅保留导出以兼容旧调用方，新代码统一用 scheduleExcluded */
  missedExcluded: (courId: number) => `missedExcluded:${courId}`,
  /** 补看清单排除项：number[]（courId），单条记录持久化 */
  scheduleExcluded: 'schedule:excluded',
  panelState: 'panel:state',
  goalAdjust: 'goal:adjust',
  lastReportAt: 'report:lastAt',
  examMode: 'review:examMode',
  termYear: 'schedule:termYear',
} as const;

// ───────────────────────── 课表（D4） ─────────────────────────

export async function putCurriculum(items: CurriculumItem[], termYear?: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction('curriculum', 'readwrite');
  // 全量替换：以课表接口返回为准（保留 termYear）
  const keys = await tx.store.getAllKeys();
  for (const key of keys) await tx.store.delete(key);
  for (const item of items) {
    const record: CurriculumRecord = { ...item, termYear, updatedAt: Date.now() };
    await tx.store.put(record);
  }
  await tx.done;
}

export async function listCurriculum(): Promise<CurriculumRecord[]> {
  const db = await getDb();
  const all = await db.getAll('curriculum');
  return all
    .map(({ updatedAt: _updatedAt, ...rest }) => rest as CurriculumRecord)
    .sort((a, b) => a.beginTime - b.beginTime);
}

// ───────────────────────── 补看排除项（D4） ─────────────────────────

/** 读取补看清单排除项（number[] courId） */
export async function listScheduleExcluded(): Promise<number[]> {
  const list = await kvGet<number[]>(KV_KEYS.scheduleExcluded);
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((id): id is number => Number.isFinite(id)))];
}

/** 标记/取消"已到课，无需补看"（持久化在 kv: schedule:excluded） */
export async function setScheduleExcluded(courId: number, excluded: boolean): Promise<void> {
  const list = await listScheduleExcluded();
  const next = excluded ? [...new Set([...list, courId])] : list.filter((id) => id !== courId);
  await kvSet(KV_KEYS.scheduleExcluded, next);
}

/** 旧名兼容：等价于 setScheduleExcluded */
export async function setMissedExcluded(courId: number, excluded: boolean): Promise<void> {
  return setScheduleExcluded(courId, excluded);
}

/** 旧名兼容：等价于 listScheduleExcluded */
export async function listMissedExcluded(): Promise<number[]> {
  return listScheduleExcluded();
}

interface MissedCandidate {
  courId: number;
  teclId: number;
  beginMs: number;
  endMs: number;
  courseName?: string;
  courLabel?: string;
  durationSec?: number;
  letiNumber?: number;
}

/**
 * 补看清单（§7 D4）：
 *  - 数据源 = 课表快照（若有），并补充本地已有元数据的课次；
 *  - 课次结束超过 `settings.missDelayHours` 且有效观看时长未达
 *    `settings.finishThreshold × durationSec` 的列入；
 *  - `kv: schedule:excluded` 中的课次默认不再返回。
 *
 * 有效时长按 `watchRecords.valid === true` 汇总（与报表口径一致）。
 * `includeExcluded=true` 时也返回被排除项（`excluded` 置 true），供"撤销排除"界面使用。
 */
export async function computeMissedItems(includeExcluded = false): Promise<MissedItem[]> {
  return wrap(async () => {
    const db = await getDb();
    const [settings, curriculum, sessions, courses, records, excluded] = await Promise.all([
      loadSettings(),
      listCurriculum(),
      db.getAll('sessions'),
      db.getAll('courses'),
      db.getAll('watchRecords'),
      listScheduleExcluded(),
    ]);
    const now = Date.now();
    const delayMs = Math.max(0, settings.missDelayHours) * 3600 * 1000;
    const excludedSet = new Set(excluded);
    const sessionByCour = new Map(sessions.map((session) => [session.courId, session]));
    const courseNames = new Map(courses.map((course) => [course.teclId, course.subjName]));

    // 有效观看时长按课次归集（一次性取出流水，避免逐条查询）
    const watchedByCour = new Map<number, number>();
    for (const record of records) {
      if (!record.valid) continue;
      watchedByCour.set(record.courId, (watchedByCour.get(record.courId) ?? 0) + record.durationSec);
    }

    const candidates = new Map<number, MissedCandidate>();
    for (const entry of curriculum) {
      candidates.set(entry.courId, {
        courId: entry.courId,
        teclId: entry.teclId,
        beginMs: entry.beginTime,
        endMs: entry.endTime,
        courseName: entry.subjName,
        letiNumber: entry.letiNumber,
      });
    }
    // 课表尚未同步时也能工作：把本地已有的课次元数据作为补充
    for (const session of sessions) {
      if (candidates.has(session.courId)) continue;
      const beginMs = Date.parse(session.beginTime);
      const endMs = Date.parse(session.endTime);
      if (!Number.isFinite(beginMs) || !Number.isFinite(endMs)) continue;
      candidates.set(session.courId, {
        courId: session.courId,
        teclId: session.teclId,
        beginMs,
        endMs,
        courseName: session.courseName,
        courLabel: session.courLabel,
        durationSec: session.durationSec,
        letiNumber: session.letiNumber,
      });
    }

    const items: MissedItem[] = [];
    for (const candidate of candidates.values()) {
      const { courId } = candidate;
      const isExcluded = excludedSet.has(courId);
      if (isExcluded && !includeExcluded) continue;
      if (!Number.isFinite(candidate.endMs)) continue;
      // 课次结束后未到补看宽限期：视为"还可能去看"
      if (now - candidate.endMs < delayMs) continue;

      const session = sessionByCour.get(courId);
      const beginMs = Number.isFinite(candidate.beginMs)
        ? candidate.beginMs
        : Number.isFinite(Date.parse(session?.beginTime ?? ''))
          ? Date.parse(session?.beginTime ?? '')
          : candidate.endMs;
      const explicitDuration =
        session?.durationSec && session.durationSec > 0 ? session.durationSec : candidate.durationSec;
      const durationSec =
        explicitDuration && explicitDuration > 0
          ? explicitDuration
          : Math.max(1, (candidate.endMs - beginMs) / 1000);
      const watchedSec = watchedByCour.get(courId) ?? 0;
      const watchRatio = ratio(watchedSec, durationSec);
      // 完看度达到阈值（默认 90%）即不列入
      if (watchRatio >= settings.finishThreshold) continue;

      items.push({
        courId,
        teclId: candidate.teclId,
        courseName:
          courseNames.get(candidate.teclId) ??
          candidate.courseName ??
          session?.courseName ??
          `教学班 ${candidate.teclId}`,
        courLabel:
          session?.courLabel ||
          candidate.courLabel ||
          buildCourLabel({ beginTime: beginMs, letiNumber: candidate.letiNumber ?? session?.letiNumber }),
        beginTime: beginMs,
        watchedSec: Math.round(watchedSec),
        watchRatio,
        excluded: isExcluded,
      });
    }

    return items.sort((a, b) => b.beginTime - a.beginTime);
  });
}
