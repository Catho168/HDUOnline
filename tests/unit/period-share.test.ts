/**
 * 周报分享摘要 buildPeriodShareText（core/stats/periodExport.ts，第 235 轮巡检；
 * 第 237 轮加精简 / 完整档；第 238 轮排版美化：标题 📊 + 段间空行分组）单测。
 *
 * 覆盖：
 *  1. 全项输出：周期名 / 站内学习 / 活跃天数 / 连续学习 / 周目标（已达成）/ 站外视频 /
 *     计划完看，标题段 + 指标段两段空行分组、纯文本（非 Markdown 表格）；
 *  2. 缺项省略：无 extras（goalSec / streakDays 缺）、plan 无排期、站外为 0 时对应行不出现；
 *  3. 零学习周：0 秒 / 0 天仍输出结构行（不抛错、不产生怪文案）；
 *  4. 周目标两种文案：达成「已达成（目标 X）」/ 未达成「差 X（目标 Y）」（分钟级差值）；
 *  5. 月报：周期名「本月 YYYY年M月」，周目标行不输出（月报与「每周」目标不同域）；
 *  6. 边界：空桶列表返回空串；负数秒数钳到 0；
 *  7. 完整档（第 237 轮；第 238 轮段落化）：concise 同输入两种调用一致；
 *     分日明细段（升序 / 0 学习省略 / 桶外忽略 / <1 分钟按 1 计 / 31 行上限）；
 *     完看课程段（去重 / 截断 / 「等 N 个」/ 缺省省略）；月报同款追加；
 *  8. 第 238 轮排版快照：整段字符串断言（标题 📊 仅标题行 + 段间空行 + 行集不变）。
 */
import { describe, expect, it } from 'vitest';

import type { PeriodBucket, PeriodReport } from '@/core/stats/period';
import { buildPeriodShareText } from '@/core/stats/periodExport';

/** 周桶构造器（默认本周站内 2h30m、活跃 4 天、无站外、无计划） */
function weekBucket(over: Partial<PeriodBucket> = {}): PeriodBucket {
  return {
    key: '2026-11-16',
    label: '11.16–11.22',
    chartLabel: '11-16',
    kind: 'week',
    startDay: '2026-11-16',
    endDay: '2026-11-22',
    startTs: 0,
    endTs: 0,
    internalSec: 9000,
    externalSec: 0,
    activeDays: 4,
    flowCount: 6,
    plan: null,
    ...over,
  };
}

function weekReport(buckets: PeriodBucket[]): PeriodReport {
  return { kind: 'week', count: buckets.length, todayKey: '2026-11-21', buckets, totalInternalSec: 0, totalExternalSec: 0, generatedAt: 0 };
}

const FULL_BUCKET = weekBucket({
  externalSec: 3600,
  plan: { total: 5, finished: 3, touched: 2, ratio: 0.6 },
});

describe('buildPeriodShareText 行清单与缺项省略（第 235 轮；第 238 轮段落化）', () => {
  it('全项输出：标题段 + 指标段空行分组、行序固定、纯文本无 Markdown 表格', () => {
    const text = buildPeriodShareText(weekReport([FULL_BUCKET]), { goalSec: 7200, streakDays: 3 });
    expect(text.split('\n')).toEqual([
      '📊 本周 11.16–11.22',
      '',
      '站内学习：2 小时 30 分',
      '活跃天数：4 天',
      '连续学习：3 天',
      '周目标：已达成（目标 2 小时）',
      '站外视频：1 小时',
      '计划完看：3/5 个',
    ]);
    expect(text).not.toMatch(/\||#/); // 非 Markdown 表格 / 无标题井号
    // 第 238 轮排版：段间恰好一个空行分组（标题段 / 指标段）
    expect(text.split('\n\n')).toHaveLength(2);
  });

  it('缺项省略：无 extras、无计划、无站外 → 标题段 + 站内 + 活跃天数指标段', () => {
    const text = buildPeriodShareText(weekReport([weekBucket()]));
    expect(text.split('\n')).toEqual(['📊 本周 11.16–11.22', '', '站内学习：2 小时 30 分', '活跃天数：4 天']);
  });

  it('零学习周：0 秒 / 0 天结构行保留，不抛错', () => {
    const text = buildPeriodShareText(weekReport([weekBucket({ internalSec: 0, activeDays: 0, flowCount: 0 })]));
    expect(text.split('\n')).toEqual(['📊 本周 11.16–11.22', '', '站内学习：0 秒', '活跃天数：0 天']);
  });
});

describe('buildPeriodShareText 周目标与周期口径（第 235 轮）', () => {
  it('未达成文案：差值分钟级显示「差 X 分钟（目标 Y）」', () => {
    const text = buildPeriodShareText(weekReport([FULL_BUCKET]), { goalSec: 9300 });
    expect(text).toContain('周目标：差 5 分钟（目标 2 小时 35 分）');
  });

  it('goalSec ≤ 0 / 非有限不输出周目标行', () => {
    expect(buildPeriodShareText(weekReport([FULL_BUCKET]), { goalSec: 0 })).not.toContain('周目标');
    expect(buildPeriodShareText(weekReport([FULL_BUCKET]), { goalSec: Number.NaN })).not.toContain('周目标');
  });

  it('月报：周期名「本月 YYYY年M月」，周目标行不输出（不同域），站外照常', () => {
    const monthBucket = weekBucket({ kind: 'month', key: '2026-11', label: '2026年11月', internalSec: 36000, externalSec: 600 });
    const text = buildPeriodShareText({ ...weekReport([monthBucket]), kind: 'month' }, { goalSec: 7200, streakDays: 3 });
    expect(text.split('\n')).toEqual([
      '📊 本月 2026年11月',
      '',
      '站内学习：10 小时',
      '活跃天数：4 天',
      '连续学习：3 天',
      '站外视频：10 分钟',
    ]);
  });

  it('空桶列表返回空串；负数秒数钳到 0', () => {
    expect(buildPeriodShareText(weekReport([]))).toBe('');
    const text = buildPeriodShareText(weekReport([weekBucket({ internalSec: -50 })]));
    expect(text).toContain('站内学习：0 秒');
  });
});

// ───────────────────────── 完整档（第 237 轮；第 238 轮段落化） ─────────────────────────

/** 桶范围（2026-11-16 ~ 11-22）内的逐日站内秒数桩：16/18/20 有学习，其余 0 学习日 */
const FULL_DAYS = [
  { date: '2026-11-14', sec: 600 }, // 桶范围外 → 忽略
  { date: '2026-11-16', sec: 2700 },
  { date: '2026-11-17', sec: 0 }, // 0 学习日 → 省略
  { date: '2026-11-18', sec: 3600 },
  { date: '2026-11-20', sec: 30 },
];

describe('buildPeriodShareText 完整档（第 237 轮；第 238 轮段落化）', () => {
  it('concise 输出稳定：同一输入，不传 options 与显式 concise 输出一致（第 238 轮排版）', () => {
    const extras = { goalSec: 7200, streakDays: 3, days: FULL_DAYS, finishedCourses: ['高等数学'] };
    const concise = buildPeriodShareText(weekReport([FULL_BUCKET]), extras, { detail: 'concise' });
    expect(buildPeriodShareText(weekReport([FULL_BUCKET]), extras)).toBe(concise);
    // 且与第 238 轮锁定行清单逐字节一致（extras 中的 full 档数据不影响精简输出）
    expect(concise.split('\n')).toEqual([
      '📊 本周 11.16–11.22',
      '',
      '站内学习：2 小时 30 分',
      '活跃天数：4 天',
      '连续学习：3 天',
      '周目标：已达成（目标 2 小时）',
      '站外视频：1 小时',
      '计划完看：3/5 个',
    ]);
  });

  it('full 档：标题/指标/分日明细三段空行分组、升序行序、0 学习日省略、桶外忽略、<1 分钟按 1 分钟计', () => {
    const text = buildPeriodShareText(weekReport([FULL_BUCKET]), { days: FULL_DAYS }, { detail: 'full' });
    expect(text.split('\n')).toEqual([
      '📊 本周 11.16–11.22',
      '',
      '站内学习：2 小时 30 分',
      '活跃天数：4 天',
      '站外视频：1 小时',
      '计划完看：3/5 个',
      '',
      '分日明细：',
      '11-16 45 分钟',
      '11-18 60 分钟',
      '11-20 1 分钟',
    ]);
    // 第 238 轮排版快照（整段字符串断言锁定空白分组）
    expect(text).toBe(
      '📊 本周 11.16–11.22\n' +
        '\n' +
        '站内学习：2 小时 30 分\n' +
        '活跃天数：4 天\n' +
        '站外视频：1 小时\n' +
        '计划完看：3/5 个\n' +
        '\n' +
        '分日明细：\n' +
        '11-16 45 分钟\n' +
        '11-18 60 分钟\n' +
        '11-20 1 分钟',
    );
  });

  it('full 档：完看课程段（去重 + 长标题截断 20 字 + 超过 5 个附「等 N 个」）', () => {
    const longTitle = '线性代数' + '数'.repeat(20); // 24 字符（线性代数 + 20 个「数」）
    const titles = [
      longTitle,
      longTitle, // 重复 → 去重
      '考研英语',
      'B', 'C', 'D', 'E', 'F',
    ];
    const text = buildPeriodShareText(weekReport([FULL_BUCKET]), { finishedCourses: titles }, { detail: 'full' });
    const finishedLine = text.split('\n').find((line) => line.startsWith('完看课程'));
    // 截断：前 20 字 = 「线性代数」+ 16 个「数」，附「…」；超出 5 个附「等 7 个」（去重后 7）
    expect(finishedLine).toBe(`完看课程（累计 7）：${'线性代数'}${'数'.repeat(16)}…、考研英语、B、C、D 等 7 个`);
    // 精简档不输出该段
    expect(buildPeriodShareText(weekReport([FULL_BUCKET]), { finishedCourses: titles })).not.toContain('完看课程');
  });

  it('full 档：分日明细与完看课程各自成段（中间空行），行集不变', () => {
    const text = buildPeriodShareText(
      weekReport([FULL_BUCKET]),
      { days: FULL_DAYS, finishedCourses: ['高等数学', '大学英语'] },
      { detail: 'full' },
    );
    const paragraphs = text.split('\n\n');
    expect(paragraphs).toHaveLength(4); // 标题 / 指标 / 分日明细 / 完看课程
    expect(paragraphs[2]?.split('\n')[0]).toBe('分日明细：');
    expect(paragraphs[3]).toBe('完看课程（累计 2）：高等数学、大学英语');
  });

  it('full 档：31 行上限——桶范围内 33 天有学习时仅保留最新 31 天（跨月桶场景）', () => {
    // 月桶最多 31 天恰好卡在上限，不足以证明「裁行」，改用跨月桶范围放 33 个有效日
    const longBucket = weekBucket({ startDay: '2026-01-01', endDay: '2026-02-02', label: '01.01–02.02' });
    const janDays = Array.from({ length: 31 }, (_, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, sec: 60 * (i + 1) }));
    const febDays = [
      { date: '2026-02-01', sec: 60 * 32 },
      { date: '2026-02-02', sec: 60 * 33 },
    ];
    const text = buildPeriodShareText(weekReport([longBucket]), { days: [...janDays, ...febDays] }, { detail: 'full' });
    const dayLines = text.split('\n').filter((line) => /^\d{2}-\d{2} \d+ 分钟$/.test(line));
    expect(dayLines).toHaveLength(31);
    expect(dayLines[0]).toBe('01-03 3 分钟'); // 01-01 / 01-02 被 31 行上限裁掉，保留最新 31 天
    expect(dayLines[30]).toBe('02-02 33 分钟'); // 升序尾部 = 最新一天
  });

  it('full 档：days / finishedCourses 缺省或全脏时两段整段省略（不输出空头行、不残留空行）', () => {
    const text = buildPeriodShareText(weekReport([FULL_BUCKET]), {}, { detail: 'full' });
    expect(text.split('\n')).toEqual([
      '📊 本周 11.16–11.22',
      '',
      '站内学习：2 小时 30 分',
      '活跃天数：4 天',
      '站外视频：1 小时',
      '计划完看：3/5 个',
    ]);
    const dirty = buildPeriodShareText(
      weekReport([FULL_BUCKET]),
      { days: [{ date: '2026-13-99', sec: 100 }, { date: '2026-11-18', sec: -5 }], finishedCourses: ['', '   ', 123 as unknown as string] },
      { detail: 'full' },
    );
    expect(dirty).not.toContain('分日明细');
    expect(dirty).not.toContain('完看课程');
    // 全脏时不产生尾随空段（段落制只拼非空段）
    expect(dirty.endsWith('\n\n')).toBe(false);
  });

  it('full 档：月报同样追加分日明细（桶范围=自然月）', () => {
    const monthBucket = weekBucket({ kind: 'month', key: '2026-11', label: '2026年11月', startDay: '2026-11-01', endDay: '2026-11-30', internalSec: 36000 });
    const text = buildPeriodShareText(
      { ...weekReport([monthBucket]), kind: 'month' },
      { days: [{ date: '2026-11-05', sec: 1200 }, { date: '2026-10-31', sec: 600 }] },
      { detail: 'full' },
    );
    expect(text.split('\n')).toEqual(['📊 本月 2026年11月', '', '站内学习：10 小时', '活跃天数：4 天', '', '分日明细：', '11-05 20 分钟']);
  });
});

// ───────────────────────── 第 238 轮排版快照 ─────────────────────────

describe('buildPeriodShareText 第 238 轮排版快照（整段字符串断言）', () => {
  it('快照：concise 全项（标题 📊 + 两段空行分组 + 全角冒号键值行）', () => {
    const text = buildPeriodShareText(weekReport([FULL_BUCKET]), { goalSec: 7200, streakDays: 3 });
    expect(text).toBe(
      '📊 本周 11.16–11.22\n' +
        '\n' +
        '站内学习：2 小时 30 分\n' +
        '活跃天数：4 天\n' +
        '连续学习：3 天\n' +
        '周目标：已达成（目标 2 小时）\n' +
        '站外视频：1 小时\n' +
        '计划完看：3/5 个',
    );
  });

  it('快照：月报 concise（周目标行不输出的月度形态）', () => {
    const monthBucket = weekBucket({ kind: 'month', key: '2026-11', label: '2026年11月', internalSec: 36000, externalSec: 600 });
    const text = buildPeriodShareText({ ...weekReport([monthBucket]), kind: 'month' }, { goalSec: 7200, streakDays: 3 });
    expect(text).toBe('📊 本月 2026年11月\n\n站内学习：10 小时\n活跃天数：4 天\n连续学习：3 天\n站外视频：10 分钟');
  });
});
