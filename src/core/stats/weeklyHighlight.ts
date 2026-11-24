/**
 * 「本周亮点」标杆提示（第 250 轮巡检，激励域 / 榜样视角）。
 *
 * 与 aggregate.buildReport / period.buildPeriodReport 同层的纯函数：从本周数据
 * 派生一条最值得肯定的「本周亮点」文案（一条就够——总览首屏密度红线，第 244 轮
 * 审计后首屏只加一行）。**不含 Date.now() 副作用**：「今天 / 本周界」由调用方经
 * `now` 传入（必填；非有限值按契约违约抛错，与 period.periodBuckets 同约定）。
 *
 * 优先级（高 → 低，命中即返回，防多个亮点抢一行）：
 *  ① 周目标达成（weekSec ≥ weeklyTargetSec 且目标 > 0）→「本周学习 X.X 小时，达成周目标」
 *    （口径与总览「本周目标」mini 卡 / weeklyGoalStreak 同线：weeklyTargetSec 由调用方
 *    传 settings.weeklyGoalHours * 3600，weekSec 与 stats.period 周桶 internalSec 同为
 *    valid 流水合计——单元测试用 buildPeriodReport 周桶交叉验证同源）；
 *  ② 本周打卡 ≥ 5 天（validSec ≥ CHECKIN_MIN_SEC 的自然日数）→「本周打卡 N 天」；
 *  ③ 单日最高 →「单日峰值 X 分钟（周X）」（并列取更近今日的一日，信息更新鲜）；
 *  ④ 完成复习最多的一日（仅统计 updatedAt 落在本周内的 done 作业）→「本周周X完成复习
 *    N 项，是一周里最稠密的一天」（并列取更近今日；无 done / reviews 缺省 → 落空）；
 *  ⑤ 无亮点 → null（不渲染，总览保持安静——同黄金时段提示的防噪声约定）。
 *
 * 数据源（不新增 op）：days 用 stats.report 的日报窗口（OverviewView 经 BundleData
 * 已持有，函数内部自行按 startOfLocalWeek(now) 截取本周）；reviews 为 review.list
 * 的可选入参（全量作业含快照、总览挂载成本高 → UI 当前不传，纯函数支持待轻量
 * 数据源出现再接入，裁决记巡检日志第 250 轮）。
 *
 * 第 251 轮（激励域 / 回顾延续视角）参数化扩展：buildWeeklyHighlight 增加可选
 * windowStartTs / windowEndTs / currentWeek（缺省行为与第 250 轮完全一致），
 * 并新增 buildWeeklyHighlights——近 N 周逐周复用同一派生逻辑（单点实现不复制
 * 优先级），产出 Array<{weekLabel, text, kind}> 供「近 4 周」回看展开区。
 */

import { CHECKIN_MIN_SEC } from './aggregate';
import { clamp, localDayKey, shortDayLabel, startOfLocalWeek } from '../shared/utils';

/** 本周亮点档位（1..4 与文件头优先级编号对应） */
export type WeeklyHighlightTier = 1 | 2 | 3 | 4;

/** 亮点类别（第 251 轮多周回看导出：与档位一一对应，UI 徽标 / 测试断言用） */
export type WeeklyHighlightKind = 'goal' | 'checkin' | 'peak' | 'review';

export interface WeeklyHighlight {
  tier: WeeklyHighlightTier;
  /** 用户可见文案（一行，无句号结尾——提示行家族惯例） */
  text: string;
}

/** 日报行（stats.report.days 的子集口径；脏数据逐字段防御） */
export interface WeeklyHighlightDay {
  date?: unknown;
  validSec?: unknown;
}

/** 复习作业行（review.list 的子集口径；脏数据逐条跳过） */
export interface WeeklyHighlightReview {
  status?: unknown;
  updatedAt?: unknown;
}

export interface WeeklyHighlightInput {
  /** 本周站内有效学习秒数（stats.report.weekSec 或 stats.period 周桶 internalSec，同口径） */
  weekSec: unknown;
  /** 周目标秒数（settings.weeklyGoalHours * 3600；≤0 / 非有限视为未设目标，① 档跳过） */
  weeklyTargetSec: unknown;
  /** 日报窗口（可含本周外的日子，函数内部按周界截取） */
  days: WeeklyHighlightDay[];
  /** 复习作业（可选；缺省 / 非数组 → ④ 档落空） */
  reviews?: WeeklyHighlightReview[] | null;
  /** 「今天」毫秒时间戳（必填：纯函数约定，不内部取 Date.now()） */
  now: number;
  /** 周窗口起点（含，本地毫秒）；缺省 = startOfLocalWeek(now)——第 251 轮多周回看的参数化入口 */
  windowStartTs?: number;
  /** 周窗口终点（含）；缺省 = now */
  windowEndTs?: number;
  /** 文案的「本周」前缀；缺省 = true（缺省窗口即本周）。历史周传 false 去前缀 */
  currentWeek?: boolean;
}

function isFiniteNum(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 'YYYY-MM-DD' → 周几短标（周一..周日） */
function weekdayLabel(dayKey: string): string {
  const ts = dayKey.split('-').map(Number);
  const d = new Date(ts[0] ?? 1970, (ts[1] ?? 1) - 1, ts[2] ?? 1, 0, 0, 0, 0);
  if (Number.isNaN(d.getTime())) return '某日';
  return `周${'一二三四五六日'[((d.getDay() + 6) % 7)] ?? '某'}`;
}

/**
 * 派生单个周窗口的亮点（内部共享实现，第 251 轮参数化）：
 *  - windowStartTs / windowEndTs：周窗口边界（含），由调用方按「本周 / 历史周」给定；
 *  - scope：文案前缀（本周 '本周' / 历史周 ''——历史周不再自称「本周」）；
 *  - 行为与第 250 轮 buildWeeklyHighlight 语义逐条一致（含 weekSec 非有限 → 0、
 *    脏数据防御、并列取更近今日），仅窗口与前缀参数化。
 */
function deriveWeeklyHighlight(
  input: WeeklyHighlightInput,
  windowStartTs: number,
  windowEndTs: number,
  scope: string,
): { tier: WeeklyHighlightTier; kind: WeeklyHighlightKind; text: string } | null {
  const weekSec = isFiniteNum(input.weekSec) ? Math.max(0, input.weekSec) : 0;
  const targetSec = isFiniteNum(input.weeklyTargetSec) ? input.weeklyTargetSec : 0;

  // 周窗口日键（周一 .. 窗口终点）：days 与 reviews 都按这个窗口截取
  const startDayKey = localDayKey(windowStartTs);
  const endDayKey = localDayKey(windowEndTs);
  const days = Array.isArray(input.days) ? input.days : [];
  const weekDays: Array<{ date: string; validSec: number }> = [];
  for (const day of days) {
    if (!day || typeof day !== 'object') continue;
    if (typeof day.date !== 'string' || day.date.length === 0) continue;
    if (day.date < startDayKey || day.date > endDayKey) continue;
    const sec = isFiniteNum(day.validSec) ? Math.max(0, day.validSec) : 0;
    weekDays.push({ date: day.date, validSec: sec });
  }
  // 日键升序（脏乱序输入也能正确判「更近今日」），同日重复行去重取首条
  weekDays.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const deduped: Array<{ date: string; validSec: number }> = [];
  for (const day of weekDays) {
    const prev = deduped[deduped.length - 1];
    if (prev === undefined || prev.date !== day.date) deduped.push(day);
  }

  // ① 周目标达成（与总览「本周目标」mini 卡 / weeklyGoalStreak 同口径）
  if (targetSec > 0 && weekSec >= targetSec) {
    return { tier: 1, kind: 'goal', text: `${scope}学习 ${(weekSec / 3600).toFixed(1)} 小时，达成周目标` };
  }

  // ② 打卡天数（validSec ≥ CHECKIN_MIN_SEC，与打卡月历同判定线）
  const checkinDays = deduped.filter((day) => day.validSec >= CHECKIN_MIN_SEC).length;
  if (checkinDays >= 5) {
    return { tier: 2, kind: 'checkin', text: `${scope}打卡 ${checkinDays} 天` };
  }

  // ③ 单日峰值（0 秒不构成亮点；deduped 已按日升序，>= 使并列取更近今日的一日）
  let peak: { date: string; validSec: number } | null = null;
  for (const day of deduped) {
    if (day.validSec <= 0) continue;
    if (!peak || day.validSec >= peak.validSec) peak = day;
  }
  if (peak) {
    return { tier: 3, kind: 'peak', text: `单日峰值 ${Math.round(peak.validSec / 60)} 分钟（${weekdayLabel(peak.date)}）` };
  }

  // ④ 完成复习最多的一日（仅周窗口内的 done 作业按 updatedAt 归日；并列取更近今日）
  const reviews = Array.isArray(input.reviews) ? input.reviews : [];
  const doneByDay = new Map<string, number>();
  for (const job of reviews) {
    if (!job || typeof job !== 'object') continue;
    if (job.status !== 'done') continue;
    if (!isFiniteNum(job.updatedAt) || job.updatedAt < windowStartTs || job.updatedAt > windowEndTs) continue;
    const dayKey = localDayKey(job.updatedAt);
    doneByDay.set(dayKey, (doneByDay.get(dayKey) ?? 0) + 1);
  }
  let topDay: { date: string; done: number } | null = null;
  for (const [date, done] of doneByDay) {
    if (done <= 0) continue;
    const later = topDay !== null && done === topDay.done && date > topDay.date;
    if (!topDay || done > topDay.done || later) topDay = { date, done };
  }
  if (topDay) {
    return { tier: 4, kind: 'review', text: `${scope}${weekdayLabel(topDay.date)}完成复习 ${topDay.done} 项，是一周里最稠密的一天` };
  }

  // ⑤ 无亮点：null（不渲染）
  return null;
}

export function buildWeeklyHighlight(input: WeeklyHighlightInput): WeeklyHighlight | null {
  if (!isFiniteNum(input?.now)) throw new Error('buildWeeklyHighlight: now 必须是有限毫秒时间戳（由调用方注入）');
  const currentWeek = input.currentWeek !== false;
  const derived = deriveWeeklyHighlight(
    input,
    isFiniteNum(input.windowStartTs) ? (input.windowStartTs as number) : startOfLocalWeek(input.now),
    isFiniteNum(input.windowEndTs) ? (input.windowEndTs as number) : input.now,
    currentWeek ? '本周' : '',
  );
  return derived ? { tier: derived.tier, text: derived.text } : null;
}

// ───────────────────────── 近 4 周亮点回看（第 251 轮巡检，激励域 / 回顾延续视角） ─────────────────────────

/** 回看默认周数（含本周；UI「近 4 周」轻入口同值） */
export const WEEKLY_HIGHLIGHTS_DEFAULT_WEEKS = 4;
/** 回看周数上限（防脏入参拉爆渲染；超出按上限 clamp） */
export const WEEKLY_HIGHLIGHTS_MAX_WEEKS = 12;

/** 单周亮点条目（旧 → 新排序输出；无亮点周直接省略不占位） */
export interface WeeklyHighlightEntry {
  /** 周一起始日键 'YYYY-MM-DD'（与 stats.period 周桶 key 同口径） */
  weekStart: string;
  /** 周标签 'MM-DD–MM-DD'（与 PeriodBucket.label 同格式） */
  weekLabel: string;
  /** 0 = 本周，1 = 上周 …（旧 → 新排序中保留回看深度语义） */
  index: number;
  /** 是否当前周（UI「本周」徽标） */
  current: boolean;
  kind: WeeklyHighlightKind;
  text: string;
}

export interface WeeklyHighlightsInput {
  /** 日报窗口（stats.report.days，30 天窗口覆盖近 4 周全部周界） */
  days: WeeklyHighlightDay[];
  /** 周目标秒数（settings.weeklyGoalHours * 3600；≤0 / 非有限 → ① 档全部跳过） */
  weeklyTargetSec: unknown;
  /** 回看周数（含本周）；缺省 4，非法 / 超限 clamp 到 [1, 12] */
  weeks?: unknown;
  /** 复习作业（可选；缺省 → ④ 档落空，与单周口径一致） */
  reviews?: WeeklyHighlightReview[] | null;
  /** 「今天」毫秒时间戳（必填：纯函数约定，不内部取 Date.now()） */
  now: number;
}

/**
 * 近 N 周亮点回看（第 251 轮，激励域 / 回顾延续视角）：把 buildWeeklyHighlight 的
 * 五档派生逻辑按周窗口参数化复用（单点实现，不复制优先级），每周产出一条亮点
 * （kind 与档位一一映射），无亮点周省略（数组短于周数是正常形态，不占空位）。
 *
 * 数据源裁决（记巡检日志第 251 轮）：从 report.days 回放，不新增 stats.period 取数
 * ——report.days 为 30 天窗口（stats.report 默认 windowDays=30），近 4 周最远周界
 * 至多 27 天前（周一锚 − 6 − 21），窗口全覆盖；weeklyTargetSec 沿用 report.goal。
 * weeklyTargetSec（BundleData 已持有），零新增 op、零新增取数；历史周 weekSec 由
 * days 求和派生（与 report.weekSec 同为 valid 流水按日归集合计，单测与 buildReport
 * 交叉验证同源）。
 *
 * 输出旧 → 新（本周最后一条）；now 非有限按契约违约抛错（与单周函数同约定）。
 */
export function buildWeeklyHighlights(input: WeeklyHighlightsInput): WeeklyHighlightEntry[] {
  if (!isFiniteNum(input?.now)) throw new Error('buildWeeklyHighlights: now 必须是有限毫秒时间戳（由调用方注入）');
  const weeks = clamp(
    Math.round(isFiniteNum(input.weeks) ? (input.weeks as number) : WEEKLY_HIGHLIGHTS_DEFAULT_WEEKS),
    1,
    WEEKLY_HIGHLIGHTS_MAX_WEEKS,
  );
  const targetSec = input.weeklyTargetSec;
  const reviews = input.reviews;
  const thisWeekStart = startOfLocalWeek(input.now);
  const entries: WeeklyHighlightEntry[] = [];

  for (let i = weeks - 1; i >= 0; i -= 1) {
    const ws = new Date(thisWeekStart);
    ws.setDate(ws.getDate() - i * 7);
    const we = new Date(ws);
    we.setDate(we.getDate() + 6);
    we.setHours(23, 59, 59, 999);
    const windowStartTs = ws.getTime();
    const windowEndTs = i === 0 ? input.now : we.getTime();
    // 历史周 weekSec：周窗口内去重日报的 validSec 合计（与 report.weekSec 同口径，
    // 见文件头「数据源裁决」）；当前周同样从 days 派生（UI 单行入口另有 report.weekSec
    // 直传口径，两者单测锁定同源）
    const startDayKey = localDayKey(windowStartTs);
    const endDayKey = localDayKey(windowEndTs);
    const byDay = new Map<string, number>();
    for (const day of Array.isArray(input.days) ? input.days : []) {
      if (!day || typeof day !== 'object') continue;
      if (typeof day.date !== 'string' || day.date.length === 0) continue;
      if (day.date < startDayKey || day.date > endDayKey) continue;
      if (!byDay.has(day.date)) byDay.set(day.date, isFiniteNum(day.validSec) ? Math.max(0, day.validSec) : 0);
    }
    let weekSec = 0;
    for (const sec of byDay.values()) weekSec += sec;

    const derived = deriveWeeklyHighlight(
      { days: input.days, weeklyTargetSec: targetSec, reviews, weekSec, now: input.now },
      windowStartTs,
      windowEndTs,
      i === 0 ? '本周' : '',
    );
    if (!derived) continue;
    entries.push({
      weekStart: startDayKey,
      weekLabel: `${shortDayLabel(startDayKey)}–${shortDayLabel(localDayKey(we))}`,
      index: i,
      current: i === 0,
      kind: derived.kind,
      text: derived.text,
    });
  }
  return entries;
}
