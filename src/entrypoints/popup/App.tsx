import { useEffect, useMemo, useState } from 'react';
import { callOp } from '@/core/shared/client';
import { buildTodayPlan, type TodayPlan } from '@/core/plan/today';
import type { PeriodReport } from '@/core/stats/period';
import { loadSettings } from '@/core/shared/settings';
import { applyDebugLogEnabled } from '@/core/shared/logger';
import { SITE_ORIGINS } from '@/core/shared/constants';
import type { AppSettings, BiliRecentWatchedRow, CourseBundle, DashboardReport, FavoriteEntity, PopupOverview, ReviewJobEntity } from '@/core/shared/types';
import type { MissedItem } from '@/core/shared/ops';
import { formatClock, formatDuration, localDayKey, withTimeParam } from '@/core/shared/utils';
import { uuid } from '@/core/shared/utils';
import { useResolvedTheme } from '@/core/shared/useResolvedTheme';
import { lessonHash } from '../content/site/navigation';
import { UI_CSS } from '../content/ui/styles';
import { Button, Chip, IconButton, Progress, cx } from '../content/ui/components';
import { Icon } from '../content/ui/icons';
import { OnboardingCard } from '../content/ui/learning/OnboardingCard';
import { DemoBadge, DemoStartButton } from '../content/ui/DemoBadge';
import { WeeklyGoalCalendarRow } from '../content/ui/learning/OverviewView';
import { clampDailyGoalMin } from '@/core/plan/dailyGoal';

const EXTRA_CSS = `
/* 第 17 轮实测修复（P3-2）：固定 372px 在 360px 弹窗窗口下页级溢出 12px，改随视口收窄 */
.hdu-popup { width: min(372px, 100vw); min-height: 520px; background: var(--paper); padding: 0; }
.hdu-popup .hdu-popup-head { display: flex; align-items: center; gap: 10px; padding: 16px 16px 12px; }
.hdu-popup .hdu-popup-body { padding: 0 16px 16px; display: flex; flex-direction: column; gap: 13px; }
.hdu-popup .hdu-popup-foot { margin-top: auto; padding: 10px 16px 14px; border-top: 1px solid var(--line); display: flex; gap: 6px; background: var(--paper); }
.hdu-popup .hdu-hero-main { padding: 18px 18px; min-height: 0; gap: 12px; border-radius: 18px; }
.hdu-popup .hdu-hero-title { font-size: 20px; }
.hdu-popup .hdu-hero-main .hdu-ring { width: 60px; height: 60px; }
.hdu-popup .hdu-stat-grid { grid-template-columns: 1fr 1fr; }
.hdu-popup .hdu-stat { padding: 12px 13px; }
.hdu-popup .hdu-stat-value { font-size: 21px; }
.hdu-popup .hdu-empty { padding: 26px 12px; }
/* popup 与 content 是不同入口，.hdu-root 上的 --paper 变量无法传递到 body（变量只向下继承）。
   以下两个值须与 content/ui/styles.ts 的 --paper 保持一致：亮 #f5f1e8 / 暗 #131518，改任一侧时同步另一侧。 */
:root { --hdu-popup-paper: #f5f1e8; --hdu-popup-paper-dark: #131518; }
html, body { margin: 0; background: var(--hdu-popup-paper); }
body.dark { background: var(--hdu-popup-paper-dark); }
/* 第 254 轮盘点伴随核对：372×520 在 chrome 弹窗 800×600 约束内（宽高均有富余，
   新增今日待办完成度行后仍自适应内容高度）；可点击行（候选 B 站内行直达 + B 站
   断点行）hover 反馈统一 4% 墨底叠加，焦点态由 .hdu-root :focus-visible 描边整组
   继承；新增「已完成 X / 共 Y」行沿用 tabular-nums 数字排版（与本周摘要行一致），
   进度条复用共享 .hdu-progress（jade）——视觉语言与扩展页同源（--* 变量），暗色
   由 .hdu-root[data-theme="dark"] 自动跟随，无需 popup 侧另设 */
.hdu-popup a.hdu-list-row { transition: background-color .15s ease; }
.hdu-popup a.hdu-list-row:hover { background: color-mix(in srgb, var(--ink) 4%, transparent); }
`;

export function App() {
  const [overview, setOverview] = useState<PopupOverview | null>(null);
  const [fallback, setFallback] = useState<{ report: DashboardReport | null; bundles: CourseBundle[] }>({ report: null, bundles: [] });
  const [weekReport, setWeekReport] = useState<PeriodReport | null>(null);
  // 今日待办计划（第 84 轮巡检引入；第 254 轮增强，候选 A）：接入 todo.today.get 勾选态——
  // 此前恒传 doneKeys: []，学习中心勾选完成的条目在 popup 仍显示为纯计数、无完成度；
  // 现与 TodayTodoCard 同口径（buildTodayPlan + doneKeys → doneCount/totalCount），
  // 同一数据两处展示的口径对齐（分区计数含已勾选项，与看板灰显条目一致）
  const [todoPlan, setTodoPlan] = useState<TodayPlan | null>(null);
  // B 站最近观看（第 87 轮巡检）：最近学习列表的站外条目
  const [biliRecent, setBiliRecent] = useState<BiliRecentWatchedRow[]>([]);
  // 知识库存在性近似探测（第 256 轮，引导域）：popup 只取过 video 型收藏，作为
  // 「沉淀知识」步的近似口径（笔记 / 非视频收藏不计入——近似判定，宁缺勿假）
  const [hasAnyFav, setHasAnyFav] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [tabId, setTabId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const loaded = await loadSettings();
      // 诊断日志开关应用（第 299 轮，工程域）：popup 上下文同受「记录诊断日志」约束
      applyDebugLogEnabled(loaded.debug.logEnabled);
      setSettings(loaded);
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (tab?.id != null) {
        setTabId(tab.id);
        try {
          const res = (await chrome.tabs.sendMessage(tab.id, { type: 'POPUP_OVERVIEW', requestId: uuid() })) as
            | { type?: string; overview?: PopupOverview }
            | undefined;
          if (res?.overview) setOverview(res.overview);
        } catch {
          /* 内容脚本未注入 */
        }
      }
      // 本周摘要口径对齐义务（照上方 --paper 双侧同步注释的先例）：本区数字必须与学习中心统计页
      // PeriodReportCard 的「本周」视图完全同源——同一个 stats.period op、同参数 { kind: 'week', count: 1 }
      // （对应 LearningCenter PERIOD_OPTIONS 的 w1 项，聚合口径见 core/stats/period 纯函数）；
      // 展示格式亦对齐：小时 = (秒 / 3600).toFixed(1)，计划完成度 = Math.round(ratio * 100)%。
      // 任一侧调整 kind/count 或展示格式时，三端（popup / dashboard / 学习中心）须同步修改。
      const [report, bundles, week] = await Promise.all([
        callOp('stats.report', { days: 30 }).catch(() => null),
        callOp('course.bundles', {}).catch(() => [] as CourseBundle[]),
        callOp('stats.period', { kind: 'week', count: 1 }).catch(() => null),
      ]);
      setFallback({ report, bundles });
      setWeekReport(week);
      // 今日待办聚合（第 84 轮巡检）：复习 / 补看 / 待学视频，任一路失败按空处理。
      // 第 254 轮增强（候选 A）：补 todo.today.get 勾选态——与学习中心 TodayTodoCard
      // 完全同口径（buildTodayPlan + doneKeys），完成度 = doneCount / totalCount
      const [due, missed, videoFavorites, doneKeys] = await Promise.all([
        callOp('review.due', {}).catch(() => [] as Array<ReviewJobEntity & { favorite: FavoriteEntity | null }>),
        callOp('schedule.missed', {}).catch(() => [] as MissedItem[]),
        callOp('fav.list', { filter: { type: 'video', limit: 500 } }).catch(() => [] as FavoriteEntity[]),
        callOp('todo.today.get', { date: localDayKey() }).catch(() => [] as string[]),
      ]);
      setTodoPlan(
        buildTodayPlan({ dueReviews: due, missedSessions: missed, videoFavorites, doneKeys, today: localDayKey() }),
      );
      setHasAnyFav(videoFavorites.length > 0);
      // B 站最近观看（第 87 轮巡检）：取最近 2 条进「最近学习」列表
      const bili = await callOp('stats.bili.overview', { kind: 'week' }).catch(() => null);
      setBiliRecent(bili?.recent?.slice(0, 2) ?? []);
      setLoading(false);
    })();
  }, []);

  const theme = useResolvedTheme(settings);
  useEffect(() => {
    document.body.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  const session = overview?.session ?? null;
  const report = fallback.report;
  // 今日站外视频时长：days 的最后一天即今天（站外通道独立口径，见 core/stats/aggregate）
  const todayExternalSec = report?.days.length ? (report.days[report.days.length - 1]?.externalSeconds ?? 0) : 0;
  // 本周桶 = PeriodReport.buckets 最后一项（旧 → 新排列；口径对齐义务见上方 useEffect 注释）
  const weekBucket = weekReport?.buckets[weekReport.buckets.length - 1] ?? null;
  const recent = useMemo(() => {
    const list = [...fallback.bundles];
    list.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
    return list.slice(0, 3);
  }, [fallback.bundles]);

  const send = async (message: unknown) => {
    if (tabId == null) return;
    try {
      await chrome.tabs.sendMessage(tabId, message);
      window.close();
    } catch {
      /* 忽略 */
    }
  };

  return (
    <div className={cx('hdu-root', 'hdu-popup')} data-theme={theme}>
      <style>{UI_CSS + EXTRA_CSS}</style>
      <header className="hdu-popup-head">
        <div className="hdu-brand-mark" style={{ width: 32, height: 32, fontSize: 17 }}>学</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: 'var(--font-serif)', fontSize: 14.5, fontWeight: 600 }}>智慧课堂助手</div>
          <div style={{ fontSize: 10, color: 'var(--muted)', letterSpacing: '.08em' }}>LEARNING COMPANION</div>
        </div>
        <DemoBadge />
        <IconButton icon="settings" label="设置" onClick={() => { void chrome.runtime.openOptionsPage(); window.close(); }} />
      </header>

      <main className="hdu-popup-body">
        {session ? (
          <div className="hdu-hero-main">
            <div>
              <div className="hdu-hero-eyebrow">正在学习</div>
              <div className="hdu-hero-title">{session.courseName}</div>
              <div className="hdu-hero-meta" style={{ marginTop: 6 }}>{session.courLabel}</div>
            </div>
            <div className="hdu-hero-actions">
              <Button size="small" variant="accent" icon="panel" onClick={() => void send({ type: 'UI_COMMAND', command: 'openPanel' })}>
                打开本节助手
              </Button>
              <Button size="small" icon="library" onClick={() => void send({ type: 'UI_COMMAND', command: 'openCenter' })}>
                学习中心
              </Button>
            </div>
          </div>
        ) : !loading && (report?.totalSec ?? 0) === 0 && fallback.bundles.length === 0 && !hasAnyFav ? (
          // 全空冷启动（第 256 轮，引导域）：三步上手引导卡替代单句提示——与学习中心
          // 空库 / 看板空课次同一份步骤与文案（core/plan/onboarding 单点）；
          // hasLibrary 用 video 收藏近似口径（见上方 hasAnyFav 注释，宁缺勿假）
          <div className="hdu-card pad" style={{ padding: 16 }}>
            <OnboardingCard
              input={{ hasCourse: false, hasWatch: false, hasLibrary: hasAnyFav }}
              compact
              footer={
                <div className="hdu-onboard-foot-row">
                  <span className="hdu-onboard-foot-hint">没有课程数据？先用假数据逛一遍。</span>
                  <DemoStartButton />
                </div>
              }
            />
          </div>
        ) : (
          <div className="hdu-card pad" style={{ padding: 16 }}>
            <div className="hdu-section-title">今天，从一节课开始</div>
            <div className="hdu-hint" style={{ marginTop: 5 }}>
              {loading ? '正在读取本机数据…' : '打开智慧课堂的播放页或列表页，插件会在这里汇总你的进度。'}
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 11 }}>
              <Button size="small" icon="library" onClick={() => tabId != null && chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') })}>
                打开学习看板
              </Button>
            </div>
          </div>
        )}

        <div className="hdu-stat-grid">
          <div className="hdu-stat">
            <div className="hdu-stat-top"><Icon name="clock" /> 今日</div>
            <div className="hdu-stat-value">{(report?.todaySec ?? 0) >= 3600 ? `${((report?.todaySec ?? 0) / 3600).toFixed(1)}` : Math.round((report?.todaySec ?? 0) / 60)}<small>{(report?.todaySec ?? 0) >= 3600 ? '小时' : '分钟'}</small></div>
          </div>
          <div className="hdu-stat">
            <div className="hdu-stat-top"><Icon name="flame" /> 连续</div>
            <div className="hdu-stat-value">{report?.streakDays ?? 0}<small>天</small></div>
          </div>
        </div>

        {/* 本周目标 7 日格（第 260 轮，引导域延伸 / 目标域复用）：与总览 / 看板 / 统计页 /
            设置页同款组件同源口径（buildWeeklyGoalCalendar）；popup 侧第四处复用——
            今日/连续两卡下方一排小点，打开弹窗即见本周节奏；无日报数据不渲染 */}
        {report && report.days.length > 0 ? (
          <div className="hdu-card" style={{ padding: '10px 13px' }}>
            <WeeklyGoalCalendarRow days={report.days} dailyGoalMin={clampDailyGoalMin(settings?.dailyGoalMin)} />
          </div>
        ) : null}

        {todayExternalSec > 0 ? (
          <div className="hdu-hint" style={{ marginTop: -6 }}>
            另有站外视频 {Math.round(todayExternalSec / 60)} 分钟（B 站等，独立口径）
          </div>
        ) : null}

        {/* 今日待办卡（第 84 轮巡检）：与学习中心今日待办同一聚合内核（buildTodayPlan）；
            有事项才显示。第 90 轮巡检：复习/待学视频计数可点击直达学习看板对应视图（hash 深链）。
            第 254 轮增强（候选 A）：标题行右侧补「已完成 X / 共 Y」+ jade 进度条——
            口径与 TodayTodoCard 的 doneCount/totalCount 完全一致（含已勾选项计数）；
            数字行 tabular-nums 对齐本周摘要行的数字排版 */}
        {todoPlan && todoPlan.totalCount > 0 ? (
          <div className="hdu-card" style={{ padding: '10px 13px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>今日待办</span>
              <span style={{ fontSize: 11, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
                已完成 {todoPlan.doneCount} / {todoPlan.totalCount}
              </span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px 10px', fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>
              <a
                href={`${chrome.runtime.getURL('dashboard.html')}#review`}
                style={{ textDecoration: 'none', color: 'inherit' }}
                title="打开学习看板 · 复习计划"
              >
                到期复习 {todoPlan.sections.find((s) => s.kind === 'review')?.items.length ?? 0}
              </a>
              <span>待补看 {todoPlan.sections.find((s) => s.kind === 'missed')?.items.length ?? 0}</span>
              <a
                href={`${chrome.runtime.getURL('dashboard.html')}#library`}
                style={{ textDecoration: 'none', color: 'inherit' }}
                title="打开学习看板 · 知识库"
              >
                待学视频 {todoPlan.sections.find((s) => s.kind === 'video')?.items.length ?? 0}
              </a>
            </div>
            <div style={{ marginTop: 6 }}>
              <Progress value={todoPlan.totalCount > 0 ? todoPlan.doneCount / todoPlan.totalCount : 0} jade />
            </div>
            <div style={{ marginTop: 6 }}>
              <Button
                size="small"
                icon="library"
                onClick={() => chrome.tabs.create({ url: `${chrome.runtime.getURL('dashboard.html')}#review` })}
              >
                查看复习计划
              </Button>
            </div>
          </div>
        ) : null}

        {/* 本周学习摘要（取数与口径对齐义务见 useEffect 内注释；取数失败静默降级为不渲染本区） */}
        {weekBucket ? (
          <div className="hdu-card" style={{ padding: '10px 13px' }}>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>本周学习</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px 10px', fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>
              <span>站内 {(weekBucket.internalSec / 3600).toFixed(1)} 小时</span>
              <span>站外 {(weekBucket.externalSec / 3600).toFixed(1)} 小时</span>
              <span>活跃 {weekBucket.activeDays} 天</span>
              {weekBucket.plan ? <span>计划完成 {Math.round(weekBucket.plan.ratio * 100)}%</span> : null}
            </div>
            {/* 计划完成度进度条（第 94 轮巡检） */}
            {weekBucket.plan ? (
              <div style={{ marginTop: 6 }}>
                <Progress value={weekBucket.plan.ratio} jade />
                <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 2 }}>
                  计划完成度 {Math.round(weekBucket.plan.ratio * 100)}%（完看 {weekBucket.plan.finished}/{weekBucket.plan.total}）
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {overview ? (
          <div className="hdu-card" style={{ padding: 13 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 }}>
              <span className="hdu-section-title" style={{ fontSize: 13.5 }}>本节状态</span>
              <Chip tone={overview.transcript?.exists ? 'jade' : 'default'}>{overview.transcript?.exists ? '已转写' : '未转写'}</Chip>
              <Chip tone={overview.ai?.exists ? 'accent' : 'default'}>{overview.ai?.exists ? `${overview.ai.topicCount} 个知识点` : '未标注'}</Chip>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--muted)' }}>
              <span>完看度 {Math.round((overview.watchRatio ?? 0) * 100)}%</span>
              {session?.lastPlayTime ? <span>· 上次 {formatClock(session.lastPlayTime)}</span> : null}
              {overview.job && ['transcribing', 'extracting', 'queued'].includes(overview.job.status) ? <span>· 转写 {Math.round(overview.job.progress * 100)}%</span> : null}
            </div>
            <div style={{ marginTop: 8 }}><Progress value={overview.watchRatio ?? 0} jade /></div>
          </div>
        ) : null}

        {recent.length > 0 || biliRecent.length > 0 ? (
          <div className="hdu-card" style={{ padding: '10px 13px' }}>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>最近学习</div>
            {/* 站内行直达（第 254 轮增强，候选 B）：此前站内课程行不可点（仅 B 站行可点），
                现复用第 249 轮深链修复的 lessonHash 机制（dashboard 同款 prefer:'play-center'
                深链，课程 → 站点播放页），取「在看中或第一节」课次作为落点；无课次可落
                （sessions 为空）时保持非链接行（不产出无效链接）。URL 由常量 origin +
                数字参数拼成，无站点不可信输入。 */}
            {recent.map((bundle) => {
              const next = bundle.sessions.find((s) => s.watchState === 'watching') ?? bundle.sessions[0];
              const deepLink = next
                ? `${SITE_ORIGINS.campus}/${lessonHash({ courId: next.courId, teclId: bundle.course.teclId, prefer: 'play-center' })}`
                : null;
              return deepLink ? (
                <a
                  className="hdu-list-row"
                  key={bundle.course.teclId}
                  href={deepLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="在智慧课堂打开本课程继续学习"
                  style={{ padding: '8px 0', textDecoration: 'none', color: 'inherit' }}
                >
                  <div className="hdu-list-main">
                    <div className="hdu-list-title">{bundle.course.subjName}</div>
                    <div className="hdu-list-sub">{formatDuration(bundle.watchedSec)} · 完看 {bundle.finishedCount}/{bundle.sessionCount}</div>
                  </div>
                  <Icon name="chevronRight" size={14} />
                </a>
              ) : (
                <div className="hdu-list-row" key={bundle.course.teclId} style={{ padding: '8px 0' }}>
                  <div className="hdu-list-main">
                    <div className="hdu-list-title">{bundle.course.subjName}</div>
                    <div className="hdu-list-sub">{formatDuration(bundle.watchedSec)} · 完看 {bundle.finishedCount}/{bundle.sessionCount}</div>
                  </div>
                  <Icon name="chevronRight" size={14} />
                </div>
              );
            })}
            {/* B 站最近观看（第 87 轮巡检）：站外条目带断点直达 */}
            {biliRecent.map((row) => (
              <a
                className="hdu-list-row"
                key={row.bvid}
                href={row.lastPositionSec > 0 ? withTimeParam(row.url, row.lastPositionSec) : row.url}
                target="_blank"
                rel="noopener noreferrer"
                style={{ padding: '8px 0', textDecoration: 'none', color: 'inherit' }}
                title="打开 B 站并回到上次观看位置"
              >
                <div className="hdu-list-main">
                  <div className="hdu-list-title">B站 · {row.title}</div>
                  <div className="hdu-list-sub">
                    {formatDuration(row.totalSec)} · 最近 {row.lastDay}
                    {row.lastPositionSec > 0 ? ` · 上次到 ${formatClock(row.lastPositionSec)}` : ''}
                  </div>
                </div>
                <Icon name="chevronRight" size={14} />
              </a>
            ))}
          </div>
        ) : null}

        <div className="hdu-hint">
          数据只保存在本机 · 音频不出设备 · 不调用站点写接口
        </div>
      </main>

      <footer className="hdu-popup-foot">
        <Button size="small" variant="ghost" icon="chart" onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') })}>
          学习看板
        </Button>
        <Button size="small" variant="ghost" icon="settings" onClick={() => { void chrome.runtime.openOptionsPage(); window.close(); }}>
          设置
        </Button>
        <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--muted)', alignSelf: 'center' }}>{localDayKey()}</span>
      </footer>
    </div>
  );
}
