/**
 * 首次使用引导（第 256 轮巡检，引导域 / 冷启动视角）。
 *
 * 纯函数层：把「新用户安装后第一步该做什么」收敛为固定三步，步骤完成态由
 * 本机数据派生（有课程 / 有观看 / 有收藏或笔记），供三处空态入口共用同一份
 * 步骤与文案——学习中心总览（空库）、学习看板概览（无课次）、popup 空态卡。
 * 此前三处空态文案各自为政（第 248/249 轮空态模板化只统一了句式，未统一
 * 引导链路），新用户在任一入口看到的「下一步」口径不一；本模块单点定义。
 *
 * 定位：纯展示与引导层——不改任何取数、不写库、不入设置；完成态判定全部
 * 用调用方已持有的数据（BundleData / DashboardReport / popup 既有取数），
 * 零新增 op。
 */

export interface OnboardingStep {
  key: 'sync' | 'watch' | 'collect';
  /** 步骤名（短，动词开头） */
  label: string;
  /** 一句怎么做（说清去哪、会发生什么） */
  hint: string;
  /** 完成态：由本机数据派生；library 步在调用方拿不到收藏/笔记计数时为 false（如实不点亮） */
  done: boolean;
}

export interface OnboardingInput {
  /** 已同步到至少一门课程（bundles / report.courses 非空） */
  hasCourse: boolean;
  /** 已有有效观看记录（report.totalSec > 0；站内 + 站外口径同 buildReport） */
  hasWatch: boolean;
  /**
   * 已有收藏或笔记。调用方拿不到该计数时传 undefined：步骤照常展示（引导
   * 语义完整），但如实不点亮——不猜、不默认完成。
   */
  hasLibrary?: boolean;
}

/** 三步文案单点定义（三处入口同源，改文案只改这里） */
const STEP_DEFS: Array<{ key: OnboardingStep['key']; label: string; hint: string }> = [
  { key: 'sync', label: '同步课程', hint: '在智慧课堂打开课程列表页，课程与课次会自动同步到本机。' },
  { key: 'watch', label: '看一节课', hint: '打开任意一节播放课，观看满 10 分钟即计入打卡与统计。' },
  { key: 'collect', label: '沉淀知识', hint: '看课时收藏时间点、记一条笔记，知识库会自动归档。' },
];

/** 派生三步完成态：输入脏值按未完成处理（不抛错），全done 仅在三步齐时为 true */
export function buildOnboardingSteps(input: OnboardingInput): { steps: OnboardingStep[]; doneCount: number; allDone: boolean } {
  const record = (input ?? {}) as Partial<Record<keyof OnboardingInput, unknown>>;
  const flags: Record<OnboardingStep['key'], boolean> = {
    sync: record.hasCourse === true,
    watch: record.hasWatch === true,
    collect: record.hasLibrary === true,
  };
  const steps = STEP_DEFS.map((def) => ({ ...def, done: flags[def.key] }));
  const doneCount = steps.filter((step) => step.done).length;
  return { steps, doneCount, allDone: doneCount === steps.length };
}

/** 引导卡标题/副题单点文案（三处入口同源） */
export const ONBOARDING_TITLE = '三步上手';
export const ONBOARDING_SUBTITLE = '数据只保存在本机，从任意一步开始都可以。';
