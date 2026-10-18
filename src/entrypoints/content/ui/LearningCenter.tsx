import { useCallback, useEffect, useMemo, useState } from 'react';
import { callOp } from '@/core/shared/client';
import { WEEKDAY_LABELS } from '@/core/shared/constants';
import type {
  CourseBundle,
  DashboardReport,
  FavoriteEntity,
  FavoriteType,
  FolderEntity,
  NoteEntity,
  SessionEntity,
} from '@/core/shared/types';
import {
  formatClock,
  formatDuration,
  localDayKey,
  shortDayLabel,
  startOfLocalWeek,
} from '@/core/shared/utils';
import { pushToast, Button, Chip, EmptyState, Progress, Ring, SectionHead, Skeleton, StatCard, BarChart, cx } from './components';
import { Icon, type IconName } from './icons';
import { uiStore, useUiStore, type CenterView } from './store';
import type { MissedItem } from '@/core/shared/ops';

interface BundleData {
  bundles: CourseBundle[];
  report: DashboardReport | null;
  missed: MissedItem[];
  favorites: FavoriteEntity[];
  folders: FolderEntity[];
  notes: NoteEntity[];
  schedule: Array<{ courId: number; teclId: number; subjName: string; beginTime: number; endTime: number; clroName?: string; letiNumber?: number }>;
  loading: boolean;
  error: string | null;
  reload?: () => Promise<void>;
}

const EMPTY_DATA: BundleData = {
  bundles: [],
  report: null,
  missed: [],
  favorites: [],
  folders: [],
  notes: [],
  schedule: [],
  loading: true,
  error: null,
};

function useCenterData(version: number): BundleData & { reload: () => Promise<void> } {
  const [data, setData] = useState<BundleData>(EMPTY_DATA);
  const reload = useCallback(async () => {
    setData((prev) => ({ ...prev, loading: true, error: null }));
    let error: string | null = null;
    const bundles = await callOp('course.bundles', {}).catch((err) => {
      error = err instanceof Error ? err.message : '课程数据读取失败';
      return [] as CourseBundle[];
    });
    const [report, missed, favorites, folders, notes, schedule] = await Promise.all([
      callOp('stats.report', { days: 90 }).catch(() => null),
      callOp('schedule.missed', {}).catch(() => [] as MissedItem[]),
      callOp('fav.list', { filter: { limit: 500 } }).catch(() => [] as FavoriteEntity[]),
      callOp('folder.list', { includeArchived: true }).catch(() => [] as FolderEntity[]),
      callOp('note.list', {}).catch(() => [] as NoteEntity[]),
      callOp('schedule.list', {}).catch(() => []),
    ]);
    setData({ bundles, report, missed, favorites, folders, notes, schedule, loading: false, error });
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
  stats: { label: '学习统计', icon: 'chart', title: '学习统计', sub: '透明、只属于你的学习记录' },
};

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

function sessionLabel(session: SessionEntity): string {
  if (session.courLabel) return session.courLabel;
  const d = new Date(session.beginTime);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return session.letiNumber ? `${date} / 第${session.letiNumber}节课` : date;
}

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
    }),
    [data.bundles.length, data.missed.length, data.favorites.length, data.notes.length],
  );

  const [refreshing, setRefreshing] = useState(false);

  const reload = useCallback(async () => {
    setRefreshing(true);
    try {
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
    <div className="hdu-center" role="dialog" aria-label="智慧课堂学习中心">
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
            const count = key === 'courses' ? counts.courses : key === 'schedule' ? counts.missed : key === 'library' ? counts.library : 0;
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
            <Chip icon="calendar">{todayLabel()}</Chip>
            <Button size="small" variant="ghost" icon="refresh" onClick={() => void reload()} loading={data.loading || refreshing}>
              刷新
            </Button>
            <Button size="small" icon="external" onClick={() => actions.suppressCenter()}>
              站点原页面
            </Button>
          </div>
        </header>
        <div className="hdu-content hdu-scroll">
          <div className="hdu-content-inner">
            {data.error ? (
              <EmptyState icon="alert" title="数据读取失败" text={data.error} action={<Button onClick={() => void reload()}>重试</Button>} />
            ) : view === 'overview' ? (
              <OverviewView data={data} />
            ) : view === 'courses' ? (
              <CoursesView data={data} />
            ) : view === 'schedule' ? (
              <ScheduleView data={data} />
            ) : view === 'library' ? (
              <LibraryView data={data} />
            ) : (
              <StatsView data={data} />
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

// ───────────────────────── 总览 ─────────────────────────

function OverviewView({ data }: { data: BundleData }) {
  const actions = uiStore.actions;
  const report = data.report;
  const cont = pickContinue(data.bundles);
  const todaySec = report?.todaySec ?? 0;
  const weekSec = report?.weekSec ?? 0;
  const goalSec = (report?.goal.weeklyTargetSec ?? 5 * 3600) || 5 * 3600;
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

  return (
    <>
      <section className="hdu-hero">
        <div className="hdu-hero-main">
          <div>
            <div className="hdu-hero-eyebrow">继续学习 · Continue</div>
            <h1 className="hdu-hero-title">
              {cont ? `接着上次，把《${cont.bundle.course.subjName}》听下去。` : '把课堂留下，把进度握在手里。'}
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
          {cont ? <Ring value={cont.session.watchRatio ?? 0} /> : null}
        </div>
        <div className="hdu-hero-side">
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
          <StatCard icon="clock" label="今日学习" value={Math.round(todaySec / 60)} unit="分钟" foot={todaySec >= 600 ? '已达成今日打卡' : '再学 10 分钟即可打卡'} />
          <StatCard icon="chart" label="本周累计" value={(weekSec / 3600).toFixed(1)} unit="小时" foot={`共 ${days.slice(-7).filter((d) => d.validSec > 0).length} 天有学习记录`} />
          <StatCard icon="flame" label="连续学习" value={report?.streakDays ?? 0} unit="天" foot="按有有效观看的自然日计算" />
          <StatCard icon="target" label="完看课次" value={data.bundles.reduce((sum, b) => sum + b.finishedCount, 0)} unit="节" foot={`共 ${data.bundles.reduce((sum, b) => sum + b.sessionCount, 0)} 节课程`} />
        </div>
      </div>

      <div className="hdu-grid g2 hdu-section">
        <div className="hdu-card pad">
          <SectionHead title="近 7 天学习节奏" sub="仅统计有效观看" actions={<span className="hdu-chart-legend"><span className="hdu-dot ok" />今天</span>} />
          <BarChart data={last7} />
        </div>
        <div className="hdu-card pad">
          <SectionHead title="继续你的课程" sub={`${data.bundles.length} 门课程`} actions={<Button size="small" variant="ghost" icon="arrowRight" onClick={() => actions.setCenterView('courses')}>全部</Button>} />
          {data.loading ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <Skeleton height={38} />
              <Skeleton height={38} />
              <Skeleton height={38} />
            </div>
          ) : data.bundles.length === 0 ? (
            <EmptyState icon="book" title="还没有课程记录" text="在智慧课堂打开任意一节播放课，课程与进度会自动汇总到这里。" />
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
            <EmptyState icon="check" title="补看清单是空的" text="所有已结束的课次都已有观看记录，或者你已标记为到课。" />
          </div>
        ) : (
      <MissedList items={data.missed.slice(0, 4)} onExcluded={() => void data.reload?.()} />
        )}
      </div>
    </>
  );
}

// ───────────────────────── 课程 ─────────────────────────

function CoursesView({ data }: { data: BundleData }) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const [syncing, setSyncing] = useState(false);
  const actions = uiStore.actions;

  const syncNow = useCallback(
    async (force: boolean, quiet: boolean) => {
      setSyncing(true);
      try {
        await actions.syncCourses({ force, quiet });
      } finally {
        setSyncing(false);
      }
    },
    [actions],
  );

  // 从播放页/首页打开“我的课程”时也尝试同步一次；是否真正请求由 15 分钟节流决定。
  useEffect(() => {
    void syncNow(false, true);
  }, [syncNow]);

  const syncButton = (
    <Button size="small" variant="ghost" icon="refresh" loading={syncing} onClick={() => void syncNow(true, false)}>
      立即同步
    </Button>
  );

  if (data.loading) {
    return (
      <div className="hdu-course-grid">
        {Array.from({ length: 4 }).map((_, i) => (
          <div className="hdu-card" key={i} style={{ padding: 18 }}>
            <Skeleton height={24} width="60%" />
            <div style={{ height: 10 }} />
            <Skeleton height={14} width="40%" />
            <div style={{ height: 18 }} />
            <Skeleton height={40} />
          </div>
        ))}
      </div>
    );
  }
  if (data.bundles.length === 0) {
    return (
      <div className="hdu-card">
        <EmptyState
          icon="book"
          title="还没有课程"
          text="课程与课次需从站点只读同步。请确认已在站点登录，然后点「立即同步」；也可以先去站点课程页停留片刻。"
          action={
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
              {syncButton}
              <Button variant="ghost" icon="external" onClick={() => actions.suppressCenter()}>
                去站点课程页
              </Button>
            </div>
          }
        />
      </div>
    );
  }
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <div style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.6 }}>
          课程与课次来自站点只读同步；成功同步后 15 分钟内不再自动重复请求。
        </div>
        {syncButton}
      </div>
      <div className="hdu-course-grid">
        {data.bundles.map((bundle, index) => {
          const open = expanded === bundle.course.teclId;
          const finishedRatio = bundle.sessionCount > 0 ? bundle.finishedCount / bundle.sessionCount : 0;
          return (
            <div className={cx('hdu-card hover hdu-course-card')} key={bundle.course.teclId}>
              <div className={cx('hdu-course-cover', `c${(index % 4) + 1}`)}>
                <div>
                  <div className="hdu-course-kicker">{bundle.course.subjCode || bundle.course.semester || '课程'}</div>
                  <div className="hdu-course-name">{bundle.course.subjName}</div>
                  <div className="hdu-course-teacher">{bundle.course.teacherNames.join('、') || '教师未知'}</div>
                </div>
                <div className="hdu-course-badge">
                  <Chip>{bundle.course.clroName || '课程'}</Chip>
                </div>
              </div>
              <div className="hdu-course-body">
                <div className="hdu-course-stats">
                  <span><b>{bundle.sessionCount}</b> 节课</span>
                  <span><b>{formatDuration(bundle.watchedSec)}</b> 已看</span>
                  <span><b>{bundle.finishedCount}</b> 完看</span>
                  <span><b>{bundle.topicCount}</b> 知识点</span>
                </div>
                <Progress value={finishedRatio} jade />
                <div className="hdu-course-foot">
                  <Button size="small" icon={open ? 'chevronDown' : 'chevronRight'} onClick={() => setExpanded(open ? null : bundle.course.teclId)}>
                    {open ? '收起课次' : '展开课次'}
                  </Button>
                  <div style={{ marginLeft: 'auto' }}>
                    <Chip tone={finishedRatio >= 0.9 ? 'jade' : 'default'}>
                      完看 {Math.round(finishedRatio * 100)}%
                    </Chip>
                  </div>
                </div>
              </div>
              {open ? (
                <div className="hdu-session-list hdu-scroll">
                  {bundle.sessions.length === 0 ? (
                    <div className="hdu-empty" style={{ padding: 20 }}>尚无课次记录</div>
                  ) : (
                    bundle.sessions.map((session) => (
                      <button
                        type="button"
                        className="hdu-session-row"
                        key={session.courId}
                        onClick={() => actions.openSessionInSite(session.courId, bundle.course.teclId, { teclCode: bundle.course.teclCode })}
                        title="在站点打开这一节"
                      >
                        <span className={cx('hdu-session-dot', session.watchState === 'finished' ? 'done' : (session.watchRatio ?? 0) > 0 ? 'partial' : '')} />
                        <span className="hdu-session-label">{sessionLabel(session)}</span>
                        <span className="hdu-session-badges">
                          {session.watchRatio ? <span className="hdu-session-badge">{Math.round(session.watchRatio * 100)}%</span> : null}
                          {session.watchState === 'finished' ? <span className="hdu-session-badge">已看完</span> : null}
                        </span>
                        <Icon name="chevronRight" size={14} />
                      </button>
                    ))
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </>
  );
}

// ───────────────────────── 课表 / 补看 ─────────────────────────

function ScheduleView({ data }: { data: BundleData }) {
  const actions = uiStore.actions;
  const weekStart = startOfLocalWeek();
  const [syncing, setSyncing] = useState(false);
  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, i) => {
      const d = new Date(weekStart);
      d.setDate(d.getDate() + i);
      return d;
    }),
    [weekStart],
  );
  // 快照里可能还留着上周的数据：只渲染本周，避免“课表空着但提示未同步”
  const weekItems = useMemo(
    () => data.schedule.filter((item) => item.beginTime >= weekStart && item.beginTime < weekStart + 7 * 86_400_000),
    [data.schedule, weekStart],
  );
  const itemsByDay = useMemo(() => {
    const map = new Map<string, BundleData['schedule']>();
    for (const item of weekItems) {
      const key = localDayKey(new Date(item.beginTime));
      const list = map.get(key) ?? [];
      list.push(item);
      map.set(key, list);
    }
    return map;
  }, [weekItems]);

  const syncNow = useCallback(async () => {
    setSyncing(true);
    try {
      await actions.syncSchedule({ force: true });
      await data.reload?.();
    } finally {
      setSyncing(false);
    }
  }, [actions, data]);

  return (
    <>
      <div className="hdu-card pad">
        <SectionHead
          title="本周课表"
          sub={`${weekDays[0] ? shortDayLabel(localDayKey(weekDays[0])) : ''} – ${weekDays[6] ? shortDayLabel(localDayKey(weekDays[6])) : ''}`}
          actions={
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Chip tone="info" icon="info">仅供个人参考，非考勤依据</Chip>
              <Button size="small" variant="ghost" icon="refresh" loading={syncing} onClick={() => void syncNow()}>
                同步课表
              </Button>
            </div>
          }
        />
        <div className="hdu-week hdu-scroll-x">
          <div />
          {weekDays.map((d) => (
            <div className="hdu-week-head" key={d.toISOString()}>
              {WEEKDAY_LABELS[(d.getDay() + 6) % 7]}
              <div style={{ fontFamily: 'var(--font-serif)', fontSize: 13, color: 'var(--ink-soft)' }}>{d.getDate()}</div>
            </div>
          ))}
          <div className="hdu-week-head" style={{ textAlign: 'left' }} />
          {weekDays.map((d) => {
            const items = itemsByDay.get(localDayKey(d)) ?? [];
            return (
              <div className={cx('hdu-week-cell', items.length > 0 ? 'has' : '')} key={d.toISOString()}>
                {items.slice(0, 4).map((item) => (
                  <button
                    type="button"
                    className={cx('hdu-week-course', item.courId % 2 === 0 ? 'jade' : '')}
                    key={`${item.teclId}-${item.courId}`}
                    title={`${item.subjName} ${item.clroName ?? ''}`}
                    onClick={() => actions.openSessionInSite(item.courId, item.teclId)}
                  >
                    {item.subjName}
                  </button>
                ))}
                {items.length > 4 ? <span className="hdu-session-badge">+{items.length - 4}</span> : null}
              </div>
            );
          })}
        </div>
        {weekItems.length === 0 ? (
          <div className="hdu-hint" style={{ marginTop: 12 }}>
            {data.schedule.length > 0
              ? '本周暂无课程安排。'
              : '尚未同步课表。点击右上角「同步课表」，或打开站点「我的课表」页面后，插件会自动读取本周课程；课表只保存在本机。'}
          </div>
        ) : null}
      </div>

      <div className="hdu-section">
        <SectionHead title="补看清单" sub="课次结束超过设定时间且无有效观看时列入" actions={<Button size="small" variant="ghost" icon="refresh" onClick={() => void data.reload?.()}>刷新</Button>} />
        {data.missed.length === 0 ? (
          <div className="hdu-card">
            <EmptyState icon="check" title="没有待补看的课次" text="已结束的课次都有有效观看记录，或已标记为到课。" />
          </div>
        ) : (
          <MissedList items={data.missed} onExcluded={() => void data.reload?.()} />
        )}
      </div>
    </>
  );
}

function MissedList({ items, onExcluded }: { items: MissedItem[]; onExcluded: () => void }) {
  const actions = uiStore.actions;
  return (
    <div className="hdu-missed-list">
      {items.map((item) => {
        const d = new Date(item.beginTime);
        return (
          <div className="hdu-missed" key={item.courId}>
            <div className="hdu-missed-date">
              <div className="hdu-missed-day">{String(d.getDate()).padStart(2, '0')}</div>
              <div className="hdu-missed-month">{d.getMonth() + 1} 月</div>
            </div>
            <div className="hdu-list-main">
              <div className="hdu-list-title">{item.courseName}</div>
              <div className="hdu-list-sub">
                <span>{item.courLabel}</span>
                <span>已过 {Math.max(0, Math.round((Date.now() - item.beginTime) / 3_600_000))} 小时</span>
                {item.watchedSec > 0 ? <span>已看 {formatDuration(item.watchedSec)}</span> : null}
              </div>
            </div>
            <div className="hdu-list-side">
              <Button size="small" icon="play" onClick={() => actions.openSessionInSite(item.courId, item.teclId)}>去补看</Button>
              <Button
                size="small"
                variant="ghost"
                onClick={() => {
                  void callOp('schedule.exclude', { courId: item.courId, excluded: true }).then(() => {
                    pushToast('已标记为到课，不再进入补看清单', 'success');
                    onExcluded();
                  });
                }}
              >
                已到课
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ───────────────────────── 知识库 ─────────────────────────

const FAVORITE_LABELS: Record<FavoriteType, { label: string; icon: IconName }> = {
  time: { label: '时间点', icon: 'clock' },
  ai: { label: 'AI 回答', icon: 'spark' },
  outline: { label: '大纲', icon: 'list' },
  screenshot: { label: '截图', icon: 'camera' },
  note: { label: '笔记', icon: 'note' },
};

function LibraryView({ data }: { data: BundleData }) {
  const [type, setType] = useState<FavoriteType | 'all'>('all');
  const [folder, setFolder] = useState<string | 'all'>('all');
  const [query, setQuery] = useState('');
  const actions = uiStore.actions;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return data.favorites.filter((fav) => {
      if (type !== 'all' && fav.type !== type) return false;
      if (folder !== 'all' && (fav.folderId ?? '') !== folder) return false;
      if (q) {
        const hay = `${fav.snapshot.title} ${fav.snapshot.content} ${fav.note ?? ''} ${fav.tags.join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [data.favorites, type, folder, query]);

  const exportCards = useCallback(() => {
    const lines: string[] = ['# 智慧课堂复习卡片', ''];
    for (const fav of filtered) {
      lines.push(`## ${fav.snapshot.title}`, '', fav.snapshot.content, '');
      if (fav.note) lines.push(`> ${fav.note}`, '');
      if (fav.anchorTime != null) lines.push(`- 时间点：${formatClock(fav.anchorTime)}`);
      lines.push(`- 类型：${FAVORITE_LABELS[fav.type].label}`, '');
    }
    downloadText(`智慧课堂-复习卡片-${localDayKey()}.md`, lines.join('\n'));
    pushToast('复习卡片已导出', 'success');
  }, [filtered]);

  return (
    <>
      <div className="hdu-filterbar">
        <div className="hdu-search">
          <Icon name="search" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索标题、内容、标签…" />
        </div>
        <button type="button" className={cx('hdu-filter-pill', type === 'all' ? 'is-active' : '')} onClick={() => setType('all')}>全部</button>
        {(Object.keys(FAVORITE_LABELS) as FavoriteType[]).map((key) => (
          <button type="button" key={key} className={cx('hdu-filter-pill', type === key ? 'is-active' : '')} onClick={() => setType(key)}>
            {FAVORITE_LABELS[key].label}
          </button>
        ))}
        <div style={{ marginLeft: 'auto' }}>
          <Button size="small" icon="download" onClick={exportCards} disabled={filtered.length === 0}>导出卡片</Button>
        </div>
      </div>
      {data.folders.length > 0 ? (
        <div className="hdu-folder-row hdu-scroll-x">
          <button type="button" className={cx('hdu-folder', folder === 'all' ? 'is-active' : '')} onClick={() => setFolder('all')}>全部文件夹</button>
          {data.folders.map((f) => (
            <button type="button" key={f.id} className={cx('hdu-folder', folder === f.id ? 'is-active' : '')} onClick={() => setFolder(f.id)}>
              <Icon name="folder" size={13} /> {f.name}
            </button>
          ))}
        </div>
      ) : null}
      {filtered.length === 0 ? (
        <div className="hdu-card">
          <EmptyState
            icon="library"
            title={data.favorites.length === 0 ? '知识库还是空的' : '没有匹配的条目'}
            text={data.favorites.length === 0 ? '在播放页收藏时间点、AI 回答、大纲节点或截图，它们会汇集在这里，可检索、可导出。' : '试试更换筛选条件或清除搜索关键词。'}
          />
        </div>
      ) : (
        <div className="hdu-knowledge-grid">
          {filtered.map((fav) => {
            const meta = FAVORITE_LABELS[fav.type];
            return (
              <div className="hdu-card hover hdu-knowledge-card" key={fav.id}>
                <div className="hdu-knowledge-head">
                  <Icon name={meta.icon} size={13} />
                  {meta.label}
                  {fav.anchorTime != null ? <span className="hdu-time-badge">{formatClock(fav.anchorTime)}</span> : null}
                  {fav.pinned ? <Chip tone="accent">置顶</Chip> : null}
                </div>
                <div className="hdu-knowledge-title">{fav.snapshot.title}</div>
                <div className="hdu-knowledge-text">{fav.snapshot.content || '（无正文）'}</div>
                {fav.note ? <div className="hdu-hint">备注：{fav.note}</div> : null}
                <div className="hdu-knowledge-foot">
                  {fav.tags.map((tag) => <span className="hdu-tag" key={tag}>{tag}</span>)}
                  {fav.courId ? (
                    <button type="button" className="hdu-btn ghost small" style={{ marginLeft: 'auto' }} onClick={() => actions.openSessionInSite(fav.courId!, fav.teclId)}>
                      回到课堂 <Icon name="arrowRight" size={12} />
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {data.notes.length > 0 ? (
        <div className="hdu-section">
          <SectionHead title="我的笔记" sub={`${data.notes.length} 条时间戳笔记`} />
          <div className="hdu-card pad">
            <div className="hdu-list">
              {data.notes.slice(0, 12).map((note) => (
                <div className="hdu-note" key={note.id}>
                  <button type="button" className="hdu-note-time" onClick={() => actions.openSessionInSite(note.courId, note.teclId)}>
                    {formatClock(note.anchorTime)}
                  </button>
                  <div className="hdu-note-body">
                    <div className="hdu-note-text">{note.text}</div>
                    <div className="hdu-hint" style={{ marginTop: 4 }}>{localDayKey(new Date(note.createdAt))}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function downloadText(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ───────────────────────── 统计 ─────────────────────────

function StatsView({ data }: { data: BundleData }) {
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
          <div className="hdu-metric-head"><Icon name="flame" /> 连续学习</div>
          <div className="hdu-metric-value">{report.streakDays}<small>天</small></div>
          <div className="hdu-hint">按有有效观看的自然日连续计算</div>
        </div>
      </div>

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
          <SectionHead title="课程分布" sub="按有效学习时长排序" />
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
        </div>
      </div>

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
        本页数据全部来自本机，不上报站点，也不改变站点的观看记录。
      </div>
    </>
  );
}
