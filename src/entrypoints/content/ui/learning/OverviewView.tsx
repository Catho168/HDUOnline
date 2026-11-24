// 学习中心「总览」视图（自 LearningCenter.tsx 第 40 轮巡检按视图纯搬移拆分，逻辑不变）：
// 今日待办卡 + 黄金时段提示（第 239 轮）+ Hero 继续学习区 + 统计卡 + 近 7 天节奏 + 继续课程列表 + 待补看摘要。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { callOp } from '@/core/shared/client';
import { CHECKIN_MIN_SEC } from '@/core/stats/aggregate';
import { clampDailyGoalMin } from '@/core/plan/dailyGoal';
import { simulateStudyProgress, type EveningSimResult } from '@/core/stats/forecast';
import { isInGoldenNow, suggestGoldenSlot, timeOfDayHourLabel } from '@/core/stats/timeOfDay';
import { buildWeeklyHighlight, buildWeeklyHighlights } from '@/core/stats/weeklyHighlight';
import { buildWeeklyGoalCalendar } from '@/core/plan/dailyGoal';
import type { BiliRecentWatchedRow, CourseBundle, SessionEntity } from '@/core/shared/types';
import { formatClock, formatDuration, localDayKey, shortDayLabel, withTimeParam } from '@/core/shared/utils';
import { BarChart, Button, EmptyState, Progress, Ring, SectionHead, Skeleton, StatCard, cx } from '../components';
import { AchievementStrip } from './AchievementStrip';
import { Icon } from '../icons';
import { uiStore, useUiStore } from '../store';
import { TodayTodoCard } from './TodayTodoCard';
import { OnboardingCard } from './OnboardingCard';
import { DemoStartButton } from '../DemoBadge';
import { MissedList, sessionLabel, useTimeOfDayDistribution, type BundleData } from './shared';

function greeting(): string {
  const h = new Date().getHours();
  if (h < 6) return '夜深了，注意休息。';
  if (h < 11) return '早上好，今天也把课听完整。';
  if (h < 14) return '中午好，午后适合复盘一节课。';
  if (h < 19) return '下午好，继续推进你的进度。';
  return '晚上好，把今天的课收个尾。';
}

function pickContinue(bundles: CourseBundle[]): { bundle: CourseBundle; session: SessionEntity } | null {
  const candidates: Array<{ bundle: CourseBundle; session: SessionEntity }> = [];
  for (const bundle of bundles) {
    for (const session of bundle.sessions) {
      if (session.watchState === 'watching' || (session.watchRatio ?? 0) > 0) candidates.push({ bundle, session });
    }
  }
  candidates.sort((a, b) => {
    const aDone = a.session.watchState === 'finished' ? 1 : 0;
    const bDone = b.session.watchState === 'finished' ? 1 : 0;
    if (aDone !== bDone) return aDone - bDone;
    return (b.session.updatedAt ?? 0) - (a.session.updatedAt ?? 0);
  });
  return candidates[0] ?? null;
}

// ───────────────────────── 每日目标快捷模拟（第 238 轮巡检） ─────────────────────────

/** 快捷模拟固定三档（分钟）：固定档位去掉第 237 轮输入框的复杂度，点击即算 */
const GOAL_SIM_CHIP_MINS = [15, 30, 60] as const;

/**
 * 每日目标快捷模拟 chips（第 238 轮巡检，目标管理 / 模拟视角）：今日目标 Ring 卡
 * foot 的固定三档 what-if——「再学 15 / 30 / 60 分」点击即在卡内即时显示模拟结果
 * （达成 ✅ / 仍差 ❌ / 已达标态下超额 ✅）。模拟引擎与第 237 轮今晚补模拟同一单点
 * 实现（core/stats/forecast.simulateEveningStudy），经 simulateStudyProgress 薄包装
 * 换当日口径传入：baseSec=今日已学、targetSec=每日目标——纯前端模拟，不写库、
 * 不入设置、刷新即失。
 *
 * 交互约定：再点同 chip 取消；结果行 8 秒后自动消失或被新点击替换（两者都实现：
 * 定时器仅一行 effect，新点击因 setSim 换值天然重置计时——选「都做」，复杂度
 * 与二选一相同）。结果行 aria-live=polite，两态着色复用第 237 轮 is-hit/is-behind。
 * （export 仅为渲染单测可达，照 EveningSimRow 先例。）
 */
export function DailyGoalSimChips({ todaySec, dailyGoalSec, done }: { todaySec: number; dailyGoalSec: number; done: boolean }) {
  const [sim, setSim] = useState<{ min: number; result: EveningSimResult } | null>(null);
  // 结果行 8 秒自动消失（依赖 sim：新点击换值即重置计时，卸载清理防泄漏）
  useEffect(() => {
    if (!sim) return;
    const timer = window.setTimeout(() => setSim(null), 8000);
    return () => window.clearTimeout(timer);
  }, [sim]);

  const pickChip = (min: number) => {
    if (sim?.min === min) {
      setSim(null); // 再点同 chip = 取消
      return;
    }
    const result = simulateStudyProgress({ baseSec: todaySec, extraSec: min * 60, targetSec: dailyGoalSec });
    setSim(result ? { min, result } : null);
  };

  // 结果行文案（未达标：达成 / 仍差；已达标：超额）——缺口分钟向上取整（学够必达标，
  // 与第 237 轮 EveningSimRow 同约定），超额向下不显示 0（达标态加学必有超额）
  let resultLine = '';
  if (sim) {
    if (!sim.result.willHit) resultLine = `+${sim.min} 分 → 仍差 ${Math.ceil(sim.result.shortBySec / 60)} 分 ❌`;
    else if (done) resultLine = `+${sim.min} 分 → 超额 ${Math.max(1, Math.round(sim.result.overBySec / 60))} 分 ✅`;
    else resultLine = `+${sim.min} 分 → 达成 ✅`;
  }

  return (
    <div className="hdu-goal-sim-chips">
      <div className="hdu-goal-sim-chip-row">
        {GOAL_SIM_CHIP_MINS.map((min) => (
          <button
            key={min}
            type="button"
            className={cx('hdu-filter-pill', sim?.min === min ? 'is-active' : '')}
            aria-pressed={sim?.min === min}
            aria-label={`模拟再学 ${min} 分钟是否达成今日目标`}
            onClick={() => pickChip(min)}
          >
            再学 {min} 分
          </button>
        ))}
      </div>
      <div
        className={cx('hdu-goal-sim-chips-result', sim ? (sim.result.willHit ? 'is-hit' : 'is-behind') : '')}
        aria-live="polite"
      >
        {resultLine}
      </div>
    </div>
  );
}

// ───────────────────────── 本周目标达成 7 日格（第 256 轮巡检，目标域 / 习惯视角） ─────────────────────────

/**
 * 本周目标达成 7 日格（第 256 轮巡检）：今日目标 Ring 卡下方的轻量「周节奏」视图——
 * 周一起 7 格（一~日），每日按「有效学习 ≥ 每日目标」点亮（buildWeeklyGoalCalendar
 * 纯函数派生，dailyGoal.ts 内注释了与 hitDaysThisWeek 打卡线的口径边界）。
 *
 * 数据零新增取数：days 复用 report.days 日报窗口（同 WeeklyHighlightRow 的
 * 数据源先例）。判定与展示约定：过去/今天判定达标（jade 实心）、未来日不判定
 * （dim 空心）、今天描边强调；foot 一行「本周达标 X/Y 天 · 每日目标 Z 分钟」。
 * （export 仅为渲染单测可达，照 DailyGoalSimChips 先例；now 参数供单测注入固定时刻。）
 */
export function WeeklyGoalCalendarRow({
  days,
  dailyGoalMin,
  now,
}: {
  days: Array<{ date: string; validSec: number }>;
  dailyGoalMin: number;
  now?: number;
}) {
  const calendar = useMemo(() => buildWeeklyGoalCalendar(days, dailyGoalMin, now), [days, dailyGoalMin, now]);
  return (
    <div
      className="hdu-goal-week"
      role="img"
      aria-label={`本周目标达成 ${calendar.hitCount} / ${calendar.judgedCount} 天，每日目标 ${calendar.dailyGoalMin} 分钟`}
    >
      <div className="hdu-goal-week-cells">
        {calendar.cells.map((cell) => (
          <span
            key={cell.date}
            className={cx('hdu-goal-week-cell', cell.hit ? 'is-hit' : '', cell.isToday ? 'is-today' : '', cell.isFuture ? 'is-future' : '')}
            title={`${cell.date} · ${Math.round(cell.validSec / 60)} 分钟${cell.isFuture ? '（未到）' : cell.hit ? ' · 已达标' : ' · 未达标'}`}
          >
            <i className="hdu-goal-week-dot" aria-hidden="true" />
            <span className="hdu-goal-week-label" aria-hidden="true">
              {cell.label}
            </span>
          </span>
        ))}
      </div>
      <div className="hdu-goal-week-foot">
        本周达标 {calendar.hitCount}/{calendar.judgedCount} 天 · 每日目标 {calendar.dailyGoalMin} 分钟
      </div>
    </div>
  );
}

// ───────────────────────── 黄金时段提示（第 239 轮巡检） ─────────────────────────

/**
 * 黄金时段提示行（第 239 轮巡检，建议 / 引导视角）：总览今日待办卡下方的一行轻提示，
 * 数据与统计页「学习时段」卡同一取数（useTimeOfDayDistribution 共享 hook，stats.records
 * 近 30 天）→ suggestGoldenSlot 纯函数判断是否值得建议（总有效 ≥60 分钟且最高桶占比
 * ≥25%，不达门槛防噪声不渲染）→ isInGoldenNow 判断此刻是否落在黄金桶：
 *  - 在黄金时段：「⏰ 现在是你的黄金时段（晚间），适合攻坚难点」（jade 软底提示行）；
 *  - 未到：「⏰ 黄金时段 晚间（18–23 点），记得留出学习时间」（中性灰虚线提示行）；
 *  - 无数据 / 不达门槛 / 取数失败：不渲染（总览保持安静，提示只在有把握时出现）。
 *
 * 提示行 aria-live=polite（读屏可感知，渲染时机在取数完成后、变化不频繁）；纯展示层
 * 不写库不入设置。export 仅为渲染单测可达（照 DailyGoalSimChips / EveningSimRow 先例），
 * nowHour 参数供单测注入固定小时（缺省取真实 getHours()，跨零点桶判定由纯函数锁定）。
 */
export function GoldenSlotHint({ nowHour }: { nowHour?: number }) {
  const { buckets } = useTimeOfDayDistribution();
  const golden = useMemo(() => suggestGoldenSlot(buckets), [buckets]);
  if (!golden) return null;
  const hour = typeof nowHour === 'number' && Number.isFinite(nowHour) ? nowHour : new Date().getHours();
  const inGolden = isInGoldenNow(golden, hour);
  return (
    <div className={cx('hdu-golden-hint', inGolden ? 'is-now' : '')} role="status" aria-live="polite">
      <span className="hdu-golden-hint-icon" aria-hidden="true">⏰</span>
      <span className="hdu-golden-hint-text">
        {inGolden
          ? `现在是你的黄金时段（${golden.label}），适合攻坚难点`
          : `黄金时段 ${golden.label}（${timeOfDayHourLabel(golden.key)}），记得留出学习时间`}
      </span>
    </div>
  );
}

// ───────────────────────── 本周亮点（第 250 轮巡检，激励域 / 榜样视角） ─────────────────────────

/** 「近 4 周」回看展开区周数（与 buildWeeklyHighlights 默认值同源同值） */
const WEEKLY_HISTORY_WEEKS = 4;

/**
 * 「本周亮点」标杆提示行（第 250 轮巡检）：黄金时段提示行下方的一行轻提示，从本周
 * 数据派生「本周最值得肯定的一件事」（buildWeeklyHighlight 纯函数，五档优先级：
 * 周目标达成 → 打卡满 5 天 → 单日峰值 → 复习最稠密一日 → 无亮点不渲染）。
 *
 * 第 251 轮（激励域 / 回顾延续视角）新增「近 4 周 ›」轻入口 + 受控展开区：行尾
 * 轻按钮切换展开区（选受控展开区而非 Popover/Modal——改动最小、无浮层栈参与、
 * 与 OverviewWeekCard 折叠卡同交互语言），展开时经 buildWeeklyHighlights 从同一份
 * days 派生近 4 周亮点列表（零新增取数，数据源裁决记巡检日志第 251 轮：report.days
 * 30 天窗口全覆盖近 4 周周界），每周一行（周标签 + 亮点文案），本周行带「本周」jade
 * 徽标；无亮点周省略、全空显示空态句。收起态与第 250 轮渲染完全一致。
 *
 * 数据源不新增 op：days 取 data.report 日报窗口（BundleData 已持有）、weekSec /
 * weeklyTargetSec 取 report.weekSec / report.goal.weeklyTargetSec（与「本周目标」
 * mini 卡 / weeklyGoalStreak 同口径）；review.list 全量含收藏快照、总览每次挂载
 * 取数成本高 → 不传 reviews（④ 档由纯函数支持，待轻量数据源再接入，裁决记
 * 巡检日志第 250 轮）。样式对齐 .hdu-golden-hint 家族（jade 软底 + gold 点缀区分），
 * aria-live=polite；无亮点返回 null（总览保持安静，防噪声约定同黄金时段行）。
 * export 仅为渲染单测可达（照 GoldenSlotHint 先例）。
 */
export function WeeklyHighlightRow({ days, weekSec, weeklyTargetSec }: { days: Array<{ date: string; validSec: number }>; weekSec: number; weeklyTargetSec: number }) {
  const highlight = useMemo(
    () => buildWeeklyHighlight({ weekSec, weeklyTargetSec, days, now: Date.now() }),
    [days, weekSec, weeklyTargetSec],
  );
  const [historyOpen, setHistoryOpen] = useState(false);
  const history = useMemo(
    () =>
      historyOpen
        ? buildWeeklyHighlights({ days, weeklyTargetSec, weeks: WEEKLY_HISTORY_WEEKS, now: Date.now() })
        : [],
    [historyOpen, days, weeklyTargetSec],
  );
  if (!highlight) return null;
  return (
    <div className={cx('hdu-weekly-highlight', historyOpen ? 'is-expanded' : '')} role="status" aria-live="polite">
      <span className="hdu-weekly-highlight-icon" aria-hidden="true">⭐</span>
      <span className="hdu-weekly-highlight-text">{highlight.text}</span>
      <button
        type="button"
        className="hdu-weekly-history-toggle"
        aria-expanded={historyOpen}
        aria-controls="hdu-weekly-history-body"
        title={historyOpen ? '收起近 4 周亮点回看' : '回看近 4 周亮点'}
        onClick={() => setHistoryOpen(!historyOpen)}
      >
        近 4 周
        <span className="hdu-weekly-history-caret" aria-hidden="true">
          <Icon name="chevronDown" size={12} />
        </span>
      </button>
      {historyOpen ? (
        <div id="hdu-weekly-history-body" className="hdu-weekly-history" aria-label="近 4 周亮点回看">
          {history.length === 0 ? (
            <div className="hdu-weekly-history-empty">近 4 周还没有可回看的亮点</div>
          ) : (
            history.map((entry) => (
              <div key={entry.weekStart} className="hdu-weekly-history-row">
                <span className="hdu-weekly-history-label">{entry.weekLabel}</span>
                <span className="hdu-weekly-history-text">{entry.text}</span>
                {entry.current ? <span className="hdu-weekly-history-badge">本周</span> : null}
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

// ───────────────────────── 近 7 天节奏折叠卡（第 244 轮巡检，总览域 / 信息架构视角） ─────────────────────────

/**
 * 近 7 天学习节奏折叠卡（第 244 轮巡检首屏密度审计落地）：首屏审计把「近 7 天柱图」
 * 标记为低频占首屏块（统计页「近 30 天」已有同粒度日柱超集）——收起后标题行保留
 * 摘要分钟数（tabular-nums），展开才渲染柱图；展开状态经 settings.ui.overviewWeekOpen
 * 持久化（仿 windowNoteOpen 先例，默认收起）。
 *  - 标题行为整行按钮：chevron 旋转指示开合 + 摘要「N 分钟」右对齐 + aria-expanded；
 *  - 展开态附「近 30 天完整趋势在统计页 ›」跳转（去重不删功能：总览保留 7 天速览）。
 * export 仅为渲染单测可达（照 GoldenSlotHint / DailyGoalSimChips 先例）。
 */
export function OverviewWeekCard({
  last7,
  open,
  onToggle,
  onViewStats,
}: {
  last7: Array<{ label: string; value: number; today?: boolean }>;
  open: boolean;
  onToggle: (open: boolean) => void;
  onViewStats: () => void;
}) {
  const totalMin = Math.round(last7.reduce((sum, day) => sum + day.value, 0) / 60);
  return (
    <div className="hdu-card pad hdu-overview-week">
      <button
        type="button"
        className={cx('hdu-overview-week-head', open ? 'is-open' : '')}
        aria-expanded={open}
        aria-controls="hdu-overview-week-body"
        title={open ? '收起近 7 天柱图' : '展开近 7 天柱图'}
        onClick={() => onToggle(!open)}
      >
        <span className="hdu-overview-week-caret" aria-hidden="true">
          <Icon name="chevronDown" size={13} />
        </span>
        <span className="hdu-overview-week-title">近 7 天学习节奏</span>
        <span className="hdu-overview-week-sum" title="近 7 天有效学习合计">
          {totalMin} 分钟
        </span>
      </button>
      {open ? (
        <div id="hdu-overview-week-body">
          <div className="hdu-chart-legend" style={{ margin: '8px 0 6px' }}>
            <span className="hdu-dot ok" />今天 · 仅统计有效观看
          </div>
          <BarChart data={last7} />
          {/* 完整趋势留跳转（第 244 轮巡检）：统计页「近 30 天」为同粒度日柱超集，
              总览侧只保留 7 天速览，不重复维护两份日柱 */}
          <div style={{ marginTop: 8 }}>
            <button type="button" className="hdu-btn ghost small" onClick={onViewStats}>
              近 30 天完整趋势在统计页 <Icon name="arrowRight" size={12} />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ───────────────────────── 总览 ─────────────────────────

export function OverviewView({ data, todoReloadKey }: { data: BundleData; todoReloadKey: number }) {
  // 回收站还原等跨视图操作经 uiStore.todoRefreshTick 触发今日待办卡重载（第 159 轮巡检）
  const { todoRefreshTick } = useUiStore();
  const settings = useUiStore().settings;
  const actions = uiStore.actions;
  const report = data.report;
  const cont = pickContinue(data.bundles);
  // B 站续看（第 86 轮巡检）：最近观看的站外视频（有断点才提示），跨端连续学习
  const [biliResume, setBiliResume] = useState<BiliRecentWatchedRow | null>(null);
  useEffect(() => {
    let cancelled = false;
    callOp('stats.bili.overview', { kind: 'week' })
      .then((res) => {
        if (cancelled) return;
        const first = res.recent?.[0] ?? null;
        setBiliResume(first && first.lastPositionSec > 0 ? first : null);
      })
      .catch(() => {
        if (!cancelled) setBiliResume(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const todaySec = report?.todaySec ?? 0;
  const weekSec = report?.weekSec ?? 0;
  const goalSec = (report?.goal.weeklyTargetSec ?? 5 * 3600) || 5 * 3600;
  // 每日目标（第 234 轮巡检）：settings.dailyGoalMin（clamp 兜底）→ Ring 进度分母；
  // 仅展示与激励层，不改打卡判定线（CHECKIN_MIN_SEC = 10 分钟）与 hitDaysThisWeek 语义
  const dailyGoalMin = clampDailyGoalMin(settings?.dailyGoalMin);
  const dailyGoalSec = dailyGoalMin * 60;
  const dailyGoalDone = todaySec >= dailyGoalSec;
  const days = report?.days ?? [];
  const last7 = useMemo(() => {
    const recent = days.slice(-7);
    if (recent.length === 7) {
      return recent.map((d) => ({ label: shortDayLabel(d.date), value: d.validSec, today: d.date === localDayKey() }));
    }
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - (6 - i));
      const key = localDayKey(d);
      const hit = days.find((x) => x.date === key);
      return { label: shortDayLabel(key), value: hit?.validSec ?? 0, today: i === 6 };
    });
  }, [days]);

  // 近 7 天柱图折叠（第 244 轮巡检首屏密度审计）：默认收起、标题行保留摘要分钟数；
  // 展开状态随 settings.ui.overviewWeekOpen 持久化（仿 windowNoteOpen 先例）
  const [weekOpen, setWeekOpen] = useState(() => settings?.ui?.overviewWeekOpen ?? false);
  const setWeekOpenPersisted = useCallback((open: boolean) => {
    setWeekOpen(open);
    const current = uiStore.getState().settings;
    const ui = { ...current.ui, overviewWeekOpen: open };
    uiStore.patch({ settings: { ...current, ui } });
    void actions.saveSetting('ui', ui);
  }, [actions]);

  return (
    <>
      <TodayTodoCard reloadKey={todoReloadKey + todoRefreshTick} />
      {/* 黄金时段提示（第 239 轮巡检，建议/引导视角）：今日待办卡下方一行轻提示——
          在黄金时段 jade 软底 / 未到中性灰 / 无数据不渲染；与统计页「学习时段」卡
          共用 useTimeOfDayDistribution 取数（两视图互斥挂载，运行期无重复请求） */}
      <GoldenSlotHint />
      {/* 本周亮点（第 250 轮巡检，激励/榜样视角）：黄金提示行下方一行标杆——五档优先级
          取「本周最值得肯定的一件事」，无亮点不渲染；数据全取 data.report 现有字段 */}
      <WeeklyHighlightRow days={days} weekSec={weekSec} weeklyTargetSec={goalSec} />
      {/* 学习成就速览（第 127 轮总览新增；第 130 轮抽共享组件，B 站面板同挂）：直达统计页成就区 */}
      <AchievementStrip onViewAll={() => actions.setCenterView('stats')} />
      <section className="hdu-hero">
        <div className="hdu-hero-main">
          <div>
            <div className="hdu-hero-eyebrow">继续学习 · Continue</div>
            <h1 className="hdu-hero-title">
              {cont
                ? `接着上次，把《${cont.bundle.course.subjName}》听下去。`
                : biliResume
                  ? `B 站的《${biliResume.title}》还在等你继续。`
                  : '把课堂留下，把进度握在手里。'}
            </h1>
          </div>
          <div className="hdu-hero-meta">
            {cont ? (
              <>
                <span>{sessionLabel(cont.session)}</span>
                <span>·</span>
                <span>
                  {cont.session.lastPositionSec ? `上次看到 ${formatClock(cont.session.lastPositionSec)}` : '尚未开始'}
                </span>
                <span>·</span>
                <span>完看度 {Math.round((cont.session.watchRatio ?? 0) * 100)}%</span>
              </>
            ) : biliResume ? (
              <>
                <span>上次看到 {formatClock(biliResume.lastPositionSec)}</span>
                <span>·</span>
                <span>累计 {formatDuration(biliResume.totalSec)}</span>
              </>
            ) : (
              <span>{greeting()} 在课程页打开一节播放课，学习进度会自动记录在这里。</span>
            )}
          </div>
          <div className="hdu-hero-actions">
            {cont ? (
              <>
                <Button
                  variant="accent"
                  icon="play"
                  onClick={() => actions.openSessionInSite(cont.session.courId, cont.bundle.course.teclId, { teclCode: cont.bundle.course.teclCode })}
                >
                  继续学习
                </Button>
                <Button icon="list" onClick={() => actions.setCenterView('courses')}>
                  查看课程
                </Button>
              </>
            ) : biliResume ? (
              <>
                <Button
                  variant="accent"
                  icon="play"
                  onClick={() => window.open(withTimeParam(biliResume.url, biliResume.lastPositionSec), '_blank', 'noopener,noreferrer')}
                >
                  继续看 B 站
                </Button>
                <Button icon="chart" onClick={() => actions.setCenterView('stats')}>
                  学习统计
                </Button>
              </>
            ) : (
              <>
                <Button variant="accent" icon="book" onClick={() => actions.setCenterView('courses')}>
                  浏览我的课程
                </Button>
                <Button icon="external" onClick={() => actions.suppressCenter()}>
                  打开站点原页面
                </Button>
              </>
            )}
          </div>
          {/* B 站续看（第 86 轮巡检）：有 HDU 续学时作为次选入口；无 HDU 续学时上方的
              主按钮已直接切到 B 站续看（第 87 轮），此处不再重复 */}
          {cont && biliResume ? (
            <div className="hdu-hero-meta" style={{ marginTop: 10 }}>
              <a
                className="hdu-btn ghost small"
                href={withTimeParam(biliResume.url, biliResume.lastPositionSec)}
                target="_blank"
                rel="noopener noreferrer"
                title="打开 B 站并回到上次观看位置"
              >
                B 站续看：{biliResume.title}
                {biliResume.lastPositionSec > 0 ? `（上次到 ${formatClock(biliResume.lastPositionSec)}）` : ''}
              </a>
            </div>
          ) : null}
          {cont ? <Ring value={cont.session.watchRatio ?? 0} /> : null}
        </div>
        <div className="hdu-hero-side">
          {/* 今日目标（第 234 轮巡检）：Ring 进度（今日有效学习 / 每日目标）；达成 jade 填满 +
              「已达标」标注，未达成显示剩余分钟，今日 0 学习显示「尚未开始」。⚙ 跳设置页
              学习目标与统计口径区调整（与 StatsView 自定义徽章「去编辑」同一入口模式） */}
          <div className="hdu-mini-card">
            <div className="hdu-mini-label">
              今日目标
              <button
                type="button"
                className="hdu-goal-edit"
                title="在设置 · 学习目标与统计口径中调整每日目标"
                aria-label="调整每日目标"
                onClick={() => chrome.runtime.openOptionsPage()}
              >
                ⚙
              </button>
            </div>
            <div className="hdu-goal-ring-row">
              <div className={cx('hdu-goal-ring', dailyGoalDone ? 'is-done' : '')}>
                <Ring
                  value={dailyGoalSec > 0 ? todaySec / dailyGoalSec : 0}
                  size={56}
                  variant="card"
                  label={dailyGoalDone ? '已达标' : `${Math.round(Math.min(1, todaySec / dailyGoalSec) * 100)}%`}
                  labelSize={10}
                  title={`今日有效学习 ${formatDuration(todaySec)} / 每日目标 ${dailyGoalMin} 分钟`}
                />
              </div>
              <div className="hdu-goal-ring-main">
                <div className="hdu-goal-ring-value">
                  {Math.round(todaySec / 60)}
                  <small>/ {dailyGoalMin} 分钟</small>
                </div>
                <div className={cx('hdu-goal-ring-foot', dailyGoalDone ? 'is-done' : '')}>
                  {dailyGoalDone
                    ? '今日目标已达成，保持节奏'
                    : todaySec <= 0
                      ? '尚未开始'
                      : `还需 ${formatDuration(dailyGoalSec - todaySec)}`}
                </div>
              </div>
            </div>
            {/* 快捷模拟 chips（第 238 轮）：固定三档 what-if，即时行内结果；dailyGoalMin
                未配置时 clampDailyGoalMin 兜底默认 30 分钟，chips 照常工作 */}
            <DailyGoalSimChips todaySec={todaySec} dailyGoalSec={dailyGoalSec} done={dailyGoalDone} />
            {/* 本周目标达成 7 日格（第 256 轮，目标域）：零新增取数（report.days 复用），
                按「每日目标」口径逐日点亮——打卡线口径不受影响（见 buildWeeklyGoalCalendar 注释） */}
            <WeeklyGoalCalendarRow days={days} dailyGoalMin={dailyGoalMin} />
          </div>
          <div className="hdu-mini-card">
            <div className="hdu-mini-label">本周目标</div>
            <div className="hdu-mini-value">
              {(weekSec / 3600).toFixed(1)}
              <small>/ {(goalSec / 3600).toFixed(0)} 小时</small>
            </div>
            <Progress value={weekSec / goalSec} jade />
            <div className="hdu-mini-foot">
              {weekSec >= goalSec ? '本周目标已达成，保持节奏' : `还差 ${formatDuration(goalSec - weekSec)} 达成本周目标`}
            </div>
          </div>
          <div className="hdu-mini-card">
            <div className="hdu-mini-label">待补看</div>
            <div className="hdu-mini-value">
              {data.missed.length}
              <small>节</small>
            </div>
            <div className="hdu-mini-foot">
              {data.missed.length > 0 ? (
                <button type="button" className="hdu-btn ghost small" onClick={() => actions.setCenterView('schedule')}>
                  查看补看清单 <Icon name="arrowRight" size={12} />
                </button>
              ) : (
                '暂时没有需要补看的课次'
              )}
            </div>
          </div>
        </div>
      </section>

      <div className="hdu-section">
        <div className="hdu-stat-grid">
          <StatCard icon="clock" label="今日学习" value={Math.round(todaySec / 60)} unit="分钟" foot={todaySec >= CHECKIN_MIN_SEC ? '已达成今日打卡' : '再学 10 分钟即可打卡'} />
          <StatCard icon="chart" label="本周累计" value={(weekSec / 3600).toFixed(1)} unit="小时" foot={`共 ${days.slice(-7).filter((d) => d.validSec > 0).length} 天有学习记录`} />
          <StatCard icon="flame" label="连续学习" value={report?.streakDays ?? 0} unit="天" foot="按有有效观看的自然日计算" />
          <StatCard icon="target" label="完看课次" value={data.bundles.reduce((sum, b) => sum + b.finishedCount, 0)} unit="节" foot={`共 ${data.bundles.reduce((sum, b) => sum + b.sessionCount, 0)} 节课程`} />
        </div>
      </div>

      <div className="hdu-grid g2 hdu-section">
        {/* 近 7 天节奏折叠卡（第 244 轮巡检首屏密度审计）：默认收起只留摘要行，
            完整日柱趋势在统计页「近 30 天」（同粒度超集），展开态留跳转 */}
        <OverviewWeekCard
          last7={last7}
          open={weekOpen}
          onToggle={setWeekOpenPersisted}
          onViewStats={() => actions.setCenterView('stats')}
        />
        <div className="hdu-card pad">
          <SectionHead title="继续你的课程" sub={`${data.bundles.length} 门课程`} actions={<Button size="small" variant="ghost" icon="arrowRight" onClick={() => actions.setCenterView('courses')}>全部</Button>} />
          {data.loading ? (
            /* 骨架行数 / 高度对齐真实首屏（第 254 轮跳版核对）：列表渲染 slice(0, 4)，
               单行高 ≈ .hdu-list-row 上下 padding 24px + 标题 18px + 副行 15px ≈ 59px——
               骨架行 52px + 10px gap ≈ 62px 节距、4 行总高 ≈ 238px（真实 4 行 ≈ 236px），
               数据到达后容器高度基本不变，下方「待补看」区不再下坠跳版 */
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <Skeleton height={52} />
              <Skeleton height={52} />
              <Skeleton height={52} />
              <Skeleton height={52} />
            </div>
          ) : data.bundles.length === 0 ? (
            // 空库引导（第 256 轮，引导域）：EmptyState 说明现状 + 三步上手卡给路径，
            // 完成态用本数据包既有字段派生（bundles / report.totalSec / favorites·notes，零新增 op）。
            // 第 257 轮：步骤加直达动作——sync→立即同步（actions.syncCourses，与课程页按钮同链路）、
            // collect→去知识库（setCenterView('library')）；watch 步无站内动作不渲染按钮。
            <div className="hdu-onboard-wrap">
              <EmptyState icon="book" title="还没有课程记录" text="在智慧课堂打开任意一节播放课，课程与进度会自动汇总到这里。" />
              <OnboardingCard
                input={{
                  hasCourse: false,
                  hasWatch: (report?.totalSec ?? 0) > 0,
                  hasLibrary: data.favorites.length > 0 || data.notes.length > 0,
                }}
                actions={{
                  sync: {
                    label: '立即同步',
                    onClick: () => {
                      void (async () => {
                        await actions.syncCourses({ force: true, quiet: false });
                        // 同步完成后即时刷新数据包（第 258 轮）：引导卡完成态随新 bundles
                        // 立即点亮，不等下一次全局 reload 节奏（失败静默——syncCourses 内部
                        // 已有错误呈现，reload 失败按既有降级）
                        await data.reload?.();
                      })();
                    },
                  },
                  collect: { label: '去知识库', onClick: () => actions.setCenterView('library') },
                }}
                footer={
                  <div className="hdu-onboard-foot-row">
                    <span className="hdu-onboard-foot-hint">没有课程数据？先用假数据逛一遍全部功能。</span>
                    <DemoStartButton />
                  </div>
                }
              />
            </div>
          ) : (
            <div className="hdu-list">
              {data.bundles.slice(0, 4).map((bundle) => {
                const next = bundle.sessions.find((s) => s.watchState === 'watching') ?? bundle.sessions[0];
                return (
                  <div className="hdu-list-row" key={bundle.course.teclId}>
                    <div className="hdu-list-main">
                      <div className="hdu-list-title">{bundle.course.subjName}</div>
                      <div className="hdu-list-sub">
                        <span>{bundle.course.teacherNames.join('、') || '教师未知'}</span>
                        <span>{bundle.sessionCount} 节课</span>
                        <span>{formatDuration(bundle.watchedSec)}</span>
                      </div>
                    </div>
                    <div className="hdu-list-side">
                      <div style={{ width: 72 }}>
                        <Progress value={bundle.sessionCount > 0 ? bundle.finishedCount / bundle.sessionCount : 0} jade />
                      </div>
                      {next ? (
                        <Button size="small" variant="ghost" icon="play" onClick={() => actions.openSessionInSite(next.courId, bundle.course.teclId, { teclCode: bundle.course.teclCode })}>
                          学习
                        </Button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="hdu-section">
        <SectionHead
          title="待补看"
          sub={data.missed.length > 0 ? `${data.missed.length} 节课程结束后尚无有效观看` : '暂无'}
          actions={<Button size="small" variant="ghost" icon="arrowRight" onClick={() => actions.setCenterView('schedule')}>全部</Button>}
        />
        {data.missed.length === 0 ? (
          <div className="hdu-card">
            {/* 空态同域同句（第 249 轮空态模板化）：与 ScheduleView 待补看空态统一 title/text */}
            <EmptyState icon="check" title="没有待补看的课次" text="已结束的课次都有有效观看记录，或已标记为到课。" />
          </div>
        ) : (
      <MissedList items={data.missed.slice(0, 4)} onExcluded={() => void data.reload?.()} />
        )}
      </div>
    </>
  );
}
