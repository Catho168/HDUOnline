/**
 * 周报三方口径一致性（第 248 轮巡检，统计域收官/一致性视角）。
 *
 * 周报数字有三个出口，同一周数据下必须一致（同一 PeriodBucket 直出）：
 *  1. 卡面展示：PeriodReportCard 数字卡（小时 toFixed(1)）+ 逐周期明细行
 *     （formatDuration 直读 bucket）；
 *  2. 复制摘要：buildPeriodShareText（concise 档，buckets 最后一项）；
 *  3. 下载周报：buildPeriodReportMarkdown（全部周期桶表格 + 头部可追溯注释行）。
 *
 * 本文件以**同一 buildPeriodReport 聚合结果**为唯一数据源构造三产物，逐字段断言
 * 关键数字（站内/站外/活跃天数/流水次数/计划完看）相等——锁定「三方同源」不被
 * 后续演进破坏；头部注释行（生成时间 + 数据窗口）一并快照锁定。
 *
 * 覆盖：
 *  1. 周报（jsdom 渲染卡面 + 纯函数摘要/md）：站内时长同一 formatDuration 串、
 *     活跃天数同一「N 天」、流水次数、外部时长同一串；卡面数字卡小时值与桶秒数
 *     换算一致（(sec/3600).toFixed(1)）；
 *  2. .md 头部注释行：生成时间 + 数据窗口（首桶开始日 ~ 末桶结束日）；
 *  3. 月报：摘要与 md 同源一致（周目标行不输出的月度形态）。
 */
// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({ callOp: vi.fn() }));

import { callOp } from '@/core/shared/client';
import { PeriodReportCard } from '@/entrypoints/content/ui/LearningCenter';
import { formatDuration } from '@/core/shared/utils';
import { buildPeriodReport, type PeriodReport } from '@/core/stats/period';
import { buildPeriodReportMarkdown, buildPeriodShareText } from '@/core/stats/periodExport';
import type { ExternalWatchEntity, WatchRecordEntity } from '@/core/shared/types';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;

/** 锚点：2026-11-18（周三）本地正午——当前周桶 = 11-16 ~ 11-22 */
const NOW = new Date(2026, 10, 18, 12, 0, 0, 0).getTime();

function rec(date: string, durationSec: number, valid = true): WatchRecordEntity {
  return { date, durationSec, valid, courId: 1, teclId: 1 } as unknown as WatchRecordEntity;
}

function ext(date: string, seconds: number, bvid = 'BV1ThreeWay'): ExternalWatchEntity {
  return { id: `ext-${date}-${bvid}`, date, bvid, seconds } as ExternalWatchEntity;
}

/** 周报固件：当前周站内 9000s（2.5h）站外 1800s（30 分）活跃 2 天流水 2 条；上周 600s */
function weekReport(): PeriodReport {
  return buildPeriodReport({
    kind: 'week',
    count: 2,
    now: NOW,
    records: [rec('2026-11-16', 5400), rec('2026-11-17', 3600), rec('2026-11-10', 600)],
    externalRecords: [ext('2026-11-17', 1800)],
  });
}

/** 月报固件：本月站内 36000s 站外 600s */
function monthReport(): PeriodReport {
  return buildPeriodReport({
    kind: 'month',
    count: 2,
    now: NOW,
    records: [rec('2026-11-05', 36000), rec('2026-10-20', 1200)],
    externalRecords: [ext('2026-11-05', 600)],
  });
}

/** 卡面取数桩：stats.period 返回固件，成就/分享辅助四路空数据 + streakDays 3 */
function stubCardOps(report: PeriodReport): void {
  callOpMock.mockImplementation(async (op: string) => {
    if (op === 'stats.period') return report;
    if (op === 'fav.list') return [];
    if (op === 'note.listAll') return [];
    if (op === 'review.list') return [];
    if (op === 'stats.report') return { days: [], streakDays: 3, totalSec: 0, externalSeconds: 0 };
    throw new Error(`unexpected op: ${op}`);
  });
}

let host: HTMLElement;
let root: Root;

async function renderCard(report: PeriodReport): Promise<void> {
  stubCardOps(report);
  await act(async () => {
    root.render(createElement(PeriodReportCard));
  });
  for (let i = 0; i < 3; i += 1) await act(async () => {});
}

/** 数字卡值（.hdu-stat 结构寻址，照 stats-period-summary-ui.test.ts） */
function statValue(label: string): string {
  const card = Array.from(host.querySelectorAll('.hdu-stat')).find((el) =>
    el.querySelector('.hdu-stat-top')?.textContent?.includes(label),
  );
  const value = card?.querySelector('.hdu-stat-value')?.textContent;
  if (value == null) throw new Error(`stat card not found: ${label}`);
  return value;
}

/** .md 当前周期表格行（按桶标签寻址） */
function mdRowOf(md: string, label: string): string {
  const row = md.split('\n').find((line) => line.startsWith(`| ${label} `));
  if (!row) throw new Error(`md row not found: ${label}`);
  return row;
}

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  callOpMock.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
});

describe('周报三方口径一致性（卡面 / 复制摘要 / 下载 .md）', () => {
  it('站内/站外/活跃天数/流水：三产物同一 PeriodBucket 直出，关键数字逐项相等', async () => {
    const report = weekReport();
    const current = report.buckets[report.buckets.length - 1]!;
    expect(current.internalSec).toBe(9000);
    expect(current.externalSec).toBe(1800);
    expect(current.activeDays).toBe(2);
    expect(current.flowCount).toBe(2);

    const share = buildPeriodShareText(report, { streakDays: 3 });
    const md = buildPeriodReportMarkdown(report);
    await renderCard(report);

    // ── 站内时长：同一 formatDuration 串在三产物中出现 ──
    const internalStr = formatDuration(current.internalSec); // '2 小时 30 分'
    expect(share).toContain(`站内学习：${internalStr}`);
    expect(mdRowOf(md, current.label)).toContain(`| ${internalStr} |`);
    expect(host.textContent).toContain(`站内 ${internalStr}`); // 卡面逐周期明细行
    // 卡面数字卡小时值与同一桶秒数换算一致（PeriodReportCard 的 (sec/3600).toFixed(1) 口径）
    expect(statValue('站内学习')).toBe(`${(current.internalSec / 3600).toFixed(1)}小时`);

    // ── 站外时长（独立口径）：同一串 ──
    const externalStr = formatDuration(current.externalSec); // '30 分'
    expect(share).toContain(`站外视频：${externalStr}`);
    expect(mdRowOf(md, current.label)).toContain(`| ${externalStr} |`);
    expect(host.textContent).toContain(`站外 ${externalStr}`);
    expect(statValue('站外视频')).toBe(`${(current.externalSec / 3600).toFixed(1)}小时`);

    // ── 活跃天数：同一「N 天」 ──
    expect(share).toContain(`活跃天数：${current.activeDays} 天`);
    expect(mdRowOf(md, current.label)).toContain(`| ${current.activeDays} 天 |`);
    expect(host.textContent).toContain(`活跃 ${current.activeDays} 天`);
    expect(statValue('活跃天数')).toBe(`${current.activeDays}天`);

    // ── 流水次数：摘要不输出该行（第 235 轮行集约定），md 与卡面明细一致 ──
    expect(mdRowOf(md, current.label)).toContain(`| ${current.flowCount} 次 |`);
    expect(host.textContent).toContain(`流水 ${current.flowCount} 次`);
  });

  it('计划完成度（周报附加指标）：卡面 foot / 明细徽标 / 摘要 / .md 同一 finished/total', async () => {
    // 收藏 watchedRatio ≥ 0.95 算完看；计划 2 个 bvid 排期到本周，1 个已完看
    const report = buildPeriodReport({
      kind: 'week',
      count: 1,
      now: NOW,
      records: [rec('2026-11-17', 1800)],
      plans: [
        {
          id: 'plan-x',
          label: '收官计划',
          perDay: 1,
          bvids: ['BV1Done', 'BV2Todo'],
          startDate: '2026-11-16',
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      favorites: [
        {
          id: 'fav-done',
          type: 'video',
          refId: 'BV1Done',
          snapshot: { title: '完看课', content: '' },
          folderId: null,
          tags: [],
          pinned: false,
          favoritedAt: 0,
          updatedAt: 0,
          metadata: { platform: 'bilibili', bvid: 'BV1Done', watchedRatio: 0.98 },
        },
        {
          id: 'fav-todo',
          type: 'video',
          refId: 'BV2Todo',
          snapshot: { title: '未完课', content: '' },
          folderId: null,
          tags: [],
          pinned: false,
          favoritedAt: 0,
          updatedAt: 0,
          metadata: { platform: 'bilibili', bvid: 'BV2Todo', watchedRatio: 0.4 },
        },
      ],
    } as Parameters<typeof buildPeriodReport>[0]);
    const current = report.buckets[report.buckets.length - 1]!;
    expect(current.plan).toMatchObject({ total: 2, finished: 1, ratio: 0.5 });

    const share = buildPeriodShareText(report);
    const md = buildPeriodReportMarkdown(report);
    await renderCard(report);

    expect(share).toContain(`计划完看：${current.plan!.finished}/${current.plan!.total} 个`);
    expect(mdRowOf(md, current.label)).toContain(
      `完看 ${current.plan!.finished}/${current.plan!.total}（${Math.round(current.plan!.ratio * 100)}%）`,
    );
    // 卡面：数字卡完成度百分比 + foot 完看/计划 + 明细行徽标，同一对数字
    expect(statValue('计划完成度')).toBe(`${Math.round(current.plan!.ratio * 100)}%`);
    expect(host.textContent).toContain(`完看 ${current.plan!.finished} / 计划 ${current.plan!.total} 个`);
    expect(host.textContent).toContain(`${current.plan!.finished}/${current.plan!.total} 完看`);
  });

  it('.md 头部注释行快照：生成时间 + 数据窗口（HTML comment，Markdown 惯例）', () => {
    const md = buildPeriodReportMarkdown(weekReport());
    const comment = md.split('\n')[2]!;
    expect(comment).toMatch(/^<!-- HDUOnline 生成于 .+ · 数据窗口 2026-11-09 ~ 2026-11-22（近 2 周） -->$/);
    // 注释行在标题与正文 bullet 之间，且正文「- 生成时间：」bullet 并存（人读/机读双通道）
    expect(md.split('\n')[0]).toBe('# 学习周报（近 2 周）');
    expect(md).toContain('- 生成时间：');
  });
});

describe('月报三方口径一致性（周目标行不输出的月度形态）', () => {
  it('摘要与 .md 同源：站内/站外/活跃天数逐项相等，.md 附加保持率列', async () => {
    const report = monthReport();
    const current = report.buckets[report.buckets.length - 1]!;
    expect(current.internalSec).toBe(36000);

    const share = buildPeriodShareText(report);
    const md = buildPeriodReportMarkdown(report);
    await renderCard(report);

    const internalStr = formatDuration(current.internalSec); // '10 小时'
    expect(share).toContain(`站内学习：${internalStr}`);
    expect(mdRowOf(md, current.label)).toContain(`| ${internalStr} |`);
    expect(host.textContent).toContain(`站内 ${internalStr}`);
    expect(statValue('站内学习')).toBe(`${(current.internalSec / 3600).toFixed(1)}小时`);

    const externalStr = formatDuration(current.externalSec); // '10 分'
    expect(share).toContain(`站外视频：${externalStr}`);
    expect(mdRowOf(md, current.label)).toContain(`| ${externalStr} |`);
    expect(statValue('活跃天数')).toBe(`${current.activeDays}天`);
    // 月报附加指标 = 复习保持率（无复习数据 → md 列为「—」，摘要无该行）
    expect(mdRowOf(md, current.label)).toContain('| — |');
    expect(share).not.toContain('保持率');
    expect(statValue('复习保持率')).toBe('—');
  });
});
