// 学习中心「学习统计」视图（自 LearningCenter.tsx 第 40 轮巡检按视图纯搬移拆分，逻辑不变）：
// 指标卡 + 周期报告（PeriodReportCard）+ B 站视频统计（BiliWatchCard）+ 近 30 天 / 12 周柱图
// + 课程分布 + 学习时段（第 238 轮）+ 笔记统计小卡（第 240 轮）+ 课次明细 + 口径说明。
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { callOp } from '@/core/shared/client';
import { formatDuration, localDayKey, shortDayLabel } from '@/core/shared/utils';
import { buildAchievements } from '@/core/plan/achievements';
import { activeDaysFromHeatmap, computeStudyStreak } from '@/core/plan/streak';
import { weeklyGoalStreak } from '@/core/stats/period';
import { buildWeeklyGoalCalendar, clampDailyGoalMin } from '@/core/plan/dailyGoal';
import { simulateEveningStudy, weeklyGoalForecast, type EveningSimResult, type WeeklyGoalForecast } from '@/core/stats/forecast';
import { BarChart, Button, EmptyState, Progress, SectionHead, Skeleton, cx, pushToast } from '../components';
import { uiStore, useUiStore } from '../store';
import { Icon } from '../icons';
import { BiliWatchCard } from '../BiliWatchCard';
import { WeeklyGoalCalendarRow } from './OverviewView';
import { recordAchievementUnlocks } from './AchievementStrip';
import { PeriodReportCard } from '../PeriodReportCard';
import { ActivityHeatmap } from './ActivityHeatmap';
import { CheckinMonthCard } from './CheckinMonthCard';
import { MilestoneWall } from './MilestoneWall';
import { TimeOfDayCard } from './TimeOfDayCard';
import { NoteStatsCard } from './NoteStatsCard';
import type { BundleData } from './shared';

// ───────────────────────── 统计 ─────────────────────────

/** 最长连续（第 125 轮巡检）：26 周热力图窗口内的历史最佳连续天数（现有卡片只展示当前连续）；
 *  第 128 轮起当前连续破历史最佳（跨会话累计）时弹祝贺并记录 */
function StreakBestLine({ current }: { current: number }) {
  const [best, setBest] = useState<number | null>(null);
  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const data = await callOp('stats.heatmap', { weeks: 26 });
        if (disposed) return;
        const todayKey = localDayKey();
        const streak = computeStudyStreak(activeDaysFromHeatmap(data?.weeks, todayKey), todayKey);
        setBest(streak.longest);
      } catch {
        if (!disposed) setBest(null);
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);
  useEffect(() => {
    if (current < 2) return;
    const settings = uiStore.getState().settings;
    const bestSeen = settings.ui?.streakBestSeen ?? 0;
    if (current > bestSeen) {
      pushToast(`连续学习新纪录：${current} 天`, 'success');
      const ui = { ...settings.ui, streakBestSeen: current };
      uiStore.patch({ settings: { ...settings, ui } });
      void uiStore.actions.saveSetting('ui', ui);
    }
  }, [current]);
  if (best === null || best <= 0) return null;
  return <div className="hdu-hint">26 周内最长连续 {best} 天</div>;
}

// ───────────────────────── B 站视频学习统计 ─────────────────────────
// BiliWatchCard 位于 ../BiliWatchCard.tsx（学习中心统计页与 Dashboard「本周学习」区共用同一
// 实现），在此 import 并于 StatsView 中挂载；测试导入路径经 LearningCenter.tsx 文件头部的
// re-export 兼容（bili-polish.test.ts）。

/**
 * 周目标预测行（第 236 轮巡检，目标管理 / 预测视角）：本周目标卡 Progress 下方
 * 的小字预测，三态文案——
 *  - 已达标：「本周目标已达成，超额 X 分钟」（jade 整行）；
 *  - 新周一未开始（今天周一且 weekSec=0）：「新的一周，目标 X 小时」（中性灰）；
 *  - 进行中：「还需日均 X 分钟（剩 Y 天）」+ 节奏判断片段（可达成 jade / 预计差
 *    danger 两态着色）。
 * forecast 为 null（未设目标 / 输入异常）不渲染该行。纯展示层：口径判断全部
 * 来自 core/stats/forecast.weeklyGoalForecast 纯函数，本组件不重算。
 */
function GoalForecastLine({
  forecast,
  weekSec,
  targetSec,
  targetHours,
}: {
  forecast: WeeklyGoalForecast | null;
  weekSec: number;
  targetSec: number;
  targetHours: number;
}) {
  if (!forecast) return null;
  if (weekSec >= targetSec) {
    const extra = Math.round((weekSec - targetSec) / 60);
    return <div className="hdu-goal-forecast is-hit">本周目标已达成{extra > 0 ? `，超额 ${extra} 分钟` : ''}</div>;
  }
  // 新周态：daysLeft=7 ⇔ 今天是周一（含今天的剩余天数口径，见 forecast.ts）
  if (forecast.daysLeft === 7 && weekSec === 0) {
    return <div className="hdu-goal-forecast">新的一周，目标 {targetHours} 小时</div>;
  }
  return (
    <div className="hdu-goal-forecast">
      还需日均 {Math.round(forecast.neededPerDaySec / 60)} 分钟（剩 {forecast.daysLeft} 天）
      {' · '}
      <span className={cx('hdu-goal-forecast-pace', forecast.willHit ? 'is-hit' : 'is-behind')}>
        {forecast.willHit
          ? '按当前节奏可达成'
          : `按当前节奏预计差 ${Math.round(Math.abs(forecast.aheadBehindSec) / 60)} 分钟`}
      </span>
    </div>
  );
}

/**
 * 今晚补进度模拟行（第 237 轮巡检，目标管理 / 模拟视角）：预测行下的轻量 what-if
 * 交互——分钟数字输入（默认取预测行 neededPerDaySec 换算分钟、最小 5）+
 * 「如果今晚学 X 分钟」按钮，点击后行内 aria-live 即时展示模拟结果（可达成 jade ✅ /
 * 还差 danger ❌）。纯前端模拟：core/stats/forecast.simulateEveningStudy 纯函数
 * 即点即算，不写库、刷新即失；输入不入设置（不持久化，避免设置项膨胀）。
 */
export function EveningSimRow({
  weekSec,
  targetSec,
  suggestedMin,
}: {
  weekSec: number;
  targetSec: number;
  /** 默认补学分钟数（预测行 neededPerDaySec 换算；已达标态落到最小值 5） */
  suggestedMin: number;
}) {
  const inputId = useId();
  const [mins, setMins] = useState(() => Math.max(5, Math.round(suggestedMin) || 5));
  const [result, setResult] = useState<{ mins: number; sim: EveningSimResult } | null>(null);
  const runSim = useCallback(() => {
    const sim = simulateEveningStudy({ weekSec, extraSec: mins * 60, targetSec });
    setResult(sim ? { mins, sim } : null);
  }, [weekSec, mins, targetSec]);
  const simHours = result ? (result.sim.simulatedSec / 3600).toFixed(1) : '';
  const shortMin = result ? Math.ceil(result.sim.shortBySec / 60) : 0;
  return (
    <div className="hdu-goal-sim">
      <div className="hdu-goal-sim-row">
        <label className="hdu-goal-sim-label" htmlFor={inputId}>
          今晚补
        </label>
        <input
          id={inputId}
          className="hdu-input hdu-goal-sim-input"
          type="number"
          min={1}
          value={mins}
          aria-label="今晚计划补学的分钟数"
          onChange={(e) => {
            const v = Number(e.target.value);
            setMins(Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);
          }}
        />
        <span className="hdu-goal-sim-unit">分钟</span>
        <Button size="small" variant="ghost" disabled={mins < 1} onClick={runSim}>
          如果今晚学 {mins} 分钟
        </Button>
      </div>
      <div
        className={cx('hdu-goal-sim-result', result ? (result.sim.willHit ? 'is-hit' : 'is-behind') : '')}
        aria-live="polite"
      >
        {result
          ? result.sim.willHit
            ? `模拟：加上 ${result.mins} 分钟后 ${simHours}h，可达成 ✅`
            : `模拟：加上 ${result.mins} 分钟后 ${simHours}h，还差 ${shortMin} 分钟 ❌`
          : ''}
      </div>
    </div>
  );
}

export function StatsView({ data }: { data: BundleData }) {
  const settings = useUiStore().settings;
  const report = data.report;
  const days = report?.days ?? [];
  const last30 = useMemo(() => {
    return days.slice(-30).map((d) => ({ label: shortDayLabel(d.date).slice(3), value: d.validSec, today: d.date === localDayKey() }));
  }, [days]);
  const weekBars = useMemo(() => {
    const weeks = report?.weeks ?? [];
    return weeks.slice(-12).map((w) => ({ label: shortDayLabel(w.weekStart), value: w.totalSec }));
  }, [report?.weeks]);
  const maxCourse = Math.max(1, ...(report?.courses ?? []).map((c) => c.totalSec));
  // 课程名映射（第 240 轮巡检）：courId → subjName（笔记卡 Top3 展示名；与
  // ReviewView 整页导出的映射同款，来自 data.bundles 快照，不发额外 op）
  const noteCourseNames = useMemo(() => {
    const map: Record<number, string> = {};
    for (const bundle of data.bundles) {
      const name = bundle?.course?.subjName;
      if (typeof name !== 'string') continue;
      for (const session of Array.isArray(bundle?.sessions) ? bundle.sessions : []) {
        if (session && typeof session.courId === 'number') map[session.courId] = name;
      }
    }
    return map;
  }, [data.bundles]);
  // 复习完成数（第 126 轮巡检）：成就徽章「复习达人」维度（review.list 现取，失败按 0）；
  // 第 135 轮起连同 stats.report 现取（data.report 是面板打开时的快照，种子后不刷新）
  const [reviewDoneCount, setReviewDoneCount] = useState(0);
  // externalSeconds 字段第 252 轮起存 externalTotalSec（站外累计口径，见 AchievementStrip）
  const [freshStats, setFreshStats] = useState<{ totalSec: number; externalSeconds: number; streakDays: number } | null>(null);
  // 周目标连续达成周数（第 235 轮巡检，激励视角延伸）：stats.period 周桶回溯
  // （含本周口径，见 core/stats/period.weeklyGoalStreak）；取数失败按 0（徽标不显示）
  const [goalStreak, setGoalStreak] = useState(0);
  const weeklyGoalHours = Math.max(1, Math.round(settings.weeklyGoalHours || 0));
  // 每日目标（第 258 轮，目标域）：本周 7 日格与双口径对照行的分母——clamp 兜底
  // 与总览 / 看板同源；calendar 为同一次派生（hitCount 供打卡/目标双口径行取数）
  const dailyGoalMin = clampDailyGoalMin(settings.dailyGoalMin);
  const goalCalendar = useMemo(() => buildWeeklyGoalCalendar(days, dailyGoalMin), [days, dailyGoalMin]);
  // 周目标达成预测（第 236 轮巡检，目标管理 / 预测视角）：本周已学 vs 每周目标的
  // 剩余缺口与节奏判断（core/stats/forecast 纯函数；纯展示层不改统计口径，报告
  // 快照变化或目标调整时随 useMemo 重算）
  const weekForecast = useMemo(
    () =>
      report
        ? weeklyGoalForecast({ now: Date.now(), weekSec: report.weekSec, targetSec: weeklyGoalHours * 3600 })
        : null,
    [report, weeklyGoalHours],
  );
  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const [jobs, dash, weekHistory] = await Promise.all([
          callOp('review.list', {}),
          callOp('stats.report', {}),
          callOp('stats.period', { kind: 'week', count: 8 }),
        ]);
        if (disposed) return;
        setReviewDoneCount(Array.isArray(jobs) ? jobs.filter((job) => job.status === 'done').length : 0);
        setFreshStats({ totalSec: dash?.totalSec ?? 0, externalSeconds: dash?.externalTotalSec ?? dash?.externalSeconds ?? 0, streakDays: dash?.streakDays ?? 0 });
        setGoalStreak(weeklyGoalStreak(Array.isArray(weekHistory?.buckets) ? weekHistory.buckets : [], weeklyGoalHours * 3600));
      } catch {
        /* 统计失败按 0 处理 */
      }
    })();
    return () => {
      disposed = true;
    };
  }, [weeklyGoalHours]);
  // 学习成就（第 125/135 轮巡检）：按既有统计量推导徽章清单（stats 现取优先，快照兜底）
  const achievementRows = useMemo(
    () =>
      buildAchievements({
        totalSec: freshStats?.totalSec ?? report?.totalSec,
        streakDays: freshStats?.streakDays ?? report?.streakDays,
        favoriteCount: data.favorites.length,
        externalSec: freshStats?.externalSeconds ?? report?.externalTotalSec ?? report?.externalSeconds,
        reviewDoneCount,
        noteCount: data.notes.length,
      }),
    [report, data.favorites.length, data.notes.length, reviewDoneCount, freshStats],
  );
  // 解锁 toast（会话内）：首次渲染只登记基线，其后新解锁的徽章弹提示
  const seenUnlockedRef = useRef<Set<string> | null>(null);
  // 成就筛选（第 141 轮巡检）：全部 / 已解锁 / 进行中 / 自定义；第 145 轮起持久化
  const [achievementFilter, setAchievementFilter] = useState<'all' | 'unlocked' | 'progress' | 'custom'>(() => {
    const stored = uiStore.getState().settings.ui?.achievementFilter;
    return stored === 'unlocked' || stored === 'progress' || stored === 'custom' ? stored : 'all';
  });
  const setAchievementFilterPersisted = useCallback((key: 'all' | 'unlocked' | 'progress' | 'custom') => {
    setAchievementFilter(key);
    const settings = uiStore.getState().settings;
    const ui = { ...settings.ui, achievementFilter: key };
    uiStore.patch({ settings: { ...settings, ui } });
    void uiStore.actions.saveSetting('ui', ui);
  }, []);
  // 成就排序（第 142 轮巡检）：默认（预置序）/ 按进度 / 按名称；第 145 轮起持久化
  const [achievementSort, setAchievementSort] = useState<'default' | 'progress' | 'name'>(() => {
    const stored = uiStore.getState().settings.ui?.achievementSort;
    return stored === 'progress' || stored === 'name' ? stored : 'default';
  });
  const setAchievementSortPersisted = useCallback((key: 'default' | 'progress' | 'name') => {
    setAchievementSort(key);
    const settings = uiStore.getState().settings;
    const ui = { ...settings.ui, achievementSort: key };
    uiStore.patch({ settings: { ...settings, ui } });
    void uiStore.actions.saveSetting('ui', ui);
  }, []);
  // 解锁说明展开（第 144 轮巡检）
  const [achievementHelpOpen, setAchievementHelpOpen] = useState(false);
  const visibleBadges = useMemo(() => {
    const filtered = achievementRows.filter((row) =>
      achievementFilter === 'all'
        ? true
        : achievementFilter === 'unlocked'
          ? row.unlocked
          : achievementFilter === 'custom'
            ? row.id.startsWith('custom-')
            : !row.unlocked,
    );
    if (achievementSort === 'name') return [...filtered].sort((a, b) => a.name.localeCompare(b.name));
    if (achievementSort === 'progress') return [...filtered].sort((a, b) => b.progress - a.progress);
    return filtered;
  }, [achievementRows, achievementFilter, achievementSort]);
  useEffect(() => {
    const unlockedIds = achievementRows.filter((row) => row.unlocked).map((row) => row.id);
    // 首次解锁时间登记（第 135 轮巡检）：统计页成就卡同样登记（时间线数据源）
    recordAchievementUnlocks(unlockedIds);
    const prev = seenUnlockedRef.current;
    if (prev !== null) {
      for (const id of unlockedIds) {
        if (!prev.has(id)) {
          const badge = achievementRows.find((row) => row.id === id);
          if (badge) pushToast(`成就解锁：${badge.name}`, 'success');
        }
      }
    }
    seenUnlockedRef.current = new Set(unlockedIds);
  }, [achievementRows]);

  if (!report) {
    return (
      <div className="hdu-card pad">
        <Skeleton height={22} width="30%" />
        <div style={{ height: 16 }} />
        <Skeleton height={90} />
      </div>
    );
  }

  return (
    <>
      <div className="hdu-stat-hero">
        <div className="hdu-card hdu-metric">
          <div className="hdu-metric-head"><Icon name="clock" /> 累计有效学习</div>
          <div className="hdu-metric-value">{Math.round(report.totalSec / 3600)}<small>小时</small></div>
          <div className="hdu-hint">仅统计「播放中 + 页面前台可见 + 非挂机」的墙钟时间</div>
        </div>
        <div className="hdu-card hdu-metric">
          <div className="hdu-metric-head"><Icon name="video" /> 站外视频</div>
          <div className="hdu-metric-value">{Math.round(report.externalSeconds / 60)}<small>分钟</small></div>
          <div className="hdu-hint">B 站等站外视频学习时长（独立口径，不并入站内累计）</div>
        </div>
        <div className="hdu-card hdu-metric">
          <div className="hdu-metric-head"><Icon name="flame" /> 连续学习</div>
          <div className="hdu-metric-value">{report.streakDays}<small>天</small></div>
          <div className="hdu-hint">按有有效观看的自然日连续计算</div>
          <StreakBestLine current={report.streakDays} />
        </div>
        {/* 本周目标（第 110 轮巡检）：本周站内有效学习 vs 每周目标（settings.weeklyGoalHours）；
            第 235 轮起 foot 附「连续达成 N 周」徽标（N≥2 才显示，避免 0/1 噪声） */}
        <div className="hdu-card hdu-metric">
          <div className="hdu-metric-head"><Icon name="target" /> 本周目标</div>
          <div className="hdu-metric-value">
            {(report.weekSec / 3600).toFixed(1)}
            <small>/{weeklyGoalHours} 小时</small>
          </div>
          <Progress value={report.weekSec / (weeklyGoalHours * 3600)} jade />
          {/* 周目标达成预测（第 236 轮）：剩余缺口 / 日均节奏推算，jade/danger 两态 */}
          <GoalForecastLine
            forecast={weekForecast}
            weekSec={report.weekSec}
            targetSec={weeklyGoalHours * 3600}
            targetHours={weeklyGoalHours}
          />
          {/* 今晚补进度模拟（第 237 轮）：预测行下的 what-if 轻交互，纯前端模拟不写库 */}
          {weekForecast ? (
            <EveningSimRow
              weekSec={report.weekSec}
              targetSec={weeklyGoalHours * 3600}
              suggestedMin={Math.max(5, Math.round(weekForecast.neededPerDaySec / 60))}
            />
          ) : null}
          <div className="hdu-hint">每周学习目标（设置中可调）；站内有效学习口径</div>
          {/* 本周目标达成 7 日格 + 双口径对照（第 258 轮，目标域）：与总览「今日目标」卡 /
              看板「本周目标」卡同款组件同源口径（buildWeeklyGoalCalendar，目标线 =
              当日有效学习 ≥ 每日目标）；下方一行并列打卡口径（hitDaysThisWeek，≥10 分钟
              打卡线）——两条口径回答的问题不同（学没学 vs 达没达标），数字可以不同，
              边界说明见 dailyGoal.ts 注释 */}
          <WeeklyGoalCalendarRow days={days} dailyGoalMin={dailyGoalMin} />
          <div className="hdu-hint">
            打卡口径（≥10 分钟）本周有效 {report?.goal.hitDaysThisWeek ?? 0} 天 · 目标口径（≥ 每日目标）达标 {goalCalendar.hitCount} 天
          </div>
          {goalStreak >= 2 ? (
            <span
              className="hdu-goal-streak"
              title={`连续达成每周目标的周数（含本周；本周未达成则从上一个完整周起算）：${goalStreak} 周`}
            >
              🔥 连续达成 {goalStreak} 周
            </span>
          ) : null}
        </div>
      </div>

      {/* 学习成就徽章（第 125 轮巡检）：按既有统计量推导的里程碑（解锁/进行中）；
          第 135 轮起附距下一枚提示与最近解锁时间线（settings.ui.achievementUnlockedAt） */}
      <div className="hdu-section">
        <SectionHead title="学习成就" sub="随学习推进自动点亮" />
        <div className="hdu-card pad">
          <div className="hdu-hint" style={{ marginBottom: 8 }}>
            {(() => {
              const next = achievementRows.filter((row) => !row.unlocked).sort((a, b) => b.progress - a.progress)[0];
              return next
                ? `距下一枚徽章「${next.name}」还差 ${Math.max(0, next.threshold - next.value)} ${next.unit}`
                : '全部徽章已解锁 🎉';
            })()}
          </div>
          {/* 成就筛选（第 141 轮巡检）：全部 / 已解锁 / 进行中 */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            {(
              [
                ['all', '全部'],
                ['unlocked', '已解锁'],
                ['progress', '进行中'],
                ['custom', '自定义'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={cx('hdu-folder', achievementFilter === key ? 'is-active' : '')}
                onClick={() => setAchievementFilterPersisted(key)}
              >
                {label}
              </button>
            ))}
          </div>
          {/* 成就排序（第 142 轮巡检）：默认 / 按进度 / 按名称 */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            <span className="hdu-hint" style={{ alignSelf: 'center' }}>
              排序
            </span>
            {(
              [
                ['default', '默认'],
                ['progress', '按进度'],
                ['name', '按名称'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={cx('hdu-folder', achievementSort === key ? 'is-active' : '')}
                onClick={() => setAchievementSortPersisted(key)}
              >
                {label}
              </button>
            ))}
            {/* 解锁说明（第 144 轮巡检）：可展开的帮助文案 */}
            <button
              type="button"
              className="hdu-folder"
              onClick={() => setAchievementHelpOpen((prev) => !prev)}
            >
              如何解锁？
            </button>
          </div>
          {achievementHelpOpen ? (
            <div className="hdu-hint" style={{ marginBottom: 8 }}>
              徽章按「当前值 ≥ 阈值」自动点亮：连续天数看有效学习自然日；累计分钟看站内有效学习；收藏数看知识库收藏；
              复习完成数看已完成复习作业；笔记数看全部笔记。自定义徽章在设置中配置，阈值同受目标倍率缩放。
            </div>
          ) : null}
          <div className="hdu-achievement-row">
            {visibleBadges.map((badge) => (
              <div
                key={badge.id}
                className={cx('hdu-achievement', badge.unlocked ? 'is-unlocked' : '')}
                title={`${badge.desc}（${badge.value}/${badge.threshold} ${badge.unit}）`}
              >
                <span className="hdu-achievement-name">
                  {badge.unlocked ? badge.icon || '🏅' : '🔒'} {badge.name}
                  {/* 自定义徽章来源角标（第 154 轮巡检）：与预置徽章区分 */}
                  {badge.id.startsWith('custom-') ? <span className="hdu-badge-src">自定义</span> : null}
                </span>
                <span className="hdu-achievement-desc">{badge.desc}</span>
                <Progress value={badge.progress} jade={badge.unlocked} />
                <span className="hdu-hint">
                  {badge.value}/{badge.threshold} {badge.unit}
                  {!badge.unlocked ? ` · 还差 ${badge.threshold - badge.value} ${badge.unit}` : ''}
                  {/* 自定义徽章编辑入口（第 155 轮巡检）：一键打开设置页（学习目标与统计口径区） */}
                  {badge.id.startsWith('custom-') ? (
                    <button
                      type="button"
                      className="hdu-folder"
                      style={{ marginLeft: 6 }}
                      title="在设置 · 学习目标与统计口径中编辑该徽章"
                      onClick={() => chrome.runtime.openOptionsPage()}
                    >
                      ⚙ 去编辑
                    </button>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
          {(() => {
            const unlockedAt = settings.ui?.achievementUnlockedAt ?? {};
            // 最近解锁时间线（第 135 轮；第 138 轮起完整列出全部已解锁徽章；
            // 第 143 轮起按 今天/昨天/更早 分组展示）
            const recent = Object.entries(unlockedAt)
              .map(([id, ts]) => ({ id, ts, badge: achievementRows.find((row) => row.id === id) }))
              .filter((entry) => entry.badge && Number.isFinite(entry.ts))
              .sort((a, b) => b.ts - a.ts);
            if (recent.length === 0) return null;
            const todayKey = localDayKey();
            const yesterdayKey = localDayKey(new Date(Date.now() - 86_400_000));
            const groups = new Map<string, string[]>();
            for (const entry of recent) {
              const key = localDayKey(new Date(entry.ts));
              const label = key === todayKey ? '今天' : key === yesterdayKey ? '昨天' : key.slice(5).replace('-', '/');
              const names = groups.get(label) ?? [];
              names.push(`${entry.badge!.name}（${new Date(entry.ts).toLocaleTimeString()}）`);
              groups.set(label, names);
            }
            return (
              <div className="hdu-hint" style={{ marginTop: 8 }}>
                解锁时间线：{[...groups.entries()].map(([label, names]) => `${label}：${names.join('、')}`).join(' ｜ ')}
              </div>
            );
          })()}
        </div>
      </div>

      {/* 学习里程碑时间线墙（第 235 轮巡检）：从 stats.report days[] 回放历史时刻
          （累计档位 / 连续新高 / 单日新高 / 首次打卡），与成就徽章卡互补——徽章看
          「现在的进度」，里程碑墙看「走过的路」 */}
      <MilestoneWall />

      {/* 学习周报 / 月报（周期聚合视图：自带周期切换与 stats.period 取数） */}
      <PeriodReportCard />

      {/* 学习热力图（第 77 轮巡检）：日级强度网格（站内 + 站外按日合并，周一为界） */}
      <ActivityHeatmap />

      {/* 打卡月历（第 234 轮巡检）：逐月「哪些天达成了打卡」（当日有效学习 ≥ 打卡线，
          与 hitDaysThisWeek 同线）；与热力图互补——热力图看趋势强度，月历看打卡分布 */}
      <CheckinMonthCard />

      {/* B 站视频学习统计（站外独立口径：TopN / 最近观看 / 连续天数） */}
      <BiliWatchCard />

      <div className="hdu-section">
        <SectionHead title="近 30 天" sub="柱高为每日有效学习时长" />
        <div className="hdu-card pad">
          <BarChart data={last30.length > 0 ? last30 : Array.from({ length: 30 }, (_, i) => ({ label: String(i + 1), value: 0 }))} height={176} />
          <div className="hdu-chart-legend" style={{ marginTop: 10 }}>
            <span><span className="hdu-dot ok" /> 今天</span>
            <span>口径：有效观看秒数，非视频播放位置</span>
          </div>
        </div>
      </div>

      <div className="hdu-grid g2 hdu-section">
        <div className="hdu-card pad">
          <SectionHead title="近 12 周" sub="每周一为起点" />
          <BarChart data={weekBars.length > 0 ? weekBars : [{ label: '本周', value: report.weekSec }]} height={150} />
        </div>
        <div className="hdu-card pad">
          <SectionHead title="课程分布" sub="按有效学习时长排序 · 想看几点学见下方「学习时段」卡" />
          {(report.courses ?? []).length === 0 ? (
            <EmptyState icon="chart" title="暂无数据" text="完成一次观看后，这里会显示课程分布。" />
          ) : (
            <div className="hdu-dist">
              {report.courses.slice(0, 8).map((course) => (
                <div className="hdu-dist-row" key={course.teclId}>
                  <span className="hdu-dist-name" title={course.courseName}>{course.courseName}</span>
                  <div className="hdu-dist-bar"><i style={{ width: `${(course.totalSec / maxCourse) * 100}%` }} /></div>
                  <span className="hdu-dist-val">{formatDuration(course.totalSec)}</span>
                </div>
              ))}
            </div>
          )}
          {/* 卡面口径标注（第 239 轮巡检，分布卡口径统一）：课程分布聚合自 stats.report
              快照（buildReport 的 courses 段）——valid=true 口径与报表同线，但窗口是
              报表取数窗（近 150 天 = 报表 30 天 + 12 周图 120 天余量）而非近 30 天，
              与时段卡的窗口差异如实注明（口径核对详见巡检日志第 239 轮四元组表） */}
          <div className="hdu-hint hdu-caliber-hint" style={{ marginTop: 10 }}>
            <span className="hdu-caliber-tag">口径</span>
            站内有效时长 · 近 150 天累计（宽于时段卡的近 30 天）
          </div>
        </div>
      </div>

      {/* 学习时段分布（第 238 轮巡检，信息 / 自我认知视角）：近 30 天按开始小时六桶，
          与热力图互补——热力图看「哪天学」，时段卡看「几点学」 */}
      <TimeOfDayCard />

      {/* 笔记统计小卡（第 240 轮巡检，笔记域 / 信息视角）：总数 + 近 7 天新增 +
          有笔记课程 Top3（buildNoteStats 纯函数，与成就徽章「笔记勤耕」同口径）；
          foot「查看笔记」跳知识库（「我的笔记」分区在 LibraryView 内） */}
      <NoteStatsCard
        notes={data.notes}
        courseNames={noteCourseNames}
      />

      <div className="hdu-section">
        <SectionHead title="课次明细" sub="完看度 = 有效观看 / 课次时长（上限 100%）" />
        <div className="hdu-card pad">
          {(report.sessions ?? []).length === 0 ? (
            <EmptyState icon="list" title="还没有课次数据" text="在播放页观看一段时间后，这里会出现每一节的完看度。" />
          ) : (
            <div className="hdu-list">
              {report.sessions.slice(0, 30).map((session) => (
                <div className="hdu-list-row" key={session.courId}>
                  <div className="hdu-list-main">
                    <div className="hdu-list-title">{session.courseName}</div>
                    <div className="hdu-list-sub">
                      <span>{session.courLabel}</span>
                      <span>{formatDuration(session.watchedSec)} / {formatDuration(session.durationSec)}</span>
                    </div>
                  </div>
                  <div className="hdu-list-side" style={{ minWidth: 150 }}>
                    <Progress value={session.watchRatio} jade />
                    <span className="hdu-time-badge">{Math.round(session.watchRatio * 100)}%</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="hdu-note-text" style={{ marginTop: 18 }}>
        统计口径：只累计「视频播放中 + 页面处于前台可见 + 未触发挂机」的墙钟时间，与倍速无关；
        单日封顶 16 小时；重复观看重复计入；<code>valid=false</code> 的异常流水保留用于审计，但不会出现在报表中。
        站外视频（B 站等）学习时长走独立通道：仅累计「播放中 + 页面前台可见」的时间，与站内口径分开展示、互不混入。
        {/* 目标线条目（第 262 轮，目标域收官）：双口径并行说明——打卡线与目标线各自回答的问题、判定出处 */}
        每日目标线（第 234 轮起）：当日有效学习 ≥ 设置的每日目标分钟数即「达标」（7 日格点阵、打卡月历金框、
        设置页预览共用这一条线），与 10 分钟打卡线并行——打卡线回答「学没学」，目标线回答「够不够」。
        本页数据全部来自本机，不上报站点，也不改变站点的观看记录。
      </div>
    </>
  );
}
