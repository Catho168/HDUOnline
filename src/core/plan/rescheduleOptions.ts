/**
 * 复习作业「顺延到指定日」快捷日期选项（第 244 轮巡检，复习域 / 灵活性视角）。
 *
 * 此前复习改期弹层的快捷档只有三条硬编码（明天 / 下周一 / 下周五，第 112 轮），
 * 远期顺延（如「下周同一日」「下月同一日」）要么靠原生 date 输入框手填。本模块把
 * 快捷档收敛为一份纯函数：
 *  - buildRescheduleOptions(today, days=14)：快捷 chips（明天 / 后天 / 未来若干天周几）
 *    + 两个跳档（下周同一日 / 下月同一日）。days 为快捷 chips 覆盖天数上限（钳到 7，
 *    即一整周——周内每天恰好出现一次，周几标签无歧义）；第 7 天恰为 today+7 =
 *    「下周同一日」，直接以跳档标签命名该档，避免同日出现「周X」与「下周同一日」
 *    两枚重复 chip；days < 7 时「下周同一日」作为跳档补在 chips 之后（快速越过
 *    chips 窗口）。「下月同一日」恒在（同「日」下月，月末溢出钳到当月最后一天）。
 *  - clampRescheduleDate(dateKey, today)：目标日期钳制——不得早于今日（早于今日
 *    钳回今日），并给 sameDay 标记（选今天 = 保持不变，调用方提示「已是今日到期」
 *    且不发起 reschedule）。非法输入返回 null。
 *
 * 全部输出为 'YYYY-MM-DD' 本地日键（与 addDaysKey / localDayKey 同口径），不依赖
 * UI 层，供 ReviewView 改期弹层 / 行内顺延浮层 / 批量改期弹层共用。
 */
import { addDaysKey } from '@/core/shared/utils';

/** 周几短标签（周一为始的中文习惯；getDay() 0=周日） */
const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'] as const;

/** 单个快捷日期选项：key 为选项身份（d1..d7 / next-week / next-month），
 *  label 为主行（chip 大字），dayLabel 为副行（M月D日 周X，排版小字）。 */
export interface RescheduleOption {
  key: string;
  label: string;
  dateKey: string;
  dayLabel: string;
}

function weekdayLabelOf(dateKey: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!m) return '';
  const day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay();
  return WEEKDAY_LABELS[day] ?? '';
}

function monthDayLabelOf(dateKey: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!m) return '';
  return `${Number(m[2])}月${Number(m[3])}日 周${weekdayLabelOf(dateKey)}`;
}

/** 同「日」下月的日键：月末溢出（1 月 31 日 → 2 月）钳到当月最后一天（闰年-aware） */
function sameDayNextMonth(dayKey: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const ny = mo === 12 ? y + 1 : y;
  const nm = mo === 12 ? 1 : mo + 1;
  const lastDay = new Date(ny, nm, 0).getDate();
  const nd = Math.min(d, lastDay);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${ny}-${pad(nm)}-${pad(nd)}`;
}

/**
 * 快捷日期选项（详见文件头注释）。today 非 'YYYY-MM-DD' 时返回空数组（防御）。
 * @param today 本地今日日键
 * @param days  快捷 chips 覆盖天数上限（钳到 [0, 7]；缺省 14 → 一整周 7 档）
 */
export function buildRescheduleOptions(today: string, days = 14): RescheduleOption[] {
  const base = addDaysKey(today, 0);
  if (!base) return [];
  const options: RescheduleOption[] = [];
  const quickCount = Math.min(7, Math.max(0, Math.trunc(days)));
  for (let offset = 1; offset <= quickCount; offset += 1) {
    const dateKey = addDaysKey(base, offset);
    if (!dateKey) break;
    // 第 7 天 = today+7 = 「下周同一日」，用跳档标签命名（避免与跳档重复）
    const isNextWeek = offset === 7;
    options.push({
      key: isNextWeek ? 'next-week' : `d${offset}`,
      label: offset === 1 ? '明天' : offset === 2 ? '后天' : isNextWeek ? '下周同一日' : `周${weekdayLabelOf(dateKey)}`,
      dateKey,
      dayLabel: monthDayLabelOf(dateKey),
    });
  }
  // chips 未覆盖到第 7 天时，「下周同一日」作为跳档补齐（快速越过 chips 窗口）
  if (quickCount < 7) {
    const dateKey = addDaysKey(base, 7);
    if (dateKey) {
      options.push({ key: 'next-week', label: '下周同一日', dateKey, dayLabel: monthDayLabelOf(dateKey) });
    }
  }
  const nextMonth = sameDayNextMonth(base);
  if (nextMonth) {
    options.push({ key: 'next-month', label: '下月同一日', dateKey: nextMonth, dayLabel: monthDayLabelOf(nextMonth) });
  }
  return options;
}

export interface ClampedRescheduleDate {
  /** 钳制后的目标日键（≥ today） */
  dateKey: string;
  /** true = 目标即今日（保持不变，调用方提示且不发起 reschedule） */
  sameDay: boolean;
}

/** 目标日期钳制：不得早于今日（早于今日钳回今日）；非法输入（含非字符串、
 *  非 'YYYY-MM-DD' 格式、语义溢出如 2026-13-40——addDaysKey 会把溢出日期滚动
 *  归一，round-trip 不等即判非法）返回 null，调用方按无效日期处理。 */
export function clampRescheduleDate(dateKey: unknown, today: string): ClampedRescheduleDate | null {
  const base = addDaysKey(today, 0);
  if (!base || typeof dateKey !== 'string') return null;
  const key = addDaysKey(dateKey, 0);
  if (!key || key !== dateKey) return null;
  if (key < base) return { dateKey: base, sameDay: true };
  return { dateKey: key, sameDay: key === base };
}
