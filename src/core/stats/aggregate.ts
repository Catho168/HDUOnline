/**
 * 报表聚合（§7 C2）与学习中心课程包。
 *
 * 报表为纯函数：输入流水 + 课次元数据 → 输出 Dashboard 所需全部指标。
 * 所有数据本地计算，不上报（§1.3）。
 */

import { getDb } from '../db';
import type {
  CourseBundle,
  CourseEntity,
  CourseStat,
  DailyStat,
  DashboardReport,
  SessionEntity,
  SessionStat,
  WatchRecordEntity,
} from '../shared/types';
import { localDayKey, ratio, recentDayKeys, startOfLocalDay, startOfLocalWeek } from '../shared/utils';

export interface AggregateInput {
  records: WatchRecordEntity[];
  sessions: SessionEntity[];
  courses: CourseEntity[];
  /** 报表窗口（近 N 天，默认 30） */
  windowDays: number;
  /** 周目标（秒） */
  weeklyTargetSec: number;
  /** 打卡判定：当日有效时长 ≥ 该值算打卡（默认 10 分钟） */
  checkinMinSec: number;
  now?: number;
}

export function buildReport(input: AggregateInput): DashboardReport {
  const now = input.now ?? Date.now();
  const valid = input.records.filter((r) => r.valid);

  // ── 逐日聚合 ──
  const dayMap = new Map<string, { totalSec: number; validSec: number; sessions: Set<number> }>();
  for (const r of input.records) {
    const entry = dayMap.get(r.date) ?? { totalSec: 0, validSec: 0, sessions: new Set<number>() };
    entry.totalSec += r.durationSec;
    if (r.valid) entry.validSec += r.durationSec;
    entry.sessions.add(r.courId);
    dayMap.set(r.date, entry);
  }

  const days: DailyStat[] = recentDayKeys(input.windowDays, now).map((date) => {
    const entry = dayMap.get(date);
    return {
      date,
      totalSec: Math.round(entry?.totalSec ?? 0),
      validSec: Math.round(entry?.validSec ?? 0),
      sessionCount: entry?.sessions.size ?? 0,
    };
  });

  const totalSec = Math.round(valid.reduce((acc, r) => acc + r.durationSec, 0));
  const todayKey = localDayKey(now);
  const todaySec = days.find((d) => d.date === todayKey)?.validSec ?? 0;
  const weekStart = startOfLocalWeek(now);
  const weekSec = Math.round(
    valid.filter((r) => r.startTs >= weekStart).reduce((acc, r) => acc + r.durationSec, 0),
  );

  // ── 连续学习天数（今日无记录则从昨日回溯，避免"今天还没学"直接断签） ──
  const streakDays = computeStreak(new Set(valid.map((r) => r.date)), todayKey, now);

  // ── 近 12 周汇总 ──
  const weeks: Array<{ weekStart: string; totalSec: number }> = [];
  for (let i = 11; i >= 0; i -= 1) {
    const ws = new Date(startOfLocalWeek(now));
    ws.setDate(ws.getDate() - i * 7);
    const wsTs = ws.getTime();
    const weTs = wsTs + 7 * 24 * 3600 * 1000;
    const sum = valid.filter((r) => r.startTs >= wsTs && r.startTs < weTs).reduce((acc, r) => acc + r.durationSec, 0);
    weeks.push({ weekStart: localDayKey(wsTs), totalSec: Math.round(sum) });
  }

  // ── 按课程分布 ──
  const courseMap = new Map<number, { totalSec: number; sessions: Set<number>; finished: number }>();
  for (const r of valid) {
    const entry = courseMap.get(r.teclId) ?? { totalSec: 0, sessions: new Set<number>(), finished: 0 };
    entry.totalSec += r.durationSec;
    entry.sessions.add(r.courId);
    courseMap.set(r.teclId, entry);
  }
  const courses: CourseStat[] = [...courseMap.entries()]
    .map(([teclId, entry]) => {
      const course = input.courses.find((c) => c.teclId === teclId);
      const finishedCount = input.sessions.filter(
        (s) => s.teclId === teclId && s.watchState === 'finished',
      ).length;
      return {
        teclId,
        courseName: course?.subjName ?? `教学班 ${teclId}`,
        totalSec: Math.round(entry.totalSec),
        sessionCount: entry.sessions.size,
        finishedCount,
      };
    })
    .sort((a, b) => b.totalSec - a.totalSec);

  // ── 按课次明细（含完看度） ──
  const sessionAgg = new Map<number, { watchedSec: number; firstTs: number }>();
  for (const r of valid) {
    const entry = sessionAgg.get(r.courId) ?? { watchedSec: 0, firstTs: r.startTs };
    entry.watchedSec += r.durationSec;
    entry.firstTs = Math.min(entry.firstTs, r.startTs);
    sessionAgg.set(r.courId, entry);
  }
  const sessions: SessionStat[] = [...sessionAgg.entries()]
    .map(([courId, agg]) => {
      const session = input.sessions.find((s) => s.courId === courId);
      const durationSec = session?.durationSec ?? 0;
      return {
        courId,
        teclId: session?.teclId ?? 0,
        courseName: session?.courseName ?? '',
        courLabel: session?.courLabel ?? `课次 ${courId}`,
        watchedSec: Math.round(agg.watchedSec),
        durationSec,
        watchRatio: durationSec > 0 ? ratio(agg.watchedSec, durationSec) : 0,
      };
    })
    .sort((a, b) => b.watchedSec - a.watchedSec);

  const hitDaysThisWeek = days.filter((d) => d.date >= localDayKey(weekStart) && d.validSec >= input.checkinMinSec).length;

  return {
    totalSec,
    weekSec,
    todaySec,
    streakDays,
    days,
    weeks,
    courses,
    sessions,
    goal: { weeklyTargetSec: input.weeklyTargetSec, weekSec, hitDaysThisWeek },
    generatedAt: now,
  };
}

/** 连续天数：从今天（或昨天）向前回溯连续有记录的天数 */
export function computeStreak(activeDays: Set<string>, todayKey: string, now = Date.now()): number {
  if (activeDays.size === 0) return 0;
  const cursor = new Date(startOfLocalDay(now));
  if (!activeDays.has(todayKey)) {
    cursor.setDate(cursor.getDate() - 1);
  }
  let streak = 0;
  for (;;) {
    const key = localDayKey(cursor);
    if (!activeDays.has(key)) break;
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
    if (streak > 3650) break;
  }
  return streak;
}

/** 完看度 = 有效累计 / 课次时长（上限 100%，§7 C1） */
export function watchRatio(watchedSec: number, durationSec: number): number {
  return ratio(watchedSec, durationSec);
}

/** 观看状态判定（§7 D4 阈值默认 90%，可配） */
export function watchState(watchedSec: number, durationSec: number, finishThreshold: number): 'unwatched' | 'watching' | 'finished' {
  if (watchedSec <= 0) return 'unwatched';
  if (durationSec > 0 && watchedSec / durationSec >= finishThreshold) return 'finished';
  return 'watching';
}

// ───────────────────────── 学习中心：课程包 ─────────────────────────

/**
 * 课程包：课程 + 课次 + 转写/AI 统计 + 有效观看秒数（`course.bundles`）。
 *
 * - 课次按开始时间倒序（与 `session.listByCourse` 一致）；
 * - `watchedSec` 按 `watchRecords.valid` 汇总，与报表口径一致；
 * - `lastActivityAt` 取课程/课次元数据、转写、AI 结果与观看流水的最大值。
 */
export async function buildCourseBundles(): Promise<CourseBundle[]> {
  const db = await getDb();
  const [courses, sessions, transcripts, aiResults, records] = await Promise.all([
    db.getAll('courses'),
    db.getAll('sessions'),
    db.getAll('transcripts'),
    db.getAll('aiResults'),
    db.getAll('watchRecords'),
  ]);

  const sessionsByTecl = new Map<number, SessionEntity[]>();
  for (const session of sessions) {
    const list = sessionsByTecl.get(session.teclId) ?? [];
    list.push(session);
    sessionsByTecl.set(session.teclId, list);
  }
  const transcriptByCour = new Map(transcripts.map((t) => [t.courId, t] as const));
  const aiByCour = new Map(aiResults.map((a) => [a.courId, a] as const));
  const watchedByCour = new Map<number, number>();
  const lastRecordTsByCour = new Map<number, number>();
  for (const record of records) {
    if (record.valid) {
      watchedByCour.set(record.courId, (watchedByCour.get(record.courId) ?? 0) + record.durationSec);
    }
    lastRecordTsByCour.set(record.courId, Math.max(lastRecordTsByCour.get(record.courId) ?? 0, record.endTs));
  }

  const bundles: CourseBundle[] = courses.map((course) => {
    const courseSessions = (sessionsByTecl.get(course.teclId) ?? [])
      .slice()
      .sort((a, b) => (a.beginTime < b.beginTime ? 1 : -1));
    let watchedSec = 0;
    let finishedCount = 0;
    let transcriptCount = 0;
    let topicCount = 0;
    let lastActivityAt: number | undefined;

    const touch = (ts: number | undefined): void => {
      if (ts === undefined || !Number.isFinite(ts)) return;
      if (lastActivityAt === undefined || ts > lastActivityAt) lastActivityAt = ts;
    };

    touch(course.updatedAt);
    for (const session of courseSessions) {
      watchedSec += watchedByCour.get(session.courId) ?? 0;
      if (session.watchState === 'finished') finishedCount += 1;

      const transcript = transcriptByCour.get(session.courId);
      if (transcript) {
        transcriptCount += 1;
        touch(transcript.updatedAt ?? transcript.createdAt);
      }

      const ai = aiByCour.get(session.courId);
      if (ai) {
        topicCount += ai.topics.length;
        touch(ai.createdAt);
      }

      touch(session.updatedAt);
      touch(Date.parse(session.beginTime));
      touch(lastRecordTsByCour.get(session.courId));
    }

    return {
      course,
      sessions: courseSessions,
      sessionCount: courseSessions.length,
      watchedSec: Math.round(watchedSec),
      finishedCount,
      transcriptCount,
      topicCount,
      lastActivityAt,
    };
  });

  return bundles.sort((a, b) => {
    const ta = a.lastActivityAt ?? a.course.updatedAt;
    const tb = b.lastActivityAt ?? b.course.updatedAt;
    return tb - ta;
  });
}
