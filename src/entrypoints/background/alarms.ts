/**
 * 定时任务（§7 C3 / D2，chrome.alarms 驱动）。
 *
 * 全部通知在本地生成，不发送远端（§1.3）。
 * 周期：每 12 小时执行一次日常维护（回收站到期清理、导出包清理、复习提醒、周报）；
 * 另有每日 20:00 的待办提醒（hdu-alarm-daily-todo，独立 alarm），以及
 * 每日待办提醒后 30 分钟的明日到期提醒（hdu-alarm-due-tomorrow，第 243 轮巡检，
 * 默认关，见 runDueTomorrowReminder）。
 */

import type { createLogger } from '@/core/shared/logger';
import { notifications, runtime, tabs } from '@/core/shared/runtime';
import { loadSettings } from '@/core/shared/settings';
import { localDayKey, startOfLocalWeek } from '@/core/shared/utils';
import { buildAchievementRecapLine, buildCoverageLine, buildDailyTodoNotification, buildDueTomorrowMessage, buildStaleTagLine, buildWeeklyRecapLine, buildWeeklyReportMessage, countTodayTodos, dailyTodoNotificationId, dueTomorrowNotificationId } from '@/core/plan/notify';
import { buildPeriodReport, weeklyGoalStreak } from '@/core/stats/period';
import { buildTimeOfDayDistribution, suggestGoldenSlot, TIME_OF_DAY_DEFAULT_DAYS, timeOfDayHourLabel } from '@/core/stats/timeOfDay';
import { CHECKIN_MIN_SEC } from '@/core/stats/aggregate';
import { countStaleTags, lastTagDoneAt, listStaleTags } from '@/core/shared/tagStats';
import { emitToAll } from './tabs';

export const ALARM_NAMES = {
  daily: 'hdu-assistant-daily',
  reviewCheck: 'hdu-assistant-review',
  dailyTodo: 'hdu-alarm-daily-todo',
  /** 明日到期提醒（第 243 轮巡检）：每日待办提醒之后 30 分钟 */
  dueTomorrow: 'hdu-alarm-due-tomorrow',
} as const;

/** 每日待办提醒的默认本地触发时刻（20:00；可在设置中调整，见 syncDailyTodoAlarm） */
const DAILY_TODO_HOUR = 20;

/** 明日到期提醒相对每日待办提醒的错开偏移（分钟）：30 分钟，避免两条通知同时弹出。
 *  实现为「基础触发时刻 + 30 分钟」而非 hour+0.5 传入 nextDailyTodoTriggerMs——后者
 *  对小时参数 Math.round 取整，20.5 会被收整为 21:00（第 243 轮实现勘误）。 */
const DUE_TOMORROW_OFFSET_MIN = 30;

/**
 * 下一个本地触发时刻的毫秒时间戳（当天已过该时刻则为明天）。
 * chrome.alarms.create 用 `when` 对准它并配 periodInMinutes 1440 实现每日提醒。
 * hour 缺省 20:00（兼容旧设置）；非法值回退默认。
 */
export function nextDailyTodoTriggerMs(now = Date.now(), hour: number = DAILY_TODO_HOUR): number {
  const h = Number.isFinite(hour) ? Math.min(23, Math.max(0, Math.round(hour))) : DAILY_TODO_HOUR;
  const d = new Date(now);
  d.setHours(h, 0, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/**
 * 按当前设置重建每日待办提醒 alarm（第 83 轮巡检：提醒时刻可配置）。
 * create 同名即替换，可在 SW 启动与设置变更时反复调用对账。
 */
export async function syncDailyTodoAlarm(): Promise<void> {
  const { alarms } = await import('@/core/shared/runtime');
  const settings = await loadSettings();
  const hour = settings.todo?.dailyNotifyHour;
  alarms.create(ALARM_NAMES.dailyTodo, {
    when: nextDailyTodoTriggerMs(Date.now(), typeof hour === 'number' ? hour : DAILY_TODO_HOUR),
    periodInMinutes: 24 * 60,
  });
}

/**
 * 明日到期提醒的下一个本地触发时刻：每日待办提醒时刻（默认 20:00，可配）+30 分钟。
 * 先取基础整点触发时刻再偏移，跨日边界（如待办 23:00）同样保持 30 分钟错开。
 */
export function nextDueTomorrowTriggerMs(now = Date.now(), baseHour: number = DAILY_TODO_HOUR): number {
  return nextDailyTodoTriggerMs(now, baseHour) + DUE_TOMORROW_OFFSET_MIN * 60 * 1000;
}

/**
 * 按当前设置重建「明日到期提醒」alarm（第 243 轮巡检）：触发时刻联动每日待办提醒
 * 偏移 30 分钟（待办 20:00 → 本提醒 20:30）；待办时刻可配时跟随其偏移。
 * create 同名即替换，可在 SW 启动与设置变更时反复调用对账。
 */
export async function syncDueTomorrowAlarm(): Promise<void> {
  const { alarms } = await import('@/core/shared/runtime');
  const settings = await loadSettings();
  const hour = settings.todo?.dailyNotifyHour;
  alarms.create(ALARM_NAMES.dueTomorrow, {
    when: nextDueTomorrowTriggerMs(Date.now(), typeof hour === 'number' ? hour : DAILY_TODO_HOUR),
    periodInMinutes: 24 * 60,
  });
}

export async function runScheduledTasks(name: string, log: ReturnType<typeof createLogger>): Promise<void> {
  if (name === ALARM_NAMES.dailyTodo) {
    await runDailyTodoReminder(log);
    return;
  }
  if (name === ALARM_NAMES.dueTomorrow) {
    await runDueTomorrowReminder(log);
    return;
  }
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

/**
 * 每日待办提醒（每天 20:00）：今日待办非空才发通知，点击打开学习看板。
 * 数据源在 SW 内直接调仓储层（不经 op RPC 自调用）；三类条目的映射与完看阈值
 * 口径全部复用 core/plan/today 的 buildTodayPlan（经 countTodayTodos），与
 * 学习中心「今日待办」看板保持同一份实现。
 * 上周回顾（todo.weeklyRecap，默认开）：末尾追加一句上周回顾（buildWeeklyRecapLine）；
 * 回顾数据任一环失败时降级为不含回顾句，提醒照发。
 */
async function runDailyTodoReminder(log: ReturnType<typeof createLogger>): Promise<void> {
  try {
    const settings = await loadSettings();
    // 开关默认开；设置入口 = options 页「学习 → 提醒」卡的 dailyNotify 开关（App.tsx LearningSection）
    if (settings.todo.dailyNotify === false) return;
    const [{ dueReviews, listFavorites, listReviewJobs }, { computeMissedItems }] = await Promise.all([
      import('@/core/db/repo/library'),
      import('@/core/db/repo/misc'),
    ]);
    const today = localDayKey();
    const [due, missed, videoFavorites, allFavorites, reviewJobs] = await Promise.all([
      dueReviews(today),
      computeMissedItems(),
      listFavorites({ type: 'video', limit: 500 }),
      listFavorites({ limit: 500 }),
      listReviewJobs(),
    ]);
    // 标签健康度（第 147 轮巡检；第 158 轮起点名最久未复习的标签；第 159 轮起窗口可配，默认 28 天）
    const staleTagList = listStaleTags(reviewJobs, allFavorites, Date.now(), settings.ui?.staleWindowDays ?? 28);
    const staleLastDone = lastTagDoneAt(reviewJobs, allFavorites);
    const counts = countTodayTodos({ dueReviews: due, missedSessions: missed, videoFavorites, doneKeys: [], today });
    // 上周回顾开关默认开（与 dailyNotify 同卡，options「提醒中包含上周回顾」）；失败降级不含回顾句
    let weeklyRecapLine: string | null = null;
    if (settings.todo.weeklyRecap !== false) {
      try {
        weeklyRecapLine = await buildLastWeekRecapLine();
      } catch (err) {
        log.warn('上周回顾生成失败，降级为不含回顾句', err);
      }
    }
    const notification = buildDailyTodoNotification(counts, {
      weeklyRecapLine,
      // 昨日新解锁成就（第 136 轮巡检；第 140 轮起含自定义徽章）
      achievementLine: buildAchievementRecapLine(settings.ui?.achievementUnlockedAt, Date.now(), settings.ui?.customAchievements),
      // 标签健康度（第 147 轮巡检；第 158 轮起点名最久标签；第 159 轮窗口可配；第 161 轮起受 notifyStaleTags 开关控制，默认开）
      staleTagLine:
        settings.todo?.notifyStaleTags !== false
          ? buildStaleTagLine(staleTagList, staleLastDone, settings.ui?.staleWindowDays ?? 28)
          : null,
      // 标签覆盖率提醒（第 152 轮巡检；第 153 轮起受 todo.notifyCoverage 开关控制，默认开）：
      // 设了目标且未达标时附一行提示
      coverageLine:
        settings.todo?.notifyCoverage !== false
          ? buildCoverageLine(
              Math.max(0, allFavorites.length - allFavorites.filter((fav) => !Array.isArray(fav?.tags) || fav.tags.length === 0).length),
              allFavorites.length,
              settings.ui?.tagCoverageGoal,
            )
          : null,
    });
    if (!notification) return;
    await notifications.create(dailyTodoNotificationId(today), {
      type: 'basic',
      title: notification.title,
      message: notification.message,
      iconUrl: notificationIconUrl(),
      silent: true,
    });
    log.info('每日待办提醒已发送', { message: notification.message });
  } catch (err) {
    log.warn('每日待办提醒失败', err);
  }
}

/**
 * 明日到期提醒（第 243 轮巡检，主动服务视角）：每天在每日待办提醒后 30 分钟检查
 * 「明日到期 pending 复习作业数」，非空且用户开启开关（todo.dueTomorrowNotify，
 * 默认关——主动提醒默认不打扰，用户显式开启才发）时发通知。
 * 数据源在 SW 内直接调仓储层（dueReviews，与 runDailyTodoReminder 同模式，不经 op
 * RPC 自调用）；课程名映射与 ReviewView / StatsView 同款（courId → subjName，
 * 经 listCourses + listSessionsByCourse），映射任一环失败降级为仅作业名，提醒照发。
 * 文案经 buildDueTomorrowMessage 纯函数拼装（单点收口，便于单测）。
 * 防重复：通知 id 按本地日键（dueTomorrowNotificationId），同一天重复触发覆盖同一条。
 */
async function runDueTomorrowReminder(log: ReturnType<typeof createLogger>): Promise<void> {
  try {
    const settings = await loadSettings();
    // 默认关（第 243 轮决策）：与 dailyNotify 默认开不同，本提醒是主动预判，
    // 默认不打扰，用户在设置页「提醒」卡显式开启后才发
    if (settings.todo?.dueTomorrowNotify !== true) return;
    const { dueReviews } = await import('@/core/db/repo/library');
    const { listCourses, listSessionsByCourse } = await import('@/core/db/repo/content');
    const tomorrow = localDayKey(Date.now() + 86_400_000);
    const jobs = await dueReviews(tomorrow);
    if (jobs.length === 0) return;
    // 课程名映射（courId → subjName；与 ReviewView 整页导出的映射同款）。
    // 失败降级：明细退化为仅作业名，不阻断提醒
    let courseNames: Record<number, string> = {};
    try {
      const courses = await listCourses();
      const map: Record<number, string> = {};
      for (const course of courses) {
        if (typeof course?.subjName !== 'string' || course.subjName.length === 0) continue;
        const sessions = await listSessionsByCourse(course.teclId);
        for (const session of sessions) {
          if (typeof session?.courId === 'number') map[session.courId] = course.subjName;
        }
      }
      courseNames = map;
    } catch (err) {
      log.warn('明日到期提醒课程名映射失败，降级为仅作业名', err);
    }
    const notification = buildDueTomorrowMessage(
      jobs.map((job) => ({
        title: job.favorite?.snapshot?.title,
        course: job.favorite?.courId != null ? courseNames[job.favorite.courId] : undefined,
      })),
    );
    if (!notification) return;
    await notifications.create(dueTomorrowNotificationId(tomorrow), {
      type: 'basic',
      title: notification.title,
      message: notification.message,
      iconUrl: notificationIconUrl(),
      silent: true,
    });
    log.info('明日到期提醒已发送', { tomorrow, count: jobs.length, message: notification.message });
  } catch (err) {
    // 失败不抛：通知失败不影响其他 alarms（与 runDailyTodoReminder 同约定）
    log.warn('明日到期提醒失败', err);
  }
}

/**
 * 上周回顾句（core/stats/period 周报口径）：直接调 buildPeriodReport 纯函数喂仓储数据
 * （与 ops.ts 的 buildPeriodOpReport 同一喂法；SW 内已有仓储访问能力，不经 op RPC 自调用）。
 * count=2 的周桶旧 → 新为 [上周, 本周]，取 buckets[0] = 上一个完整周（本地周一为界）；
 * 查询窗口 = 上周一 → 今天，窗口外数据由桶按日键归集天然过滤。
 */
async function buildLastWeekRecapLine(): Promise<string | null> {
  const now = Date.now();
  const [{ listWatchRecords }, { getExternalByDateRange }, { getWeeklyPlans }, { listFavorites }] = await Promise.all([
    import('@/core/db/repo/stats'),
    import('@/core/db/repo/external'),
    import('@/core/db/repo/weekly'),
    import('@/core/db/repo/library'),
  ]);
  const lastWeekStart = new Date(startOfLocalWeek(now));
  lastWeekStart.setDate(lastWeekStart.getDate() - 7);
  const [records, externalRecords, plans, favorites] = await Promise.all([
    listWatchRecords(localDayKey(lastWeekStart), localDayKey(now)),
    getExternalByDateRange(localDayKey(lastWeekStart), localDayKey(now)),
    getWeeklyPlans(),
    listFavorites({}),
  ]);
  const report = buildPeriodReport({ kind: 'week', count: 2, now, records, externalRecords, plans, favorites });
  const lastWeek = report.buckets[0];
  if (!lastWeek) return null;
  return buildWeeklyRecapLine({
    internalSec: lastWeek.internalSec,
    externalSec: lastWeek.externalSec,
    plan: lastWeek.plan ?? null,
  });
}

/**
 * 通知点击 → 打开学习看板（dashboard.html 非 web_accessible，经 SW 代开）。
 * 覆盖每日待办提醒与明日到期提醒（第 243 轮巡检，两类通知 id 前缀均指向看板）。
 * 由 background/index.ts 在 SW 启动时顶层调用一次（SW 内 listener 必须顶层注册）。
 */
export function registerDailyTodoNotificationClick(): void {
  notifications.onClicked((id) => {
    if (typeof id !== 'string') return;
    if (!id.startsWith(ALARM_NAMES.dailyTodo) && !id.startsWith(ALARM_NAMES.dueTomorrow)) return;
    void tabs.create(runtime.getURL('dashboard.html'));
  });
}

/**
 * 周报通知动态亮点（第 242 轮巡检，激励视角）：从既有纯函数取材，供
 * buildWeeklyReportMessage 拼装第二行。
 *  - 周目标达成态：stats.period 周桶（count = 6，覆盖近 6 周）喂
 *    weeklyGoalStreak（连续达成周数，含「本周未达成自动跳过」口径）；
 *    goalAchieved = 上一个完整周（倒数第二桶）internalSec ≥ 周目标；
 *    上周未达成且周目标已设时给本周进度百分比（进行时激励线）；
 *  - 黄金时段：近 30 天流水 → buildTimeOfDayDistribution → suggestGoldenSlot
 *    （内部自带 60 分钟总量 + 25% 占比双门槛，不达门槛返回 null 不提示）。
 * 任一环失败降级为空 extras（周报照发，主行不受影响）；goalSec ≤ 0（未设目标）
 * 不出周目标态亮点。
 */
async function buildWeeklyReportExtras(goalSec: number): Promise<{
  goalAchieved?: boolean;
  goalStreakWeeks?: number;
  weekGoalPct?: number;
  goldenSlot?: { label: string; hoursLabel: string } | null;
}> {
  const now = Date.now();
  const [{ listWatchRecords }, { getExternalByDateRange }, { getWeeklyPlans }, { listFavorites }] = await Promise.all([
    import('@/core/db/repo/stats'),
    import('@/core/db/repo/external'),
    import('@/core/db/repo/weekly'),
    import('@/core/db/repo/library'),
  ]);
  // 近 6 周（含本周）+ 近 30 天的并集窗口：一次取数同时喂周桶聚合与时段分布
  const windowStart = startOfLocalWeek(now) - 5 * 7 * 24 * 3600 * 1000;
  const goldenStart = now - (TIME_OF_DAY_DEFAULT_DAYS - 1) * 24 * 3600 * 1000;
  const fromKey = localDayKey(Math.min(windowStart, goldenStart));
  const [records, externalRecords, plans, favorites] = await Promise.all([
    listWatchRecords(fromKey, localDayKey(now)),
    getExternalByDateRange(fromKey, localDayKey(now)),
    getWeeklyPlans(),
    listFavorites({}),
  ]);
  // 周目标达成态（goalSec ≤ 0 = 未设目标，跳过）
  let goalAchieved: boolean | undefined;
  let goalStreakWeeks: number | undefined;
  let weekGoalPct: number | undefined;
  if (Number.isFinite(goalSec) && goalSec > 0) {
    try {
      const report = buildPeriodReport({ kind: 'week', count: 6, now, records, externalRecords, plans, favorites });
      const lastWeek = report.buckets[report.buckets.length - 2];
      const thisWeek = report.buckets[report.buckets.length - 1];
      goalAchieved = !!lastWeek && lastWeek.internalSec >= goalSec;
      goalStreakWeeks = weeklyGoalStreak(report.buckets, goalSec);
      if (!goalAchieved && thisWeek && thisWeek.internalSec > 0) {
        const pct = Math.min(99, Math.max(0, Math.round((thisWeek.internalSec / goalSec) * 100)));
        if (pct >= 1) weekGoalPct = pct;
      }
    } catch {
      /* 周桶聚合失败：周目标态亮点降级省略 */
    }
  }
  // 黄金时段（双门槛在 suggestGoldenSlot 内部；失败/未达门槛降级为 null 不提示）
  let goldenSlot: { label: string; hoursLabel: string } | null = null;
  try {
    const dist = buildTimeOfDayDistribution(records, now, TIME_OF_DAY_DEFAULT_DAYS);
    const golden = suggestGoldenSlot(dist);
    if (golden) goldenSlot = { label: golden.label, hoursLabel: timeOfDayHourLabel(golden.key) };
  } catch {
    /* 时段分布失败：黄金时段亮点降级省略 */
  }
  return { goalAchieved, goalStreakWeeks, weekGoalPct, goldenSlot };
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
  const { listFavorites, listReviewJobs } = await import('@/core/db/repo/library');
  const settings = await loadSettings();
  const courses = await listCourses();
  const records = await listWatchRecords(localDayKey(startOfLocalWeek() - 24 * 3600 * 1000), localDayKey());
  const sessions: Awaited<ReturnType<typeof listSessionsByCourse>> = [];
  for (const course of courses) sessions.push(...(await listSessionsByCourse(course.teclId)));
  // 标签健康度（第 141 轮巡检）：近 N 周零完成的标签数（有完成记录但窗口内零完成；第 159 轮起窗口可配）
  const [favorites, reviewJobs] = await Promise.all([listFavorites({ limit: 500 }), listReviewJobs()]);
  const staleTagCount = countStaleTags(reviewJobs, favorites, Date.now(), settings.ui?.staleWindowDays ?? 28);
  const report = buildReport({
    records,
    sessions,
    courses,
    windowDays: 7,
    weeklyTargetSec: Math.max(1, settings.weeklyGoalHours) * 3600,
    checkinMinSec: CHECKIN_MIN_SEC,
  });
  await kvSet(KV_KEYS.lastReportAt, weekStart);
  // 动态亮点（第 242 轮巡检）：周目标达成态 / 黄金时段（buildWeeklyReportExtras，
  // 失败降级为空）；标签健康沿用既有 staleTagCount，全部经 buildWeeklyReportMessage
  // 纯函数拼装（文案与截断策略单点收口，便于单测）
  const extras = await buildWeeklyReportExtras(Math.max(1, settings.weeklyGoalHours) * 3600).catch(() => ({}));
  const notification = buildWeeklyReportMessage(report.weekSec, report.goal.hitDaysThisWeek, report.streakDays, {
    ...extras,
    staleTagCount,
  });
  await notifications.create(`hdu-assistant-weekly-${weekStart}`, {
    type: 'basic',
    title: notification.title,
    message: notification.message,
    iconUrl: notificationIconUrl(),
    silent: true,
  });
  log.info('周报已生成', { weekStart, weekSec: report.weekSec, message: notification.message });
  // 让已打开的播放页/面板刷新（宽播到所有登记的播放页，不按 teclId 误投）
  await emitToAll({ name: 'SETTINGS_APPLIED', data: {} });
}
