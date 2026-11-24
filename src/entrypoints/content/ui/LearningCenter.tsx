// 智慧课堂学习中心（HDU 站点内浮层主面板）：主装配——侧栏导航 + 顶栏 + 视图切换 + 公共数据
// （useCenterData）。各视图与内聚块自第 40 轮巡检起按视图纯搬移拆分到 ./learning/：
//   OverviewView / CoursesView / ScheduleView / LibraryView / StatsView / TopBarSearch /
//   TodayTodoCard / shared（BundleData、sessionLabel、MissedList）。逻辑不变。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { callOp } from '@/core/shared/client';
import { errorTextOf } from '@/core/shared/errors';
import { WEEKDAY_LABELS } from '@/core/shared/constants';
import type { CourseBundle, FavoriteEntity, FolderEntity, NoteEntity } from '@/core/shared/types';
import type { MissedItem } from '@/core/shared/ops';
import { pushToast, Button, Chip, EmptyState, IconButton, cx } from './components';
import { ErrorBoundary } from './ErrorBoundary';
import { ShortcutsModal } from './ShortcutsModal';
import { Icon, type IconName } from './icons';
import { FavoriteEditModal } from './FavoriteEditModal';
import { BiliWatchCard } from './BiliWatchCard';
import { PeriodReportCard } from './PeriodReportCard';
import { uiStore, useUiStore, type CenterView } from './store';
import { DemoBadge } from './DemoBadge';
import { OverviewView } from './learning/OverviewView';
import { CoursesView } from './learning/CoursesView';
import { ScheduleView } from './learning/ScheduleView';
import { LibraryView } from './learning/LibraryView';
import { ReviewView } from './learning/ReviewView';
import { StatsView } from './learning/StatsView';
import { TopBarSearch } from './learning/TopBarSearch';
import type { BundleData } from './learning/shared';

// 收藏编辑弹层已收口到共享实现（Dashboard 知识库与学习中心同一份）；
// 保留此导出仅为兼容既有测试的导入路径（fav-edit-modal.test.ts）
export { FavoriteEditModal };
// B 站视频统计卡已抽到独立文件（./BiliWatchCard.tsx，Dashboard「本周学习」区与学习中心统计页共用）；
// 保留此导出仅为兼容既有测试的导入路径（bili-polish.test.ts）
export { BiliWatchCard };
// 学习周报 / 月报卡已抽到独立文件（./PeriodReportCard.tsx，HDU 统计页与 B 站学习中心统计页签
// 共用同一实现，第 34 轮巡检）；保留此导出仅为兼容既有测试的导入路径（stats-period-ui.test.ts）
export { PeriodReportCard };

const EMPTY_DATA: BundleData = {
  bundles: [],
  report: null,
  missed: [],
  favorites: [],
  folders: [],
  notes: [],
  schedule: [],
  reviewPending: 0,
  loading: true,
  error: null,
};

function useCenterData(version: number): BundleData & { reload: () => Promise<void> } {
  const [data, setData] = useState<BundleData>(EMPTY_DATA);
  const reload = useCallback(async () => {
    setData((prev) => ({ ...prev, loading: true, error: null }));
    let error: string | null = null;
    const bundles = await callOp('course.bundles', {}).catch((err) => {
      // errorTextOf：AppError 显示 userMessage，非 Error 异常值回退语境化兜底（第 29 轮清尾）
      error = errorTextOf(err, '课程数据读取失败');
      return [] as CourseBundle[];
    });
    const [report, missed, favorites, folders, notes, schedule, reviewStats] = await Promise.all([
      callOp('stats.report', { days: 90 }).catch(() => null),
      callOp('schedule.missed', {}).catch(() => [] as MissedItem[]),
      callOp('fav.list', { filter: { limit: 500 } }).catch(() => [] as FavoriteEntity[]),
      callOp('folder.list', { includeArchived: true }).catch(() => [] as FolderEntity[]),
      callOp('note.list', {}).catch(() => [] as NoteEntity[]),
      callOp('schedule.list', {}).catch(() => []),
      callOp('review.stats', {}).catch(() => null),
    ]);
    setData({
      bundles,
      report,
      missed,
      favorites,
      folders,
      notes,
      schedule,
      reviewPending: reviewStats?.pending ?? 0,
      loading: false,
      error,
    });
  }, []);
  useEffect(() => {
    void reload();
  }, [reload, version]);
  return { ...data, reload };
}

const VIEW_META: Record<CenterView, { label: string; icon: IconName; title: string; sub: string }> = {
  overview: { label: '总览', icon: 'home', title: '总览', sub: '今天的学习从这里开始' },
  courses: { label: '我的课程', icon: 'book', title: '我的课程', sub: '课程、课次与完看度' },
  schedule: { label: '课表与补看', icon: 'calendar', title: '课表与补看', sub: '本周安排与待补清单' },
  library: { label: '知识库', icon: 'library', title: '知识库', sub: '收藏、笔记与截图' },
  review: { label: '复习计划', icon: 'refresh', title: '复习计划', sub: '到期复习与完成历史' },
  stats: { label: '学习统计', icon: 'chart', title: '学习统计', sub: '透明、只属于你的学习记录' },
};

export function LearningCenter() {
  const state = useUiStore();
  const actions = uiStore.actions;
  const data = useCenterData(state.centerDataVersion);
  const view = state.centerView;

  const counts = useMemo(
    () => ({
      courses: data.bundles.length,
      missed: data.missed.length,
      library: data.favorites.length + data.notes.length,
      review: data.reviewPending,
    }),
    [data.bundles.length, data.missed.length, data.favorites.length, data.notes.length, data.reviewPending],
  );

  const [refreshing, setRefreshing] = useState(false);
  // 今日待办卡片的数据源独立于 BundleData，顶栏「刷新」时用它触发卡片重载
  const [todoReloadTick, setTodoReloadTick] = useState(0);
  // 快捷键速查浮层（第 228 轮巡检）：顶栏「⌨」入口，键位读当前设置
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // 视图切换过渡与滚动位置策略（第 252 轮巡检，视图域 / 体验视角，审计落地）：
  //  - 六视图为三元链直切、无过渡（审计结论）→ 落地 fade-only 微过渡：key={view} 使
  //    .hdu-content-inner 随切换重挂载、CSS 动画（hdu-fade-in，opacity-only）随之重播；
  //    首挂载不播动画（viewFadeOn 初始 false，首帧渲染不加类，首次 effect 发现视图未变
  //    也不置位）——面板打开即播会与数据骨架闪烁叠加，故跳过首次；
  //  - 滚动位置策略统一「切换后回到顶部」：.hdu-content 滚动容器跨视图持久（探查结论：
  //    此前切换不重置 scrollTop，从长页统计视图切到总览会带着旧偏移落在页面中部）。
  //    scrollTop 直赋值而非 scrollTo({})（jsdom 无布局引擎，直赋值可测）。
  const contentRef = useRef<HTMLDivElement | null>(null);
  const prevViewRef = useRef<CenterView>(view);
  const [viewFadeOn, setViewFadeOn] = useState(false);
  useEffect(() => {
    if (prevViewRef.current === view) return;
    prevViewRef.current = view;
    setViewFadeOn(true);
    const scroller = contentRef.current;
    if (scroller) scroller.scrollTop = 0;
  }, [view]);

  const reload = useCallback(async () => {
    setRefreshing(true);
    try {
      setTodoReloadTick((t) => t + 1);
      if (view === 'courses') {
        // “刷新”在课程页应真正去站点同步，而不是只重读本机 IndexedDB
        await actions.syncCourses({ force: true });
        await data.reload();
        return;
      }
      await data.reload();
      pushToast('学习数据已刷新', 'success');
    } finally {
      setRefreshing(false);
    }
  }, [actions, data, view]);

  return (
    <div className="hdu-center" role="dialog" aria-modal="true" aria-label="智慧课堂学习中心">
      <aside className="hdu-rail">
        <div className="hdu-brand">
          <div className="hdu-brand-mark">学</div>
          <div>
            <div className="hdu-brand-name">智慧课堂</div>
            <div className="hdu-brand-sub">Learning Center</div>
          </div>
        </div>
        <nav className="hdu-nav" aria-label="学习中心导航">
          <div className="hdu-nav-label">我的学习</div>
          {(Object.keys(VIEW_META) as CenterView[]).map((key) => {
            const meta = VIEW_META[key];
            const count =
              key === 'courses'
                ? counts.courses
                : key === 'schedule'
                  ? counts.missed
                  : key === 'library'
                    ? counts.library
                    : key === 'review'
                      ? counts.review
                      : 0;
            return (
              <button
                key={key}
                type="button"
                className={cx('hdu-nav-item', view === key ? 'is-active' : '')}
                onClick={() => actions.setCenterView(key)}
                aria-current={view === key ? 'page' : undefined}
              >
                <Icon name={meta.icon} />
                {meta.label}
                {count > 0 ? <span className="hdu-nav-count">{count > 99 ? '99+' : count}</span> : null}
              </button>
            );
          })}
        </nav>
        <div className="hdu-rail-foot">
          <div className="hdu-status-line">
            <span className={`hdu-dot ${state.backendReady ? 'ok' : 'err'}`} />
            {state.backendReady ? '本地服务已连接' : '正在连接本地服务'}
          </div>
          <div className="hdu-status-line">
            <span className={`hdu-dot ${state.job ? 'warn' : ''}`} />
            {state.job && (state.job.status === 'transcribing' || state.job.status === 'extracting')
              ? `转写中 · ${Math.round(state.job.progress * 100)}%`
              : '转写模型待命'}
          </div>
          <div className="hdu-rail-actions">
            <Button variant="ghost" size="small" icon="settings" onClick={() => openOptions()}>
              设置
            </Button>
          </div>
        </div>
      </aside>

      <div className="hdu-main">
        <header className="hdu-topbar">
          <div>
            <div className="hdu-topbar-title">{VIEW_META[view].title}</div>
            <div className="hdu-topbar-sub">{VIEW_META[view].sub}</div>
          </div>
          <div className="hdu-topbar-actions">
            <DemoBadge />
            <IconButton icon="scan" label="快捷键速查" onClick={() => setShortcutsOpen(true)} />
            <TopBarSearch />
            <Chip icon="calendar">{todayLabel()}</Chip>
            <Button size="small" variant="ghost" icon="refresh" onClick={() => void reload()} loading={data.loading || refreshing}>
              刷新
            </Button>
            <Button size="small" icon="external" onClick={() => actions.suppressCenter()}>
              站点原页面
            </Button>
          </div>
        </header>
        {/* 快捷键速查（第 228 轮巡检）：与播放页/B 站学习中心共享同一浮层组件 */}
        <ShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} shortcuts={state.settings.shortcuts} />
        <div ref={contentRef} className="hdu-content hdu-scroll">
          <div key={view} className={cx('hdu-content-inner', viewFadeOn ? 'hdu-view-fade' : '')}>
            {data.error ? (
              /* 失败态 CTA 统一 small ghost（第 249 轮空态模板化，重试钮全仓同款） */
              <EmptyState icon="alert" title="数据读取失败" text={data.error} action={<Button size="small" variant="ghost" icon="refresh" onClick={() => void reload()}>重试</Button>} />
            ) : (
              /* 视图级错误边界（第 272 轮，健壮性域）：单视图渲染错误只降级当前内容区
                 （导航 / 头部不受影响），切视图时经 key 重建自动复位；entry 带视图名便于日志定位 */
              <ErrorBoundary key={view} entry={`learning/${view}`} retryable={false}>
                {view === 'overview' ? (
                  <OverviewView data={data} todoReloadKey={todoReloadTick} />
                ) : view === 'courses' ? (
                  <CoursesView data={data} />
                ) : view === 'schedule' ? (
                  <ScheduleView data={data} />
                ) : view === 'library' ? (
                  <LibraryView data={data} />
                ) : view === 'review' ? (
                  <ReviewView />
                ) : (
                  <StatsView data={data} />
                )}
              </ErrorBoundary>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function todayLabel(): string {
  const d = new Date();
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 · ${WEEKDAY_LABELS[(d.getDay() + 6) % 7]}`;
}

function openOptions(): void {
  try {
    void chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' });
  } catch {
    /* 扩展重载时忽略 */
  }
}
