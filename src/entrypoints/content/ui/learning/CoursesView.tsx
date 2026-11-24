// 学习中心「我的课程」视图（自 LearningCenter.tsx 第 40 轮巡检按视图纯搬移拆分，逻辑不变）：
// 课程卡网格 + 课次展开列表，含「立即同步」入口；第 82 轮巡检增排序选择器。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { nextUnfinishedSession } from '@/core/stats/aggregate';
import { formatDuration } from '@/core/shared/utils';
import { Button, Chip, EmptyState, Progress, Skeleton, cx } from '../components';
import { Icon } from '../icons';
import { uiStore } from '../store';
import { sessionLabel, type BundleData } from './shared';

// ───────────────────────── 课程 ─────────────────────────

type CourseSortKey = 'default' | 'ratio' | 'watched' | 'name';
type CourseStatusFilter = 'all' | 'finished' | 'progress' | 'unstarted';

/** 排序选择项（第 82 轮巡检）：默认=站点同步顺序，其余为本地即时排序 */
const COURSE_SORT_OPTIONS: Array<{ value: CourseSortKey; label: string }> = [
  { value: 'default', label: '默认排序' },
  { value: 'ratio', label: '按完看度' },
  { value: 'watched', label: '按已看时长' },
  { value: 'name', label: '按课程名' },
];

/** 完看状态筛选项（第 83 轮巡检）：按课程完看比率分档（100% / >0 / 0） */
const COURSE_STATUS_OPTIONS: Array<{ value: CourseStatusFilter; label: string }> = [
  { value: 'all', label: '全部状态' },
  { value: 'finished', label: '已完看' },
  { value: 'progress', label: '进行中' },
  { value: 'unstarted', label: '未开始' },
];

/** 课程完看比率（无课次记 0） */
function courseFinishedRatio(bundle: BundleData['bundles'][number]): number {
  return bundle.sessionCount > 0 ? bundle.finishedCount / bundle.sessionCount : 0;
}

/** 完看状态筛选判定（第 83 轮巡检） */
function matchesStatusFilter(bundle: BundleData['bundles'][number], filter: CourseStatusFilter): boolean {
  if (filter === 'all') return true;
  const ratio = courseFinishedRatio(bundle);
  if (filter === 'finished') return ratio >= 1;
  if (filter === 'progress') return ratio > 0 && ratio < 1;
  return ratio <= 0;
}

export function CoursesView({ data }: { data: BundleData }) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [sortBy, setSortBy] = useState<CourseSortKey>('default');
  // 课程搜索（第 100 轮巡检）：按课程名/教师/课程代码过滤
  const [courseQuery, setCourseQuery] = useState('');
  // 筛选（第 83 轮巡检）：完看状态 + 学期（学期取自课程元数据，自动去重）；教师筛选（第 84 轮巡检）
  const [statusFilter, setStatusFilter] = useState<CourseStatusFilter>('all');
  const [semesterFilter, setSemesterFilter] = useState<string>('all');
  const [teacherFilter, setTeacherFilter] = useState<string | null>(null);
  const actions = uiStore.actions;

  const semesters = useMemo(() => {
    const set = new Set<string>();
    for (const bundle of data.bundles) {
      if (bundle.course.semester) set.add(bundle.course.semester);
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  }, [data.bundles]);

  // 教师自动聚合（第 84 轮巡检）：教师名去重（出现 ≥2 位教师才显示筛选）
  const teachers = useMemo(() => {
    const set = new Set<string>();
    for (const bundle of data.bundles) {
      for (const teacher of bundle.course.teacherNames ?? []) {
        if (teacher) set.add(teacher);
      }
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  }, [data.bundles]);

  // 本地筛选（第 83/84/100 轮巡检）：搜索（课程名/教师/课程代码）→ 完看状态 → 学期 → 教师，再排序
  const courseFiltered = useMemo(() => {
    const kw = courseQuery.trim().toLowerCase();
    if (!kw) return data.bundles;
    return data.bundles.filter((bundle) => {
      const hay = `${bundle.course.subjName} ${(bundle.course.teacherNames ?? []).join(' ')} ${bundle.course.subjCode ?? ''}`.toLowerCase();
      return hay.includes(kw);
    });
  }, [data.bundles, courseQuery]);
  const sortedBundles = useMemo(() => {
    const list = courseFiltered.filter(
      (bundle) =>
        matchesStatusFilter(bundle, statusFilter) &&
        (semesterFilter === 'all' || bundle.course.semester === semesterFilter) &&
        (teacherFilter === null || (bundle.course.teacherNames ?? []).includes(teacherFilter)),
    );
    if (sortBy === 'ratio') {
      list.sort((a, b) => courseFinishedRatio(b) - courseFinishedRatio(a));
    } else if (sortBy === 'watched') {
      list.sort((a, b) => b.watchedSec - a.watchedSec);
    } else if (sortBy === 'name') {
      list.sort((a, b) => a.course.subjName.localeCompare(b.course.subjName, 'zh-Hans-CN'));
    }
    return list;
  }, [data.bundles, courseQuery, sortBy, statusFilter, semesterFilter, teacherFilter]);

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
            /* 空态 CTA 统一 small ghost（第 249 轮空态模板化）：syncButton 本就是 small ghost */
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
              {syncButton}
              <Button size="small" variant="ghost" icon="external" onClick={() => actions.suppressCenter()}>
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.6 }}>
          课程与课次来自站点只读同步；成功同步后 15 分钟内不再自动重复请求。
        </div>
        {/* 课程搜索（第 100 轮巡检）：按课程名/教师/课程代码过滤 */}
        <div className="hdu-search" style={{ flex: 'none' }}>
          <Icon name="search" />
          <input
            value={courseQuery}
            onChange={(e) => setCourseQuery(e.target.value)}
            placeholder="搜索课程 / 教师…"
            aria-label="搜索课程"
          />
        </div>
        {/* 筛选（第 83 轮巡检）：完看状态 + 学期，本地即时过滤 */}
        <select
          className="hdu-input"
          style={{ width: 'auto', height: 30, flex: 'none' }}
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as CourseStatusFilter)}
          aria-label="按完看状态筛选"
        >
          {COURSE_STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {semesters.length > 1 ? (
          <select
            className="hdu-input"
            style={{ width: 'auto', height: 30, flex: 'none' }}
            value={semesterFilter}
            onChange={(e) => setSemesterFilter(e.target.value)}
            aria-label="按学期筛选"
          >
            <option value="all">全部学期</option>
            {semesters.map((semester) => (
              <option key={semester} value={semester}>
                {semester}
              </option>
            ))}
          </select>
        ) : null}
        {/* 排序选择器（第 82 轮巡检）：本地即时排序，不改同步数据 */}
        <select
          className="hdu-input"
          style={{ width: 'auto', height: 30, flex: 'none' }}
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as CourseSortKey)}
          aria-label="课程排序"
        >
          {COURSE_SORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {syncButton}
      </div>
      {teachers.length > 1 ? (
        /* 教师筛选（第 84 轮巡检）：教师名自动聚合，与状态/学期/排序叠加 */
        <div className="hdu-folder-row hdu-scroll-x" style={{ marginBottom: 12 }}>
          <button
            type="button"
            className={cx('hdu-folder', teacherFilter === null ? 'is-active' : '')}
            onClick={() => setTeacherFilter(null)}
          >
            全部教师
          </button>
          {teachers.map((teacher) => (
            <button
              type="button"
              key={teacher}
              className={cx('hdu-folder', teacherFilter === teacher ? 'is-active' : '')}
              onClick={() => setTeacherFilter(teacherFilter === teacher ? null : teacher)}
            >
              {teacher}
            </button>
          ))}
        </div>
      ) : null}
      {sortedBundles.length === 0 ? (
        <div className="hdu-card">
          {/* 空态引导型补 CTA（第 249 轮空态模板化）：筛选/搜索无匹配时附「清空搜索与筛选」
              一键复位（原为纯文案告知，引导场景缺行动入口） */}
          <EmptyState
            icon="book"
            title={courseQuery.trim() ? '没有匹配的课程' : '没有符合筛选条件的课程'}
            text={
              courseQuery.trim()
                ? '换个课程名、教师或课程代码试试，或清除搜索关键词。'
                : '调整完看状态或学期筛选后重试，或点「立即同步」刷新课程。'
            }
            action={
              <Button
                size="small"
                variant="ghost"
                icon="refresh"
                onClick={() => {
                  setCourseQuery('');
                  setStatusFilter('all');
                  setSemesterFilter('all');
                  setTeacherFilter(null);
                }}
              >
                清空搜索与筛选
              </Button>
            }
          />
        </div>
      ) : (
      <div className="hdu-course-grid">
        {sortedBundles.map((bundle, index) => {
          const open = expanded === bundle.course.teclId;
          const finishedRatio = courseFinishedRatio(bundle);
          // 下一节（第 255 轮课程域候选 B）：课程时间序第一个未完看课次，全完看为 null
          const next = nextUnfinishedSession(bundle.sessions);
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
                {/* 下一节直达行（第 255 轮课程域候选 B）：未展开课次列表时的一键续学落点——
                    点击语义与展开列表里的课次行一致（openSessionInSite，play-center 深链）；
                    jade 软底行与既有 .hdu-golden-hint 家族同克制度，样式见 styles.ts .hdu-course-next */}
                {next ? (
                  <button
                    type="button"
                    className="hdu-course-next"
                    onClick={() => actions.openSessionInSite(next.courId, bundle.course.teclId, { teclCode: bundle.course.teclCode })}
                    title="在站点打开这一节继续学习"
                    aria-label={`继续学习下一节：${sessionLabel(next)}`}
                  >
                    <Icon name="play" size={13} />
                    <span className="hdu-course-next-label">下一节 · {sessionLabel(next)}</span>
                    <Icon name="chevronRight" size={13} />
                  </button>
                ) : null}
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
      )}
    </>
  );
}
