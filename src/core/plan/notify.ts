/**
 * 每日待办提醒（纯函数，无 IO / 无 chrome API）。
 *
 * 计数口径完全复用 core/plan/today 的 buildTodayPlan（单一实现，避免第二份口径）：
 *  - countTodayTodos：把今日待办输入折算为三分区条目数（与学习中心看板一致）；
 *  - buildDailyTodoNotification：三计数 → 通知标题/消息，0 项返回 null（不发）。
 * 通知文案的分区短标签（复习 / 补看 / 待学视频）为通知场景的约定写法，
 * 与看板分区标题（TODO_SECTION_LABELS）一一对应但更短。
 *
 * 上周回顾（第 13 轮任务 B）：buildWeeklyRecapLine 把 core/stats/period 的上周
 * 周桶折算为一句回顾文案，由 buildDailyTodoNotification 追加到提醒末尾；
 * 数据获取（buildPeriodReport 喂仓储数据）在 background/alarms.ts，本文件保持纯函数。
 */

import { buildTodayPlan, type TodayPlanInput } from './today';
import { buildAchievements } from './achievements';
import { formatMonthDay, localDayKey } from '../shared/utils';

export interface DailyTodoCounts {
  /** 到期复习条数 */
  review: number;
  /** 待补看课次条数 */
  missed: number;
  /** 待学视频条数 */
  video: number;
}

export interface DailyTodoNotification {
  title: string;
  message: string;
}

/** 上周回顾输入：core/stats/period 周桶（PeriodBucket）的相关字段子集 */
export interface WeeklyRecapData {
  /** 上周站内有效学习秒数 */
  internalSec: number;
  /** 上周站外学习秒数 */
  externalSec: number;
  /** 上周计划完成度（PeriodPlanProgress 子集）；该周无计划排期时为 null（不显示计划项） */
  plan: { ratio: number } | null;
}

/** 防御式计数：非有限负数等脏输入按 0 处理 */
function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * 从今日待办输入提取三分区计数。
 * 直接走 buildTodayPlan 的条目映射（excluded 课次、已看完视频、已删收藏等过滤规则
 * 全部沿用其实现），输出与看板各分区的条目数完全一致。
 */
export function countTodayTodos(input: TodayPlanInput): DailyTodoCounts {
  const plan = buildTodayPlan(input);
  const byKind = new Map(plan.sections.map((section) => [section.kind, section.items.length] as const));
  return {
    review: byKind.get('review') ?? 0,
    missed: byKind.get('missed') ?? 0,
    video: byKind.get('video') ?? 0,
  };
}

/**
 * 上周回顾句：站内外周秒数 + 计划完成度 → 一行文案。
 *  - 输入缺失 / 全脏数据 → null（调用方降级为不含回顾句，提醒照发）；
 *  - plan 为 null（该周无计划排期）或 ratio 脏 → 不显示计划项；
 *  - 文案：「上周：站内 X.X 小时 + 站外 X.X 小时，计划完成 Y%」。
 */
export function buildWeeklyRecapLine(data: WeeklyRecapData | null | undefined): string | null {
  if (!data || typeof data !== 'object') return null;
  const internalHours = (asCount(data.internalSec) / 3600).toFixed(1);
  const externalHours = (asCount(data.externalSec) / 3600).toFixed(1);
  let line = `上周：站内 ${internalHours} 小时 + 站外 ${externalHours} 小时`;
  const ratio = data.plan?.ratio;
  if (data.plan && typeof ratio === 'number' && Number.isFinite(ratio)) {
    const percent = Math.min(100, Math.max(0, Math.round(ratio * 100)));
    line += `，计划完成 ${percent}%`;
  }
  return line;
}

/**
 * 昨日新解锁成就句（第 136 轮巡检；第 140 轮起含自定义徽章）：
 * achievementUnlockedAt（徽章 id → 首次解锁时间戳）中「昨天（本地日）」解锁的徽章
 * → 「昨日新解锁成就：X、Y」；无则 null（不追加）。
 * 徽章名录复用 buildAchievements（零计数即可得 id → name；自定义徽章经 customBadges 传入）。
 */
export function buildAchievementRecapLine(
  unlockedAt: Record<string, number> | null | undefined,
  now: number,
  customBadges?: Array<{ id: string; name: string; metric: string; threshold: number }> | null,
): string | null {
  if (!unlockedAt || typeof unlockedAt !== 'object') return null;
  const yesterday = localDayKey(new Date(now - 86_400_000));
  const nameById = new Map(buildAchievements({ customBadges }).map((row) => [row.id, row.name] as const));
  const names = Object.entries(unlockedAt)
    .filter(([, ts]) => typeof ts === 'number' && Number.isFinite(ts) && localDayKey(new Date(ts)) === yesterday)
    .map(([id]) => nameById.get(id) ?? '')
    .filter((name) => name.length > 0);
  if (names.length === 0) return null;
  return `昨日新解锁成就：${names.join('、')}`;
}

/**
 * 标签健康度提醒句（第 147 轮巡检引入计数文案；第 158 轮起点名最久标签）：
 * staleTags 非空时返回一行提醒；≤2 个直接点名，>2 个按最近完成时间最早（最久未复习）点名前 2 个。
 * lastDone 提供各标签最近完成时间（无记录视为最久）；脏输入（非字符串标签）跳过，全脏 → null。
 */
export function buildStaleTagLine(
  staleTags: string[] | null | undefined,
  lastDone?: Map<string, number> | null,
  windowDays: number = 28,
): string | null {
  const list = Array.isArray(staleTags) ? staleTags.filter((t) => typeof t === 'string' && t.trim().length > 0) : [];
  if (list.length === 0) return null;
  const sorted = [...list].sort((a, b) => (lastDone?.get(a) ?? 0) - (lastDone?.get(b) ?? 0) || (a < b ? -1 : 1));
  // 点名个数自适应（第 160 轮巡检）：零完成标签 ≥10 个时点名 3 个，否则 2 个；
  // 第 178 轮起窗口天数随设置（与统计口径一致），文案「近 N 天」；
  // 第 179 轮起点名附最近完成日期（MM/DD）/「从未完成」，提醒更可执行
  const nameCount = list.length >= 10 ? 3 : 2;
  const worst = sorted
    .slice(0, nameCount)
    .map((tag) => {
      const ts = lastDone?.get(tag);
      // 第 180 轮起日期格式化统一走 utils.formatMonthDay
      return ts && ts > 0 ? `${tag}（上次完成 ${formatMonthDay(ts)}）` : `${tag}（从未完成）`;
    })
    .join('、');
  const windowLabel = `近 ${Math.max(1, Math.floor(windowDays))} 天`;
  return list.length <= nameCount
    ? `有 ${list.length} 个标签${windowLabel}零完成：${worst}`
    : `有 ${list.length} 个标签${windowLabel}零完成（最久：${worst}）`;
}

/**
 * 标签覆盖率提示句（第 152 轮巡检）：设了覆盖率目标（goal > 0）且当前覆盖率低于目标时，
 * 返回一行提醒文案；未设目标 / 已达标 / 输入脏 → null（不追加）。
 * 文案：「标签覆盖率 X%（Y/Z），低于目标 G%——去知识库给收藏补打标签」。
 */
export function buildCoverageLine(
  tagged: unknown,
  total: unknown,
  goal: unknown,
): string | null {
  const goalPct = asCount(goal);
  const totalNum = asCount(total);
  if (goalPct <= 0 || goalPct > 100 || totalNum <= 0) return null;
  // tagged 脏（非有限负数）宁可不提醒也不误报「0% 未达标」；0 为合法值（全未打标）
  if (typeof tagged !== 'number' || !Number.isFinite(tagged) || tagged < 0) return null;
  const taggedNum = Math.floor(tagged);
  const pct = Math.round((taggedNum / totalNum) * 100);
  if (pct >= goalPct) return null;
  return `标签覆盖率 ${pct}%（${taggedNum}/${totalNum}），低于目标 ${goalPct}%——去知识库给收藏补打标签`;
}

/**
 * 通知内容：输入三计数 → 标题/消息字符串。
 *  - 总项数 0 → null（不发通知）；
 *  - 空分区不输出（如只有复习时为「复习 x，共 x 项」）；
 *  - 全分区：「复习 x · 补看 y · 待学视频 z，共 N 项」；
 *  - options.weeklyRecapLine 非空时在消息末尾追加一行上周回顾
 *    （回顾句缺失 / 开关关闭时调用方不传或传 null，主文案不变）；
 *  - options.achievementLine 非空时再追加一行昨日新解锁成就（第 136 轮巡检）。
 *  - options.coverageLine 非空时再追加一行标签覆盖率提醒（第 152 轮巡检）。
 */
export function buildDailyTodoNotification(
  counts: DailyTodoCounts | null | undefined,
  options?: { weeklyRecapLine?: string | null; achievementLine?: string | null; staleTagLine?: string | null; coverageLine?: string | null },
): DailyTodoNotification | null {
  const review = asCount(counts?.review);
  const missed = asCount(counts?.missed);
  const video = asCount(counts?.video);
  const total = review + missed + video;
  if (total <= 0) return null;
  const parts: string[] = [];
  if (review > 0) parts.push(`复习 ${review}`);
  if (missed > 0) parts.push(`补看 ${missed}`);
  if (video > 0) parts.push(`待学视频 ${video}`);
  const base = `${parts.join(' · ')}，共 ${total} 项`;
  const extras: string[] = [];
  const recap = typeof options?.weeklyRecapLine === 'string' && options.weeklyRecapLine.length > 0
    ? options.weeklyRecapLine
    : null;
  if (recap) extras.push(recap);
  const achievementLine = typeof options?.achievementLine === 'string' && options.achievementLine.length > 0
    ? options.achievementLine
    : null;
  if (achievementLine) extras.push(achievementLine);
  const staleTagLine = typeof options?.staleTagLine === 'string' && options.staleTagLine.length > 0
    ? options.staleTagLine
    : null;
  if (staleTagLine) extras.push(staleTagLine);
  const coverageLine = typeof options?.coverageLine === 'string' && options.coverageLine.length > 0
    ? options.coverageLine
    : null;
  if (coverageLine) extras.push(coverageLine);
  // 附加行数上限保护（第 162 轮巡检）：超过 3 行时保留前 2 行，其余折叠为一行汇总，
  // 避免系统通知正文过长被截断；第 163 轮起汇总行点明点击通知可直达学习看板
  const MAX_EXTRAS = 3;
  const shownExtras = extras.length > MAX_EXTRAS
    ? [...extras.slice(0, MAX_EXTRAS - 1), `另有 ${extras.length - (MAX_EXTRAS - 1)} 项提醒，点击通知直达学习看板`]
    : extras;
  return { title: '今日待办', message: shownExtras.length > 0 ? `${base}\n${shownExtras.join('\n')}` : base };
}

/** 通知 id：按本地日去重（同一天重复触发覆盖同一条，不叠加） */
export function dailyTodoNotificationId(date: string): string {
  return `hdu-alarm-daily-todo-${date}`;
}

// ───────────────────────── 明日到期提醒（第 243 轮巡检，主动服务视角） ─────────────────────────

/** 明日到期明细条目：收藏标题（作业名）+ 课程名（courId → subjName 映射，可选） */
export interface DueTomorrowJobInput {
  /** 收藏标题；缺失/脏回退「未命名收藏」 */
  title?: unknown;
  /** 课程名（与 ReviewView / StatsView 的 courId → subjName 同款映射）；缺失省略课程段 */
  course?: unknown;
}

/** 明日到期明细条目截断上限（字符，含省略号）：「课程 · 作业名」整体计长，
 *  18 字符兼顾通知正文紧凑与常见「课程名 + 讲次标题」完整展示 */
export const DUE_TOMORROW_LABEL_MAX = 18;

/** 单条明细的展示名：课程名在前（「课程 · 作业名」），无课程时仅作业名；超长截断加省略号 */
function dueTomorrowItemLabel(job: DueTomorrowJobInput): string {
  const title = typeof job?.title === 'string' && job.title.trim().length > 0 ? job.title.trim() : '未命名收藏';
  const course = typeof job?.course === 'string' && job.course.trim().length > 0 ? job.course.trim() : '';
  const full = course ? `${course} · ${title}` : title;
  return full.length > DUE_TOMORROW_LABEL_MAX ? `${full.slice(0, DUE_TOMORROW_LABEL_MAX - 1)}…` : full;
}

/** 明日到期通知 id：按本地日去重（同一天重复触发覆盖同一条，不叠加） */
export function dueTomorrowNotificationId(date: string): string {
  return `hdu-alarm-due-tomorrow-${date}`;
}

/**
 * 明日到期提醒文案（纯函数，第 243 轮巡检）：「明日到期 pending 复习作业」列表 → 标题/消息。
 *  - 0 项 → null（不发通知）；
 *  - 消息两行：主行「明日有 N 项复习到期」+ 明细行（前 2 个「课程 · 作业名」，
 *    超过 2 项以「等 N 项」收尾，与 buildStaleTagLine 的点名截断风格一致）；
 *  - 防御式：jobs 非数组 / 字段脏一律回退兜底文案，不抛错（与 buildDailyTodoNotification 同约定）。
 */
export function buildDueTomorrowMessage(jobs: DueTomorrowJobInput[] | null | undefined): DailyTodoNotification | null {
  const list = Array.isArray(jobs) ? jobs.filter((job) => job && typeof job === 'object') : [];
  if (list.length === 0) return null;
  const total = list.length;
  const shown = list.slice(0, 2).map(dueTomorrowItemLabel);
  const detail = shown.join('、') + (total > 2 ? ` 等 ${total} 项` : '');
  return { title: '明日复习到期', message: `明日有 ${total} 项复习到期\n${detail}` };
}

// ───────────────────────── 周报通知文案（第 242 轮巡检，激励视角） ─────────────────────────

/** 周报消息总长上限：chrome 通知 message 上限约 300 字，稳妥 200 内（超出丢亮点不丢主线） */
export const WEEKLY_REPORT_MESSAGE_MAX_LEN = 200;

/** 周报动态亮点输入（全部可选，缺 / 脏数据 → 该亮点省略）：数据获取在 background/alarms.ts */
export interface WeeklyReportExtras {
  /** 上周是否达成周目标（上周 internalSec ≥ 周目标秒数，period 周桶口径） */
  goalAchieved?: boolean;
  /** 连续达成周目标的周数（weeklyGoalStreak 口径：本周未达成自动跳过从上周起算） */
  goalStreakWeeks?: number;
  /** 本周目标进度百分比（1–99 整数；上周未达成时的进行时激励线） */
  weekGoalPct?: number;
  /** 黄金时段建议（suggestGoldenSlot 达门槛才传）：label=桶名、hoursLabel=时刻范围标注 */
  goldenSlot?: { label: string; hoursLabel: string } | null;
  /** 近 4 周零完成标签数（沿用既有周报尾巴口径，> 0 才出现） */
  staleTagCount?: number;
}

/**
 * 周报通知文案（纯函数，第 242 轮巡检）：两行结构，主行 + 动态亮点行。
 *  - 主行：「上周学习 X 小时 · 打卡 Y 天 · 连续 Z 天」（既有三指标，分隔符从逗号
 *    换成间隔点与看板 Chip 句式统一）；
 *  - 亮点行（择优 ≤1 条周目标态 + 黄金时段 + 标签健康，最多 3 段以「，」相连）：
 *    ① 周目标达成态三选一——连续达成 ≥2 周 →「✅ 连续达成 N 周目标」（连续感）；
 *      上周达成但连续 <2 →「🎯 上周达成周目标」（新达成）；
 *      上周未达成且本周进度 1–99% →「本周目标已过 X%」（进行时激励）；
 *    ② 黄金时段（suggestGoldenSlot 达门槛）→「黄金时段：晚间（18–23 点）」
 *      （label/hoursLabel 来自时段桶定义，与统计卡 tooltip 同源）；
 *    ③ 标签健康（沿用既有尾巴）→「N 个标签近 4 周零完成」；
 *  - 无任何亮点 → 单行主文案；总长超 WEEKLY_REPORT_MESSAGE_MAX_LEN 时从行尾
 *    逐段丢弃亮点（超长段整体丢弃不截半句），最终兜底再整体收敛到上限加省略号
 *    （主行优先保完整）。
 * 防御式：各数值脏输入按 0 处理（与 buildDailyTodoNotification 同风格）。
 */
export function buildWeeklyReportMessage(
  weekSec: unknown,
  checkinDays: unknown,
  streakDays: unknown,
  extras?: WeeklyReportExtras | null,
): DailyTodoNotification {
  const hours = (asCount(weekSec) / 3600).toFixed(1);
  const line1 = `上周学习 ${hours} 小时 · 打卡 ${asCount(checkinDays)} 天 · 连续 ${asCount(streakDays)} 天`;
  const highlights: string[] = [];
  const goalStreak = asCount(extras?.goalStreakWeeks);
  if (goalStreak >= 2) {
    highlights.push(`✅ 连续达成 ${goalStreak} 周目标`);
  } else if (extras?.goalAchieved === true) {
    highlights.push('🎯 上周达成周目标');
  } else {
    const pct = asCount(extras?.weekGoalPct);
    if (pct >= 1 && pct <= 99) highlights.push(`本周目标已过 ${pct}%`);
  }
  const golden = extras?.goldenSlot;
  if (golden && typeof golden.label === 'string' && golden.label.trim() && typeof golden.hoursLabel === 'string' && golden.hoursLabel.trim()) {
    highlights.push(`黄金时段：${golden.label}（${golden.hoursLabel}）`);
  }
  const staleTagCount = asCount(extras?.staleTagCount);
  if (staleTagCount > 0) highlights.push(`${staleTagCount} 个标签近 4 周零完成`);

  let line2 = highlights.join('，');
  // 超长保护：从行尾逐段丢弃亮点（超长段整体丢弃，主行不动）
  while (line2 && line1.length + 1 + line2.length > WEEKLY_REPORT_MESSAGE_MAX_LEN && highlights.length > 0) {
    highlights.pop();
    line2 = highlights.join('，');
  }
  let message = line2 ? `${line1}\n${line2}` : line1;
  // 最终兜底（防御性：主行自身超长的极端脏输入）：整体收敛到上限加省略号
  if (message.length > WEEKLY_REPORT_MESSAGE_MAX_LEN) {
    message = `${message.slice(0, WEEKLY_REPORT_MESSAGE_MAX_LEN - 1)}…`;
  }
  return { title: '上周学习周报', message };
}
