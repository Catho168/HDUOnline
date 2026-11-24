/**
 * 周报通知文案纯函数单测（core/plan/notify.ts buildWeeklyReportMessage，第 242 轮巡检）：
 *  - 两行结构：主行三指标（上周学习 X 小时 · 打卡 Y 天 · 连续 Z 天）+ 亮点行；
 *  - 周目标达成态三选一优先级：连续 ≥2 周 ✅ > 上周达成 🎯 > 本周进度；
 *  - 黄金时段与标签健康亮点拼接；
 *  - 缺数据 / 脏数据逐项省略；全缺 → 单行主文案；
 *  - 超长截断：从行尾整段丢亮点（超长段不截半句），主行永不丢；
 *  - 0 周 / 未设目标等边界。
 */

import { describe, expect, it } from 'vitest';
import { buildWeeklyReportMessage, WEEKLY_REPORT_MESSAGE_MAX_LEN } from '@/core/plan/notify';

describe('buildWeeklyReportMessage（周报通知文案，第 242 轮）', () => {
  it('无亮点：单行主文案（间隔点句式）', () => {
    const out = buildWeeklyReportMessage(5 * 3600, 3, 2, null);
    expect(out.title).toBe('上周学习周报');
    expect(out.message).toBe('上周学习 5.0 小时 · 打卡 3 天 · 连续 2 天');
    expect(out.message).not.toContain('\n');
  });

  it('全亮点：两行结构（周目标连续达成 + 黄金时段 + 标签健康）', () => {
    const out = buildWeeklyReportMessage(6 * 3600, 5, 4, {
      goalAchieved: true,
      goalStreakWeeks: 3,
      goldenSlot: { label: '晚间', hoursLabel: '18–23 点' },
      staleTagCount: 2,
    });
    const lines = out.message.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('上周学习 6.0 小时 · 打卡 5 天 · 连续 4 天');
    expect(lines[1]).toBe('✅ 连续达成 3 周目标，黄金时段：晚间（18–23 点），2 个标签近 4 周零完成');
  });

  it('周目标态三选一：连续 <2 但上周达成 → 🎯；未达成 → 本周进度（1–99 才出）', () => {
    const achieved = buildWeeklyReportMessage(3600, 1, 1, { goalAchieved: true, goalStreakWeeks: 1 });
    expect(achieved.message.split('\n')[1]).toBe('🎯 上周达成周目标');
    const progress = buildWeeklyReportMessage(0, 0, 0, { goalAchieved: false, weekGoalPct: 42 });
    expect(progress.message.split('\n')[1]).toBe('本周目标已过 42%');
    // pct 0 / 100 越界不显示（100 由达成分支接管，0 无激励意义）
    const pctZero = buildWeeklyReportMessage(0, 0, 0, { goalAchieved: false, weekGoalPct: 0 });
    expect(pctZero.message.split('\n')).toHaveLength(1);
    const pctHundred = buildWeeklyReportMessage(0, 0, 0, { goalAchieved: false, weekGoalPct: 100 });
    expect(pctHundred.message.split('\n')).toHaveLength(1);
  });

  it('缺数据逐项省略：全脏输入 → 单行 0 值主文案；goldenSlot 脏 label 省略', () => {
    const dirty = buildWeeklyReportMessage(Number.NaN, undefined, null, {
      goldenSlot: { label: '  ', hoursLabel: '' },
      staleTagCount: 0,
    });
    expect(dirty.message).toBe('上周学习 0.0 小时 · 打卡 0 天 · 连续 0 天');
    const noHours = buildWeeklyReportMessage(3600, 2, 1, { goldenSlot: { label: '晚间', hoursLabel: '' } });
    expect(noHours.message).not.toContain('黄金时段');
  });

  it('超长截断：总长 ≤ 上限；从行尾整段丢亮点；主行永不丢', () => {
    const line1 = '上周学习 6.0 小时 · 打卡 5 天 · 连续 4 天';
    // 三亮点均短：不截断
    const full = buildWeeklyReportMessage(6 * 3600, 5, 4, {
      goalAchieved: true,
      goalStreakWeeks: 2,
      goldenSlot: { label: '晚间', hoursLabel: '18–23 点' },
      staleTagCount: 1,
    });
    expect(full.message.length).toBeLessThanOrEqual(WEEKLY_REPORT_MESSAGE_MAX_LEN);
    expect(full.message.split('\n')[0]).toBe(line1);
    // 单段超长（超长 golden label）：整段丢弃不截半句，退回单行主文案
    const huge = buildWeeklyReportMessage(6 * 3600, 5, 4, {
      goldenSlot: { label: '晚'.repeat(300), hoursLabel: '18–23 点' },
    });
    expect(huge.message).toBe(line1);
    // 两段亮点 + 超长第二段：第二段整体丢弃（从行尾逐段丢），保留第一段
    const dropLast = buildWeeklyReportMessage(6 * 3600, 5, 4, {
      goalAchieved: true,
      goalStreakWeeks: 2,
      goldenSlot: { label: '晚'.repeat(300), hoursLabel: '18–23 点' },
    });
    expect(dropLast.message).toContain('✅ 连续达成 2 周目标');
    expect(dropLast.message).not.toContain('黄金时段');
    expect(dropLast.message.length).toBeLessThanOrEqual(WEEKLY_REPORT_MESSAGE_MAX_LEN);
  });

  it('边界：0 周（0 秒 / 0 天）与 streak=1/2 的分档', () => {
    const zero = buildWeeklyReportMessage(0, 0, 0, { goalAchieved: true, goalStreakWeeks: 0 });
    expect(zero.message.split('\n')[0]).toBe('上周学习 0.0 小时 · 打卡 0 天 · 连续 0 天');
    // streak 0 → 落 goalAchieved 分支（streak>=2 才走连续）
    expect(zero.message.split('\n')[1]).toBe('🎯 上周达成周目标');
    const streak1 = buildWeeklyReportMessage(3600, 1, 1, { goalAchieved: true, goalStreakWeeks: 1 });
    expect(streak1.message.split('\n')[1]).toBe('🎯 上周达成周目标');
    const streak2 = buildWeeklyReportMessage(3600, 1, 1, { goalAchieved: true, goalStreakWeeks: 2 });
    expect(streak2.message.split('\n')[1]).toBe('✅ 连续达成 2 周目标');
  });
});
