/**
 * 学习周报 / 月报卡（第 34 轮巡检自 LearningCenter.tsx 抽出为共享组件）：
 * HDU 学习中心统计页与 B 站学习中心面板统计页签共用同一实现。
 *
 *  - 数据经 stats.period op 现取（args 仅 { kind, count }，不含任何 HDU 会话参数，
 *    天然双端可用；聚合口径见 core/stats/period 纯函数）；
 *  - 顶部 PillTabs 切换周期，下方数字卡（当前周期）+ 趋势条形（纯 CSS 复用 BarChart）
 *    + 逐周期明细（周报带计划完成度、月报带复习保持率）；
 *  - 结果含站内 + 站外（B 站等）时长：站外为独立口径，在数字卡与图例中注明，
 *    报告口径本身不因挂载端不同而改变；
 *  - 样式全部沿用现有令牌与类（hdu-stat-grid / hdu-list / hdu-pill-tabs），
 *    暗色主题与窄口由既有规则收编，无新增 CSS。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { callOp } from '@/core/shared/client';
import { loadSettings } from '@/core/shared/settings';
import type { PeriodBucket, PeriodKind, PeriodReport } from '@/core/stats/period';
import { formatPeriodDelta } from '@/core/stats/period';
import { buildPeriodReportFilename, buildPeriodReportMarkdown, buildPeriodShareText } from '@/core/stats/periodExport';
import { buildAchievements } from '@/core/plan/achievements';
import { formatDuration } from '@/core/shared/utils';
import { BarChart, Button, Chip, EmptyState, PillTabs, Progress, SectionHead, Skeleton, StatCard, pushToast } from './components';
import { copyTextToClipboard } from './clipboard';
import { downloadTextFile } from './download';

type PeriodOptionKey = 'w1' | 'w8' | 'm1' | 'm6';

/** 紧凑周期切换项：本周 / 近 8 周（周报，含计划完成度）/ 本月 / 近 6 月（月报，含复习保持率） */
const PERIOD_OPTIONS: Array<{ key: PeriodOptionKey; label: string; kind: PeriodKind; count: number }> = [
  { key: 'w1', label: '本周', kind: 'week', count: 1 },
  { key: 'w8', label: '近 8 周', kind: 'week', count: 8 },
  { key: 'm1', label: '本月', kind: 'month', count: 1 },
  { key: 'm6', label: '近 6 月', kind: 'month', count: 6 },
];

/** 环比脚注（第 80 轮巡检）：有上周期数据且可比时输出「 · 较上周期+12%」式片段 */
function deltaFoot(previous: number | undefined, current: number, kindLabel: string): string {
  const label = formatPeriodDelta(current, previous ?? 0);
  return label ? ` · 较上${kindLabel}${label}` : '';
}

export function PeriodReportCard() {
  const [optionKey, setOptionKey] = useState<PeriodOptionKey>('w8');
  const [report, setReport] = useState<PeriodReport | null>(null);
  const [loading, setLoading] = useState(true);
  // 每周目标（第 111 轮巡检）：目标达成史条形用（settings.weeklyGoalHours，读失败按 0=不展示）
  const [goalHours, setGoalHours] = useState(0);
  // 成就目标倍率（第 133 轮巡检）：周报导出成就附录与统计页同口径
  const [goalScale, setGoalScale] = useState(1);
  // 自定义成就徽章（第 139 轮巡检）：随设置读取，导出附录与统计页同口径
  const [customBadges, setCustomBadges] = useState<Array<{ id: string; name: string; metric: string; threshold: number }>>([]);
  const option = PERIOD_OPTIONS.find((item) => item.key === optionKey) ?? (PERIOD_OPTIONS[1] as (typeof PERIOD_OPTIONS)[number]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    callOp('stats.period', { kind: option.kind, count: option.count })
      .then((result) => {
        if (!cancelled) setReport(result);
      })
      .catch(() => {
        if (!cancelled) setReport(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [option.kind, option.count]);

  useEffect(() => {
    let cancelled = false;
    loadSettings()
      .then((settings) => {
        if (!cancelled) {
          setGoalHours(Math.max(0, Math.round(settings.weeklyGoalHours || 0)));
          setGoalScale(settings.achievementGoalScale ?? 1);
          setCustomBadges(Array.isArray(settings.ui?.customAchievements) ? settings.ui.customAchievements : []);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // 复制摘要档位（第 237 轮，分享视角）：精简 / 完整——组件 state 即用即失，**不持久化**
  // （档位属一次性分享选择而非偏好，持久化会膨胀设置项；刷新回精简默认档）
  const [shareDetail, setShareDetail] = useState<'concise' | 'full'>('concise');
  // 分享完整档数据（第 237 轮）：分日明细（stats.report days[] 站内 validSec 同源）与
  // 完看课程名单（收藏 metadata.watchedRatio ≥ 0.95 现值口径，与周报「计划完看」同阈值）。
  // days 取默认窗口 30 天：本周恒足；本月仅 31 日的月份可能缺 1 号当天（补益段，边缘可接受）
  const [shareDays, setShareDays] = useState<Array<{ date: string; sec: number }>>([]);
  const [finishedTitles, setFinishedTitles] = useState<string[]>([]);

  const current: PeriodBucket | null = report?.buckets[report.buckets.length - 1] ?? null;
  // 环比基准：上一个周期桶（无则不展示环比，第 80 轮巡检）
  const previous: PeriodBucket | null = report && report.buckets.length >= 2 ? report.buckets[report.buckets.length - 2] ?? null : null;
  const kindLabel = report?.kind === 'month' ? '月' : '周';

  // 成就徽章（第 128 轮巡检）：周报/月报导出附成就附录（复习/笔记/收藏数现取，失败按 0；
  // 累计时长/连续天数取 stats.report 全局口径，与统计页一致）
  const [extraCounts, setExtraCounts] = useState({ favorites: 0, notes: 0, reviewDone: 0, totalSec: 0, externalSec: 0, streakDays: 0 });
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [favs, notes, jobs, dash] = await Promise.all([
          callOp('fav.list', {}),
          callOp('note.listAll', {}),
          callOp('review.list', {}),
          callOp('stats.report', {}),
        ]);
        if (!cancelled) {
          setExtraCounts({
            favorites: Array.isArray(favs) ? favs.length : 0,
            notes: Array.isArray(notes) ? notes.length : 0,
            reviewDone: Array.isArray(jobs) ? jobs.filter((job) => job.status === 'done').length : 0,
            totalSec: dash?.totalSec ?? 0,
            externalSec: dash?.externalSeconds ?? 0,
            streakDays: dash?.streakDays ?? 0,
          });
          // 分享完整档（第 237 轮）：分日明细 + 完看课程名单（脏数据逐条跳过；精简档不用）
          setShareDays(
            Array.isArray(dash?.days)
              ? dash!
                .days.filter((d) => typeof d?.date === 'string' && Number.isFinite(d?.validSec) && d.validSec > 0)
                .map((d) => ({ date: d.date, sec: d.validSec }))
              : [],
          );
          setFinishedTitles(
            (Array.isArray(favs) ? favs : [])
              .filter((fav) => Number((fav as { metadata?: { watchedRatio?: unknown } })?.metadata?.watchedRatio) >= 0.95)
              .map((fav) => String((fav as { snapshot?: { title?: unknown } })?.snapshot?.title ?? ''))
              .filter((title) => title.length > 0),
          );
        }
      } catch {
        /* 统计失败按 0 处理 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const achievements = useMemo(
    () =>
      buildAchievements({
        totalSec: extraCounts.totalSec,
        streakDays: extraCounts.streakDays,
        favoriteCount: extraCounts.favorites,
        externalSec: extraCounts.externalSec,
        reviewDoneCount: extraCounts.reviewDone,
        noteCount: extraCounts.notes,
        goalScale,
        customBadges,
      }),
    [extraCounts, goalScale, customBadges],
  );

  // 报告下载（第 80 轮巡检「导出报告」，第 239 轮升级为「下载周报/月报」）：当前已加载
  // 的报告 → Markdown 文件下载（纯函数序列化见 core/stats/periodExport；下载走
  // download.ts 单点实现：Blob + a[download] + 临时挂载点击 + finally 清理，无需
  // downloads 权限）；第 128 轮起附成就附录；文件名第 239 轮起带数据窗口
  // （HDUOnline周报_2026-11-16_11-22.md，buildPeriodReportFilename），多周期下载按名可区分。
  // 与「复制摘要」互不影响：下载恒为完整 Markdown（全部周期桶 + 口径附注 + 成就附录），
  // 摘要为纯文本（精简/完整档），两者数据同源但通道独立。
  const [downloading, setDownloading] = useState(false);
  const downloadReport = useCallback(() => {
    if (!report) return;
    const first = report.buckets[0];
    const last = report.buckets[report.buckets.length - 1];
    if (!first || !last) return;
    const filename = buildPeriodReportFilename(report.kind, first.startDay, last.endDay);
    setDownloading(true);
    try {
      downloadTextFile(filename, buildPeriodReportMarkdown(report, achievements));
      pushToast(`已生成 ${filename}`, 'success');
    } catch {
      pushToast('下载失败，请重试或改用「复制摘要」', 'error');
    } finally {
      setDownloading(false);
    }
  }, [report, achievements]);

  // 复制摘要（第 235 轮巡检，分享视角）：当前周期 → 精炼纯文本摘要（buildPeriodShareText，
  // 与数字卡同源取 buckets 最后一项）→ 剪贴板（clipboard.writeText 优先，失败回退
  // execCommand + 临时 textarea，见 clipboard.ts）；成功 / 失败均 toast，执行中 loading 态
  const [sharing, setSharing] = useState(false);
  const shareSummary = useCallback(async () => {
    if (!report || !current) return;
    setSharing(true);
    try {
      const text = buildPeriodShareText(
        report,
        {
          goalSec: goalHours > 0 ? goalHours * 3600 : undefined,
          streakDays: extraCounts.streakDays,
          days: shareDays,
          finishedCourses: finishedTitles,
        },
        { detail: shareDetail },
      );
      const ok = await copyTextToClipboard(text);
      if (ok) pushToast('已复制，可粘贴分享', 'success');
      else pushToast('复制失败，请手动选择文本复制', 'error');
    } catch {
      pushToast('复制失败，请手动选择文本复制', 'error');
    } finally {
      setSharing(false);
    }
  }, [report, current, goalHours, extraCounts.streakDays, shareDays, finishedTitles, shareDetail]);

  return (
    <div className="hdu-section">
      <SectionHead
        title={report?.kind === 'month' ? '学习月报' : '学习周报'}
        sub="站内外时长、计划完成度与复习保持率的周期聚合"
        actions={
          /* 导出按钮组行样式（第 248 轮巡检，统计域收官伴随打磨）：周期 PillTabs + 档位
              PillTabs + 复制摘要 / 下载周报两钮 + 成就角标同行排布，窄口（B 站 720 面板
              减内边距）下允许折行（flexWrap + rowGap 与 SectionHead 行基线一致），不再
              横向溢出挤压；「下载周报」产物 .md 头部注释行的内容样式见 periodExport.ts */
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', rowGap: 6 }}>
            <PillTabs
              value={optionKey}
              items={PERIOD_OPTIONS.map(({ key, label }) => ({ value: key, label }))}
              onChange={setOptionKey}
            />
            {/* 分享档位（第 237 轮）：精简 / 完整两档 pill 切换（复用既有 .hdu-pill-tabs），
                紧邻「复制摘要」；不持久化（一次性分享选择，刷新回精简） */}
            <span
              title="复制摘要档位：完整档追加分日明细与完看课程"
              style={{ display: 'inline-flex', alignItems: 'center' }}
            >
              <PillTabs
                value={shareDetail}
                items={[
                  { value: 'concise', label: '精简' },
                  { value: 'full', label: '完整' },
                ]}
                onChange={setShareDetail}
              />
            </span>
            {/* 复制摘要（第 235 轮巡检）：当前周期 → 纯文本摘要 → 剪贴板（分享用） */}
            <Button size="small" variant="ghost" icon="send" loading={sharing} disabled={!report || !current} onClick={() => void shareSummary()}>
              复制摘要
            </Button>
            {/* 下载周报/月报（第 239 轮巡检，分享视角；第 80 轮「导出报告」升级移位）：
                当前报告 → 完整 Markdown .md 文件（Blob + a[download]，无需 downloads
                权限），紧邻「复制摘要」构成分享双通道；成功/失败 toast，文件名带数据窗口 */}
            <Button
              size="small"
              variant="ghost"
              icon="download"
              loading={downloading}
              disabled={!report}
              title="下载完整 Markdown 报告（全部周期 + 成就附录）"
              onClick={downloadReport}
            >
              {report?.kind === 'month' ? '下载月报' : '下载周报'}
            </Button>
            {/* 学习成就角标（第 137 轮巡检）：已解锁徽章数（与总览/统计页同口径） */}
            <Chip tone="jade" title="学习成就已解锁数">
              🏅 {achievements.filter((badge) => badge.unlocked).length}/{achievements.length}
            </Chip>
          </span>
        }
      />
      <div className="hdu-card pad">
        {loading && !report ? (
          <>
            <Skeleton height={22} width="40%" />
            <div style={{ height: 16 }} />
            <Skeleton height={132} />
          </>
        ) : !report || !current ? (
          <EmptyState icon="chart" title="周期报表暂不可用" text="稍后重试；报表数据全部来自本机流水，不上报。" />
        ) : (
          <>
            <div className="hdu-stat-grid">
              <StatCard
                icon="clock"
                label={`${current.label} 站内学习`}
                value={(current.internalSec / 3600).toFixed(1)}
                unit="小时"
                foot={`有效口径 · 流水 ${current.flowCount} 条${deltaFoot(previous?.internalSec, current.internalSec, kindLabel)}`}
              />
              <StatCard
                icon="video"
                label={`${current.label} 站外视频`}
                value={(current.externalSec / 3600).toFixed(1)}
                unit="小时"
                foot={`B 站等站外独立口径${deltaFoot(previous?.externalSec, current.externalSec, kindLabel)}`}
              />
              <StatCard
                icon="flame"
                label="活跃天数"
                value={current.activeDays}
                unit="天"
                foot={`站内或站外有学习的自然日${deltaFoot(previous?.activeDays, current.activeDays, kindLabel)}`}
              />
              {report.kind === 'week' ? (
                <StatCard
                  icon="target"
                  label="计划完成度"
                  value={current.plan ? Math.round(current.plan.ratio * 100) : '—'}
                  unit={current.plan ? '%' : undefined}
                  foot={current.plan ? `完看 ${current.plan.finished} / 计划 ${current.plan.total} 个` : '该周无计划排期'}
                />
              ) : (
                <StatCard
                  icon="brain"
                  label="复习保持率"
                  value={current.review ? Math.round(current.review.ratio * 100) : '—'}
                  unit={current.review ? '%' : undefined}
                  foot={
                    current.review
                      ? `${current.review.retained} / ${current.review.reviewed} 个收藏期内复习过`
                      : '暂无复习完成记录'
                  }
                />
              )}
            </div>

            <div style={{ height: 18 }} />
            <BarChart
              data={report.buckets.map((b, i) => ({
                label: b.chartLabel,
                value: b.internalSec,
                today: i === report.buckets.length - 1,
              }))}
              height={140}
            />
            <div className="hdu-chart-legend" style={{ marginTop: 10 }}>
              <span>
                <span className="hdu-dot ok" /> 当前{kindLabel}
              </span>
              <span>柱高为站内有效学习时长；站外时长独立口径，见上方数字卡</span>
            </div>

            <div className="hdu-list" style={{ marginTop: 12 }}>
              {report.buckets
                .slice()
                .reverse()
                .map((b) => (
                  <div className="hdu-list-row" key={b.key}>
                    <div className="hdu-list-main">
                      <div className="hdu-list-title">{b.label}</div>
                      <div className="hdu-list-sub">
                        <span>站内 {formatDuration(b.internalSec)}</span>
                        <span>站外 {formatDuration(b.externalSec)}</span>
                        <span>活跃 {b.activeDays} 天</span>
                        <span>流水 {b.flowCount} 次</span>
                      </div>
                    </div>
                    <div className="hdu-list-side" style={{ minWidth: 132 }}>
                      {report.kind === 'week' ? (
                        <>
                          {b.plan ? (
                            <>
                              <Progress value={b.plan.ratio} jade />
                              <span className="hdu-time-badge">
                                {b.plan.finished}/{b.plan.total} 完看
                              </span>
                            </>
                          ) : (
                            <span className="hdu-list-sub">无计划排期</span>
                          )}
                          {/* 每周目标达成史（第 111 轮巡检）：站内有效学习 vs 每周目标（settings.weeklyGoalHours） */}
                          {goalHours > 0 ? (
                            <>
                              <Progress value={Math.min(1, b.internalSec / (goalHours * 3600))} />
                              <span className="hdu-time-badge">
                                {(b.internalSec / 3600).toFixed(1)}/{goalHours}h 目标
                              </span>
                            </>
                          ) : null}
                        </>
                      ) : b.review ? (
                        <>
                          <Progress value={b.review.ratio} jade />
                          <span className="hdu-time-badge">{Math.round(b.review.ratio * 100)}% 保持</span>
                        </>
                      ) : (
                        <span className="hdu-list-sub">无复习数据</span>
                      )}
                    </div>
                  </div>
                ))}
            </div>

            <div className="hdu-hint" style={{ marginTop: 12 }}>
              {report.kind === 'week'
                ? '计划完成度口径：该周计划排期到的视频中，收藏 watchedRatio ≥ 95% 视为完看（与今日待办同口径）；当前周只统计已到期的排期。'
                : '复习保持率口径：有复习完成记录的收藏中，最近一次复习落在本月内的占比（复习作业完成时刻记为复习时间）。'}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
