import { callOp } from '@/core/shared/client';
import { isDemoActive } from '@/core/demo';
import { toAppError } from '@/core/shared/errors';
import type { CourseEntity, CourseListItem } from '@/core/shared/types';
import { buildCourLabel, startOfLocalWeek } from '@/core/shared/utils';
import {
  fetchCourseWall,
  fetchCurriculum,
  fetchSessionList,
  fetchTeachingClass,
  fetchTermYears,
  orderTermYearsForSchedule,
  type TermYear,
} from '../site/api';
import { uiStore } from '../ui/store';
import { log, type CourseSyncResult, type ScheduleSyncResult } from './dom';
import type { ControllerContext } from './context';

// 站点同步节流状态自包含（内容脚本每页单实例，随模块生存）
let courseSyncAt = 0;
let courseSyncAttemptAt = 0;
let courseSyncPromise: Promise<CourseSyncResult> | null = null;
let scheduleSyncAt = 0;
let scheduleSyncAttemptAt = 0;
let scheduleSyncPromise: Promise<ScheduleSyncResult> | null = null;

function readSessionNumber(key: string): number {
  try {
    const value = Number(sessionStorage.getItem(key) ?? 0);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

/**
 * 从站点只读同步课程墙与课次。
 *
 * 节流规则：只在**成功**后记录时间戳（15 分钟内不重复同步）。
 * 旧实现先把时间戳写进 sessionStorage 再请求，首次请求失败（例如刚登录、
 * 站点接口尚未就绪）会把后续 15 分钟的自动重试全部挡掉，表现为“我的课程一直为空”。
 */
export async function syncSiteCache(ctx: ControllerContext, force = false): Promise<CourseSyncResult> {
  const empty = { courses: 0, sessions: 0 };
  if (ctx.disposed) return { ok: false, skipped: true, ...empty };
  // 演示模式（第 319 轮）：站点同步写入的是真实站点数据，跳过以免混进演示库
  if (await isDemoActive()) return { ok: true, skipped: true, ...empty };
  if (courseSyncPromise) return courseSyncPromise;

  const now = Date.now();
  // v2 键：旧实现会在**请求前**写入时间戳（失败也被计入节流），换键避免继承那次失败的节流。
  const lastSuccessAt = Math.max(courseSyncAt, readSessionNumber('hdu.courseSyncAt.v2'));
  if (!force && now - lastSuccessAt < 15 * 60_000) {
    return { ok: true, skipped: true, ...empty };
  }
  // 失败后的短冷却：避免用户在列表页频繁切换筛选时连续打站点接口
  if (!force && now - courseSyncAttemptAt < 30_000) {
    return { ok: false, skipped: true, ...empty };
  }
  courseSyncAttemptAt = now;

  const run = (async (): Promise<CourseSyncResult> => {
    try {
      const courses = await fetchAllCourseWall();
      const picked = courses.filter((c) => c.teclId > 0);
      let courseCount = 0;
      let sessionCount = 0;
      for (const item of picked) {
        // 课程墙接口经常不返回教师字段：先看课次行，最后用教学班详情补一次（只在缺失时请求）
        const sessions = await fetchSessionList(item.teclId).catch(() => []);
        let teacherNames =
          item.teacherNames.length > 0
            ? item.teacherNames
            : (sessions.find((s) => (s.teacherNames?.length ?? 0) > 0)?.teacherNames ?? []);
        if (teacherNames.length === 0) {
          const info = await fetchTeachingClass(item.teclId).catch(() => null);
          if (info?.teacherNames.length) teacherNames = info.teacherNames;
        }
        const course: CourseEntity = {
          teclId: item.teclId,
          subjName: item.subjName || `教学班 ${item.teclId}`,
          subjCode: item.subjCode,
          teacherNames,
          clroName: item.clroName,
          teclCode: item.teclCode,
          coverUrl: item.coverUrl,
          updatedAt: Date.now(),
        };
        try {
          await callOp('course.upsert', { course });
          courseCount += 1;
        } catch (err) {
          log.warn('课程写入失败', { teclId: item.teclId, detail: toAppError(err).detail });
          continue;
        }
        for (const s of sessions.slice(0, 80)) {
          if (!s.courId || !s.beginTime) continue;
          try {
            await callOp('session.patch', {
              courId: s.courId,
              patch: {
                teclId: item.teclId,
                beginTime: new Date(s.beginTime).toISOString(),
                endTime: new Date(s.endTime).toISOString(),
                letiNumber: s.letiNumber,
                letyName: s.letyName,
                courseName: item.subjName,
                courLabel: buildCourLabel({ beginTime: s.beginTime, letiNumber: s.letiNumber, clroName: s.clroName }),
              },
            });
            sessionCount += 1;
          } catch (err) {
            log.debug('课次写入失败', { courId: s.courId, detail: toAppError(err).detail });
          }
        }
      }
      await syncSchedule();
      uiStore.patch({ centerDataVersion: uiStore.getState().centerDataVersion + 1 });
      if (picked.length > 0 && courseCount === 0) {
        return { ok: false, courses: 0, sessions: sessionCount, error: '课程数据写入本地失败' };
      }
      courseSyncAt = Date.now();
      try {
        sessionStorage.setItem('hdu.courseSyncAt.v2', String(courseSyncAt));
      } catch {
        /* 隐私模式忽略 */
      }
      return { ok: true, courses: courseCount, sessions: sessionCount };
    } catch (err) {
      const appErr = toAppError(err, 'SITE_API_FAILED');
      log.warn('课程同步失败', { code: appErr.code, detail: appErr.detail });
      return { ok: false, courses: 0, sessions: 0, error: appErr.userMessage };
    }
  })();

  courseSyncPromise = run;
  try {
    return await run;
  } finally {
    if (courseSyncPromise === run) courseSyncPromise = null;
  }
}

/** 拉取课程墙全部分页（站点忽略分页时自动停止）。 */
async function fetchAllCourseWall(): Promise<CourseListItem[]> {
  // 站点页面自身使用 pageSize=15，沿用该值以避免服务端对页大小设限
  const pageSize = 15;
  const maxPages = 10;
  const collected = new Map<number, CourseListItem>();
  for (let page = 1; page <= maxPages; page += 1) {
    let batch: CourseListItem[];
    try {
      batch = await fetchCourseWall(pageSize, page);
    } catch (err) {
      // 首页失败视为同步失败（用于提示用户）；后续分页失败则保留已取到的课程
      if (page === 1) throw err;
      log.warn('课程墙后续分页拉取失败', { page, detail: toAppError(err).detail });
      break;
    }
    if (batch.length === 0) break;
    let added = 0;
    for (const item of batch) {
      if (item.teclId > 0 && !collected.has(item.teclId)) {
        collected.set(item.teclId, item);
        added += 1;
      }
    }
    // 站点忽略 pageIndex 时会重复返回第一页：没有新增就停止
    if (added === 0) break;
  }
  return [...collected.values()];
}

export async function syncSchedule(force = false): Promise<ScheduleSyncResult> {
  // 演示模式（第 319 轮）：课表同步同理跳过，演示库只保留虚构课表
  if (await isDemoActive()) return { ok: true, count: 0, skipped: true };
  if (scheduleSyncPromise) return scheduleSyncPromise;

  const nowMs = Date.now();
  const lastSuccessAt = Math.max(scheduleSyncAt, readSessionNumber('hdu.scheduleSyncAt.v1'));
  if (!force && lastSuccessAt > 0 && nowMs - lastSuccessAt < 5 * 60_000) {
    return { ok: true, count: 0, skipped: true };
  }
  if (!force && scheduleSyncAttemptAt > 0 && nowMs - scheduleSyncAttemptAt < 30_000) {
    return { ok: true, count: 0, skipped: true };
  }
  scheduleSyncAttemptAt = nowMs;

  const promise = (async (): Promise<ScheduleSyncResult> => {
    const weekStart = startOfLocalWeek();
    const weekEnd = weekStart + 7 * 86_400_000 - 1;
    const now = new Date();
    let years: TermYear[] = [];
    let termYearsError: unknown = null;
    try {
      years = await fetchTermYears({ strict: true });
    } catch (err) {
      termYearsError = err;
      log.warn('学期字典读取失败，回退 acteId=9', toAppError(err).detail);
    }
    // 站点 termYear 自带 currentTerm；没有时按“当前时间落在区间内 → 最近开学 → 最大 id”排序
    const ordered = orderTermYearsForSchedule(years, now.getTime());
    const candidates: TermYear[] = [];
    for (const year of ordered) {
      if (String(year.acteId).trim() === '') continue;
      if (candidates.some((item) => String(item.acteId) === String(year.acteId))) continue;
      candidates.push(year);
      if (candidates.length >= 6) break;
    }
    if (candidates.length === 0) candidates.push({ acteId: 9, name: '' });
    log.info('课表学期候选', {
      candidates: candidates.map((item) => ({
        acteId: item.acteId,
        name: item.name,
        current: item.currentTerm === true,
        begin: item.beginTime ? new Date(item.beginTime).toISOString() : undefined,
        end: item.endTime ? new Date(item.endTime).toISOString() : undefined,
      })),
      termYearsError: termYearsError ? toAppError(termYearsError).detail : undefined,
    });

    // 站点实测使用 "YYYY-MM-DD HH:mm:ss"；毫秒时间戳与纯日期作为兼容兜底
    const attempted: string[] = [];
    let lastError: unknown = termYearsError;
    let emptyResponse = false;
    for (const format of ['datetime', 'date', 'ms'] as const) {
      for (const candidate of candidates) {
        const label = `${candidate.acteId}/${format}`;
        attempted.push(label);
        try {
          const items = await fetchCurriculum(candidate.acteId, weekStart, weekEnd, format, {
            strict: true,
          });
          if (items.length === 0) {
            // 接口成功但本周确实没课：这是有效结果，不再拿旧快照臆断
            emptyResponse = true;
            continue;
          }
          await callOp('schedule.put', { items, termYear: candidate.name || undefined });
          uiStore.patch({ centerDataVersion: uiStore.getState().centerDataVersion + 1 });
          scheduleSyncAt = Date.now();
          try {
            sessionStorage.setItem('hdu.scheduleSyncAt.v1', String(scheduleSyncAt));
          } catch {
            /* 隐私模式忽略 */
          }
          log.info('课表同步完成', {
            acteId: candidate.acteId,
            termYear: candidate.name,
            format,
            count: items.length,
          });
          return { ok: true, count: items.length };
        } catch (err) {
          lastError = err;
          log.warn('课表请求失败', {
            acteId: candidate.acteId,
            termYear: candidate.name,
            format,
            detail: toAppError(err).detail,
          });
        }
      }
    }
    if (lastError && !emptyResponse) {
      const appErr = toAppError(lastError, 'SITE_API_FAILED');
      log.warn('课表同步失败', { code: appErr.code, detail: appErr.detail, attempted });
      return { ok: false, count: 0, error: appErr.userMessage };
    }
    // 接口正常但本周确实没课时也会返回空：保留旧快照，只记录诊断信息
    log.warn('本周课表未取得数据', {
      weekStart: new Date(weekStart).toISOString(),
      attempted,
    });
    return { ok: true, count: 0 };
  })().catch((err) => {
    const appErr = toAppError(err, 'SITE_API_FAILED');
    log.warn('课表同步失败', { code: appErr.code, detail: appErr.detail });
    return { ok: false, count: 0, error: appErr.userMessage };
  });

  scheduleSyncPromise = promise;
  try {
    return await promise;
  } finally {
    if (scheduleSyncPromise === promise) scheduleSyncPromise = null;
  }
}
