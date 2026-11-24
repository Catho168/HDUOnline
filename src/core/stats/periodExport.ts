/**
 * 周报 / 月报导出（第 80 轮巡检）：把 stats.period 的聚合结果序列化为 Markdown。
 * 纯函数、无副作用（下载由 UI 层经 reviewCards.downloadTextFile 完成）；
 * 口径行随文附注，与卡片内展示同源（buildPeriodReport 的 PeriodReport 直出）。
 */

import type { PeriodReport } from './period';
import { formatDuration } from '../shared/utils';

// ───────────────────────── 导出文件名（第 239 轮巡检，分享视角） ─────────────────────────

/** 周报 / 月报导出文件名里的周期档位标签（与 PeriodReport.kind 同域） */
export type PeriodFileKind = 'week' | 'month';

/** 文件名非法字符（Windows 保留字符 + 控制符）→ 安全替换为 '-'；首尾空白去除 */
function sanitizeFilenamePart(value: string): string {
  return value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim();
}

/** 'YYYY-MM-DD' 日键匹配（取数失败 / 非法格式降级为原串，不猜日期） */
const FILENAME_DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * 周报 / 月报 .md 导出文件名（纯函数，第 239 轮巡检）：替换第 80 轮的
 * 「智慧课堂-学习周报-<今天日键>.md」——文件名里带**数据窗口**（报告首桶开始日 →
 * 末桶结束日）而非生成日，下载多个周期的报告时按窗口可区分、按名可排序：
 *  - 周报：`HDUOnline周报_2026-11-16_11-22.md`（开始日全键 _ 结束日月日）；
 *  - 月报：`HDUOnline月报_2026-11_11-30.md`（开始月 YYYY-MM _ 结束日月日）；
 *  - 近 8 周 / 近 6 月多桶报告自然适用（首桶 → 末桶跨窗）。
 *
 * 防御：kind 非 'month' 一律按周报；日期非 'YYYY-MM-DD' 键形（或被脏数据污染）
 * 时不猜日期——原串经文件名安全化后直出（非法字符替换为 '-'），保证函数对任意
 * 输入返回合法文件名而不抛错；startPart/endPart 各自安全化后拼装再整体安全化一遍。
 */
export function buildPeriodReportFilename(kind: PeriodFileKind, startDate: string, endDate: string): string {
  const label = kind === 'month' ? '月报' : '周报';
  const startRaw = sanitizeFilenamePart(String(startDate ?? ''));
  const endRaw = sanitizeFilenamePart(String(endDate ?? ''));
  const startPart = kind === 'month' && FILENAME_DAY_KEY_RE.test(startRaw) ? startRaw.slice(0, 7) : startRaw;
  const endPart = FILENAME_DAY_KEY_RE.test(endRaw) ? endRaw.slice(5, 10) : endRaw;
  return sanitizeFilenamePart(`HDUOnline${label}_${startPart}_${endPart}.md`);
}

/** 附加指标列：周报=计划完成度，月报=复习保持率；无则「—」 */
function extraMetric(report: PeriodReport, index: number): string {
  const bucket = report.buckets[index];
  if (!bucket) return '—';
  if (report.kind === 'week') {
    const plan = bucket.plan;
    return plan ? `完看 ${plan.finished}/${plan.total}（${Math.round(plan.ratio * 100)}%）` : '—';
  }
  const review = bucket.review;
  return review ? `保持率 ${Math.round(review.ratio * 100)}%（${review.retained}/${review.reviewed}）` : '—';
}

/** 周期行：| 周期 | 站内 | 站外 | 活跃天数 | 流水次数 | 附加指标 | */
function bucketRow(report: PeriodReport, index: number): string {
  const bucket = report.buckets[index];
  if (!bucket) return '';
  return [
    bucket.label,
    formatDuration(bucket.internalSec),
    formatDuration(bucket.externalSec),
    `${bucket.activeDays} 天`,
    `${bucket.flowCount} 次`,
    extraMetric(report, index),
  ]
    .map((cell) => cell.replace(/\|/g, '\\|'))
    .join(' | ')
    .replace(/^/, '| ')
    .replace(/$/, ' |');
}

/**
 * 周报 / 月报 → Markdown（表格 + 口径附注；空报告输出标题与口径，不抛错）。
 *
 * 头部可追溯注释行（第 248 轮巡检，统计域收官）：标题之下补一行 HTML comment
 * `<!-- HDUOnline 生成于 <生成时间> · 数据窗口 <首桶开始日> ~ <末桶结束日>（<spanLabel>） -->`——
 * Markdown 惯例的注释写法（HTML comment 在渲染器中不显示为正文，粘贴进支持 HTML 的
 * 渲染环境也不可见，但源文件中恒可读），与既有正文「- 生成时间：」bullet 并存：
 * comment 行面向机器/存档追溯（含数据窗口起止日键，正文 bullet 只有人读时间）。
 * 防御：桶列表为空（理论不可达，report 恒有桶）时数据窗口段整体省略，不抛错。
 */
export function buildPeriodReportMarkdown(
  report: PeriodReport,
  achievements?: Array<{ name: unknown; desc?: unknown; unlocked?: unknown; value?: unknown; threshold?: unknown; unit?: unknown }> | null,
): string {
  const kindLabel = report.kind === 'month' ? '月报' : '周报';
  const spanLabel = report.kind === 'month' ? `近 ${report.count} 个月` : `近 ${report.count} 周`;
  const generated = new Date(report.generatedAt);
  const generatedLabel = Number.isFinite(generated.getTime()) ? generated.toLocaleString() : String(report.generatedAt);
  const firstBucket = report.buckets[0];
  const lastBucket = report.buckets[report.buckets.length - 1];
  const windowLabel =
    firstBucket && lastBucket ? `数据窗口 ${firstBucket.startDay} ~ ${lastBucket.endDay}（${spanLabel}）` : '';

  const lines: string[] = [];
  lines.push(`# 学习${kindLabel}（${spanLabel}）`);
  lines.push('');
  lines.push(`<!-- HDUOnline 生成于 ${generatedLabel}${windowLabel ? ` · ${windowLabel}` : ''} -->`);
  lines.push('');
  lines.push(`- 生成时间：${generatedLabel}`);
  lines.push(`- 窗口内站内有效学习：${formatDuration(report.totalInternalSec)}`);
  lines.push(`- 窗口内站外视频学习：${formatDuration(report.totalExternalSec)}`);
  lines.push('');
  lines.push('| 周期 | 站内 | 站外 | 活跃天数 | 流水次数 | 附加指标 |');
  lines.push('|---|---|---|---|---|---|');
  for (let i = 0; i < report.buckets.length; i += 1) {
    lines.push(bucketRow(report, i));
  }
  lines.push('');
  // 成就附录（第 128 轮巡检）：学习成就徽章随周报/月报带走（防御式：脏行跳过）
  const badges = (Array.isArray(achievements) ? achievements : []).filter(
    (badge) => badge && typeof badge.name === 'string' && badge.name.trim().length > 0,
  );
  if (badges.length > 0) {
    const unlockedCount = badges.filter((badge) => badge.unlocked === true).length;
    lines.push('', `## 成就附录（${unlockedCount}/${badges.length} 已解锁）`, '');
    for (const badge of badges) {
      const desc = typeof badge.desc === 'string' && badge.desc ? `：${badge.desc}` : '';
      const value = typeof badge.value === 'number' && Number.isFinite(badge.value) ? badge.value : 0;
      const threshold = typeof badge.threshold === 'number' && Number.isFinite(badge.threshold) ? badge.threshold : 0;
      const unit = typeof badge.unit === 'string' && badge.unit ? badge.unit : '';
      lines.push(`- ${badge.unlocked === true ? '🏅' : '🔒'} ${badge.name}${desc}（${value}/${threshold} ${unit}）`);
    }
    lines.push('');
  }
  lines.push('> 口径：站内为「播放中 + 页面前台可见 + 非挂机」的墙钟时间（单日封顶 16 小时）；');
  lines.push('> 站外视频（B 站等）为独立通道，不并入站内；周界=本地周一，月界=自然月。');
  lines.push('> 数据全部来自本机流水，不上报站点。');
  return lines.join('\n');
}

// ───────────────────────── 分享摘要（第 235 轮巡检；第 237 轮加精简 / 完整档） ─────────────────────────

/** buildPeriodShareText 的可选补充数据（缺项对应行自动省略） */
export interface PeriodShareExtras {
  /** 每周目标秒数（settings.weeklyGoalHours * 3600；仅周报输出目标行，>0 才输出） */
  goalSec?: number;
  /** 当前连续学习天数（stats.report 全局口径；>0 才输出） */
  streakDays?: number;
  /** full 档分日明细数据（第 237 轮）：逐日站内有效秒数（date='YYYY-MM-DD'；周期范围外日忽略） */
  days?: Array<{ date: string; sec: number }>;
  /** full 档完看课程名单（第 237 轮）：收藏 metadata.watchedRatio ≥ 0.95 的标题（累计口径；缺省省略该段） */
  finishedCourses?: string[];
}

/** buildPeriodShareText 档位选项（第 237 轮）：缺省 / 'concise' 保持第 235 轮现行为（逐字节不变） */
export interface PeriodShareOptions {
  /** 精简（默认）/ 完整（追加分日明细 + 完看课程段） */
  detail?: 'concise' | 'full';
}

/** full 档防超长：分日明细最多 31 行（自然月最多 31 天），完看课程最多列 5 个名字 */
const SHARE_FULL_MAX_DAY_LINES = 31;
const SHARE_FULL_MAX_COURSE_NAMES = 5;
/** 完看课程单标题截断长度（B 站收藏标题可能很长，分享文本保持克制） */
const SHARE_FULL_COURSE_TITLE_MAX = 20;

/** full 档标题截断：超长加「…」（按码元截断，emoji 类标题极少见且仅影响展示） */
function truncateTitle(title: string): string {
  return title.length > SHARE_FULL_COURSE_TITLE_MAX ? `${title.slice(0, SHARE_FULL_COURSE_TITLE_MAX)}…` : title;
}

/**
 * full 档分日明细行（第 237 轮）：周期桶范围内的逐日站内秒数 → 'MM-DD X 分钟'
 * 升序行列表。0 学习日省略；>0 但不足 1 分钟的日子按 1 分钟计（避免「0 分钟」行）；
 * 上限 31 行防超长（自然月最多 31 天，超出取最新的 31 天）。
 */
function fullDayDetailLines(bucket: { startDay: string; endDay: string }, days?: Array<{ date: string; sec: number }>): string[] {
  const rows = (Array.isArray(days) ? days : [])
    .filter(
      (row) =>
        !!row &&
        typeof row.date === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(row.date) &&
        row.date >= bucket.startDay &&
        row.date <= bucket.endDay &&
        typeof row.sec === 'number' &&
        Number.isFinite(row.sec) &&
        row.sec > 0,
    )
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .slice(-SHARE_FULL_MAX_DAY_LINES); // 升序后取尾部 = 保留最新 31 天
  return rows.map((row) => `${row.date.slice(5)} ${Math.max(1, Math.round(row.sec / 60))} 分钟`);
}

/** full 档完看课程段：去重 + 截断 + 限量，无有效名字返回 null（整段省略） */
function fullFinishedCoursesLine(titles?: string[]): string | null {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(titles) ? titles : []) {
    if (typeof raw !== 'string') continue;
    const title = raw.trim();
    if (title.length === 0 || seen.has(title)) continue;
    seen.add(title);
    if (names.length < SHARE_FULL_MAX_COURSE_NAMES) names.push(truncateTitle(title));
  }
  if (names.length === 0) return null;
  const total = seen.size;
  return `完看课程（累计 ${total}）：${names.join('、')}${total > names.length ? ` 等 ${total} 个` : ''}`;
}

/**
 * 周期分享摘要（第 235 轮巡检，分享视角；第 237 轮加精简 / 完整档位；第 238 轮
 * 排版美化）：把「当前周期」（buckets 最后一项，与 PeriodReportCard / dashboard
 * 数字卡同源）序列化为精炼可分享的纯文本（非 Markdown 表格、无口径附注、末尾
 * 不加广告语——简洁克制，粘贴即用）。
 *
 * 排版（第 238 轮打磨，**不改任何数据口径与行集**，只改空白 / 分组 / 标题装饰）：
 *  - 段落间空行分组：标题行 / 主指标块 / 明细块（分日明细 / 完看课程）之间各一个
 *    空行（'\n\n' 连接），行集与行序与第 237 轮完全一致；
 *  - 标题行加一个克制的 emoji（📊，仅标题行，正文不加装饰）；
 *  - 键值分隔沿用全角冒号「键：值」（两处分享函数与卡面文案的既有惯例，
 *    第 238 轮起作为全仓分享文案的统一约定，不引入半角冒号混排）。
 *
 * 行清单（缺项自动省略；行集不变，仍与第 235/237 轮同线）：
 *  - 周期名：周「本周 11.16–11.22」/ 月「本月 2026年11月」（bucket.label 直出）；
 *  - 站内学习：formatDuration（小时分钟）；
 *  - 活跃天数：站内或站外有学习的自然日（PeriodBucket 现有口径；周报桶无逐日打卡
 *    数据，「打卡天数」以同源的活跃天数行承担，卡面/摘要均沿用该术语）；
 *  - 连续学习：extras.streakDays > 0 才输出；
 *  - 周目标：仅周报且 goalSec > 0 才输出（月报与「每周」目标不同域）——
 *    达成「已达成（目标 X）」/ 未达成「差 X（目标 Y）」；
 *  - 站外视频：externalSec > 0 才输出；
 *  - 计划完看：仅周报且该周有计划排期（plan.total > 0）才输出。
 *
 * 完整档（options.detail === 'full'，第 237 轮）在指标块之后追加两段（缺数据省略，
 * 各自成段）：
 *  - 分日明细：'MM-DD X 分钟' 逐日行（周期范围内、0 学习日省略、上限 31 行），
 *    前置「分日明细：」头行；数据取 extras.days（stats.report days[] 的 validSec
 *    同源传入，站内口径与「站内学习」行一致）；
 *  - 完看课程：'完看课程（累计 N）：A、B、C' 单行（去重、单标题截断 20 字、最多
 *    列 5 个，超出附「等 N 个」）；数据取 extras.finishedCourses（收藏
 *    watchedRatio ≥ 0.95 现值口径，累计口径——非周期内切片，与周报「计划完看」
 *    行的排期口径不同源，故只在完整档输出、不与「计划完看」混淆）。
 */
export function buildPeriodShareText(report: PeriodReport, extras?: PeriodShareExtras, options?: PeriodShareOptions): string {
  const bucket = report?.buckets?.[report.buckets.length - 1];
  if (!bucket) return '';
  const kindLabel = report.kind === 'month' ? '本月' : '本周';
  const internalSec = Number.isFinite(bucket.internalSec) ? Math.max(0, Math.round(bucket.internalSec)) : 0;

  // 段落制（第 238 轮）：标题 / 指标 / 明细各自成段，段间空行；段内行集与行序不变
  const paragraphs: string[][] = [];
  paragraphs.push([`📊 ${kindLabel} ${bucket.label}`]);

  const metricLines: string[] = [];
  metricLines.push(`站内学习：${formatDuration(internalSec)}`);
  metricLines.push(`活跃天数：${Number.isFinite(bucket.activeDays) ? Math.max(0, Math.round(bucket.activeDays)) : 0} 天`);
  if (typeof extras?.streakDays === 'number' && Number.isFinite(extras.streakDays) && extras.streakDays > 0) {
    metricLines.push(`连续学习：${Math.round(extras.streakDays)} 天`);
  }
  if (report.kind === 'week' && typeof extras?.goalSec === 'number' && Number.isFinite(extras.goalSec) && extras.goalSec > 0) {
    const goalSec = extras.goalSec;
    if (internalSec >= goalSec) {
      metricLines.push(`周目标：已达成（目标 ${formatDuration(goalSec)}）`);
    } else {
      metricLines.push(`周目标：差 ${formatDuration(goalSec - internalSec)}（目标 ${formatDuration(goalSec)}）`);
    }
  }
  if (Number.isFinite(bucket.externalSec) && bucket.externalSec > 0) {
    metricLines.push(`站外视频：${formatDuration(Math.max(0, Math.round(bucket.externalSec)))}`);
  }
  if (report.kind === 'week' && bucket.plan && bucket.plan.total > 0) {
    metricLines.push(`计划完看：${bucket.plan.finished}/${bucket.plan.total} 个`);
  }
  paragraphs.push(metricLines);

  // 完整档（第 237 轮）：分日明细 + 完看课程（缺数据整段省略，保持「缺项自动省略」约定）
  if (options?.detail === 'full') {
    const dayLines = fullDayDetailLines(bucket, extras?.days);
    if (dayLines.length > 0) {
      paragraphs.push(['分日明细：', ...dayLines]);
    }
    const finishedLine = fullFinishedCoursesLine(extras?.finishedCourses);
    if (finishedLine) paragraphs.push([finishedLine]);
  }
  return paragraphs.map((lines) => lines.join('\n')).join('\n\n');
}
