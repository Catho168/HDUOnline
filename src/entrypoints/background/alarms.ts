/**
 * 定时任务（§7 C3 / D2，chrome.alarms 驱动）。
 *
 * 全部通知在本地生成，不发送远端（§1.3）。
 * 周期：每 12 小时执行一次日常维护（回收站到期清理、导出包清理、复习提醒、周报）。
 */

import type { createLogger } from '@/core/shared/logger';
import { notifications, runtime } from '@/core/shared/runtime';
import { loadSettings } from '@/core/shared/settings';
import { localDayKey, startOfLocalWeek } from '@/core/shared/utils';
import { emitToAll } from './tabs';

export const ALARM_NAMES = {
  daily: 'hdu-assistant-daily',
  reviewCheck: 'hdu-assistant-review',
} as const;

export async function runScheduledTasks(name: string, log: ReturnType<typeof createLogger>): Promise<void> {
  if (name !== ALARM_NAMES.daily && name !== ALARM_NAMES.reviewCheck) return;
  try {
    await runHousekeeping(log);
    await runReviewReminder(log);
    await runWeeklyReport(log);
  } catch (err) {
    log.warn('定时任务执行失败', err);
  }
}

async function runHousekeeping(log: ReturnType<typeof createLogger>): Promise<void> {
  const { purgeExpiredTrash } = await import('@/core/db/repo/trash');
  const { purgeExpiredExportJobs } = await import('@/core/db');
  const purged = await purgeExpiredTrash();
  const exports_ = await purgeExpiredExportJobs();
  if (purged > 0 || exports_ > 0) log.info(`例行清理：回收站 ${purged} 项、导出包 ${exports_} 个`);
}

function notificationIconUrl(): string {
  return runtime.getURL('icon/128.png');
}

/** 复习提醒（§7 D2）：当天有待复习卡片则发本地通知 */
async function runReviewReminder(log: ReturnType<typeof createLogger>): Promise<void> {
  const { reviewStats, dueReviews } = await import('@/core/db/repo/library');
  const stats = await reviewStats();
  if (stats.todayDone >= stats.pending) return;
  const due = await dueReviews(localDayKey());
  if (due.length === 0) return;
  const settings = await loadSettings();
  if (settings.modules.d === false) return;
  await notifications.create(`hdu-assistant-review-${localDayKey()}`, {
    type: 'basic',
    title: '今日待复习',
    message: `有 ${due.length} 张复习卡片到期，点击扩展图标查看`,
    iconUrl: notificationIconUrl(),
    silent: true,
  });
  log.info(`复习提醒：${due.length} 张卡片到期`);
}

/** 周报（§7 C3）：周一首次打开时生成（本地） */
async function runWeeklyReport(log: ReturnType<typeof createLogger>): Promise<void> {
  const now = new Date();
  if (now.getDay() !== 1) return; // 仅周一
  const { kvGet, kvSet, KV_KEYS } = await import('@/core/db/repo/misc');
  const weekStart = localDayKey(startOfLocalWeek());
  const last = await kvGet<string>(KV_KEYS.lastReportAt);
  if (last === weekStart) return;

  const { buildReport } = await import('@/core/stats/aggregate');
  const { listWatchRecords } = await import('@/core/db/repo/stats');
  const { listCourses, listSessionsByCourse } = await import('@/core/db/repo/content');
  const settings = await loadSettings();
  const courses = await listCourses();
  const records = await listWatchRecords(localDayKey(startOfLocalWeek() - 24 * 3600 * 1000), localDayKey());
  const sessions: Awaited<ReturnType<typeof listSessionsByCourse>> = [];
  for (const course of courses) sessions.push(...(await listSessionsByCourse(course.teclId)));
  const report = buildReport({
    records,
    sessions,
    courses,
    windowDays: 7,
    weeklyTargetSec: Math.max(1, settings.weeklyGoalHours) * 3600,
    checkinMinSec: 600,
  });
  await kvSet(KV_KEYS.lastReportAt, weekStart);
  const hours = (report.weekSec / 3600).toFixed(1);
  await notifications.create(`hdu-assistant-weekly-${weekStart}`, {
    type: 'basic',
    title: '上周学习周报',
    message: `上周学习 ${hours} 小时，打卡 ${report.goal.hitDaysThisWeek} 天，连续 ${report.streakDays} 天`,
    iconUrl: notificationIconUrl(),
    silent: true,
  });
  log.info('周报已生成', { weekStart, weekSec: report.weekSec });
  // 让已打开的播放页/面板刷新（宽播到所有登记的播放页，不按 teclId 误投）
  await emitToAll({ name: 'SETTINGS_APPLIED', data: {} });
}
