/**
 * 学习时段分布（第 238 轮巡检，信息 / 自我认知视角）。
 *
 * 与 heatmap.ts / checkinMonth.ts 同层的纯函数聚合器：输入站内观看流水 + 「今天」
 * 时刻（+ 可选窗口天数），把近 N 天的观看按**开始小时**分入六个时段桶，输出每桶
 * 的有效秒数与次数。热力图看「哪天学」，本聚合看「几点学」——与热力图互补的
 * 自我认知维度（StatsView「学习时段」卡的取数口径）。
 *
 * 口径决定（与既有报表同线）：
 *  - **只计 valid === true 的流水**：报表/热力图/周月报的「有效时长」口径都是
 *    「播放中 + 页面前台可见 + 非挂机」的墙钟时间（valid=false 的挂机/异常流水
 *    保留审计但不进报表，见 WatchRecordEntity.valid 注释与 StatsView 口径说明），
 *    时段分布作为「自我认知」展示同样沿用有效口径，避免「报表 2 小时、时段卡
 *    3 小时」的口径分裂；sec 与 count 同源（都只数 valid 行）；
 *  - 分桶按 startTs 的**本地开始小时**（new Date(startTs).getHours()），跨零点
 *    记录按开始时刻归桶（23 点开始的跨零点记录归「深夜」，不按时长拆分——时段
 *    分布问的是「什么时候开始学」，与热力图「按 date 日键拆分」的口径不同且各有
 *    语义）；桶界：清晨 [5,8) / 上午 [8,12) / 午后 [12,14) / 傍晚 [14,18) /
 *    晚间 [18,23) / 深夜 [23,24)∪[0,5)；
 *  - 窗口 = 近 days 天（默认 30，含今天）：按流水 date 日键字符串比较
 *    （'YYYY-MM-DD' 字典序 = 时间序），窗口起点 = localDayKey(now − (days−1) 天)，
 *    终点 = 今天日键（未来日键防御性排除）；
 *  - 总有效时长为 0（无流水 / 全 invalid / 窗口外）→ 返回 null（UI 渲染空态），
 *    与「0 学习不该画出六条 0 比例空条」的展示约定一致。
 *
 * 脏数据防御（与 heatmap.ts 同风格，不抛错）：records 非数组 / 行非对象 /
 * date 非合法日键 / startTs 非有限 / durationSec 非有限正数的行逐条跳过；
 * now 非有限 → null（纯函数约定：不内部取 Date.now()，「今天」由调用方传入，
 * 与 heatmap / period 同一口径）；days 非法回退默认 30 并 clamp 到 [1, 365]。
 *
 * 第 239 轮巡检在同文件追加「黄金时段建议」纯函数组（suggestGoldenSlot /
 * isInGoldenNow，建议 / 引导视角）：消费 buildTimeOfDayDistribution 的输出给出
 * 「你的黄金时段」建议与「此刻是否在黄金时段」判断，见文件末段注释。
 */

import type { WatchRecordEntity } from '../shared/types';
import { localDayKey } from '../shared/utils';

/** 时段桶 key（内部标识，UI 高亮判断用） */
export type TimeOfDayBucketKey = 'dawn' | 'morning' | 'midday' | 'dusk' | 'evening' | 'lateNight';

/** 单个时段桶（固定六桶全量输出，含 0 秒桶——UI 需要完整的一天结构） */
export interface TimeOfDayBucket {
  key: TimeOfDayBucketKey;
  /** 展示名（清晨 / 上午 / 午后 / 傍晚 / 晚间 / 深夜） */
  label: string;
  /** 桶内 valid 流水的有效秒数合计 */
  sec: number;
  /** 桶内 valid 流水条数（与 sec 同源计数） */
  count: number;
}

/** 时段桶定义（顺序 = 输出顺序；hourLabel 供 UI tooltip 的时刻范围标注） */
interface TimeOfDayBucketDef {
  key: TimeOfDayBucketKey;
  label: string;
  /** 桶内小时集合（本地开始小时，23-5 跨零点桶为两段并集） */
  hours: ReadonlySet<number>;
  /** 时刻范围标注（UI title 用） */
  hourLabel: string;
}

const BUCKET_DEFS: readonly TimeOfDayBucketDef[] = [
  { key: 'dawn', label: '清晨', hours: new Set([5, 6, 7]), hourLabel: '5–8 点' },
  { key: 'morning', label: '上午', hours: new Set([8, 9, 10, 11]), hourLabel: '8–12 点' },
  { key: 'midday', label: '午后', hours: new Set([12, 13]), hourLabel: '12–14 点' },
  { key: 'dusk', label: '傍晚', hours: new Set([14, 15, 16, 17]), hourLabel: '14–18 点' },
  { key: 'evening', label: '晚间', hours: new Set([18, 19, 20, 21, 22]), hourLabel: '18–23 点' },
  { key: 'lateNight', label: '深夜', hours: new Set([23, 0, 1, 2, 3, 4]), hourLabel: '23–5 点' },
];

/** 时段桶 key → 时刻范围标注（UI tooltip 用；未知 key 返回空串） */
export function timeOfDayHourLabel(key: TimeOfDayBucketKey): string {
  return BUCKET_DEFS.find((def) => def.key === key)?.hourLabel ?? '';
}

/** 默认窗口天数（近 30 天，与 StatsView「近 30 天」柱图窗口一致） */
export const TIME_OF_DAY_DEFAULT_DAYS = 30;

// ───────────────────────── 黄金时段建议（第 239 轮巡检，建议 / 引导视角） ─────────────────────────

/** 黄金时段建议门槛：近 30 天总有效时长 ≥ 60 分钟（低于此值「最高桶」只是偶然噪声） */
export const GOLDEN_SLOT_MIN_TOTAL_SEC = 60 * 60;
/** 黄金时段建议门槛：最高桶占比 ≥ 25%（六桶均分基线 16.7% 之上才有「习惯」意义） */
export const GOLDEN_SLOT_MIN_SHARE = 0.25;

/** 黄金时段建议（suggestGoldenSlot 返回；label 为桶展示名，share 为 0..1 原始占比） */
export interface GoldenSlotSuggestion {
  key: TimeOfDayBucketKey;
  label: string;
  /** 黄金桶内的有效秒数（时间分布卡同源的 Math.round 取整） */
  shareSec: number;
  /** 黄金桶占比（0..1，未取整——阈值判断与展示层各自决定舍入） */
  share: number;
}

/**
 * 黄金时段建议（纯函数，第 239 轮巡检，建议 / 引导视角）：取时段分布中占比最高的
 * 桶为「黄金时段」，但只在数据足以支撑「习惯」判断时给出——
 *  - 总有效时长 ≥ GOLDEN_SLOT_MIN_TOTAL_SEC（60 分钟）且最高桶占比 ≥
 *    GOLDEN_SLOT_MIN_SHARE（25%）才返回建议，否则 null（防噪声：刚学 10 分钟的
 *    新用户不该立刻被告知「你的黄金时段是深夜」）；
 *  - 并列最高取固定桶序靠前者（清晨→…→深夜，与 TimeOfDayCard topKey 高亮同约定，
 *    保证同一数据恒定同一建议）；
 *  - 防御同 buildTimeOfDayDistribution 风格（不抛错）：dist 非数组 / 行非对象 /
 *    key 未知 / sec 非有限正数的行跳过，总量为 0 或不达门槛 → null；总量由本函数
 *    从过滤后的行重算（不信任外部传入的分母，避免调用方切片后占比漂移）。
 *
 * 签名说明（对任务草图的调整）：任务草图建议 `suggestGoldenSlot(dist, nowHour?)`，
 * 实现把「当前是否落在黄金时段」拆给独立的 isInGoldenNow(golden, nowHour)——
 * nowHour 属于「此刻判断」的入参而非「生成建议」的入参（建议只依赖历史分布），
 * 黄金桶信息经返回值携带，避免 suggestGoldenSlot 收一个用不上的参数。
 */
export function suggestGoldenSlot(dist: TimeOfDayBucket[] | null | undefined): GoldenSlotSuggestion | null {
  if (!Array.isArray(dist)) return null;
  // 只认固定六桶 key 的合法行（sec 必须为有限正数；label 取桶定义而非行内值，防脏数据串味）
  const secByKey = new Map<TimeOfDayBucketKey, number>();
  for (const row of dist) {
    if (!row || typeof row !== 'object') continue;
    if (typeof row.key !== 'string' || !BUCKET_DEFS.some((def) => def.key === row.key)) continue;
    if (typeof row.sec !== 'number' || !Number.isFinite(row.sec) || row.sec <= 0) continue;
    secByKey.set(row.key, row.sec);
  }
  if (secByKey.size === 0) return null;

  const totalSec = [...secByKey.values()].reduce((acc, sec) => acc + sec, 0);
  if (totalSec < GOLDEN_SLOT_MIN_TOTAL_SEC) return null;

  // 固定桶序扫描取最高（并列取靠前，与 TimeOfDayCard topKey 同约定）
  let topDef: TimeOfDayBucketDef | null = null;
  let topSec = 0;
  for (const def of BUCKET_DEFS) {
    const sec = secByKey.get(def.key) ?? 0;
    if (sec > topSec) {
      topSec = sec;
      topDef = def;
    }
  }
  if (!topDef) return null; // 理论不可达（secByKey 非空且正数），防御前进

  const share = topSec / totalSec;
  if (share < GOLDEN_SLOT_MIN_SHARE) return null;
  return { key: topDef.key, label: topDef.label, shareSec: Math.round(topSec), share };
}

/**
 * 当前小时是否落在黄金时段桶内（纯函数，第 239 轮巡检）：golden 为 null（未达
 * 建议门槛）恒 false；nowHour 须为 0–23 整数（防御非有限 / 越界 / 小数，Date
 * getHours() 恰为该域）；跨零点桶（深夜 [23,24)∪[0,5)）经桶定义的小时集合判断，
 * 0–4 点与 23 点同归深夜、判定正确。
 */
export function isInGoldenNow(golden: GoldenSlotSuggestion | null | undefined, nowHour: number): boolean {
  if (!golden || typeof golden !== 'object') return false;
  if (!Number.isInteger(nowHour) || nowHour < 0 || nowHour > 23) return false;
  const def = BUCKET_DEFS.find((bucket) => bucket.key === golden.key);
  return !!def && def.hours.has(nowHour);
}

/** 合法日键守卫（与 milestones.isValidDayKey 同规则：格式 + round-trip 校验） */
function isValidDayKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const parsed = new Date(year, month - 1, day);
  return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day;
}

/**
 * 学习时段分布（纯函数）：近 days 天（默认 30）内 valid 流水按本地开始小时分六桶，
 * 输出固定顺序的桶数组；总有效秒数为 0 → null（UI 空态）。语义与防御见文件头。
 */
export function buildTimeOfDayDistribution(
  records: WatchRecordEntity[] | null | undefined,
  now?: number,
  days?: number,
): TimeOfDayBucket[] | null {
  // 「今天」必须由调用方传入（纯函数约定，与 heatmap / period 同线）
  if (typeof now !== 'number' || !Number.isFinite(now)) return null;

  // 窗口天数：非法回退默认 30，clamp 到 [1, 365]
  let windowDays = TIME_OF_DAY_DEFAULT_DAYS;
  if (typeof days === 'number' && Number.isFinite(days)) {
    windowDays = Math.min(365, Math.max(1, Math.floor(days)));
  }

  const todayKey = localDayKey(now);
  const windowStartKey = localDayKey(now - (windowDays - 1) * 86_400_000);

  // 固定六桶全量初始化（0 秒桶也保留，UI 画完整一天结构）
  const secByKey = new Map<TimeOfDayBucketKey, number>(BUCKET_DEFS.map((def) => [def.key, 0]));
  const countByKey = new Map<TimeOfDayBucketKey, number>(BUCKET_DEFS.map((def) => [def.key, 0]));

  for (const record of Array.isArray(records) ? records : []) {
    if (!record || typeof record !== 'object') continue;
    // 只计 valid 口径（与报表「有效时长」同线，文件头「口径决定」）
    if (record.valid !== true) continue;
    const date = record.date;
    if (!isValidDayKey(date)) continue;
    // 近 N 天窗口（含今天）：日键字符串字典序比较；未来日键防御性排除
    if (date < windowStartKey || date > todayKey) continue;
    if (typeof record.startTs !== 'number' || !Number.isFinite(record.startTs)) continue;
    if (typeof record.durationSec !== 'number' || !Number.isFinite(record.durationSec) || record.durationSec <= 0) continue;

    const hour = new Date(record.startTs).getHours();
    const def = BUCKET_DEFS.find((bucket) => bucket.hours.has(hour));
    if (!def) continue; // 理论不可达（24 小时全覆盖），防御前进
    secByKey.set(def.key, (secByKey.get(def.key) ?? 0) + record.durationSec);
    countByKey.set(def.key, (countByKey.get(def.key) ?? 0) + 1);
  }

  const totalSec = [...secByKey.values()].reduce((acc, sec) => acc + sec, 0);
  if (totalSec <= 0) return null;

  return BUCKET_DEFS.map((def) => ({
    key: def.key,
    label: def.label,
    sec: Math.round(secByKey.get(def.key) ?? 0),
    count: countByKey.get(def.key) ?? 0,
  }));
}
