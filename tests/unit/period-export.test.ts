/**
 * 周报/月报导出 Markdown 与环比文案单测（第 80 轮巡检）。
 * buildPeriodReportMarkdown：buildPeriodReport 聚合结果 → Markdown（标题/汇总/表格/口径）；
 * formatPeriodDelta：周期环比文案（新增/持平/带符号百分比/不可比 null）。
 */
import { describe, expect, it } from 'vitest';
import { buildPeriodReport, formatPeriodDelta, type PeriodKind } from '@/core/stats/period';
import { buildPeriodReportMarkdown } from '@/core/stats/periodExport';
import type { WatchRecordEntity } from '@/core/shared/types';

const NOW = new Date(2026, 10, 18, 12, 0, 0, 0).getTime();

function rec(date: string, durationSec: number, valid = true): WatchRecordEntity {
  return { date, durationSec, valid, courId: 1, teclId: 1 } as unknown as WatchRecordEntity;
}

function makeReport(kind: PeriodKind) {
  return buildPeriodReport({
    kind,
    count: 2,
    now: NOW,
    records: [
      rec('2026-11-17', 3600),
      rec('2026-11-16', 1800),
      rec('2026-11-10', 600),
      rec('2026-11-09', 1200),
    ],
  });
}

describe('formatPeriodDelta（周期环比文案）', () => {
  it('带符号百分比；|Δ|<0.5% 记持平', () => {
    expect(formatPeriodDelta(200, 100)).toBe('+100%');
    expect(formatPeriodDelta(100, 200)).toBe('-50%');
    expect(formatPeriodDelta(101, 100)).toBe('+1%');
    expect(formatPeriodDelta(100, 100)).toBe('持平');
    expect(formatPeriodDelta(100.4, 100)).toBe('持平');
  });

  it('上周期为 0：当前 >0 记「新增」，两者皆 0 返回 null（不展示）', () => {
    expect(formatPeriodDelta(50, 0)).toBe('新增');
    expect(formatPeriodDelta(0, 0)).toBeNull();
    expect(formatPeriodDelta(0, 100)).toBe('-100%');
  });

  it('非有限值按 0 处理', () => {
    expect(formatPeriodDelta(Number.NaN, 100)).toBe('-100%');
    expect(formatPeriodDelta(50, Number.NaN)).toBe('新增');
  });
});

describe('buildPeriodReportMarkdown（周报/月报导出）', () => {
  it('周报：标题/头部注释行/生成时间/汇总/表格行/口径附注齐全', () => {
    const md = buildPeriodReportMarkdown(makeReport('week'));
    expect(md).toContain('# 学习周报（近 2 周）');
    // 头部可追溯注释行（第 248 轮巡检）：生成时间 + 数据窗口，HTML comment 紧跟标题
    expect(md).toMatch(/^# 学习周报（近 2 周）\n\n<!-- HDUOnline 生成于 .+ · 数据窗口 2026-11-09 ~ 2026-11-22（近 2 周） -->\n/);
    expect(md).toContain('- 生成时间：');
    expect(md).toContain('- 窗口内站内有效学习：');
    expect(md).toContain('| 周期 | 站内 | 站外 | 活跃天数 | 流水次数 | 附加指标 |');
    // 两个周期桶各一行，标签为周区间
    expect(md).toContain('11-09–11-15');
    expect(md).toContain('11-16–11-22');
    expect(md).toContain('> 口径：站内为「播放中 + 页面前台可见 + 非挂机」的墙钟时间');
  });

  it('月报：标题与周期标签切换为月口径', () => {
    const md = buildPeriodReportMarkdown(makeReport('month'));
    expect(md).toContain('# 学习月报（近 2 个月）');
    expect(md).toContain('2026年10月');
    expect(md).toContain('2026年11月');
  });

  it('数值与流水归桶一致：表格里的站内时长与聚合结果同源', () => {
    const report = makeReport('week');
    const md = buildPeriodReportMarkdown(report);
    const current = report.buckets[report.buckets.length - 1]!;
    // 当前周站内 3600+1800=5400s → formatDuration = 「1 小时 30 分」
    expect(current.internalSec).toBe(5400);
    expect(md).toContain('1 小时 30 分');
  });
});

describe('buildPeriodReportMarkdown 成就附录（第 128 轮巡检）', () => {
  it('传入徽章时追加附录段（解锁/未解锁分列，脏行跳过）；不传则无该段', () => {
    const report = makeReport('week');
    expect(buildPeriodReportMarkdown(report)).not.toContain('成就附录');
    const md = buildPeriodReportMarkdown(report, [
      { name: '恒心毅力', desc: '连续学习满 7 天', unlocked: true, value: 7, threshold: 7, unit: '天' },
      { name: '小时级选手', desc: '累计有效学习满 1 小时', unlocked: false, value: 30, threshold: 60, unit: '分钟' },
      { tag: '脏行' } as never,
    ]);
    expect(md).toContain('## 成就附录（1/2 已解锁）');
    expect(md).toContain('🏅 恒心毅力：连续学习满 7 天（7/7 天）');
    expect(md).toContain('🔒 小时级选手：累计有效学习满 1 小时（30/60 分钟）');
    expect(md).not.toContain('脏行');
  });
});
