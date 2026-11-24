/**
 * 学习里程碑回放（第 235 轮巡检）。
 *
 * 与 checkinMonth.ts / period.ts 同层的纯函数聚合器：输入按日报表行（DailyStat 的
 * { date, validSec } 口径，时间正序期望），回放派生「里程碑时刻」数组——不新增
 * 表 / op / kv，全部从既有 stats.report 的 days[] 数据回放得出（打卡月历卡同款
 * 取数路径）。
 *
 * 口径决定（与既有纯函数同线）：
 *  - 累计里程碑：累计站内 validSec 首次跨越 MILESTONE_TOTAL_THRESHOLDS_SEC 各档
 *    （1h / 5h / 10h / 25h / 50h / 100h），跨越即记一条，detail 写当日累计；
 *  - 连续新高：按日键回放连续段（有学习的自然日 validSec > 0，与 computeStreak 的
 *    「valid 流水日」口径一致），每次刷新个人最长纪录且 ≥3 天记一条（避开 1~2 天
 *    的起步噪声）；
 *  - 单日新高：单日 validSec 刷新历史最高且 ≥30 分钟记一条（同上，避开短时学习
 *    的频繁刷新）；
 *  - 首次打卡：首个 validSec ≥ checkinMinSec 的日子（打卡线由调用方传
 *    aggregate.CHECKIN_MIN_SEC，与 hitDaysThisWeek / 打卡月历同线，不在此复制魔数）。
 *
 * 脏数据防御（与 checkinMonth.ts 同风格）：days 非数组 / 行非对象 / date 非合法
 * 日键（含 2026-02-30 类形似键）/ validSec 非有限非负逐条跳过；日期乱序时先按
 * 日键升序归并（同日去重求和）再回放——回放语义要求时间正序，调用方传入乱序
 * 数据不产生错误里程碑。全量里程碑时间升序输出；items 取最近 limit 条（默认 12），
 * total 为全量条数（UI 据此显示「共 X 个里程碑」）。
 */

import { CHECKIN_MIN_SEC } from './aggregate';
import { formatDuration } from '../shared/utils';

/** 单个里程碑时刻 */
export interface StudyMilestone {
  /** 本地日键 'YYYY-MM-DD'（达成当日） */
  date: string;
  /** 事件类型：cumulative=累计跨越 / streak=连续新高 / daily=单日新高 / checkin=首次打卡 */
  kind: 'cumulative' | 'streak' | 'daily' | 'checkin';
  /** 标题（如「累计学习 1 小时」「连续学习新高」「单日学习新高」「首次打卡」） */
  title: string;
  /** 说明（如「当日累计 1 小时 5 分」「连续 5 天」） */
  detail: string;
}

export interface MilestonesResult {
  /** 最近 limit 条（时间升序；不足则全量） */
  items: StudyMilestone[];
  /** 全量里程碑条数（≥ items.length） */
  total: number;
}

/** 累计学习里程碑档位（秒）：首次跨越即记一条 */
export const MILESTONE_TOTAL_THRESHOLDS_SEC = [3600, 18000, 36000, 90000, 180000, 360000];

/** 单日新高记录线（秒）：30 分钟 */
const DAILY_HIGH_MIN_SEC = 30 * 60;
/** 连续新高记录线（天）：≥3 天才记 */
const STREAK_MIN_DAYS = 3;

/** 默认展示条数 */
const DEFAULT_LIMIT = 12;

/** 合法日键守卫（与 checkinMonth.isValidDayKey 同规则：格式 + round-trip 校验） */
function isValidDayKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const parsed = new Date(year, month - 1, day);
  return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day;
}

/** 日键 → UTC 天序号（相邻日差 1，跨夏令时安全；与 plan/streak.ts 同手法） */
function dayIndex(key: string): number {
  return Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10))) / 86400000;
}


/**
 * 里程碑回放（纯函数）。days = 按日报表行（只读 date / validSec 两个字段）；
 * options.limit 截取最近 N 条展示（默认 12）；options.checkinMinSec 打卡线
 * （默认 CHECKIN_MIN_SEC）。不抛错：任何非法输入回退为「无里程碑」。
 */
export function deriveMilestones(
  days: Array<{ date?: unknown; validSec?: unknown }>,
  options?: { limit?: number; checkinMinSec?: number },
): MilestonesResult {
  const limitRaw = options?.limit;
  const limit =
    typeof limitRaw === 'number' && Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : DEFAULT_LIMIT;
  const checkinMinSec =
    typeof options?.checkinMinSec === 'number' && Number.isFinite(options.checkinMinSec) && options.checkinMinSec > 0
      ? options.checkinMinSec
      : CHECKIN_MIN_SEC;

  // 归并去重（同日求和）并按日键升序——回放要求时间正序，乱序输入归并后仍语义正确
  const secByDay = new Map<string, number>();
  for (const row of Array.isArray(days) ? days : []) {
    if (!row || typeof row !== 'object') continue;
    const date = (row as { date?: unknown }).date;
    const rawSec = (row as { validSec?: unknown }).validSec;
    if (!isValidDayKey(date)) continue;
    if (typeof rawSec !== 'number' || !Number.isFinite(rawSec) || rawSec < 0) continue;
    secByDay.set(date, (secByDay.get(date) ?? 0) + rawSec);
  }

  const dayKeys = [...secByDay.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const all: StudyMilestone[] = [];
  let totalSec = 0;
  let bestDaySec = 0;
  let bestStreak = 0;
  let runDays = 0;
  let prevIdx: number | null = null;
  let checkinDone = false;

  for (const key of dayKeys) {
    const sec = secByDay.get(key) ?? 0;
    const idx = dayIndex(key);

    // 连续段回放：与昨日相邻则续段，否则重开（validSec > 0 才算有学习日）
    if (sec > 0) {
      runDays = prevIdx !== null && idx - prevIdx === 1 ? runDays + 1 : 1;
      prevIdx = idx;
    } else {
      runDays = 0;
      prevIdx = idx;
    }

    // 1) 累计跨越（先累计再判定：跨越 = 此前累计 < 档位 ≤ 当日累计；
    //    sec=0 的空日子 total 不变，天然不会重复触发）
    totalSec += sec;
    for (const threshold of MILESTONE_TOTAL_THRESHOLDS_SEC) {
      if (totalSec >= threshold && totalSec - sec < threshold) {
        all.push({ date: key, kind: 'cumulative', title: `累计学习 ${formatDuration(threshold)}`, detail: `当日累计 ${formatDuration(totalSec)}` });
      }
    }

    // 2) 连续新高（≥3 天才记）
    if (runDays > bestStreak) {
      bestStreak = runDays;
      if (runDays >= STREAK_MIN_DAYS) {
        all.push({ date: key, kind: 'streak', title: '连续学习新高', detail: `连续 ${runDays} 天` });
      }
    }

    // 3) 单日新高（≥30 分钟才记）
    if (sec > bestDaySec) {
      const recordable = sec >= DAILY_HIGH_MIN_SEC;
      bestDaySec = sec;
      if (recordable) {
        all.push({ date: key, kind: 'daily', title: '单日学习新高', detail: `单日 ${formatDuration(sec)}` });
      }
    }

    // 4) 首次打卡
    if (!checkinDone && sec >= checkinMinSec) {
      checkinDone = true;
      all.push({ date: key, kind: 'checkin', title: '首次打卡', detail: `当日有效 ${formatDuration(sec)}` });
    }
  }

  return { items: all.slice(-limit), total: all.length };
}

// ───────────────────────── 分享文案（第 236 轮巡检） ─────────────────────────

/**
 * 里程碑分享文案（第 236 轮巡检，分享视角；第 238 轮排版美化）：把里程碑列表
 * 序列化为可分享纯文本（与 periodExport.buildPeriodShareText 同线的纯函数，
 * 无副作用，粘贴即用）。
 *
 * 形态（第 238 轮打磨，**不改行集与计数口径**，只改空白 / 分组 / 标题装饰）：
 *  - 标题行「🏆 学习里程碑（共 X 个，展示最近 N 个）」——X = total 全量条数；仅当
 *    截断生效（total > items.length）时才附「展示最近 N 个」，与 MilestoneWall foot
 *    的两态文案同规则（未截断时「展示最近 N 个」是噪声）；标题 emoji 🏆 仅标题行
 *    （与 buildPeriodShareText 的 📊 同约定：标题一个克制 emoji，正文不加装饰）；
 *  - 标题与明细行之间空行分组（段落制，与 periodExport 第 238 轮排版同线）；
 *  - 逐行「YYYY-MM-DD 标题 · detail」；detail 为空则省略「 · detail」尾巴；
 *  - 键值分隔沿用全角冒号惯例（本函数明细行为「日期 标题 · detail」列表形态，
 *    无键值对；标题括号计数与 period 分享一致用全角括号）。
 *
 * 防御（与 deriveMilestones 同风格，不抛错）：
 *  - 空列表（items 无有效行）返回空串（UI 据此不显示复制按钮 / 点击提示）；
 *  - 行非对象 / date 非合法日键 / title 非非空字符串的行跳过；title/detail 中的
 *    换行折为空格（长 detail 或换行脏数据不破坏「一行一条」的分享排版）；
 *  - total 非有限或 < items.length 时按 items.length 兜底（分享标题不显示荒谬数）。
 */
export function buildMilestoneShareText(
  items: StudyMilestone[],
  total?: number,
): string {
  const rows = (Array.isArray(items) ? items : []).filter(
    (item): item is StudyMilestone =>
      !!item &&
      typeof item === 'object' &&
      isValidDayKey((item as { date?: unknown }).date) &&
      typeof (item as { title?: unknown }).title === 'string' &&
      ((item as { title?: unknown }).title as string).trim().length > 0,
  );
  if (rows.length === 0) return '';
  const shown = rows.length;
  const totalCount = typeof total === 'number' && Number.isFinite(total) && total >= shown ? Math.round(total) : shown;
  const oneLine = (text: string): string => text.replace(/\s*\r?\n\s*/g, ' ').trim();

  const title = `🏆 学习里程碑（共 ${totalCount} 个${totalCount > shown ? `，展示最近 ${shown} 个` : ''}）`;
  const detailLines: string[] = [];
  for (const item of rows) {
    const detail = typeof item.detail === 'string' ? oneLine(item.detail) : '';
    const tail = detail.length > 0 ? ` · ${detail}` : '';
    detailLines.push(`${item.date} ${oneLine(item.title)}${tail}`);
  }
  // 标题 / 明细两段，段间空行（第 238 轮排版，与 periodExport 分享同线）
  return [title, detailLines.join('\n')].join('\n\n');
}
