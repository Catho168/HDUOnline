/**
 * 周目标达成预测（第 236 轮巡检，目标管理 / 预测视角）+ 今晚补进度模拟
 * （第 237 轮巡检，目标管理 / 模拟视角）。
 *
 * 与 period.ts / milestones.ts 同层的纯函数：输入「今天」时刻 + 本周已学秒数 +
 * 周目标秒数，输出本周剩余口径的达成预测（全部为派生字段，UI 直用 + 可单测）。
 * **纯展示层：不改变任何统计口径**——只读传入的 weekSec / targetSec，不回放流水。
 *
 * 口径决定：
 *  - 周界 = 本地周一（shared/utils.startOfLocalWeek 既有惯例的同一口径，与
 *    period.periodBuckets 周桶、aggregate.buildReport 的 weekSec 同线）；
 *    daysLeft 按本地时区日历日计算，**含今天**：周一=7、周日=1（本周最后一天则 1）；
 *  - neededPerDaySec = 剩余缺口 / daysLeft，**向上取整到分钟**（3600 秒粒度向上，
 *    保证按该值学满必达标；已达标则为 0）；
 *  - onPaceSec = 按当前日均节奏推算的本周预计总量 = weekSec / 已过天数 × 7，
 *    已过天数**含今天**（本周第 N 天 → N；周一=1、周日=7）；
 *  - willHit = onPace ≥ target（已达标态恒 true，见下）；aheadBehindSec =
 *    onPace − target（正超前 / 负落后；UI 在未达标分支才使用该字段）。
 *
 * 边界防御（不抛错，返回 null = 不预测，UI 不渲染预测行）：
 *  - now 非有限 / targetSec 非有限或 ≤ 0（未设目标）→ null；
 *  - daysLeft ≤ 0（理论上不可达，防御时钟回拨等异常）→ null；
 *  - weekSec 非有限按 0、负数 clamp 到 0（脏数据不产生荒谬预测）；
 *  - weekSec ≥ target →「已达标」态：neededPerDaySec = 0、willHit = true
 *    （onPace / aheadBehindSec 仍按统一公式输出，UI 达标分支改用 weekSec − target
 *    显示「超额」，不用该字段）。
 */

/** 单个周目标预测输入（now 必填：纯函数约定，不内部取 Date.now()） */
export interface WeeklyGoalForecastInput {
  /** 「今天」毫秒时间戳（本地时区语义） */
  now: number;
  /** 本周已学秒数（站内有效口径，调用方与自身 Progress 分母同源传入） */
  weekSec: number;
  /** 周目标秒数（settings.weeklyGoalHours * 3600；≤0 视为未设目标） */
  targetSec: number;
}

/** 周目标预测输出（全部派生字段，UI 直用） */
export interface WeeklyGoalForecast {
  /** 本周剩余天数（含今天；周一=7 … 周日=1） */
  daysLeft: number;
  /** 达标还需日均秒数（剩余缺口 / daysLeft 向上取整到分钟；已达标为 0） */
  neededPerDaySec: number;
  /** 按当前日均节奏推算的本周预计总量（秒，取整） */
  onPaceSec: number;
  /** 按当前节奏是否会达标（onPace ≥ target；已达标恒 true） */
  willHit: boolean;
  /** 预计总量 − 目标（秒，正超前 / 负落后；仅未达标分支供 UI 使用） */
  aheadBehindSec: number;
}

/** 周内已过天数（含今天）：本周第 N 天 → N；用于日均节奏分母 */
function daysElapsedInWeek(now: number): number {
  const d = new Date(now);
  return ((d.getDay() + 6) % 7) + 1; // 周一=1 … 周日=7
}

/**
 * 周目标达成预测（纯函数）。输入见 WeeklyGoalForecastInput；不预测时返回 null
 * （UI 不渲染预测行），语义见文件头注释。
 */
export function weeklyGoalForecast(input: WeeklyGoalForecastInput): WeeklyGoalForecast | null {
  const { now, targetSec } = input ?? ({} as WeeklyGoalForecastInput);
  if (typeof now !== 'number' || !Number.isFinite(now)) return null;
  if (typeof targetSec !== 'number' || !Number.isFinite(targetSec) || targetSec <= 0) return null;

  // 剩余天数（含今天）：本周一为起点（startOfLocalWeek 口径），「一周 7 天 − 已过
  // 天数 + 今天」= 含今天的剩余天数（周一=7 … 周日=1）
  const daysLeft = 8 - daysElapsedInWeek(now);
  if (daysLeft <= 0 || daysLeft > 7) return null;

  const rawWeekSec = typeof input.weekSec === 'number' && Number.isFinite(input.weekSec) ? input.weekSec : 0;
  const weekSec = Math.max(0, rawWeekSec);
  const achieved = weekSec >= targetSec;

  // 剩余缺口 / daysLeft 向上取整到分钟（已达标为 0）
  const remaining = targetSec - weekSec;
  const neededPerDaySec = achieved ? 0 : Math.ceil(remaining / daysLeft / 60) * 60;

  // 按当前日均节奏推算本周总量（已过天数含今天）；脏数据（除零不可能：≥1）防御
  const elapsed = 8 - daysLeft; // 1..7
  const onPaceSec = Math.round((weekSec / elapsed) * 7);

  return {
    daysLeft,
    neededPerDaySec,
    onPaceSec,
    willHit: achieved ? true : onPaceSec >= targetSec,
    aheadBehindSec: onPaceSec - targetSec,
  };
}

// ───────────────────────── 今晚补进度模拟（第 237 轮巡检） ─────────────────────────

/** 今晚补进度模拟输入（weekSec / targetSec 与 weeklyGoalForecast 同口径传入） */
export interface EveningSimInput {
  /** 本周已学秒数（站内有效口径，调用方与自身 Progress 分母同源传入） */
  weekSec: number;
  /** 今晚准备补学的秒数（UI 以分钟输入 ×60 传入；≤0 / 非法 → null） */
  extraSec: number;
  /** 周目标秒数（settings.weeklyGoalHours * 3600；≤0 视为未设目标） */
  targetSec: number;
}

/** 今晚补进度模拟输出（overBySec / shortBySec 恒一正一零，恰好达标两者皆 0） */
export interface EveningSimResult {
  /** 模拟后的本周总量（weekSec + extraSec，取整） */
  simulatedSec: number;
  /** 模拟后是否达标（simulatedSec ≥ targetSec） */
  willHit: boolean;
  /** 达标时的超额秒数（simulatedSec − targetSec；未达标恒 0，恰好达标为 0） */
  overBySec: number;
  /** 未达标时的缺口秒数（targetSec − simulatedSec；达标恒 0） */
  shortBySec: number;
}

/**
 * 今晚补进度模拟（纯函数，第 237 轮巡检，目标管理 / 模拟视角）：在当前本周已学
 * 基础上「再学 extraSec 后是否达成本周目标」——「如果今晚学 X 分钟会怎样」的
 * what-if 即时计算。纯展示层：不写库、不回放流水、刷新即失，UI 即点即算。
 *
 * 边界防御（返回 null = 不模拟，UI 不渲染结果）：
 *  - extraSec 非有限 / ≤ 0 → null（0 或负数补学无意义）；
 *  - targetSec 非有限 / ≤ 0（未设目标）→ null（与 weeklyGoalForecast 同防御）；
 *  - weekSec 非有限按 0、负数 clamp 到 0（脏数据不产生荒谬结果）；
 *  - 已达标（weekSec ≥ targetSec）正常输出：overBySec = simulatedSec − targetSec
 *    （含今晚补学部分），UI 显示「再学 X 分钟后超额 Y」。
 */
export function simulateEveningStudy(input: EveningSimInput): EveningSimResult | null {
  const extraSec = input?.extraSec;
  if (typeof extraSec !== 'number' || !Number.isFinite(extraSec) || extraSec <= 0) return null;
  const targetSec = input?.targetSec;
  if (typeof targetSec !== 'number' || !Number.isFinite(targetSec) || targetSec <= 0) return null;

  const rawWeekSec = input?.weekSec;
  const weekSec = typeof rawWeekSec === 'number' && Number.isFinite(rawWeekSec) ? Math.max(0, rawWeekSec) : 0;
  const simulatedSec = Math.round(weekSec + extraSec);
  const delta = simulatedSec - targetSec;
  return {
    simulatedSec,
    willHit: delta >= 0,
    overBySec: delta > 0 ? delta : 0,
    shortBySec: delta < 0 ? -delta : 0,
  };
}

// ───────────────────────── 通用进度模拟薄包装（第 238 轮巡检） ─────────────────────────

/**
 * 通用「再学 X 会怎样」进度模拟（纯函数，第 238 轮巡检）：simulateEveningStudy 的
 * 薄包装，把「当前累计秒数」语义泛化为 baseSec（不绑定「本周」），供每日目标等
 * 任意「累计 vs 目标」口径复用同一模拟引擎。
 *
 * 为什么是薄包装而非直接复用 / 改名合一（第 238 轮日志口径）：simulateEveningStudy
 * 的计算本体（累计 + 增量 vs 目标，一正一零的 over/short 输出）已与「周」无关，
 * 但参数名 weekSec / 类型名 EveningSimInput 在文档与命名上绑死「今晚补周目标」；
 * 若直接改名会波及第 237 轮的 EveningSimRow 与两份既有单测（影响面大），故新增
 * 薄包装把命名泛化、计算委托原函数——单点实现不变，两套命名各自贴切。
 *
 * 边界防御与 simulateEveningStudy 完全一致（baseSec 对应 weekSec 传入，非有限按 0、
 * 负数 clamp 到 0；extraSec / targetSec 非法 → null），不重复实现计算逻辑。
 */
export interface StudyProgressInput {
  /** 当前已累计秒数（任意口径：本周已学 / 今日已学等，与 targetSec 同口径传入） */
  baseSec: number;
  /** 准备再学的秒数（UI 以分钟 ×60 传入；≤0 / 非法 → null） */
  extraSec: number;
  /** 目标秒数（≤0 / 非法视为未设目标 → null） */
  targetSec: number;
}

/** 通用进度模拟（返回类型与 EveningSimResult 完全一致，UI 可共用着色与文案逻辑） */
export function simulateStudyProgress(input: StudyProgressInput): EveningSimResult | null {
  return simulateEveningStudy({ weekSec: input?.baseSec, extraSec: input?.extraSec, targetSec: input?.targetSec });
}
