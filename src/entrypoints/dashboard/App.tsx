import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { callOp } from '@/core/shared/client';
import { AppError, errorTextOf } from '@/core/shared/errors';
import { getDb } from '@/core/db';
import type { ExportJobRecord } from '@/core/db/schema';
import type { PeriodReport } from '@/core/stats/period';
import { loadSettings, saveSettings } from '@/core/shared/settings';
import { pushRecentQuery, recentQueryLabel, removeRecentQuery, RECENT_QUERY_CAP } from '../content/ui/learning/recentQueries';
import { applyDebugLogEnabled } from '@/core/shared/logger';
import type {
  AppSettings,
  DashboardReport,
  FavoriteEntity,
  FavoriteType,
  FolderEntity,
  NoteEntity,
  ReviewJobEntity,
  ScreenshotEntity,
  TagEntity,
} from '@/core/shared/types';
import type { MissedItem } from '@/core/shared/ops';
import { formatBytes, formatClock, formatDuration, formatMonthDay, localDayKey, shortDayLabel, uuid } from '@/core/shared/utils';
import { SITE_ORIGINS } from '@/core/shared/constants';
import { lessonHash } from '../content/site/navigation';
import { clampDailyGoalMin } from '@/core/plan/dailyGoal';
import { buildTodayPlan, type TodayPlan } from '@/core/plan/today';
import { weeklyGoalStreak } from '@/core/stats/period';
import { weeklyGoalForecast } from '@/core/stats/forecast';
import { useResolvedTheme } from '@/core/shared/useResolvedTheme';
import { FAVORITE_META, VideoFavCard } from '../content/ui/VideoFavCard';
import { FavoriteEditModal } from '../content/ui/FavoriteEditModal';
import { BiliWatchCard } from '../content/ui/BiliWatchCard';
import { ActivityHeatmap } from '../content/ui/learning/ActivityHeatmap';
import { OnboardingCard } from '../content/ui/learning/OnboardingCard';
import { DemoBadge, DemoStartButton } from '../content/ui/DemoBadge';
import { WeeklyGoalCalendarRow } from '../content/ui/learning/OverviewView';
import { ErrorBoundary } from '../content/ui/ErrorBoundary';
import { UI_CSS } from '../content/ui/styles';
import { BarChart, Button, Chip, ConfirmButton, ConfirmIconButton, EmptyState, IconButton, Progress, SectionHead, Skeleton, StatCard, cx } from '../content/ui/components';
import { Icon, type IconName } from '../content/ui/icons';

const EXTRA_CSS = String.raw`
html, body { margin: 0; height: 100%; background: #f5f1e8; }
body.dark { background: #131518; }
.hdu-dash { display: flex; height: 100vh; background: var(--paper); overflow: hidden; }
.hdu-dash-nav { width: 232px; flex: 0 0 232px; border-right: 1px solid var(--line); background: color-mix(in srgb, var(--paper-2) 60%, transparent); padding: 22px 14px; display: flex; flex-direction: column; gap: 24px; }
.hdu-dash-main { flex: 1; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
.hdu-dash-content { flex: 1; overflow: auto; }
.hdu-dash-inner { max-width: 1120px; margin: 0 auto; padding: 30px 36px 90px; }
.hdu-dash .hdu-knowledge-grid { grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
.hdu-shot-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
.hdu-shot { overflow: hidden; border-radius: 14px; border: 1px solid var(--line); background: var(--paper-2); }
.hdu-shot img { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; display: block; background: var(--paper-3); }
.hdu-shot-meta { padding: 9px 11px; font-size: 10.5px; color: var(--muted); display: flex; align-items: center; gap: 6px; }
.hdu-review-row { display: flex; align-items: center; gap: 12px; padding: 13px 0; border-bottom: 1px solid var(--line); }
.hdu-review-row:last-child { border-bottom: 0; }
.hdu-kv { display: grid; grid-template-columns: 130px 1fr; gap: 8px 14px; font-size: 12px; }
.hdu-kv dt { color: var(--muted); }
.hdu-kv dd { margin: 0; }
.hdu-options-row { display: flex; align-items: center; gap: 14px; padding: 10px 0; }
.hdu-options-row-main { flex: 1; min-width: 0; }
.hdu-options-row-title { font-size: 13px; font-weight: 500; }
.hdu-options-row-sub { font-size: 11.5px; color: var(--muted); margin-top: 2px; line-height: 1.6; }
.hdu-options-row-side { flex: 0 0 auto; }
.hdu-dash .hdu-nav { flex-direction: column; gap: 3px; }
.hdu-dash .hdu-nav-item { width: 100%; }
/* 概览指标行（7 张卡：累计 / 站外视频 / 本周 / 连续 / 本周打卡 / 今日目标 / 今日待办，
   第 234 轮加今日目标、第 255 轮加今日待办）；窄屏收编（7 卡 → 4+3 → 2 列流） */
.hdu-dash .hdu-grid.g5 { grid-template-columns: repeat(7, minmax(0, 1fr)); }
@media (max-width: 1080px) { .hdu-dash .hdu-grid.g5 { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
@media (max-width: 640px) { .hdu-dash .hdu-grid.g5 { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 820px) {
  .hdu-dash .hdu-nav { flex-direction: column; }
  .hdu-dash .hdu-nav-item { width: 100%; padding: 10px 12px; }
}
@media (max-width: 640px) { .hdu-dash-nav { width: 68px; flex-basis: 68px; } .hdu-dash-nav .hdu-nav-label, .hdu-dash-nav .hdu-nav-item span, .hdu-dash-nav .hdu-brand-name, .hdu-dash-nav .hdu-brand-sub { display: none; } .hdu-dash-nav .hdu-nav-item { justify-content: center; width: 100%; } .hdu-dash-inner { padding: 20px 18px 70px; } }
`;

type DashView = 'overview' | 'library' | 'review' | 'data';
/** 通知函数签名（第 226 轮扩展）：可选 action（如「撤销」），带 action 的提示停留更久 */
type NotifyFn = (text: string, error?: boolean, action?: { label: string; run: () => Promise<void> }) => void;

const NAV: Array<{ key: DashView; label: string; icon: IconName }> = [
  { key: 'overview', label: '学习概览', icon: 'chart' },
  { key: 'library', label: '知识库', icon: 'library' },
  { key: 'review', label: '复习计划', icon: 'refresh' },
  { key: 'data', label: '数据管理', icon: 'layers' },
];

export function App() {
  // 初始视图支持 hash 深链（第 85 轮巡检）：popup 待办卡等入口可直达对应视图
  // （如 dashboard.html#review）；非法/缺省回落 overview
  const [view, setView] = useState<DashView>(() => {
    const hash = typeof window !== 'undefined' ? window.location.hash.replace('#', '') : '';
    return (['overview', 'library', 'review', 'data'] as DashView[]).includes(hash as DashView)
      ? (hash as DashView)
      : 'overview';
  });
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [toast, setToast] = useState<{ text: string; error?: boolean; action?: { label: string; run: () => Promise<void> } } | null>(null);
  const theme = useResolvedTheme(settings);

  useEffect(() => {
    // 诊断日志开关应用（第 299 轮，工程域）：看板上下文同受「记录诊断日志」约束
    void loadSettings().then((loaded) => {
      applyDebugLogEnabled(loaded.debug.logEnabled);
      setSettings(loaded);
    });
  }, []);
  useEffect(() => {
    document.body.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  // notify（第 226 轮扩展）：可选 action（如「撤销」）——带 action 的提示停留 6s，普通 3.2s
  const notify = useCallback((text: string, error = false, action?: { label: string; run: () => Promise<void> }) => {
    setToast({ text, error, action });
    window.setTimeout(() => setToast(null), action ? 6000 : 3200);
  }, []);

  return (
    <div className={cx('hdu-root', 'hdu-dash')} data-theme={theme}>
      <style>{UI_CSS + EXTRA_CSS}</style>
      <aside className="hdu-dash-nav">
        <div className="hdu-brand">
          <div className="hdu-brand-mark">学</div>
          <div>
            <div className="hdu-brand-name">学习看板</div>
            <div className="hdu-brand-sub">Dashboard</div>
          </div>
        </div>
        <nav className="hdu-nav">
          <div className="hdu-nav-label">我的数据</div>
          {NAV.map((item) => (
            <button type="button" key={item.key} className={cx('hdu-nav-item', view === item.key ? 'is-active' : '')} onClick={() => setView(item.key)}>
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="hdu-rail-foot">
          <Button size="small" variant="ghost" icon="settings" onClick={() => chrome.runtime.openOptionsPage()}>设置</Button>
          <div className="hdu-hint">全部数据只保存在本机</div>
        </div>
      </aside>
      <main className="hdu-dash-main">
        <div className="hdu-topbar">
          <div>
            <div className="hdu-topbar-title">{NAV.find((n) => n.key === view)?.label}</div>
            <div className="hdu-topbar-sub">
              {view === 'overview' ? '透明口径，只看有效学习' : view === 'library' ? '收藏、笔记与截图' : view === 'review' ? '间隔复习，别忘了回头' : '导出、导入、回收站与清理'}
            </div>
          </div>
          <div className="hdu-topbar-actions">
            <DemoBadge />
            {toast ? (
              <>
                <Chip tone={toast.error ? 'danger' : 'jade'} icon={toast.error ? 'alert' : 'check'}>{toast.text}</Chip>
                {/* 撤销等操作入口（第 226 轮巡检）：点击即执行并收起提示 */}
                {toast.action ? (
                  <Button
                    size="small"
                    variant="ghost"
                    onClick={() => {
                      const run = toast.action?.run;
                      setToast(null);
                      if (run) void run();
                    }}
                  >
                    {toast.action.label}
                  </Button>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
        <div className="hdu-dash-content hdu-scroll">
          <div className="hdu-dash-inner">
            {/* 视图级错误边界（第 273 轮，健壮性域）：单视图渲染错误只降级当前内容区
                （侧边导航不受影响），切视图经 key 重建自动复位 */}
            <ErrorBoundary key={view} entry={`dashboard/${view}`} retryable={false}>
              {view === 'overview' ? <Overview notify={notify} settings={settings} onNavigate={setView} /> :
                view === 'library' ? <Library notify={notify} /> :
                view === 'review' ? <Review notify={notify} /> :
                <Data notify={notify} />}
            </ErrorBoundary>
          </div>
        </div>
      </main>
    </div>
  );
}

// ───────────────────────── 概览 ─────────────────────────

/** 导出供单元测试（two-step-confirm.test.ts / stats-period-summary-ui.test.ts）：概览的行为验证 */
export function Overview({
  notify,
  settings = null,
  onNavigate,
}: {
  notify: NotifyFn;
  settings?: AppSettings | null;
  /** 视图切换回调（第 258 轮，引导域）：空课次引导卡「去知识库」动作的直达出口；
   *  缺省（既有用例/无动作场景）时 collect 步不渲染按钮——组件不感知路由细节 */
  onNavigate?: (view: 'overview' | 'library' | 'review' | 'data') => void;
}) {
  const [report, setReport] = useState<DashboardReport | null>(null);
  const [weekReport, setWeekReport] = useState<PeriodReport | null>(null);
  // 周目标连续达成周数（第 235 轮巡检，激励视角延伸；与学习中心统计页同口径同函数）
  const [goalStreakWeeks, setGoalStreakWeeks] = useState(0);
  // 今日待办聚合（第 255 轮口径一致性轮）：与 popup 今日待办卡 / 学习中心 TodayTodoCard
  // 完全同口径（同一组 op + 同参数 + 同一 buildTodayPlan 纯函数），补 dashboard 侧缺口
  const [todoPlan, setTodoPlan] = useState<TodayPlan | null>(null);
  // 知识库存在性探测（第 256 轮，引导域）：空课次引导卡的「沉淀知识」步完成态——
  // fav.list 只取 1 条 / note.listAll 本地规模小，仅判存在性不参与渲染明细
  const [libProbe, setLibProbe] = useState<{ fav: boolean; note: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    // 「本周学习」卡取数口径对齐义务（照 popup 变量化注释的先例）：本卡数字必须与学习中心统计页
    // PeriodReportCard 的「本周」视图完全同源——同一个 stats.period op、同参数 { kind: 'week', count: 1 }
    // （对应 LearningCenter PERIOD_OPTIONS 的 w1 项，聚合口径见 core/stats/period 纯函数），
    // 不使用 stats.report 的 weekSec（那是 buildReport 侧口径，与周期聚合桶可能存在跨零点归属差异）。
    // 展示格式亦对齐：小时 = (秒 / 3600).toFixed(1)，计划完成度 = Math.round(ratio * 100)%；
    // 任一侧调整 kind/count 或展示格式时，三端（popup / dashboard / 学习中心）须同步修改。
    // 「今日待办」卡取数口径对齐义务（第 255 轮三方口径对照表，见巡检日志）：四路信号与
    // popup（popup/App.tsx）/ 学习中心（TodayTodoCard.useTodayPlan）逐项同参——
    // review.due {} / schedule.missed {} / fav.list { type:'video', limit:500 } /
    // todo.today.get { date: 本地日键 }，同一 buildTodayPlan 聚合；任一路失败按空降级，
    // 不拖垮概览其余区块。weeklyBvids（每周计划今日批次排前）为学习中心侧增强，不影响计数。
    const [r, week, weekHistory, todo] = await Promise.all([
      callOp('stats.report', { days: 90 }).catch(() => null),
      callOp('stats.period', { kind: 'week', count: 1 }).catch(() => null),
      // 第 235 轮巡检：周目标连续达成周数用周达成史（count: 8 回看 8 周；失败按 0，徽标不显示）。
      // 与上方 count: 1 的「本周学习」卡取数分离，避免改动既有口径对齐义务注释所锁定的参数
      callOp('stats.period', { kind: 'week', count: 8 }).catch(() => null),
      Promise.all([
        callOp('review.due', {}).catch(() => [] as Array<ReviewJobEntity & { favorite: FavoriteEntity | null }>),
        callOp('schedule.missed', {}).catch(() => [] as MissedItem[]),
        callOp('fav.list', { filter: { type: 'video', limit: 500 } }).catch(() => [] as FavoriteEntity[]),
        callOp('todo.today.get', { date: localDayKey() }).catch(() => [] as string[]),
      ]).then(([dueReviews, missedSessions, videoFavorites, doneKeys]) =>
        buildTodayPlan({ dueReviews, missedSessions, videoFavorites, doneKeys, today: localDayKey() }),
      ),
    ]);
    setReport(r);
    setWeekReport(week);
    setTodoPlan(todo);
    // 知识库存在性探测（第 256 轮）：失败按「未知」= null（引导卡第三步如实不点亮）
    const [favProbe, noteProbe] = await Promise.all([
      callOp('fav.list', { filter: { limit: 1 } })
        .then((list) => (Array.isArray(list) ? list.length > 0 : false))
        .catch(() => null),
      callOp('note.listAll', {})
        .then((list) => (Array.isArray(list) ? list.length > 0 : false))
        .catch(() => null),
    ]);
    setLibProbe(favProbe === null || noteProbe === null ? null : { fav: favProbe, note: noteProbe });
    setGoalStreakWeeks(weeklyGoalStreak(Array.isArray(weekHistory?.buckets) ? weekHistory.buckets : [], r?.goal?.weeklyTargetSec ?? 0));
    setLoading(false);
  }, []);
  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => void reload(), 30_000);
    return () => window.clearInterval(timer);
  }, [reload]);

  if (loading || !report) {
    return <div className="hdu-card pad"><Skeleton height={24} width="30%" /><div style={{ height: 16 }} /><Skeleton height={120} /></div>;
  }

  const last30 = report.days.slice(-30).map((d) => ({ label: shortDayLabel(d.date).slice(3), value: d.validSec, today: d.date === localDayKey() }));
  const maxCourse = Math.max(1, ...report.courses.map((c) => c.totalSec));
  const goalRatio = report.goal.weeklyTargetSec > 0 ? report.goal.weekSec / report.goal.weeklyTargetSec : 0;
  // 每日目标（第 234 轮巡检，与学习中心总览「今日目标」卡同口径：仅展示与激励层，
  // 不改打卡判定线）；settings 未就绪时 clamp 回退默认 30
  const dailyGoalMin = clampDailyGoalMin(settings?.dailyGoalMin);
  const dailyGoalSec = dailyGoalMin * 60;
  const dailyGoalDone = report.todaySec >= dailyGoalSec;
  // 本周桶 = PeriodReport.buckets 最后一项（旧 → 新排列；口径对齐义务见 reload 内注释）
  const weekBucket = weekReport?.buckets[weekReport.buckets.length - 1] ?? null;
  // 周目标达成预测（第 236 轮巡检，目标管理 / 预测视角）：与学习中心统计页同款
  // weeklyGoalForecast 纯函数，取数同源本卡既有口径（report.weekSec + goal.weeklyTargetSec）；
  // mini-foot 追加紧凑预测片段——已达标 / 新周未开始 / 未设目标不追加（避免与既有
  // 「目标 N%」重复），纯展示层不改统计口径
  const weekForecast =
    report.goal.weeklyTargetSec > 0
      ? weeklyGoalForecast({ now: Date.now(), weekSec: report.weekSec, targetSec: report.goal.weeklyTargetSec })
      : null;
  const forecastFoot = (() => {
    if (!weekForecast || report.weekSec >= report.goal.weeklyTargetSec) return '';
    if (weekForecast.daysLeft === 7 && report.weekSec === 0) return ''; // 新周态：既有 0% 已表意
    const minutes = Math.round(weekForecast.neededPerDaySec / 60);
    const pace = weekForecast.willHit
      ? '可达成'
      : `预计差 ${Math.round(Math.abs(weekForecast.aheadBehindSec) / 60)} 分`;
    return ` · 日均 ${minutes} 分（剩 ${weekForecast.daysLeft} 天）${pace}`;
  })();

  return (
    <>
      <div className="hdu-grid g5">
        <div className="hdu-card hdu-metric"><div className="hdu-metric-head"><Icon name="clock" /> 累计</div><div className="hdu-metric-value">{Math.round(report.totalSec / 3600)}<small>小时</small></div></div>
        {/* 站外视频时长：与学习中心统计页同口径（stats.engine 的 externalSeconds，分钟展示，独立口径不并入站内） */}
        <div className="hdu-card hdu-metric"><div className="hdu-metric-head"><Icon name="video" /> 站外视频</div><div className="hdu-metric-value">{Math.round(report.externalSeconds / 60)}<small>分钟</small></div><div className="hdu-mini-foot">B 站等 · 独立口径</div></div>
        <div className="hdu-card hdu-metric"><div className="hdu-metric-head"><Icon name="chart" /> 本周</div><div className="hdu-metric-value">{(report.weekSec / 3600).toFixed(1)}<small>小时</small></div><div className="hdu-mini-foot">目标 {Math.round(goalRatio * 100)}%{goalStreakWeeks >= 2 ? ` · 🔥 连续达成 ${goalStreakWeeks} 周` : ''}{forecastFoot}</div></div>
        <div className="hdu-card hdu-metric"><div className="hdu-metric-head"><Icon name="flame" /> 连续</div><div className="hdu-metric-value">{report.streakDays}<small>天</small></div></div>
        <div className="hdu-card hdu-metric"><div className="hdu-metric-head"><Icon name="target" /> 本周打卡</div><div className="hdu-metric-value">{report.goal.hitDaysThisWeek}<small>天</small></div><div className="hdu-mini-foot">每日 ≥10 分钟</div></div>
        {/* 今日目标（第 234 轮巡检）：与学习中心总览 mini 卡同口径同文案，双端一致 */}
        <div className="hdu-card hdu-metric"><div className="hdu-metric-head"><Icon name="check" /> 今日目标</div><div className="hdu-metric-value">{Math.round(report.todaySec / 60)}<small>/{dailyGoalMin} 分钟</small></div><Progress value={dailyGoalSec > 0 ? Math.min(1, report.todaySec / dailyGoalSec) : 0} jade={dailyGoalDone} /><div className="hdu-mini-foot">{dailyGoalDone ? '已达标，保持节奏' : report.todaySec > 0 ? `还需 ${formatDuration(dailyGoalSec - report.todaySec)}` : '尚未开始'}</div></div>
        {/* 今日待办（第 255 轮口径一致性轮，三方口径对照表见巡检日志）：popup / 学习中心
            TodayTodoCard 均有今日待办完成度而 dashboard 此前缺失——反向补齐。取数与
            buildTodayPlan 聚合与两方完全同口径（见 reload 内对齐义务注释）；
            数字行 serif + tabular-nums 与相邻指标卡同刻度，进度条复用共享 .hdu-progress（jade），
            暗色由 .hdu-root[data-theme="dark"] 自动跟随 */}
        <div className="hdu-card hdu-metric"><div className="hdu-metric-head"><Icon name="list" /> 今日待办</div><div className="hdu-metric-value">{todoPlan?.doneCount ?? 0}<small>/ {todoPlan?.totalCount ?? 0} 项</small></div><Progress value={todoPlan && todoPlan.totalCount > 0 ? todoPlan.doneCount / todoPlan.totalCount : 0} jade={!!todoPlan && todoPlan.totalCount > 0 && todoPlan.doneCount === todoPlan.totalCount} /><div className="hdu-mini-foot">{!todoPlan || todoPlan.totalCount === 0 ? '今日暂无待办事项' : todoPlan.doneCount === todoPlan.totalCount ? '待办全部完成' : `完成度 ${Math.round((todoPlan.doneCount / todoPlan.totalCount) * 100)}%`}</div></div>
      </div>

      {/* 「本周学习」周报摘要卡（取数与口径对齐义务见 reload 内注释；取数失败静默降级为不渲染本卡）。
          数字卡样式与学习中心 PeriodReportCard 完全同款（StatCard + hdu-stat-grid），便于三端逐项比对。
          dashboard 无打开学习中心的既有机制（openCenter 是 content-script store action，需站点页消息通道），
          故不加跳转，遵守「不造新机制」约定。 */}
      {weekBucket ? (
        <div className="hdu-card pad" style={{ marginTop: 14 }}>
          <SectionHead title="本周学习" sub={`${weekBucket.label} · 与学习中心统计页「本周」同口径`} />
          <div className="hdu-stat-grid">
            <StatCard icon="clock" label="站内学习" value={(weekBucket.internalSec / 3600).toFixed(1)} unit="小时" foot={`有效口径 · 流水 ${weekBucket.flowCount} 条`} />
            <StatCard icon="video" label="站外视频" value={(weekBucket.externalSec / 3600).toFixed(1)} unit="小时" foot="B 站等站外独立口径" />
            <StatCard icon="flame" label="活跃天数" value={weekBucket.activeDays} unit="天" foot="站内或站外有学习的自然日" />
            <StatCard
              icon="target"
              label="计划完成度"
              value={weekBucket.plan ? Math.round(weekBucket.plan.ratio * 100) : '—'}
              unit={weekBucket.plan ? '%' : undefined}
              foot={weekBucket.plan ? `完看 ${weekBucket.plan.finished} / 计划 ${weekBucket.plan.total} 个` : '该周无计划排期'}
            />
          </div>
          <div className="hdu-hint" style={{ marginTop: 12 }}>完整周报 / 月报（趋势与逐周期明细）见学习中心 · 统计页</div>
        </div>
      ) : null}

      {/* B 站视频学习统计卡（与学习中心统计页共用 BiliWatchCard；固定本周口径，挂在「本周学习」摘要区旁）。
          自带加载 / 空态 / 失败重试态，取数走 stats.bili.overview op，与上方摘要卡互不影响。 */}
      <BiliWatchCard range="week" />

      {/* 学习热力图（第 78 轮巡检）：与学习中心统计页 / B 站学习中心同一 ActivityHeatmap
          （stats.heatmap，周列×7行日级强度，近 13/26/52 周可切），看板第三落点同源同口径。
          深链核对（第 249 轮）：看板是独立扩展页、无 HDU 内容脚本的 uiStore 跳转实现
          （缺省 openSessionInSite 为 noop，点「回看」无响应）——与 B 站宿主 openHduSession
          同策略覆写为新标签打开 HDU 播放页深链，弹层课次行「回看」在看板内真正可达。 */}
      <ActivityHeatmap
        onOpenCourse={(courId, teclId) => {
          if (!Number.isFinite(courId) || courId <= 0) return;
          window.open(`${SITE_ORIGINS.campus}/${lessonHash({ courId, teclId, prefer: 'play-center' })}`, '_blank', 'noopener,noreferrer');
        }}
      />

      <div className="hdu-section">
        <SectionHead title="近 30 天" sub="有效学习时长" actions={<Button size="small" variant="ghost" icon="refresh" onClick={() => void reload()}>刷新</Button>} />
        <div className="hdu-card pad">
          <BarChart data={last30} height={180} />
          <div className="hdu-chart-legend" style={{ marginTop: 10 }}>
            <span><span className="hdu-dot ok" /> 今天</span>
            <span>仅播放中 + 前台可见 + 非挂机</span>
          </div>
        </div>
      </div>

      <div className="hdu-grid g2 hdu-section">
        <div className="hdu-card pad">
          <SectionHead title="课程分布" sub="按有效时长" />
          <div className="hdu-dist">
            {report.courses.slice(0, 10).map((course) => (
              <div className="hdu-dist-row" key={course.teclId}>
                <span className="hdu-dist-name">{course.courseName}</span>
                <div className="hdu-dist-bar"><i style={{ width: `${(course.totalSec / maxCourse) * 100}%` }} /></div>
                <span className="hdu-dist-val">{formatDuration(course.totalSec)}</span>
              </div>
            ))}
            {report.courses.length === 0 ? <div className="hdu-hint">暂无数据</div> : null}
          </div>
        </div>
        <div className="hdu-card pad">
          <SectionHead title="本周目标" sub={`${(report.goal.weekSec / 3600).toFixed(1)} / ${(report.goal.weeklyTargetSec / 3600).toFixed(0)} 小时`} />
          <div style={{ display: 'flex', justifyContent: 'center', padding: '12px 0' }}>
            <RingLarge value={Math.min(1, goalRatio)} />
          </div>
          <div className="hdu-hint" style={{ textAlign: 'center' }}>
            {goalRatio >= 1 ? '本周目标已达成' : `还差 ${formatDuration(Math.max(0, report.goal.weeklyTargetSec - report.goal.weekSec))}`}
          </div>
          {/* 本周目标达成 7 日格（第 257 轮，目标域延续）：与学习中心「今日目标」卡同款
              组件同源口径（buildWeeklyGoalCalendar），days 复用 stats.report 90 天日报窗口
              （覆盖本周），零新增取数；每日目标线与打卡线相互独立（见 dailyGoal.ts 注释） */}
          <WeeklyGoalCalendarRow days={report.days} dailyGoalMin={dailyGoalMin} />
        </div>
      </div>

      <div className="hdu-section">
        <SectionHead title="课次明细" sub="完看度 = 有效观看 / 课次时长" />
        <div className="hdu-card pad">
          {report.sessions.length === 0 ? (
            // 空课次引导（第 256 轮，引导域）：EmptyState 说明现状 + 三步上手卡给路径；
            // libProbe 未知（取数失败）时 hasLibrary 传 undefined——第三步如实不点亮
            <div className="hdu-onboard-wrap">
              <EmptyState icon="list" title="暂无课次数据" text="打开一节播放课并观看一段时间。" />
              <OnboardingCard
                input={{
                  hasCourse: report.courses.length > 0,
                  hasWatch: report.totalSec > 0,
                  hasLibrary: libProbe ? libProbe.fav || libProbe.note : undefined,
                }}
                actions={
                  onNavigate
                    ? { collect: { label: '去知识库', onClick: () => onNavigate('library') } }
                    : undefined
                }
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
              {report.sessions.slice(0, 40).map((session) => (
                <div className="hdu-list-row" key={session.courId}>
                  <div className="hdu-list-main">
                    <div className="hdu-list-title">{session.courseName}</div>
                    <div className="hdu-list-sub"><span>{session.courLabel}</span><span>{formatDuration(session.watchedSec)} / {formatDuration(session.durationSec)}</span></div>
                  </div>
                  <div className="hdu-list-side" style={{ minWidth: 170 }}>
                    <div style={{ width: 90 }}><Progress value={session.watchRatio} jade /></div>
                    <span className="hdu-time-badge">{Math.round(session.watchRatio * 100)}%</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
        {/* 两步确认：第一次点击仅进入确认态（红色文案「再点一次确认清空统计」，3 秒复原），第二次点击才清空 */}
        <ConfirmButton size="small" variant="ghost" icon="trash" confirmLabel="再点一次确认清空统计" onConfirm={async () => {
          await callOp('stats.clear', {});
          notify('学习统计已清空');
          void reload();
        }}>清空统计</ConfirmButton>
      </div>
    </>
  );
}

function RingLarge({ value }: { value: number }) {
  const size = 150;
  const stroke = 10;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div className="hdu-ring" style={{ width: size, height: size }}>
      <svg width={size} height={size}>
        <circle className="hdu-ring-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} />
        <circle className="hdu-ring-fill" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} strokeDasharray={c} strokeDashoffset={c * (1 - value)} />
      </svg>
      <span className="hdu-ring-label" style={{ fontSize: 26 }}>{Math.round(value * 100)}%</span>
    </div>
  );
}

// ───────────────────────── 知识库 ─────────────────────────

/** 导出供单元测试（two-step-confirm.test.ts）：笔记/截图删除两步确认的行为验证 */
export function Library({ notify }: { notify: NotifyFn }) {
  const [favorites, setFavorites] = useState<FavoriteEntity[]>([]);
  const [folders, setFolders] = useState<FolderEntity[]>([]);
  const [tags, setTags] = useState<TagEntity[]>([]);
  const [notes, setNotes] = useState<NoteEntity[]>([]);
  const [shots, setShots] = useState<Array<Omit<ScreenshotEntity, 'blob'>>>([]);
  // 上次复习完成时间（第 225 轮巡检）：与学习中心同口径，卡片显示「上次复习 MM/DD」
  const [lastReviewDoneLabels, setLastReviewDoneLabels] = useState<Map<string, string>>(new Map());
  const [type, setType] = useState<FavoriteType | 'all'>('all');
  const [folder, setFolder] = useState<string | 'all'>('all');
  const [query, setQuery] = useState('');
  // 搜索框引用（第 285 轮）：× 清空后焦点回归输入框（四端一致）
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  // 最近搜索（第 303 轮，检索域）：与统一搜索 / 学习中心知识库共用 settings.ui.recentQueries；
  // 看板无 uiStore，直接 loadSettings/saveSettings 读写（deepMerge 只动 ui.recentQueries）
  const [recentQueries, setRecentQueries] = useState<string[]>([]);
  useEffect(() => {
    void loadSettings().then((s) => setRecentQueries(s.ui?.recentQueries ?? []));
  }, []);
  const persistRecent = useCallback((next: string[]) => {
    setRecentQueries(next);
    void (async () => {
      const current = await loadSettings();
      await saveSettings({ ui: { ...current.ui, recentQueries: next } });
    })();
  }, []);
  useEffect(() => {
    const kw = query.trim();
    if (!kw) return;
    const timer = window.setTimeout(() => {
      const next = pushRecentQuery(recentQueries, kw, RECENT_QUERY_CAP);
      if (JSON.stringify(recentQueries) !== JSON.stringify(next)) persistRecent(next);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [query, recentQueries, persistRecent]);
  const [editing, setEditing] = useState<FavoriteEntity | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const [f, fo, t, n, s, rj] = await Promise.all([
      callOp('fav.list', { filter: { limit: 1000 } }).catch(() => []),
      callOp('folder.list', { includeArchived: true }).catch(() => []),
      callOp('tag.list', {}).catch(() => []),
      callOp('note.list', {}).catch(() => []),
      callOp('shot.list', {}).catch(() => []),
      callOp('review.list', {}).catch(() => []),
    ]);
    setFavorites(f);
    // 上次复习完成时间（第 225 轮巡检）：done 作业按收藏取最近一次 updatedAt → 'MM/DD'
    {
      const latest = new Map<string, number>();
      for (const job of rj) {
        if (!job || job.status !== 'done' || typeof job.favoriteId !== 'string') continue;
        const ts = typeof job.updatedAt === 'number' ? job.updatedAt : 0;
        const prev = latest.get(job.favoriteId);
        if (prev === undefined || ts > prev) latest.set(job.favoriteId, ts);
      }
      const labels = new Map<string, string>();
      for (const [id, ts] of latest) {
        const label = formatMonthDay(ts);
        if (label) labels.set(id, label);
      }
      setLastReviewDoneLabels(labels);
    }
    setFolders(fo);
    setTags(t);
    setNotes(n);
    setShots(s);
    setLoading(false);
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return favorites.filter((fav) => {
      if (type !== 'all' && fav.type !== type) return false;
      if (folder !== 'all' && (fav.folderId ?? '') !== folder) return false;
      if (q) {
        const hay = `${fav.snapshot.title} ${fav.snapshot.content} ${fav.note ?? ''} ${fav.tags.join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [favorites, type, folder, query]);

  // 两步确认后的实际执行：ConfirmIconButton 第一次点击只进入确认态（图标变警示色 + title 切换），第二次点击才删除
  const remove = async (fav: FavoriteEntity) => {
    await callOp('fav.softDelete', { ids: [fav.id] });
    // 撤销入口（第 226 轮巡检）：软删除即入回收站，5 秒等待窗口内可一键还原
    notify('已移入回收站', false, {
      label: '撤销',
      run: async () => {
        await callOp('trash.restore', { keys: [`favorite:${fav.id}`] });
        notify('已撤销删除');
        void reload();
      },
    });
    void reload();
  };

  return (
    <>
      <div className="hdu-filterbar">
        <div className="hdu-search">
          <Icon name="search" />
          <input
            ref={searchInputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索收藏、笔记与标签…"
            aria-label="搜索收藏、笔记与标签"
          />
          {/* 清除搜索（第 276 轮，检索域 / 四端一致）：与统一搜索 / 学习中心知识库 × 同款；
              第 285 轮：清空后焦点回归输入框 */}
          {query ? (
            <button
              type="button"
              className="hdu-search-clear"
              aria-label="清空搜索"
              title="清空搜索"
              onClick={() => {
                setQuery('');
                searchInputRef.current?.focus();
              }}
            >
              ×
            </button>
          ) : null}
        </div>
        {/* 最近搜索回放（第 303 轮，检索域）：搜索词为空时平铺最近关键词（与统一搜索 /
            学习中心知识库同源 settings.ui.recentQueries），点击即重搜、可单条删除 */}
        {!query.trim() && recentQueries.length > 0 ? (
          <div className="hdu-lib-recent" role="group" aria-label="从最近搜索重试">
            <span className="hdu-lib-recent-label">最近搜索</span>
            {recentQueries.map((q) => (
              <span key={q} className="hdu-lib-recent-chip">
                <button
                  type="button"
                  title={q}
                  onClick={() => {
                    setQuery(q);
                    searchInputRef.current?.focus();
                  }}
                >
                  {recentQueryLabel(q)}
                </button>
                <button
                  type="button"
                  className="hdu-lib-recent-del"
                  aria-label={`删除最近搜索 ${q}`}
                  title="删除该条最近搜索"
                  onClick={() => persistRecent(removeRecentQuery(recentQueries, q))}
                >
                  ×
                </button>
              </span>
            ))}
            <button type="button" className="hdu-lib-recent-clear" onClick={() => { void persistRecent([]); searchInputRef.current?.focus(); }}>清空</button>
          </div>
        ) : null}
        <button type="button" className={cx('hdu-filter-pill', type === 'all' ? 'is-active' : '')} onClick={() => setType('all')}>全部</button>
        {(Object.keys(FAVORITE_META) as FavoriteType[]).map((key) => (
          <button type="button" key={key} className={cx('hdu-filter-pill', type === key ? 'is-active' : '')} onClick={() => setType(key)}>{FAVORITE_META[key].label}</button>
        ))}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <Button size="small" icon="plus" onClick={async () => {
            const name = window.prompt('新文件夹名称');
            if (!name?.trim()) return;
            await callOp('folder.upsert', { folder: { id: uuid(), name: name.trim(), orderIndex: folders.length, archived: false, createdAt: Date.now() } });
            notify('文件夹已创建');
            void reload();
          }}>文件夹</Button>
          <Button size="small" icon="download" onClick={async () => {
            const job = await callOp('export.build', { kind: 'cards', filter: { type: type === 'all' ? undefined : type } });
            await downloadJob(job.jobId);
          }}>导出卡片</Button>
        </div>
      </div>

      {folders.length > 0 ? (
        <div className="hdu-folder-row hdu-scroll-x">
          <button type="button" className={cx('hdu-folder', folder === 'all' ? 'is-active' : '')} onClick={() => setFolder('all')}>全部</button>
          {folders.map((f) => (
            <button type="button" key={f.id} className={cx('hdu-folder', folder === f.id ? 'is-active' : '')} onClick={() => setFolder(f.id)}>
              <Icon name="folder" size={13} /> {f.name}
            </button>
          ))}
        </div>
      ) : null}

      {loading ? <div className="hdu-card pad"><Skeleton height={90} /></div> : filtered.length === 0 ? (
        /* 空态（第 249 轮空态模板化）：title 与学习中心知识库空态（LibraryView）同句；
           筛选无匹配为引导型——附「查看全部」一键复位类型/文件夹筛选 */
        <div className="hdu-card">
          <EmptyState
            icon="library"
            title={favorites.length === 0 ? '知识库还是空的' : '没有匹配的条目'}
            text={favorites.length === 0 ? '在播放页收藏时间点、AI 回答、大纲或截图。' : '试试更换类型或文件夹筛选。'}
            action={
              favorites.length > 0 ? (
                <Button size="small" variant="ghost" icon="refresh" onClick={() => { setType('all'); setFolder('all'); }}>
                  查看全部
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="hdu-knowledge-grid">
          {filtered.map((fav) => (
            <VideoFavCard
              key={fav.id}
              fav={fav}
              highlight={query.trim()}
              editPlacement="foot"
              lastReviewDoneLabel={lastReviewDoneLabels.get(fav.id)}
              onReview={async () => { await callOp('review.plan', { favoriteId: fav.id }); notify('已加入复习计划'); }}
              onTogglePin={async () => { await callOp('fav.update', { id: fav.id, patch: { pinned: !fav.pinned } }); void reload(); }}
              onEdit={() => setEditing(fav)}
              onDelete={() => void remove(fav)}
            />
          ))}
        </div>
      )}

      {notes.length > 0 ? (
        <div className="hdu-section">
          <SectionHead title="时间戳笔记" sub={`${notes.length} 条`} />
          <div className="hdu-card pad">
            <div className="hdu-list">
              {notes.slice(0, 30).map((note) => (
                <div className="hdu-note" key={note.id}>
                  <span className="hdu-note-time">{formatClock(note.anchorTime)}</span>
                  <div className="hdu-note-body">
                    <div className="hdu-note-text">{note.text}</div>
                    <div className="hdu-hint">{localDayKey(new Date(note.createdAt))}</div>
                  </div>
                  <div className="hdu-note-actions">
                    <IconButton icon="star" label="转收藏" onClick={async () => { await callOp('note.toFavorite', { id: note.id }); notify('已转为收藏'); void reload(); }} />
                    {/* 两步确认：第一次点击仅进入确认态（图标变警示色 + title 切换，3 秒复原），第二次点击才删除 */}
                    <ConfirmIconButton icon="trash" label="删除" confirmLabel="再点一次确认移入回收站" onConfirm={async () => { await callOp('note.softDelete', { id: note.id }); notify('笔记已移入回收站'); void reload(); }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {shots.length > 0 ? (
        <div className="hdu-section">
          <SectionHead title="板书截图" sub={`${shots.length} 张`} />
          <div className="hdu-shot-grid">
            {shots.map((shot) => (
              <div className="hdu-shot" key={shot.id}>
                {shot.thumbDataUrl ? <img src={shot.thumbDataUrl} alt={shot.meta.courseName} loading="lazy" /> : <div style={{ aspectRatio: '16/9', background: 'var(--paper-3)' }} />}
                <div className="hdu-shot-meta">
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shot.meta.courseName}</span>
                  <span className="hdu-time-badge">{formatClock(shot.meta.anchorTime)}</span>
                  {/* 两步确认：第一次点击仅进入确认态（图标变警示色 + title 切换，3 秒复原），第二次点击才删除 */}
                  <ConfirmIconButton icon="trash" label="删除截图" confirmLabel="再点一次确认移入回收站" onConfirm={async () => { await callOp('shot.softDelete', { ids: [shot.id] }); notify('截图已移入回收站'); void reload(); }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {tags.length > 0 ? (
        <div className="hdu-section">
          <SectionHead title="标签" sub={`${tags.length} 个`} />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {tags.map((tag) => <span className="hdu-tag" key={tag.id} style={{ padding: '3px 9px', fontSize: 11 }}>{tag.name}</span>)}
          </div>
        </div>
      ) : null}

      {/* 共享编辑弹层（与学习中心 LibraryView 同一实现）：Dashboard 维持原三字段能力
          （删除入口在卡片 ConfirmIconButton 上），故关闭弹层内删除 / 置顶 / 新建文件夹；
          保存成功经 onDone 回传「已保存」给 notify，与原 onSaved 固定文案一致 */}
      <FavoriteEditModal
        favorite={editing}
        folders={folders}
        onClose={() => setEditing(null)}
        onDone={(toast) => { setEditing(null); void reload(); notify(toast); }}
        allowDelete={false}
        allowPin={false}
        allowCreateFolder={false}
      />
    </>
  );
}

// ───────────────────────── 复习 ─────────────────────────

function Review({ notify }: { notify: NotifyFn }) {
  const [due, setDue] = useState<Array<ReviewJobEntity & { favorite: FavoriteEntity | null }>>([]);
  const [stats, setStats] = useState<{ pending: number; todayDone: number; planned: number } | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const [d, s] = await Promise.all([callOp('review.due', {}).catch(() => []), callOp('review.stats', {}).catch(() => null)]);
    setDue(d);
    setStats(s);
    setLoading(false);
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <>
      <div className="hdu-grid g3">
        <div className="hdu-card hdu-metric"><div className="hdu-metric-head"><Icon name="refresh" /> 待复习</div><div className="hdu-metric-value">{stats?.pending ?? 0}<small>条</small></div></div>
        <div className="hdu-card hdu-metric"><div className="hdu-metric-head"><Icon name="check" /> 今日完成</div><div className="hdu-metric-value">{stats?.todayDone ?? 0}<small>条</small></div></div>
        <div className="hdu-card hdu-metric"><div className="hdu-metric-head"><Icon name="calendar" /> 已排期</div><div className="hdu-metric-value">{stats?.planned ?? 0}<small>条</small></div></div>
      </div>
      <div className="hdu-section">
        <SectionHead title="今日待复习" sub="间隔模板：1 / 3 / 7 / 16 天" actions={<Button size="small" variant="ghost" icon="refresh" onClick={() => void reload()}>刷新</Button>} />
        <div className="hdu-card pad">
          {loading ? <Skeleton height={80} /> : due.length === 0 ? (
            <EmptyState icon="refresh" title="今天没有待复习" text="在知识库中点击「加入复习」，按间隔模板自动排期。" />
          ) : (
            <div>
              {due.map((job) => (
                <div className="hdu-review-row" key={job.id}>
                  <div className="hdu-fav-icon"><Icon name={job.favorite ? FAVORITE_META[job.favorite.type].icon : 'star'} /></div>
                  <div className="hdu-list-main">
                    <div className="hdu-list-title">{job.favorite?.snapshot.title ?? '（收藏已删除）'}</div>
                    <div className="hdu-list-sub">
                      <span>第 {job.round + 1} 轮</span>
                      {job.favorite?.anchorTime != null ? <span>{formatClock(job.favorite.anchorTime)}</span> : null}
                      <span>到期 {job.dueDate}</span>
                    </div>
                  </div>
                  <div className="hdu-list-side">
                    <Button size="small" variant="ghost" onClick={async () => { await callOp('review.complete', { jobId: job.id, status: 'skipped' }); notify('已跳过本轮'); void reload(); }}>跳过</Button>
                    <Button size="small" icon="check" onClick={async () => { await callOp('review.complete', { jobId: job.id, status: 'done' }); notify('完成一轮复习'); void reload(); }}>完成</Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ───────────────────────── 数据 ─────────────────────────

/**
 * 导入文件体积上限（第 251 轮巡检，数据自主权域 / 导入可行性评估的最小防呆落地）：
 * 结构校验与事务回滚已在 import.run 侧闭环（parseBackupPayload 写库前校验 + 单事务
 * 失败即回滚，单测锁定），但「读文件」发生在 UI 侧——file.text() / arrayBuffer()
 * 会把整文件读进内存，误选超大文件（如几百 MB 的视频改名 .json）会在 JSON.parse
 * 前就卡死页面。512MB 上限参考全量备份 ZIP 的现实规模（截图二进制为主，正常备份
 * 远小于此），只拦「误选文件」不拦合法备份。评估结论记 docs/数据导入可行性评估.md。
 */
export const MAX_IMPORT_FILE_BYTES = 512 * 1024 * 1024;

/**
 * 导入文件体积校验（第 251 轮最小防呆，纯函数供单测）：超限返回用户可见 toast 文案，
 * 否则 null。文案与「文件不匹配 / 格式损坏」错误 toast 家族同句式（明确拒绝 + 现有
 * 数据未受影响）。
 */
export function importFileSizeGuardText(size: unknown): string | null {
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return null;
  return size > MAX_IMPORT_FILE_BYTES ? '文件超过 512MB，已拒绝导入（现有数据未受影响）' : null;
}

/** 导出供单元测试（two-step-confirm.test.ts）：回收站单条「彻底删除」两步确认的行为验证 */
export function Data({ notify }: { notify: NotifyFn }) {
  const [usage, setUsage] = useState<{ indexedDbBytes: number; opfsBytes: number; quotaBytes: number; screenshotCount: number; transcriptCount: number; modelCached: boolean } | null>(null);
  const [trash, setTrash] = useState<Array<{ key: string; kind: string; id: string; title: string; deletedAt: number; expiresAt: number }>>([]);
  const [importing, setImporting] = useState(false);
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge');

  const reload = useCallback(async () => {
    const [u, t] = await Promise.all([callOp('storage.usage', {}).catch(() => null), callOp('trash.list', {}).catch(() => [])]);
    setUsage(u);
    setTrash(t);
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const exportData = async (kind: 'cards' | 'list' | 'backup') => {
    try {
      const job = await callOp('export.build', { kind, includeScreenshots: kind === 'backup' });
      await downloadJob(job.jobId);
      notify('导出已开始');
    } catch (err) {
      // errorTextOf：AppError 显示 userMessage，非 Error 异常值回退语境化兜底（第 29 轮清尾）
      notify(errorTextOf(err, '导出失败'), true);
    }
  };

  const importFile = async (file: File) => {
    // 体积前置校验（第 251 轮最小防呆）：在读取进内存之前拒绝（不 staging 不写库），
    // toast 与「文件不匹配 / 格式损坏」错误 toast 家族同句式
    const sizeGuard = importFileSizeGuardText(file.size);
    if (sizeGuard) {
      notify(sizeGuard, true);
      return;
    }
    setImporting(true);
    try {
      const isZip = file.name.toLowerCase().endsWith('.zip');
      const data = isZip ? new Uint8Array(await file.arrayBuffer()) : await file.text();
      const record: ExportJobRecord = {
        id: uuid(),
        kind: 'import',
        filename: file.name,
        mime: file.type || (isZip ? 'application/zip' : 'application/json'),
        data,
        size: file.size,
        createdAt: Date.now(),
        expiresAt: Date.now() + 30 * 60_000,
      };
      await (await getDb()).put('exportJobs', record);
      const result = await callOp('import.run', { jobId: record.id, mode: importMode });
      const total = Object.values(result.imported).reduce((a, b) => a + b, 0);
      notify(`导入完成，共写入 ${total} 条记录`);
      void reload();
    } catch (err) {
      // errorTextOf：AppError 显示 userMessage，非 Error 异常值回退语境化兜底（第 29 轮清尾）
      notify(errorTextOf(err, '导入失败（文件可能损坏）'), true);
    } finally {
      setImporting(false);
    }
  };

  return (
    <>
      <div className="hdu-card">
        <SectionHead title="存储占用" actions={<Button size="small" variant="ghost" icon="refresh" onClick={() => void reload()}>刷新</Button>} />
        {usage ? (
          <dl className="hdu-kv">
            <dt>IndexedDB</dt><dd>{formatBytes(usage.indexedDbBytes)} · {usage.transcriptCount} 节转写 · {usage.screenshotCount} 张截图</dd>
            <dt>模型 / OPFS</dt><dd>{formatBytes(usage.opfsBytes)} {usage.modelCached ? '· 已缓存模型' : ''}</dd>
            <dt>浏览器配额</dt><dd>{formatBytes(usage.quotaBytes)}</dd>
          </dl>
        ) : <div className="hdu-hint">读取中…</div>}
      </div>

      <div className="hdu-grid g2 hdu-section">
        <div className="hdu-card pad">
          <SectionHead title="导出" sub="只含自产内容与可见元信息" />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <Button size="small" icon="download" onClick={() => void exportData('cards')}>复习卡片</Button>
            <Button size="small" icon="download" onClick={() => void exportData('list')}>收藏清单 CSV</Button>
            <Button size="small" icon="download" onClick={() => void exportData('backup')}>全量备份 ZIP</Button>
          </div>
          <div className="hdu-hint" style={{ marginTop: 10 }}>
            转写文本属于插件本地派生物，备份中会标注来源；不包含视频、音频或站点签名直链。
          </div>
        </div>
        <div className="hdu-card pad">
          <SectionHead title="导入" sub="JSON 备份或 ZIP" />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <select className="hdu-select" value={importMode} onChange={(e) => setImportMode(e.target.value as 'merge' | 'replace')}>
              <option value="merge">合并</option>
              <option value="replace">替换现有数据</option>
            </select>
            <label className="hdu-btn small" style={{ cursor: 'pointer' }}>
              {importing ? '导入中…' : '选择文件'}
              <input
                type="file"
                accept=".json,.zip,application/json,application/zip"
                style={{ display: 'none' }}
                disabled={importing}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void importFile(file);
                  e.currentTarget.value = '';
                }}
              />
            </label>
          </div>
          <div className="hdu-hint" style={{ marginTop: 10 }}>导入前会校验版本与结构；损坏或超大文件（&gt;512MB）会被拒绝，不会破坏现有数据。</div>
        </div>
      </div>

      <div className="hdu-section">
        <SectionHead title="回收站" sub={`${trash.length} 条 · 保留 30 天`} actions={trash.length > 0 ? <ConfirmButton size="small" variant="danger" icon="trash" confirmLabel="再点一次确认清空" onConfirm={async () => { await callOp('trash.purge', {}); notify('回收站已清空，内容已永久删除'); void reload(); }}>清空</ConfirmButton> : undefined} />
        <div className="hdu-card pad">
          {trash.length === 0 ? <EmptyState icon="trash" title="回收站是空的" text="删除的收藏、笔记与截图会在这里保留 30 天。" /> : (
            <div className="hdu-list">
              {trash.map((item) => (
                <div className="hdu-list-row" key={item.key}>
                  <div className="hdu-list-main">
                    <div className="hdu-list-title">{item.title}</div>
                    <div className="hdu-list-sub"><span>{item.kind}</span><span>删除于 {localDayKey(item.deletedAt)}</span><span>到期 {localDayKey(item.expiresAt)}</span></div>
                  </div>
                  <div className="hdu-list-side">
                    <Button size="small" variant="ghost" onClick={async () => { await callOp('trash.restore', { keys: [item.key] }); notify('已恢复'); void reload(); }}>恢复</Button>
                    {/* 两步确认：第一次点击仅进入确认态（红色文案，3 秒复原），第二次点击才彻底删除（不可恢复，与恢复按钮区分） */}
                    <ConfirmButton size="small" variant="danger" confirmLabel="再点一次确认删除" onConfirm={async () => { await callOp('trash.purge', { keys: [item.key] }); void reload(); }}>彻底删除</ConfirmButton>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="hdu-section">
        <SectionHead title="危险操作" sub="不可撤销" />
        <div className="hdu-card pad">
          <div className="hdu-options-row">
            <div className="hdu-options-row-main"><div className="hdu-options-row-title">清空全部本地数据</div><div className="hdu-options-row-sub">收藏、笔记、转写、统计、截图与 AI 缓存；模型文件也会被清除。</div></div>
            <div className="hdu-options-row-side">
              {/* 两步确认：第一次点击仅进入确认态（红色文案，3 秒复原），第二次点击才清空全部 */}
              <ConfirmButton size="small" variant="danger" icon="trash" confirmLabel="再点一次确认清空全部" onConfirm={async () => {
                await callOp('data.clear', { kinds: ['all'] });
                notify('全部本地数据已清空');
                void reload();
              }}>清空全部</ConfirmButton>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

async function downloadJob(jobId: string): Promise<void> {
  const db = await getDb();
  const record = await db.get('exportJobs', jobId);
  // 结构化错误透传（第 255 轮错误文案盘点）：此前抛普通 Error，errorTextOf 一律回退
  // 「导出失败」——具体原因「文件已过期」被吞掉；改抛 AppError 带 userMessage，
  // 与 errorTextOf 的结构化优先链一致，用户看到可行动的具体文案
  if (!record) throw new AppError('INVALID_INPUT', { userMessage: '导出文件已过期，请重新导出' });
  const blob = record.data instanceof Uint8Array ? new Blob([record.data as BlobPart], { type: record.mime }) : new Blob([String(record.data)], { type: record.mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = record.filename;
  anchor.rel = 'noopener';
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
