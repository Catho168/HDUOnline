/**
 * 学习中心「复习计划」视图（第 83 轮巡检）：全量复习作业三分区——
 * 待完成（按到期日升序，行内「去复习 / 完成 / 跳过」）、已完成（最近优先，最多 30 条）、
 * 已跳过。数据经 review.list op（含 favorite 快照，可能 null=收藏已删除）；
 * 完成/跳过接 review.complete 后重拉；待完成行的跳转复用 buildHubTodayItems 的
 * 站外链接解析（B 站收藏带 ?t=/?p= 直达，HDU 站内收藏跳学习看板）。
 * 与「今日待办」卡的差异：这里看全量计划与历史，今日卡只看今天到期。
 * 第 244 轮巡检：顺延到指定日——列表行「改期」先展开行内轻量浮层（快捷 chips
 * 点选即顺延，buildRescheduleOptions 共享 8 档：明天/后天/周X…/下周同一日/下月
 * 同一日），「其他日期…」进完整改期弹层；批量改期弹层同款；目标日期钳制不早于
 * 今日，选今天 = 保持不变（提示「已是今日到期」）。
 * 第 245 轮巡检：①完成（done）toast 升级「已完成 · 建议 M月D日 再看」+「排到 M月D日」
 * 轻按钮（suggestNextReviewDate 倍增序列 [3,7,14,30]；按钮 = reopen + reschedule，
 * 纯提示不自动写数据）；②待完成列表渐进显示（前 60 条 + 显示更多，对齐知识库
 * 第 225 轮策略，visibleRowsOf 共享切分；筛选/搜索变化即重置，完成重拉不重置）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { callOp } from '@/core/shared/client';
import { errorTextOf } from '@/core/shared/errors';
import { DEFAULT_SETTINGS } from '@/core/shared/constants';
import type { FavoriteEntity, FavoriteType, ReviewJobEntity, ReviewTemplate } from '@/core/shared/types';
import { buildHubTodayItems, type HubTodayReviewItem } from '../BiliHubTodayCard';
import { buildReviewWeekColumns, buildReviewMonthGrid, jobIdsForDayFilter } from '@/core/plan/reviewWeek';
import { buildReviewForecast, forecastBarTitle, type ReviewForecastBar } from '@/core/plan/reviewForecast';
import { buildRescheduleOptions, clampRescheduleDate, type RescheduleOption } from '@/core/plan/rescheduleOptions';
import { intervalScalePosition, lastIntervalForRound, monthDayLabelOf, suggestNextReviewDate, type IntervalScalePosition } from '@/core/plan/reviewSuggest';
import { buildReviewStats, type ReviewStats } from '@/core/plan/reviewStats';
import { buildReviewDoneMarkdown } from '@/core/export/reviewDone';
import { buildReviewPlanMarkdown } from '@/core/export/reviewPlan';
import { addDaysKey, localDayKey } from '@/core/shared/utils';
import { FAVORITE_META } from '../VideoFavCard';
import { exportReviewCards, downloadTextFile } from '../reviewCards';
import { Button, Chip, EmptyState, Modal, Progress, SectionHead, Skeleton, pushToast, cx } from '../components';
import { Icon } from '../icons';
import { uiStore, DEFAULT_REVIEW_FILTERS, type ReviewFilters } from '../store';
import { nextVisibleLimit, visibleRowsOf } from './progressive';
import { useAchievementCounts } from './AchievementStrip';
import { buildAchievements } from '@/core/plan/achievements';

/** 月份键平移（'YYYY-MM' ± delta）；非法键原样返回 */
function shiftMonth(key: string, delta: number): string {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) return key;
  const d = new Date(Number(m[1]), Number(m[2]) - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function ReviewView() {
  const actions = uiStore.actions;
  // 学习成就角标（第 132 轮巡检）：复习计划页头显示已解锁徽章数（与总览/B 站今日卡同全局口径）
  const achievementCounts = useAchievementCounts();
  const unlockedBadges = useMemo(
    () =>
      buildAchievements({
        totalSec: achievementCounts.totalSec,
        streakDays: achievementCounts.streakDays,
        favoriteCount: achievementCounts.favorites,
        externalSec: achievementCounts.externalSec,
        reviewDoneCount: achievementCounts.reviewDone,
        noteCount: achievementCounts.notes,
        goalScale: achievementCounts.goalScale,
        customBadges: achievementCounts.customBadges,
      }).filter((row) => row.unlocked).length,
    [achievementCounts],
  );
  // 课程名映射（第 137 轮巡检）：整页导出的待完成行按课程分组
  const [courseNames, setCourseNames] = useState<Record<number, string>>({});
  useEffect(() => {
    let disposed = false;
    callOp('course.bundles', {})
      .then((bundles) => {
        if (disposed) return;
        const map: Record<number, string> = {};
        for (const bundle of Array.isArray(bundles) ? bundles : []) {
          const name = bundle?.course?.subjName;
          if (typeof name !== 'string') continue;
          for (const session of Array.isArray(bundle?.sessions) ? bundle.sessions : []) {
            if (session && typeof session.courId === 'number') map[session.courId] = name;
          }
        }
        setCourseNames(map);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, []);
  const [jobs, setJobs] = useState<Array<ReviewJobEntity & { favorite: FavoriteEntity | null }> | null>(null);
  const [failed, setFailed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const loadSeqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    setFailed(false);
    try {
      const result = await callOp('review.list', {});
      if (loadSeqRef.current !== seq) return;
      setJobs(Array.isArray(result) ? result : []);
    } catch {
      if (loadSeqRef.current !== seq) return;
      setJobs([]);
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const all = jobs ?? [];

  /**
   * 「排到 M月D日」action（第 245 轮巡检，完成 toast 内轻量按钮，ttl 8s 内有效）：
   * 复活刚完成的 done 作业（review.reopen 回 pending、到期日拉回今天起算）再
   * review.reschedule 到建议日。纯函数建议本身不写数据，只有这里（用户显式点击）
   * 才改库——避免自动排期打扰既有计划（既有下一轮 pending 作业保持不动）。
   */
  const scheduleCompletedJob = useCallback(
    async (jobId: string, dateKey: string, label?: string) => {
      setBusyId(jobId);
      try {
        await callOp('review.reopen', { jobId });
        await callOp('review.reschedule', { jobId, dueDate: dateKey });
        pushToast(label ? `已排到 ${label}（${dateKey}）再看` : `已排到 ${dateKey} 再看`, 'success');
        await load();
      } catch (err) {
        pushToast(errorTextOf(err, '排期失败，请重试'), 'error');
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  /** 完成 / 跳过：review.complete 后重拉（与今日待办、Dashboard 复习看板同一 op）。
   *  第 245 轮：done 时 toast 升级为「已完成 · 建议 M月D日 再看」——建议日期来自
   *  suggestNextReviewDate 纯函数（按作业模板间隔推进倍增序列 [3,7,14,30]，脏数据
   *  回退首档 3 天；建议不可得时维持普通完成文案），并附「排到 M月D日」轻按钮。 */
  const settle = useCallback(
    async (jobId: string, status: 'done' | 'skipped') => {
      setBusyId(jobId);
      try {
        await callOp('review.complete', { jobId, status });
        if (status === 'done') {
          const job = all.find((j) => j.id === jobId);
          const suggestion = suggestNextReviewDate(
            Date.now(),
            lastIntervalForRound(
              job?.template,
              job?.round,
              uiStore.getState().settings.review?.intervals ?? DEFAULT_SETTINGS.review.intervals,
            ),
          );
          if (suggestion) {
            const label = monthDayLabelOf(suggestion.dateKey);
            pushToast(`已完成 · 建议 ${label} 再看`, 'success', 8000, {
              label: `排到 ${label}`,
              run: () => scheduleCompletedJob(jobId, suggestion.dateKey, label),
            });
          } else {
            pushToast('完成一轮复习', 'success');
          }
        } else {
          pushToast('已跳过本次复习', 'success');
        }
        await load();
      } catch (err) {
        // 第 255 轮错误文案盘点：泛化兜底「操作失败，请重试」补上下文词——与 B 站今日卡
        // 同一 op（review.complete）的兜底「完成复习失败，请重试」对齐（BiliHubTodayCard）
        pushToast(errorTextOf(err, '完成复习失败，请重试'), 'error');
      } finally {
        setBusyId(null);
      }
    },
    [all, load, scheduleCompletedJob],
  );

  // 筛选/排序（第 84/88/97/103 轮巡检；第 104 轮起随 settings 持久化，跨打开保留）：
  // 本地 state 即时生效（点击不等存储回程），同步镜像进 uiStore.settings（重开即读），
  // 再经 saveSetting 落 chrome.storage.sync（内容脚本启动时随 settings 回填）。
  const [reviewFilters, setFiltersState] = useState<ReviewFilters>(() => ({
    ...DEFAULT_REVIEW_FILTERS,
    ...uiStore.getState().settings.ui?.reviewFilters,
  }));
  const setReviewFilters = (patch: Partial<ReviewFilters>) => {
    const next = { ...reviewFilters, ...patch };
    setFiltersState(next);
    const ui = { ...uiStore.getState().settings.ui, reviewFilters: next };
    uiStore.patch({ settings: { ...uiStore.getState().settings, ui } });
    void actions.saveSetting('ui', ui);
  };
  // 有任一筛选/排序偏离缺省时给「重置筛选」一键还原（第 104 轮巡检；第 105 轮含周视图日筛选）
  const [dayFilter, setDayFilter] = useState<string | null>(null);
  const filtersActive =
    dayFilter !== null ||
    reviewFilters.type !== 'all' ||
    reviewFilters.template !== 'all' ||
    reviewFilters.urgency !== 'all' ||
    reviewFilters.sort !== 'due' ||
    reviewFilters.courseCourId !== undefined;
  // 最近套用的快照名（第 128 轮巡检：快照快捷回溯标注；重置筛选时清除）
  const [snapshotsLast, setSnapshotsLast] = useState<string | null>(
    () => uiStore.getState().settings.ui?.reviewSnapshotsLast ?? null,
  );
  const resetFilters = () => {
    setDayFilter(null);
    setReviewFilters({ type: 'all', template: 'all', urgency: 'all', sort: 'due', courseCourId: undefined });
    setSnapshotsLast(null);
    const settings = uiStore.getState().settings;
    const ui = { ...settings.ui, reviewSnapshotsLast: undefined };
    uiStore.patch({ settings: { ...settings, ui } });
    void actions.saveSetting('ui', ui);
  };
  // 筛选快照（第 125 轮巡检）：命名保存当前筛选组合，一键套用（settings.ui.reviewSnapshots
  // 持久化，跨打开保留；最多 6 个，超出淘汰最旧）。第 126 轮起支持自定义名称（重名自动加序号）
  const [snapshots, setSnapshots] = useState<Array<{ name: string; filters: ReviewFilters }>>(
    () => uiStore.getState().settings.ui?.reviewSnapshots ?? [],
  );
  const [snapshotName, setSnapshotName] = useState('');
  const persistSnapshots = useCallback(
    (next: Array<{ name: string; filters: ReviewFilters }>) => {
      setSnapshots(next);
      const settings = uiStore.getState().settings;
      const ui = { ...settings.ui, reviewSnapshots: next };
      uiStore.patch({ settings: { ...settings, ui } });
      void actions.saveSetting('ui', ui);
    },
    [actions],
  );
  const saveSnapshot = useCallback(() => {
    const stamp = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const base = snapshotName.trim() || `快照 ${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())} ${pad(stamp.getHours())}:${pad(stamp.getMinutes())}`;
    // 重名自动加序号：名称、名称·2、名称·3…
    let name = base;
    for (let i = 2; snapshots.some((snapshot) => snapshot.name === name); i += 1) name = `${base}·${i}`;
    persistSnapshots([...snapshots, { name, filters: reviewFilters }].slice(-6));
    setSnapshotName('');
    pushToast(`已保存「${name}」`, 'success');
  }, [snapshots, reviewFilters, snapshotName, persistSnapshots]);
  const applySnapshot = useCallback(
    (name: string) => {
      const hit = snapshots.find((snapshot) => snapshot.name === name);
      if (!hit) return;
      setDayFilter(null);
      setReviewFilters(hit.filters);
      setSnapshotsLast(name);
      const settings = uiStore.getState().settings;
      const ui = { ...settings.ui, reviewSnapshotsLast: name };
      uiStore.patch({ settings: { ...settings, ui } });
      void actions.saveSetting('ui', ui);
      pushToast(`已套用「${name}」`, 'success');
    },
    [snapshots],
  );
  const removeSnapshot = useCallback(
    (name: string) => {
      persistSnapshots(snapshots.filter((snapshot) => snapshot.name !== name));
    },
    [snapshots, persistSnapshots],
  );
  // 快照重命名（第 127 轮巡检）：chip 上直接改；重名自动加序号
  const [renamingSnapshot, setRenamingSnapshot] = useState<{ old: string; value: string } | null>(null);
  const saveSnapshotRename = useCallback(() => {
    if (!renamingSnapshot) return;
    const base = renamingSnapshot.value.trim();
    if (!base) return;
    let final = base;
    for (let i = 2; snapshots.some((snapshot) => snapshot.name === final && snapshot.name !== renamingSnapshot.old); i += 1) {
      final = `${base}·${i}`;
    }
    persistSnapshots(
      snapshots.map((snapshot) => (snapshot.name === renamingSnapshot.old ? { name: final, filters: snapshot.filters } : snapshot)),
    );
    setRenamingSnapshot(null);
    pushToast(`快照已重命名为「${final}」`, 'success');
  }, [renamingSnapshot, snapshots, persistSnapshots]);
  const typeFilter = reviewFilters.type;
  const templateFilter = reviewFilters.template;
  const urgencyFilter = reviewFilters.urgency;
  const pendingSort = reviewFilters.sort;
  // 待完成区形态（第 106 轮巡检）：list = 行列表；week = 周视图（随 settings 持久化）
  const viewMode = reviewFilters.viewMode;
  // 周视图窗口档（第 108/110 轮巡检）：7 天 / 14 天 / 30 天（月历式 7 列栅格）
  const viewRange = reviewFilters.viewRange === 30 ? 30 : reviewFilters.viewRange === 14 ? 14 : 7;
  // 月视图（第 111 轮巡检）：当前渲染的月份——第 117 轮起持久化到 settings.ui.reviewMonth
  //（跨打开保留，恢复上次浏览的月份；无记录时用当前月）
  const [monthKey, setMonthKeyState] = useState(
    () => uiStore.getState().settings.ui.reviewMonth || localDayKey().slice(0, 7),
  );
  const navMonth = useCallback(
    (delta: number) => {
      const key = shiftMonth(monthKey, delta);
      setMonthKeyState(key);
      // 同步镜像进 uiStore.settings（重挂载/重开即读），再异步落盘（第 112 轮同款时序处理）
      const settings = uiStore.getState().settings;
      const ui = { ...settings.ui, reviewMonth: key };
      uiStore.patch({ settings: { ...settings, ui } });
      void actions.saveSetting('ui', ui);
    },
    [monthKey, actions],
  );
  // 回到今天（第 118 轮巡检）：月视图导航一键回到当前月
  const jumpToMonth = useCallback(
    (key: string) => {
      setMonthKeyState(key);
      const settings = uiStore.getState().settings;
      const ui = { ...settings.ui, reviewMonth: key };
      uiStore.patch({ settings: { ...settings, ui } });
      void actions.saveSetting('ui', ui);
    },
    [actions],
  );
  // 已完成分页（第 85 轮巡检）：默认 30 条，「查看更多」每次 +30
  const [doneLimit, setDoneLimit] = useState(30);
  // 待完成列表渐进显示（第 245 轮巡检，性能域）：默认前 60 条 +「显示更多」（visibleRowsOf
  // 共享切分，对齐知识库第 225 轮策略）。多收藏 × 多轮计划下 pending 可能远超 60 条
  // （如 50 收藏 × 3 轮 = 150 行），一次性渲染拖慢键入搜索时的整表重渲。
  // 重置口径与知识库不同点：只在筛选/搜索/视图形态变化时回首批（dep 为筛选输入），
  // 完成作业触发的重拉不重置——完成动作发生在列表顶部（按到期日排序），重置反而打断浏览。
  const [pendingLimit, setPendingLimit] = useState(60);
  // 历史分区折叠（第 114 轮巡检）：已完成/已跳过分区可收起（默认展开）
  const [doneOpen, setDoneOpen] = useState(true);
  const [skippedOpen, setSkippedOpen] = useState(true);
  // 多选批量完成（第 121 轮巡检）：待完成行勾选 → 批量完成
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const toggleSelect = useCallback((jobId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  }, []);
  const batchCompleteSelected = useCallback(async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    setBusyId('__batch_complete__');
    let ok = 0;
    for (const jobId of ids) {
      try {
        await callOp('review.complete', { jobId, status: 'done' });
        ok += 1;
      } catch {
        /* 单项失败继续其余，最终统一提示 */
      }
    }
    pushToast(ok === ids.length ? `已完成 ${ok} 项复习` : `已完成 ${ok}/${ids.length} 项（部分失败）`, ok > 0 ? 'success' : 'error');
    setSelectedIds(new Set());
    await load();
    setBusyId(null);
  }, [selectedIds, load]);

  /** 多选批量顺延（第 122 轮巡检）：所选 pending 作业逐条 review.reschedule 推一天
   * （与单行顺延同口径：逾期/到期日早于今天先拉回今天再 +1）；单项失败不中断。 */
  const batchPostponeSelected = useCallback(async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    const today = localDayKey();
    setBusyId('__batch_postpone__');
    let ok = 0;
    for (const jobId of ids) {
      const job = all.find((j) => j.id === jobId);
      if (!job) continue;
      const base = !job.dueDate || job.dueDate < today ? today : job.dueDate;
      try {
        await callOp('review.reschedule', { jobId, dueDate: addDaysKey(base, 1) ?? base });
        ok += 1;
      } catch {
        /* 单项失败继续其余，最终统一提示 */
      }
    }
    pushToast(ok === ids.length ? `已顺延 ${ok} 项复习` : `已顺延 ${ok}/${ids.length} 项（部分失败）`, ok > 0 ? 'success' : 'error');
    setSelectedIds(new Set());
    await load();
    setBusyId(null);
  }, [selectedIds, all, load]);
  const presentTypes = useMemo(() => {
    const counts = new Map<FavoriteType, number>();
    for (const job of all) {
      const type = job.favorite?.type;
      if (type) counts.set(type, (counts.get(type) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([type]) => type);
  }, [all]);
  const presentTemplates = useMemo(() => {
    const set = new Set<ReviewTemplate>();
    for (const job of all) {
      if (job.template) set.add(job.template);
    }
    return [...set];
  }, [all]);
  // 待完成集合链路 memo 化（第 245 轮巡检，性能域）：此前 pendingJobs / pendingItems /
  // urgencyFilteredItems 与六张 jobId 映射表每次渲染重建——搜索关键词每敲一个字全表
  // 重算重渲。这里把整条派生链 memo 化（dep 为上游筛选输入），键入搜索词时命中
  // displayPending 一个 memo 重算，映射表与周历/预测/月历全部复用。
  const pendingJobs = useMemo(
    () =>
      all.filter(
        (job) =>
          job.status === 'pending' &&
          (typeFilter === 'all' || job.favorite?.type === typeFilter) &&
          (templateFilter === 'all' || job.template === templateFilter),
      ),
    [all, typeFilter, templateFilter],
  );
  const pendingItems: HubTodayReviewItem[] = useMemo(() => buildHubTodayItems(pendingJobs, localDayKey()), [pendingJobs]);
  // 紧急度过滤（第 103 轮巡检）：基于 dueLabel 的快捷筛选
  const urgencyFilteredItems = useMemo(
    () =>
      pendingItems.filter((item) => {
        if (urgencyFilter === 'all') return true;
        if (urgencyFilter === 'today') return item.dueLabel.includes('今日到期');
        if (urgencyFilter === 'overdue') return item.dueLabel.includes('已到期');
        return !item.dueLabel.includes('今日到期') && !item.dueLabel.includes('已到期');
      }),
    [pendingItems, urgencyFilter],
  );
  // 周视图条（第 105 轮巡检）：逾期 + 今日起 7 天分栏聚合；点选按日筛选待完成作业
  // （日筛选为会话内临时态，不随 settings 持久化——日历日随打开日期漂移，持久化无意义）
  const weekColumns = useMemo(() => buildReviewWeekColumns(pendingJobs, localDayKey(), viewRange), [pendingJobs, viewRange]);
  // 7 日到期预测（第 241 轮巡检）：逾期 + 今日起 7 天 + 以后的到期量小柱图；
  // 逾期口径与周历条同源（reviewWeek dueTs < todayTs），脏 dueDate 跳过
  const forecastBars = useMemo(() => buildReviewForecast(pendingJobs, localDayKey(), 7), [pendingJobs]);
  // 复习统计摘要（第 247 轮巡检，复习域收官 / 信息视角）：四 mini 指标
  // （累计完成 / 本周完成 / 连续天数 / 跳过率）同源纯函数 buildReviewStats；
  // dep 只取 all（jobs 重拉即刷新），now 取渲染时刻即可
  const reviewStats = useMemo(() => buildReviewStats(all, Date.now()), [all]);
  // 月视图栅格（第 111 轮巡检）：按当前渲染月份聚合（格内仅标题，操作在列表/周视图）
  const monthGrid = useMemo(() => buildReviewMonthGrid(pendingJobs, monthKey, localDayKey()), [pendingJobs, monthKey]);
  // 按日筛选（第 240 轮巡检改口径）：日键解析不再查周历列（窗口只有逾期+7/14/30 天），
  // 改用 jobIdsForDayFilter 对全量 pending 按到期日解析——月历格可指向窗口外日期
  // （前后月导航），与周历条共用同一 dayFilter state，两端解析结果一致
  const dayFilteredItems = useMemo(() => {
    if (!dayFilter) return urgencyFilteredItems;
    const ids = jobIdsForDayFilter(pendingJobs, dayFilter, localDayKey());
    return urgencyFilteredItems.filter((item) => ids.has(item.jobId));
  }, [urgencyFilteredItems, dayFilter, pendingJobs]);
  // 清除日期过滤 chip（第 240 轮巡检）：label 逾期 / M月D日 + 当前命中项数
  const dayFilterLabel = useMemo(() => {
    if (!dayFilter) return null;
    if (dayFilter === 'overdue') return '逾期到期';
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayFilter);
    return m ? `${Number(m[2])}月${Number(m[3])}日` : dayFilter;
  }, [dayFilter]);
  /** 月历格点击（第 240 轮巡检）：有到期作业的格 → 切列表视图并按该日过滤（与周历条
   *  共用同一 dayFilter state）；重复点击已选格 = 清除返回全量。 */
  const jumpToDay = (key: string) => {
    if (dayFilter === key) {
      setDayFilter(null);
      return;
    }
    setDayFilter(key);
    setReviewFilters({ viewMode: 'list' });
  };
  const doneJobs = all.filter((job) => job.status === 'done').sort((a, b) => b.updatedAt - a.updatedAt);
  const doneShown = doneJobs.slice(0, doneLimit);
  const skippedJobs = all.filter((job) => job.status === 'skipped');
  const todayDueItems = pendingItems.filter((item) => item.dueLabel.includes('今日到期'));
  // 逾期存量（第 108 轮巡检）：复习统计条用
  const overdueCount = pendingItems.filter((item) => item.dueLabel.includes('已到期')).length;
  // 来源标注（第 91 轮巡检）：站内收藏（courId）vs B 站收藏
  const sourceByJobId = useMemo(
    () => new Map<string, string>(pendingJobs.map((job) => [job.id, job.favorite?.courId != null ? '站内' : 'B 站'])),
    [pendingJobs],
  );
  // 到期日反查（第 107 轮巡检）：顺延按钮按 job.dueDate 推算新到期日
  const dueDateByJobId = useMemo(() => new Map(pendingJobs.map((job) => [job.id, job.dueDate])), [pendingJobs]);
  // 模板标注（第 98 轮巡检）：常规 / 考试 / 自定义
  const templateByJobId = useMemo(
    () =>
      new Map<string, string>(
        pendingJobs.map((job) => [
          job.id,
          job.template === 'regular' ? '常规' : job.template === 'exam' ? '考试' : '自定义',
        ]),
      ),
    [pendingJobs],
  );
  // 轮次标注（第 102 轮巡检）：第 X/Y 轮（Y = 该模板的间隔数；配置缺失回退当前轮次）
  const roundByJobId = useMemo(
    () =>
      new Map<string, string>(
        pendingJobs.map((job) => [
          job.id,
          `第 ${job.round}/${DEFAULT_SETTINGS.review.intervals[job.template]?.length ?? job.round} 轮`,
        ]),
      ),
    [pendingJobs],
  );
  // 倍增间隔刻度条（第 246 轮巡检，复习策略域 / 可视化延续视角）：pending 行内 4 格
  // 迷你档位条（3/7/14/30 天），位置 = intervalScalePosition(round, 模板间隔)——与
  // 第 245 轮完成 toast 的「下次复习日期建议」同一倍增序列（同源口径，title 提及）。
  // 模板间隔异常（脏数据 / 非递增）→ 不入 map，该行不渲染刻度条、退回既有文本徽标；
  // 仅列表行挂载（周/月视图格内空间紧凑，保持既有轮次文本，避免挤压）
  const intervalScaleByJobId = useMemo(() => {
    const intervals = uiStore.getState().settings.review?.intervals ?? DEFAULT_SETTINGS.review.intervals;
    const map = new Map<string, { round: number; scale: IntervalScalePosition }>();
    for (const job of pendingJobs) {
      const scale = intervalScalePosition(job.round, intervals[job.template]);
      if (scale) map.set(job.id, { round: job.round, scale });
    }
    return map;
  }, [pendingJobs]);
  // 行详情展开（第 94 轮巡检）：收藏内容摘要 + 标签
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // 月视图格内折叠（第 123 轮巡检）：格内作业 >3 时默认只显前 3 行，其余折叠为「还有 N 项」可展开
  const [expandedCells, setExpandedCells] = useState<Set<string>>(new Set());
  const toggleCell = useCallback((cellKey: string) => {
    setExpandedCells((prev) => {
      const next = new Set(prev);
      if (next.has(cellKey)) next.delete(cellKey);
      else next.add(cellKey);
      return next;
    });
  }, []);
  const favoriteByJobId = useMemo(() => new Map(pendingJobs.map((job) => [job.id, job.favorite])), [pendingJobs]);
  // 周视图（第 106 轮巡检）：jobId → 条目视图模型（标题/到期标签/类型标签）
  const itemByJobId = useMemo(() => new Map(pendingItems.map((item) => [item.jobId, item])), [pendingItems]);
  // 待完成排序（第 88 轮巡检）：到期日（默认升序）/ 类型（中文标签字典序）；源 = 紧急度 + 周视图日筛选后（第 103/105 轮巡检）
  const sortedPendingItems = useMemo(() => {
    if (pendingSort === 'due') return dayFilteredItems;
    return [...dayFilteredItems].sort((a, b) => (a.typeLabel ?? '').localeCompare(b.typeLabel ?? '', 'zh-Hans-CN'));
  }, [dayFilteredItems, pendingSort]);
  const pendingFavorites = pendingJobs
    .map((job) => job.favorite)
    .filter((fav): fav is FavoriteEntity => Boolean(fav));

  // 关键词搜索（第 115 轮巡检）：按标题过滤待完成/已完成/已跳过三个分区（大小写不敏感；作用于展示行）
  const [keyword, setKeyword] = useState('');
  // 来源筛选（第 118 轮巡检）：all=全部 / internal=站内 / bili=B站
  const [sourceFilter, setSourceFilter] = useState<'all' | 'internal' | 'bili'>('all');
  const reviewKw = keyword.trim().toLowerCase();
  const titleMatch = useCallback(
    (title: string | undefined) => reviewKw.length === 0 || (title ?? '').toLowerCase().includes(reviewKw),
    [reviewKw],
  );
  const sourceMatch = useCallback(
    (fav: FavoriteEntity | null | undefined) =>
      sourceFilter === 'all' || (sourceFilter === 'internal' ? fav?.courId != null : fav?.courId == null),
    [sourceFilter],
  );
  // 课程筛选（第 317 轮巡检，复习域）：按收藏所属课程（courId）过滤；all=全部课程。
  // 与关键词/来源筛选叠加；随 reviewFilters 持久化（courseCourId）——派生自 reviewFilters
  //（与 typeFilter 同款：单一来源，setReviewFilters 落盘）
  const courseFilter = reviewFilters.courseCourId ?? 'all';
  const courseMatch = useCallback(
    (fav: FavoriteEntity | null | undefined) =>
      courseFilter === 'all' || (fav?.courId != null && fav.courId === courseFilter),
    [courseFilter],
  );
  // 课程清单随当前复习作业聚合（有作业的课程才出现，按名称升序）；角标 = 该课程待完成数
  const courseOptions = useMemo(() => {
    const ids = new Set<number>();
    for (const job of all) {
      const courId = job.favorite?.courId;
      if (courId != null && courseNames[courId]) ids.add(courId);
    }
    return Array.from(ids).sort((a, b) => (courseNames[a] ?? '').localeCompare(courseNames[b] ?? '', 'zh-Hans-CN'));
  }, [all, courseNames]);
  const coursePendingCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const job of pendingJobs) {
      const courId = job.favorite?.courId;
      if (courId != null) counts.set(courId, (counts.get(courId) ?? 0) + 1);
    }
    return counts;
  }, [pendingJobs]);
  const displayPending = useMemo(
    () => sortedPendingItems.filter((item) => titleMatch(item.title) && sourceMatch(favoriteByJobId.get(item.jobId)) && courseMatch(favoriteByJobId.get(item.jobId))),
    [sortedPendingItems, titleMatch, sourceMatch, courseMatch, favoriteByJobId],
  );
  // 渐进显示重置（第 245 轮巡检）：筛选/排序/搜索/来源/视图形态变化回首批 60 条；
  // dep 只取筛选输入（jobs 重拉不重置，完成动作不打断当前位置）
  useEffect(() => {
    setPendingLimit(60);
  }, [reviewFilters, dayFilter, sourceFilter, keyword]);
  // 待完成区实际渲染行（visibleRowsOf 共享切分，见 ./progressive）
  const pendingShown = useMemo(() => visibleRowsOf(displayPending, pendingLimit), [displayPending, pendingLimit]);
  const displayDone = useMemo(
    () => doneShown.filter((job) => titleMatch(job.favorite?.snapshot?.title) && sourceMatch(job.favorite) && courseMatch(job.favorite)),
    [doneShown, titleMatch, sourceMatch, courseMatch],
  );
  const displaySkipped = useMemo(
    () => skippedJobs.filter((job) => titleMatch(job.favorite?.snapshot?.title) && sourceMatch(job.favorite) && courseMatch(job.favorite)),
    [skippedJobs, titleMatch, sourceMatch, courseMatch],
  );
  const allSelected = displayPending.length > 0 && displayPending.every((item) => selectedIds.has(item.jobId));
  const toggleAllSelected = useCallback(() => {
    setSelectedIds((prev) => (prev.size > 0 ? new Set() : new Set(displayPending.map((item) => item.jobId))));
  }, [displayPending]);

  /** 导出复习卡（第 85 轮巡检）：按当前类型筛选后的待完成收藏生成复习卡片 md */
  const exportPendingCards = useCallback(() => {
    exportReviewCards(pendingFavorites);
  }, [pendingFavorites]);

  /** 导出完成记录（第 110 轮巡检）：已完成分区 → Markdown（按完成时间降序） */
  const exportDoneRecords = useCallback(() => {
    downloadTextFile(
      `智慧课堂-复习完成记录-${localDayKey()}.md`,
      buildReviewDoneMarkdown(
        doneJobs.map((job) => ({
          title: job.favorite?.snapshot?.title ?? '（收藏已删除）',
          round: job.round,
          dueDate: job.dueDate,
          updatedAt: job.updatedAt,
        })),
        '复习计划',
      ),
    );
  }, [doneJobs]);

  /** 整页清单序列化（第 129 轮巡检）：导出与复制共用同一份 Markdown 构建 */
  const buildPlanMarkdown = useCallback(() => {
    const jobById = new Map(all.map((job) => [job.id, job]));
    const pendingRows = displayPending.map((item) => {
      const job = jobById.get(item.jobId);
      return {
        title: job?.favorite?.snapshot?.title,
        round: job?.round,
        dueDate: job?.dueDate,
        template: job?.template,
        updatedAt: job?.updatedAt,
        tags: job?.favorite?.tags,
        course: job?.favorite?.courId != null ? courseNames[job.favorite.courId] : undefined,
      };
    });
    const toRow = (job: ReviewJobEntity & { favorite: FavoriteEntity | null }) => ({
      title: job.favorite?.snapshot?.title,
      round: job.round,
      dueDate: job.dueDate,
      template: job.template,
      updatedAt: job.updatedAt,
      tags: job.favorite?.tags,
      course: job.favorite?.courId != null ? courseNames[job.favorite.courId] : undefined,
    });
    const filtersNote = [
      `类型=${typeFilter === 'all' ? '全部' : typeFilter}`,
      `模板=${templateFilter === 'all' ? '全部' : templateFilter === 'regular' ? '常规' : templateFilter === 'exam' ? '考试' : '自定义'}`,
      `紧急度=${urgencyFilter === 'all' ? '全部' : urgencyFilter === 'today' ? '今日到期' : urgencyFilter === 'overdue' ? '已逾期' : '后续'}`,
      `来源=${sourceFilter === 'all' ? '全部' : sourceFilter === 'internal' ? '站内' : 'B站'}`,
      `课程=${courseFilter === 'all' ? '全部' : courseNames[courseFilter] ?? courseFilter}`,
      `关键词=${keyword.trim() || '无'}`,
    ].join(' · ');
    return buildReviewPlanMarkdown({
      pending: pendingRows,
      done: displayDone.map(toRow),
      skipped: displaySkipped.map(toRow),
      title: '复习计划',
      filtersNote,
    });
  }, [all, displayPending, displayDone, displaySkipped, typeFilter, templateFilter, urgencyFilter, sourceFilter, courseFilter, keyword, courseNames]);

  /** 导出整页（第 124 轮巡检）：三分区（按当前筛选） → Markdown 一键带走 */
  const exportWholePage = useCallback(() => {
    downloadTextFile(`智慧课堂-复习计划-${localDayKey()}.md`, buildPlanMarkdown());
    pushToast('已导出复习计划整页（当前筛选）', 'success');
  }, [buildPlanMarkdown]);

  /** 复制为纯文本（第 129 轮巡检）：同一份清单进剪贴板，便于贴到笔记 / 群聊 */
  const copyPlanText = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(buildPlanMarkdown());
      pushToast('已复制复习清单（纯文本）', 'success');
    } catch {
      pushToast('复制失败：剪贴板未授权，可改用「导出整页」', 'error');
    }
  }, [buildPlanMarkdown]);

  /** 撤销完成（第 116 轮巡检）：done 作业回到 pending（review.reopen，到期日拉回今天起算）后重拉 */
  const reopenDone = useCallback(async (jobId: string) => {
    setBusyId(jobId);
    try {
      await callOp('review.reopen', { jobId });
      pushToast('已撤销完成，作业回到待完成', 'success');
      await load();
    } catch (err) {
      pushToast(errorTextOf(err, '撤销失败，请重试'), 'error');
    } finally {
      setBusyId(null);
    }
  }, [load]);

  /** 已跳过作业重新加入计划（第 85 轮巡检）：复用 review.plan（同收藏重新排期） */
  const replan = useCallback(
    async (favoriteId: string) => {
      setBusyId(`replan-${favoriteId}`);
      try {
        await callOp('review.plan', { favoriteId });
        pushToast('已重新加入复习计划', 'success');
        await load();
      } catch (err) {
        pushToast(errorTextOf(err, '重新加入计划失败'), 'error');
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  /** 顺延（第 107 轮巡检）：pending 作业到期日推一天（已逾期先拉回明天再 +1），
   *  review.reschedule 后重拉。 */
  const postpone = useCallback(
    async (jobId: string, dueDate: string) => {
      setBusyId(jobId);
      try {
        const today = localDayKey();
        const base = !dueDate || dueDate < today ? today : dueDate;
        const next = addDaysKey(base, 1) ?? base;
        await callOp('review.reschedule', { jobId, dueDate: next });
        pushToast('已顺延一天', 'success');
        await load();
      } catch (err) {
        pushToast(errorTextOf(err, '顺延失败，请重试'), 'error');
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  // 自定义改期（第 109 轮巡检）：日期选择弹层（默认值 = 顺延一天的落点）；确认走同一 review.reschedule
  const [rescheduleTarget, setRescheduleTarget] = useState<{ jobId: string; title: string; dueDate: string } | null>(null);
  const [rescheduleDate, setRescheduleDate] = useState('');
  const [rescheduleBusy, setRescheduleBusy] = useState(false);
  const openReschedule = useCallback((jobId: string, title: string, dueDate: string) => {
    const today = localDayKey();
    const base = !dueDate || dueDate < today ? today : dueDate;
    setRescheduleTarget({ jobId, title, dueDate });
    setRescheduleDate(addDaysKey(base, 1) ?? base);
  }, []);
  const confirmReschedule = useCallback(async () => {
    const target = rescheduleTarget;
    if (!target) return;
    // 钳制（第 244 轮巡检）：目标日期不得早于今日（早于今日钳回今日）；
    // 选今天 = 保持不变（提示「已是今日到期」），不发起 reschedule
    const clamped = clampRescheduleDate(rescheduleDate, localDayKey());
    if (!clamped) {
      pushToast('日期格式无效，请重新选择', 'error');
      return;
    }
    if (clamped.sameDay) {
      setRescheduleDate(clamped.dateKey);
      pushToast('已是今日到期，到期日保持不变', 'info');
      return;
    }
    // 所选日 = 当前到期日（第 244 轮）：不动、不产 from=to 留痕
    if (clamped.dateKey === target.dueDate) {
      pushToast('已是指定到期日，到期日保持不变', 'info');
      setRescheduleTarget(null);
      return;
    }
    setRescheduleBusy(true);
    try {
      await callOp('review.reschedule', { jobId: target.jobId, dueDate: clamped.dateKey });
      pushToast(`已改期到 ${clamped.dateKey}`, 'success');
      setRescheduleTarget(null);
      await load();
    } catch (err) {
      pushToast(errorTextOf(err, '改期失败，请重试'), 'error');
    } finally {
      setRescheduleBusy(false);
    }
  }, [rescheduleTarget, rescheduleDate, load]);

  /** 多选批量改期（第 123 轮巡检）：复用自定义改期日期弹层，所选 pending 作业统一改到
   * 该日期（逐条 review.reschedule，单项失败不中断）；完成后清空勾选并重拉。 */
  const [batchRescheduleOpen, setBatchRescheduleOpen] = useState(false);
  const openBatchReschedule = useCallback(() => {
    if (selectedIds.size === 0) return;
    setRescheduleDate(addDaysKey(localDayKey(), 1) ?? localDayKey());
    setBatchRescheduleOpen(true);
  }, [selectedIds]);
  const confirmBatchReschedule = useCallback(async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    // 钳制（第 244 轮巡检，与单行改期同口径）：不早于今日；选今天 = 全部保持不变仅提示
    const clamped = clampRescheduleDate(rescheduleDate, localDayKey());
    if (!clamped) {
      pushToast('日期格式无效，请重新选择', 'error');
      return;
    }
    if (clamped.sameDay) {
      setRescheduleDate(clamped.dateKey);
      pushToast('所选日期为今天，作业到期日保持不变', 'info');
      return;
    }
    setRescheduleBusy(true);
    let ok = 0;
    for (const jobId of ids) {
      try {
        await callOp('review.reschedule', { jobId, dueDate: clamped.dateKey });
        ok += 1;
      } catch {
        /* 单项失败继续其余，最终统一提示 */
      }
    }
    pushToast(ok === ids.length ? `已改期 ${ok} 项复习到 ${clamped.dateKey}` : `已改期 ${ok}/${ids.length} 项（部分失败）`, ok > 0 ? 'success' : 'error');
    setBatchRescheduleOpen(false);
    setSelectedIds(new Set());
    await load();
    setRescheduleBusy(false);
  }, [selectedIds, rescheduleDate, load]);

  // ── 顺延到指定日（第 244 轮巡检，复习域 / 灵活性视角） ─────────────────────────
  // 快捷日期选项（buildRescheduleOptions 共享纯函数）：明天/后天/周X…/下周同一日/
  // 下月同一日 8 档，改期弹层、行内顺延浮层、批量改期弹层三处共用同一份。
  const rescheduleOptions = useMemo(() => buildRescheduleOptions(localDayKey()), []);
  // 行内轻量顺延浮层（列表行「改期」先展开快捷 chips，点选即顺延——比 Modal 少一步
  // 确认；「其他日期…」再进完整改期弹层选任意日期）。周视图 / 月视图行仍直达弹层。
  const [reschedQuickJobId, setReschedQuickJobId] = useState<string | null>(null);
  /** 单个作业顺延到所选日：钳制同改期弹层（不早于今日；今日 = 保持不变仅提示）；
   *  所选日 = 当前到期日时同样不动（避免 from=to 留痕噪声，第 244 轮） */
  const rescheduleTo = useCallback(
    async (jobId: string, dateKey: string, label?: string, currentDue?: string) => {
      const clamped = clampRescheduleDate(dateKey, localDayKey());
      if (!clamped) {
        pushToast('日期格式无效，请重新选择', 'error');
        return;
      }
      if (clamped.sameDay) {
        pushToast('已是今日到期，到期日保持不变', 'info');
        return;
      }
      if (currentDue && clamped.dateKey === currentDue) {
        pushToast('已是指定到期日，无需顺延', 'info');
        setReschedQuickJobId(null);
        return;
      }
      setBusyId(jobId);
      try {
        await callOp('review.reschedule', { jobId, dueDate: clamped.dateKey });
        pushToast(label ? `已顺延到 ${label}（${clamped.dateKey}）` : `已顺延到 ${clamped.dateKey}`, 'success');
        setReschedQuickJobId(null);
        await load();
      } catch (err) {
        pushToast(errorTextOf(err, '顺延失败，请重试'), 'error');
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  /** 一键完成今日到期（第 84 轮巡检）：顺序提交 review.complete(done) 后重拉；单项失败不中断其余 */
  const completeAllToday = useCallback(async () => {    const items = todayDueItems;
    if (items.length === 0) return;
    let ok = 0;
    for (const item of items) {
      try {
        await callOp('review.complete', { jobId: item.jobId, status: 'done' });
        ok += 1;
      } catch {
        /* 单项失败继续其余，最终统一提示 */
      }
    }
    pushToast(ok === items.length ? `已完成今日到期的 ${ok} 项复习` : `已完成 ${ok}/${items.length} 项（部分失败）`, ok > 0 ? 'success' : 'error');
    await load();
  }, [todayDueItems, load]);

  /** 逾期全部顺延（第 113 轮巡检）：全部已逾期 pending 作业推到明天（逐条 review.reschedule）；单项失败不中断 */
  const postponeAllOverdue = useCallback(async () => {
    const today = localDayKey();
    const targets = pendingJobs.filter((job) => job.dueDate < today);
    if (targets.length === 0) return;
    const tomorrow = addDaysKey(today, 1) ?? today;
    setBusyId('postpone-all-overdue');
    let ok = 0;
    for (const job of targets) {
      try {
        await callOp('review.reschedule', { jobId: job.id, dueDate: tomorrow });
        ok += 1;
      } catch {
        /* 单项失败继续其余，最终统一提示 */
      }
    }
    pushToast(ok === targets.length ? `已顺延 ${ok} 条逾期作业` : `已顺延 ${ok}/${targets.length} 条（部分失败）`, ok > 0 ? 'success' : 'error');
    await load();
    setBusyId(null);
  }, [pendingJobs, load]);

  /** 今日到期全部顺延（第 119 轮巡检）：全部今日到期 pending 作业推到明天（与逾期全部顺延对齐） */
  const postponeAllToday = useCallback(async () => {
    const today = localDayKey();
    const targets = pendingJobs.filter((job) => job.dueDate === today);
    if (targets.length === 0) return;
    const tomorrow = addDaysKey(today, 1) ?? today;
    setBusyId('postpone-all-today');
    let ok = 0;
    for (const job of targets) {
      try {
        await callOp('review.reschedule', { jobId: job.id, dueDate: tomorrow });
        ok += 1;
      } catch {
        /* 单项失败继续其余，最终统一提示 */
      }
    }
    pushToast(ok === targets.length ? `已顺延 ${ok} 条今日到期作业` : `已顺延 ${ok}/${targets.length} 条（部分失败）`, ok > 0 ? 'success' : 'error');
    await load();
    setBusyId(null);
  }, [pendingJobs, load]);

  /** 已跳过批量重新入计划（第 86 轮巡检）：≥2 项时一键全部重新排期 */
  const replanAllSkipped = useCallback(async () => {
    const targets = skippedJobs.filter((job) => job.favorite);
    if (targets.length === 0) return;
    setBusyId('__batch_replan__');
    let ok = 0;
    for (const job of targets) {
      try {
        await callOp('review.plan', { favoriteId: job.favoriteId });
        ok += 1;
      } catch {
        /* 单项失败继续其余 */
      }
    }
    pushToast(
      ok === targets.length ? `已重新加入 ${ok} 项复习` : `已重新加入 ${ok}/${targets.length} 项（部分失败）`,
      ok > 0 ? 'success' : 'error',
    );
    await load();
    setBusyId(null);
  }, [skippedJobs, load]);

  return (
    <div className="hdu-section hdu-review-view">
      <SectionHead
        title="复习计划"
        sub="全部复习作业：待完成按到期日排序；完成后进入历史"
        actions={
          !failed && pendingItems.length > 0 ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <Chip tone="info">
                待完成 {pendingItems.length} 项{todayDueItems.length > 0 ? ` · 今日到期 ${todayDueItems.length}` : ''}
              </Chip>
              {/* 学习成就角标（第 132 轮巡检）：已解锁徽章数（>0 出现，与总览/B 站今日卡同口径） */}
              {unlockedBadges > 0 ? (
                <Chip tone="jade" title="学习成就已解锁数">
                  🏅 {unlockedBadges}
                </Chip>
              ) : null}
              {/* 一键完成今日到期（第 84 轮巡检）：≥2 项时出现 */}
              {todayDueItems.length > 1 ? (
                <Button
                  size="small"
                  icon="check"
                  loading={busyId === '__batch__'}
                  onClick={() => void completeAllToday()}
                >
                  今日到期全部完成
                </Button>
              ) : null}
              {/* 逾期全部顺延（第 113 轮巡检）：有逾期作业时出现，全部推到明天 */}
              {overdueCount > 0 ? (
                <Button
                  size="small"
                  variant="ghost"
                  loading={busyId === 'postpone-all-overdue'}
                  onClick={() => void postponeAllOverdue()}
                >
                  逾期全部顺延
                </Button>
              ) : null}
              {/* 导出复习卡（第 85 轮巡检）：按当前类型筛选后的待完成收藏生成 md */}
              <Button
                size="small"
                variant="ghost"
                icon="download"
                disabled={pendingFavorites.length === 0}
                onClick={exportPendingCards}
              >
                导出复习卡
              </Button>
              {/* 导出整页（第 124 轮巡检）：三分区按当前筛选一键导出 Markdown */}
              <Button size="small" variant="ghost" icon="download" onClick={exportWholePage}>
                导出整页
              </Button>
              {/* 复制清单（第 129 轮巡检）：同一份清单进剪贴板 */}
              <Button size="small" variant="ghost" icon="note" onClick={() => void copyPlanText()}>
                复制清单
              </Button>
            </span>
          ) : undefined
        }
      />
      <div className="hdu-card pad">
        {/* 关键词搜索（第 115 轮巡检）：按标题过滤待完成/已完成/已跳过三个分区 */}
        {all.length > 0 ? (
          <input
            type="text"
            className="hdu-input"
            style={{ marginBottom: 10 }}
            placeholder="搜索作业标题…"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            aria-label="搜索复习作业"
          />
        ) : null}
        {/* 复习统计条（第 108 轮巡检）：待完成/今日到期/已逾期/已完成/已跳过 计数一览；
            第 120 轮起今日到期/已逾期 chips 可点击 → 切换对应紧急度筛选 */}
        {all.length > 0 ? (
          <div className="hdu-review-stats" role="group" aria-label="复习计划统计">
            <span className="hdu-review-stat"><b>{pendingItems.length}</b> 待完成</span>
            <button
              type="button"
              className={cx('hdu-review-stat', 'is-today', urgencyFilter === 'today' ? 'is-active' : '')}
              onClick={() => setReviewFilters({ urgency: urgencyFilter === 'today' ? 'all' : 'today' })}
            >
              <b>{todayDueItems.length}</b> 今日到期
            </button>
            <button
              type="button"
              className={cx('hdu-review-stat', 'is-overdue', urgencyFilter === 'overdue' ? 'is-active' : '')}
              onClick={() => setReviewFilters({ urgency: urgencyFilter === 'overdue' ? 'all' : 'overdue' })}
            >
              <b>{overdueCount}</b> 已逾期
            </button>
            <span className="hdu-review-stat is-done"><b>{doneJobs.length}</b> 已完成</span>
            <span className="hdu-review-stat"><b>{skippedJobs.length}</b> 已跳过</span>
          </div>
        ) : null}
        {/* 完成率进度条（第 118 轮巡检）：已完成 / 全部作业（含历史） */}
        {all.length > 0 ? (
          <div style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="hdu-hint" style={{ flex: 'none' }}>完成率</span>
            <Progress value={doneJobs.length / Math.max(1, all.length)} jade />
            <span className="hdu-hint" style={{ flex: 'none' }}>
              {doneJobs.length}/{all.length} · {Math.round((doneJobs.length / Math.max(1, all.length)) * 100)}%
            </span>
          </div>
        ) : null}
        {/* 待完成区形态切换（第 106 轮巡检）：列表 / 周视图；周视图下可选 7/14 天窗口（第 108 轮巡检）。
            两类选择均随 settings 持久化 */}
        {pendingItems.length > 0 ? (
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginBottom: 8 }}>
            <button
              type="button"
              className={cx('hdu-folder', viewMode === 'list' ? 'is-active' : '')}
              onClick={() => setReviewFilters({ viewMode: 'list' })}
            >
              列表
            </button>
            <button
              type="button"
              className={cx('hdu-folder', viewMode === 'week' ? 'is-active' : '')}
              onClick={() => setReviewFilters({ viewMode: 'week' })}
            >
              周视图
            </button>
            <button
              type="button"
              className={cx('hdu-folder', viewMode === 'month' ? 'is-active' : '')}
              onClick={() => setReviewFilters({ viewMode: 'month' })}
            >
              月视图
            </button>
            {viewMode === 'week' ? (
              <>
                <button
                  type="button"
                  className={cx('hdu-folder', viewRange === 7 ? 'is-active' : '')}
                  onClick={() => setReviewFilters({ viewRange: 7 })}
                >
                  7 天
                </button>
                <button
                  type="button"
                  className={cx('hdu-folder', viewRange === 14 ? 'is-active' : '')}
                  onClick={() => setReviewFilters({ viewRange: 14 })}
                >
                  14 天
                </button>
                <button
                  type="button"
                  className={cx('hdu-folder', viewRange === 30 ? 'is-active' : '')}
                  onClick={() => setReviewFilters({ viewRange: 30 })}
                >
                  30 天
                </button>
              </>
            ) : null}
          </div>
        ) : null}
        {/* 周视图条（第 105 轮巡检）：逾期 + 今日起 7 天分栏聚合，点选按日筛选待完成作业（月视图下不展示） */}
        {pendingItems.length > 0 && weekColumns.length > 0 && viewMode !== 'month' ? (
          <div className="hdu-week-strip" role="group" aria-label="按到期日筛选待完成作业">
            {weekColumns.map((col) => (
              <button
                type="button"
                key={col.key}
                className={cx('hdu-week-col', col.kind, dayFilter === col.key ? 'is-active' : '')}
                onClick={() => setDayFilter((prev) => (prev === col.key ? null : col.key))}
                disabled={col.jobIds.length === 0}
                title={col.kind === 'overdue' ? '筛选已逾期作业' : `筛选 ${col.label} 到期的作业`}
              >
                <span className="hdu-week-col-label">{col.label}</span>
                <span className="hdu-week-col-count">{col.jobIds.length}</span>
              </button>
            ))}
          </div>
        ) : null}
        {/* 7 日到期预测（第 241 轮巡检）：逾期 + 今日起 7 天 + 以后的到期量小柱图，
            点日柱/逾期柱复用按日过滤（与周历条/月历格同一 dayFilter），「以后」柱跨
            多日无单一筛选键仅展示；数字全 0 时给轻量空态而非空图（月视图下不展示） */}
        {pendingJobs.length > 0 && viewMode !== 'month' ? (
          forecastBars.every((bar) => bar.count === 0) ? (
            <div className="hdu-forecast-empty" role="status">
              未来 7 天暂无到期作业
            </div>
          ) : (
            <>
              <ReviewForecastChart bars={forecastBars} onPick={jumpToDay} />
              {/* 口径互认标注（第 242 轮巡检）：预测「明」柱与今日待办/B 站今日卡「明日到期」
                  Chip 同源同口径（reviewJobs pending × dueDate 精确匹配，收藏删除时作业级联
                  取消无孤儿入账）；复用第 239 轮 .hdu-caliber-hint 句式，hint 基座与分布卡一致 */}
              <div className="hdu-caliber-hint hdu-forecast-caliber">
                <span className="hdu-caliber-tag">同口径</span>
                <span className="hdu-hint">「明」柱与今日待办「明日到期」预告同口径（待完成复习作业按到期日计数）</span>
              </div>
            </>
          )
        ) : null}
        {/* 复习统计摘要行（第 247 轮巡检，复习域收官 / 信息视角）：预测柱图下方的
            四 mini 指标横排——累计完成 / 本周完成 / 连续天数 / 跳过率（buildReviewStats
            同源纯函数，跳过率无记录时不显示）。与上方「复习统计条」（pending 视角的
            待完成/今日到期/已逾期计数）互补：本行只看历史完成侧。全空给轻量空态 */}
        {all.length > 0 ? <ReviewStatsSummary stats={reviewStats} /> : null}
        {/* 类型筛选（第 84 轮巡检）：当前作业的收藏类型自动聚合，≥2 类才显示 */}
        {presentTypes.length > 1 ? (
          <div className="hdu-folder-row hdu-scroll-x" style={{ marginBottom: 10 }}>
            <button
              type="button"
              className={cx('hdu-folder', typeFilter === 'all' ? 'is-active' : '')}
              onClick={() => setReviewFilters({ type: 'all' })}
            >
              全部类型
            </button>
            {presentTypes.map((type) => (
              <button
                type="button"
                key={type}
                className={cx('hdu-folder', typeFilter === type ? 'is-active' : '')}
                onClick={() => setReviewFilters({ type })}
              >
                {FAVORITE_META[type].label}
              </button>
            ))}
          </div>
        ) : null}
        {/* 模板筛选（第 97 轮巡检）：按复习模板过滤待完成作业，≥2 种模板才显示 */}
        {presentTemplates.length > 1 ? (
          <div className="hdu-folder-row hdu-scroll-x" style={{ marginBottom: 10 }}>
            <button
              type="button"
              className={cx('hdu-folder', templateFilter === 'all' ? 'is-active' : '')}
              onClick={() => setReviewFilters({ template: 'all' })}
            >
              全部模板
            </button>
            {presentTemplates.map((template) => (
              <button
                type="button"
                key={template}
                className={cx('hdu-folder', templateFilter === template ? 'is-active' : '')}
                onClick={() => setReviewFilters({ template })}
              >
                {template === 'regular' ? '常规' : template === 'exam' ? '考试' : '自定义'}
              </button>
            ))}
          </div>
        ) : null}
        {/* 紧急度筛选（第 103 轮巡检）：今日到期 / 已逾期 / 未来，基于 dueLabel 的快捷筛选 */}
        {pendingItems.length > 1 ? (
          <div className="hdu-folder-row hdu-scroll-x" style={{ marginBottom: 10 }}>
            {(
              [
                { value: 'all', label: '全部' },
                { value: 'today', label: '今日到期' },
                { value: 'overdue', label: '已逾期' },
                { value: 'future', label: '未来' },
              ] as const
            ).map((option) => (
              <button
                type="button"
                key={option.value}
                className={cx('hdu-folder', urgencyFilter === option.value ? 'is-active' : '')}
                onClick={() => setReviewFilters({ urgency: option.value })}
              >
                {option.label}
              </button>
            ))}
          </div>
        ) : null}
        {/* 来源筛选（第 118 轮巡检）：站内 / B站，与类型/模板/紧急度筛选叠加 */}
        {pendingItems.length > 0 ? (
          <div className="hdu-folder-row hdu-scroll-x" style={{ marginBottom: 10 }}>
            {(
              [
                { value: 'all', label: '全部来源' },
                { value: 'internal', label: '站内' },
                { value: 'bili', label: 'B站' },
              ] as const
            ).map((option) => (
              <button
                type="button"
                key={option.value}
                className={cx('hdu-folder', sourceFilter === option.value ? 'is-active' : '')}
                onClick={() => setSourceFilter(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        ) : null}
        {/* 课程筛选（第 317 轮巡检，复习域）：按收藏所属课程，与来源/关键词筛选叠加；
            点击已选课程 = 取消（回到全部课程） */}
        {pendingItems.length > 0 && courseOptions.length > 0 ? (
          <div className="hdu-folder-row hdu-scroll-x" style={{ marginBottom: 10 }}>
            <button
              type="button"
              className={cx('hdu-folder', courseFilter === 'all' ? 'is-active' : '')}
              onClick={() => setReviewFilters({ courseCourId: undefined })}
            >
              全部课程
            </button>
            {courseOptions.map((courId) => (
              <button
                type="button"
                key={courId}
                className={cx('hdu-folder', courseFilter === courId ? 'is-active' : '')}
                onClick={() => setReviewFilters({ courseCourId: courId })}
                title={`课程「${courseNames[courId]}」：待完成 ${coursePendingCounts.get(courId) ?? 0} 项`}
              >
                {courseNames[courId]}（{coursePendingCounts.get(courId) ?? 0}）
              </button>
            ))}
          </div>
        ) : null}
        {/* 重置筛选（第 104 轮巡检）：任一筛选/排序偏离缺省时提供一键还原 */}
        {filtersActive ? (
          <div className="hdu-folder-row hdu-scroll-x" style={{ marginBottom: 10 }}>
            <button type="button" className="hdu-folder" onClick={resetFilters} title="清除全部筛选并恢复默认排序">
              ✕ 重置筛选
            </button>
          </div>
        ) : null}
        {/* 清除日期过滤 chip（第 240 轮巡检）：周历条 / 月历格按日筛选后的定位标——
            显示当前过滤日与命中项数，× 一键清除返回全量（danger 淡色 × 图标） */}
        {dayFilterLabel ? (
          <div className="hdu-folder-row" style={{ marginBottom: 10 }}>
            <span className="hdu-day-filter-chip" role="status" aria-label={`当前按 ${dayFilterLabel} 到期过滤，共 ${dayFilteredItems.length} 项`}>
              查看 {dayFilterLabel} 到期（{dayFilteredItems.length} 项）
              <button
                type="button"
                className="hdu-day-filter-clear"
                aria-label="清除日期过滤"
                title="清除日期过滤"
                onClick={() => setDayFilter(null)}
              >
                ×
              </button>
            </span>
          </div>
        ) : null}
        {/* 筛选快照（第 125 轮巡检）：命名保存当前筛选组合，一键套用；最多 6 个，超出淘汰最旧 */}
        {all.length > 0 ? (
          <div className="hdu-folder-row hdu-scroll-x" style={{ marginBottom: 10 }} role="group" aria-label="筛选快照">
            <span className="hdu-hint" style={{ flex: 'none', alignSelf: 'center' }}>筛选快照</span>
            {snapshotsLast && snapshots.some((snapshot) => snapshot.name === snapshotsLast) ? (
              <span className="hdu-hint" style={{ flex: 'none', alignSelf: 'center' }} title="当前筛选来自该快照">
                当前来自：{snapshotsLast}
              </span>
            ) : null}
            {snapshots.map((snapshot) =>
              renamingSnapshot?.old === snapshot.name ? (
                <span key={snapshot.name} className="hdu-snapshot-chip">
                  <input
                    type="text"
                    className="hdu-input"
                    value={renamingSnapshot.value}
                    autoFocus
                    aria-label={`重命名快照 ${snapshot.name}`}
                    style={{ width: 130, padding: '3px 8px', fontSize: 11 }}
                    onChange={(e) => setRenamingSnapshot({ old: snapshot.name, value: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveSnapshotRename();
                      if (e.key === 'Escape') setRenamingSnapshot(null);
                    }}
                  />
                  <button type="button" className="hdu-folder" onClick={saveSnapshotRename} title="保存新名称">
                    ✓
                  </button>
                  <button type="button" className="hdu-folder" onClick={() => setRenamingSnapshot(null)} title="取消重命名">
                    取消
                  </button>
                </span>
              ) : (
                <span key={snapshot.name} className="hdu-snapshot-chip">
                  <button
                    type="button"
                    className="hdu-folder"
                    onClick={() => applySnapshot(snapshot.name)}
                    title={`套用 ${snapshot.name}`}
                  >
                    {snapshot.name}
                  </button>
                  <button
                    type="button"
                    className="hdu-snapshot-del"
                    aria-label={`重命名快照 ${snapshot.name}`}
                    title="重命名该快照"
                    onClick={() => setRenamingSnapshot({ old: snapshot.name, value: snapshot.name })}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    className="hdu-snapshot-del"
                    aria-label={`删除快照 ${snapshot.name}`}
                    title="删除该快照"
                    onClick={() => removeSnapshot(snapshot.name)}
                  >
                    ×
                  </button>
                </span>
              ),
            )}
            <input
              type="text"
              className="hdu-input"
              value={snapshotName}
              onChange={(e) => setSnapshotName(e.target.value)}
              placeholder="快照名称（留空自动命名）"
              aria-label="快照名称"
              style={{ flex: '0 1 160px', minWidth: 0, alignSelf: 'center' }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveSnapshot();
              }}
            />
            <button type="button" className="hdu-folder" onClick={saveSnapshot} title="把当前筛选组合存为快照">
              ＋ 存当前筛选
            </button>
          </div>
        ) : null}
        {jobs === null && !failed ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Skeleton height={34} />
            <Skeleton height={34} />
            <Skeleton height={34} />
          </div>
        ) : failed ? (
          <EmptyState
            icon="alert"
            title="加载失败"
            text="复习计划暂时读取失败，请稍后重试。"
            action={<Button size="small" variant="ghost" icon="refresh" onClick={() => void load()}>重试</Button>}
          />
        ) : all.length === 0 ? (
          <EmptyState
            icon="check"
            title="暂无复习计划"
            text="在知识库把收藏「加入复习计划」后，复习作业会按遗忘曲线排期出现在这里。"
            action={
              /* 去知识库（第 97 轮巡检）：空态引导；CTA 统一 small ghost（第 249 轮空态模板化） */
              <Button size="small" variant="ghost" icon="library" onClick={() => actions.setCenterView('library')}>
                去知识库
              </Button>
            }
          />
        ) : (
          <>
            {/* ── 待完成 ── */}
            {pendingItems.length > 0 ? (
              <div className="hdu-todo-head">
                待完成
                {/* 排序（第 88 轮巡检）：到期日 / 类型 */}
                <select
                  className="hdu-input"
                  style={{ width: 'auto', height: 26 }}
                  value={pendingSort}
                  onChange={(e) => setReviewFilters({ sort: e.target.value as 'due' | 'type' })}
                  aria-label="待完成排序"
                >
                  <option value="due">按到期日</option>
                  <option value="type">按类型</option>
                </select>
                {/* 今日到期全部顺延（第 119 轮巡检）：与逾期全部顺延对齐 */}
                {todayDueItems.length > 0 ? (
                  <Button
                    size="small"
                    variant="ghost"
                    loading={busyId === 'postpone-all-today'}
                    onClick={() => void postponeAllToday()}
                  >
                    今日到期全部顺延
                  </Button>
                ) : null}
                {/* 多选批量完成 + 批量顺延（第 121/122 轮巡检）：全选 + 批量操作 */}
                {displayPending.length > 0 ? (
                  <>
                    <input
                      type="checkbox"
                      aria-label="全选待完成"
                      checked={allSelected}
                      onChange={toggleAllSelected}
                    />
                    <Button
                      size="small"
                      variant="ghost"
                      disabled={selectedIds.size === 0}
                      loading={busyId === '__batch_complete__'}
                      onClick={() => void batchCompleteSelected()}
                    >
                      批量完成
                    </Button>
                    <Button
                      size="small"
                      variant="ghost"
                      disabled={selectedIds.size === 0}
                      loading={busyId === '__batch_postpone__'}
                      onClick={() => void batchPostponeSelected()}
                    >
                      批量顺延
                    </Button>
                    <Button
                      size="small"
                      variant="ghost"
                      disabled={selectedIds.size === 0}
                      onClick={openBatchReschedule}
                    >
                      批量改期
                    </Button>
                  </>
                ) : null}
              </div>
            ) : (
              <EmptyState icon="check" title="待完成已清空" text="所有排期复习都已完成或跳过。" />
            )}
            {viewMode === 'week' ? (
              /* 周视图（第 106 轮巡检；第 108 轮支持 7/14 天窗口）：逾期 + 今日起分栏，
                 行内完成/跳过/顺延；日筛选（周视图条点选）作用于非选中列降透明度提示 */
              <div className={cx('hdu-week-grid', viewRange >= 14 ? 'is-14' : '')}>
                {weekColumns.map((col) => (
                  <div key={col.key} className={cx('hdu-week-day', col.kind, dayFilter && dayFilter !== col.key ? 'is-dim' : '')}>
                    <div className="hdu-week-day-head">
                      <span>{col.label}</span>
                      <span className="hdu-week-day-count">{col.jobIds.length}</span>
                    </div>
                    {col.jobIds.length === 0 ? (
                      <div className="hdu-week-day-empty">—</div>
                    ) : (
                      col.jobIds.map((jobId) => {
                        const item = itemByJobId.get(jobId);
                        if (!item) return null;
                        return (
                          <div key={jobId} className="hdu-week-job">
                            <div className="hdu-week-job-title" title={item.title}>
                              {item.title}
                            </div>
                            <div className="hdu-week-job-sub">
                              {item.dueLabel}
                              {item.typeLabel ? ` · ${item.typeLabel}` : ''}
                            </div>
                            {/* 去复习（第 109 轮巡检）：周视图行内与列表行同权——站内走 SPA 深链，B 站走外链 */}
                            {(() => {
                              const weekFav = favoriteByJobId.get(jobId);
                              if (item.url) {
                                return (
                                  <a className="hdu-btn ghost small" href={item.url} target="_blank" rel="noopener noreferrer" title={`去复习：${item.title}`}>
                                    去复习
                                  </a>
                                );
                              }
                              if (weekFav?.courId != null) {
                                return (
                                  <Button size="small" variant="ghost" icon="play" onClick={() => actions.openSessionInSite(weekFav.courId!, weekFav.teclId)}>
                                    去复习
                                  </Button>
                                );
                              }
                              // 未关联收藏（第 119 轮巡检）：无链接/无课次的作业给引导文案
                              return <span className="hdu-week-job-sub">（未关联收藏，请在知识库补录）</span>;
                            })()}
                            <div className="hdu-week-job-actions">
                              <Button size="small" icon="check" loading={busyId === jobId} onClick={() => void settle(jobId, 'done')}>
                                完成
                              </Button>
                              {/* 顺延（第 107 轮巡检）：周视图行内同样可推一天（item.subtitle = 到期日） */}
                              <Button
                                size="small"
                                variant="ghost"
                                disabled={busyId === jobId}
                                onClick={() => void postpone(jobId, item.subtitle ?? '')}
                              >
                                顺延
                              </Button>
                              {/* 改期（第 109 轮巡检）：日期选择弹层 */}
                              <Button
                                size="small"
                                variant="ghost"
                                disabled={busyId === jobId}
                                onClick={() => openReschedule(jobId, item.title, item.subtitle ?? '')}
                              >
                                改期
                              </Button>
                              <Button size="small" variant="ghost" disabled={busyId === jobId} onClick={() => void settle(jobId, 'skipped')}>
                                跳过
                              </Button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                ))}
              </div>
            ) : viewMode === 'month' && monthGrid ? (
              /* 月视图（第 111 轮巡检）：自然月周历（周一为起点，前后月补位），
                 月份可前后导航；格内仅列作业标题（紧凑） */
              <div className="hdu-month-view">
                <div className="hdu-month-nav">
                  <button type="button" className="hdu-folder" onClick={() => navMonth(-1)} aria-label="上一月">
                    ‹
                  </button>
                  <span className="hdu-month-label">{monthGrid.label}</span>
                  <button type="button" className="hdu-folder" onClick={() => navMonth(1)} aria-label="下一月">
                    ›
                  </button>
                  {/* 回到今天（第 118 轮巡检）：一键回到当前月 */}
                  <button type="button" className="hdu-folder" onClick={() => jumpToMonth(localDayKey().slice(0, 7))}>
                    今天
                  </button>
                </div>
                <div className="hdu-month-weekdays" aria-hidden="true">
                  {['一', '二', '三', '四', '五', '六', '日'].map((d) => (
                    <span key={d}>{d}</span>
                  ))}
                </div>
                <div className="hdu-week-grid is-14 hdu-month-grid">
                  {monthGrid.weeks.flat().map((cell) => {
                    // 格头可点（第 240 轮巡检）：有到期作业的格 → 列表视图按该日过滤
                    // （与周历条同一 dayFilter state）；空格 / 无作业格不可点
                    const cellSelected = dayFilter === cell.key;
                    const cellClickable = cell.jobIds.length > 0;
                    const cellMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(cell.key);
                    const cellAria =
                      cellClickable && cellMatch
                        ? `${Number(cellMatch[2])}月${Number(cellMatch[3])}日有 ${cell.jobIds.length} 项到期，点击查看`
                        : undefined;
                    return (
                    <div
                      key={cell.key}
                      className={cx('hdu-week-day', cell.isToday ? 'today' : '', cell.inMonth ? '' : 'is-dim', cellSelected ? 'is-selected' : '')}
                    >
                      <div className="hdu-week-day-head">
                        {cellClickable ? (
                          <button
                            type="button"
                            className="hdu-month-cell-btn"
                            onClick={() => jumpToDay(cell.key)}
                            aria-label={cellAria}
                            title={`查看 ${cell.key} 到期的作业`}
                          >
                            <span>{cell.dayLabel}</span>
                            <span className="hdu-week-day-count">{cell.jobIds.length}</span>
                          </button>
                        ) : (
                          <span>{cell.dayLabel}</span>
                        )}
                      </div>
                      {/* 格内折叠（第 123 轮巡检）：作业 >3 时默认只显前 3 行，其余折叠为「还有 N 项」 */}
                      {(() => {
                        const cellExpanded = expandedCells.has(cell.key);
                        const shownJobIds = cellExpanded ? cell.jobIds : cell.jobIds.slice(0, 3);
                        const hiddenCount = cell.jobIds.length - shownJobIds.length;
                        return (
                          <>
                            {shownJobIds.map((jobId) => {
                        const item = itemByJobId.get(jobId);
                        if (!item) return null;
                        const monthOverdue = item.dueLabel.includes('已到期');
                        return (
                          <div key={jobId} className={cx('hdu-week-job', monthOverdue ? 'is-overdue' : '')} title={`${item.title} · ${item.dueLabel}`}>
                            {/* 标题可点（第 114 轮巡检）：月视图格内展开内容摘要 */}
                            <div
                              className="hdu-week-job-title"
                              style={{ cursor: 'pointer' }}
                              onClick={() => setExpandedId((prev) => (prev === jobId ? null : jobId))}
                              title={expandedId === jobId ? '收起详情' : '展开详情'}
                            >
                              {item.title}
                            </div>
                            {/* 轮次徽标（第 120 轮巡检）：格内显示第 X/Y 轮 */}
                            {roundByJobId.get(jobId) ? (
                              <div className="hdu-week-job-sub">{roundByJobId.get(jobId)}</div>
                            ) : null}
                            {expandedId === jobId ? (
                              <div className="hdu-week-job-sub">
                                {(() => {
                                  const monthFavorite = favoriteByJobId.get(jobId);
                                  const content = monthFavorite?.snapshot?.content ?? '';
                                  return content ? content.replace(/\s+/g, ' ').slice(0, 80) : '（无内容摘要）';
                                })()}
                              </div>
                            ) : null}
                            {/* 完成（第 112 轮巡检）：月视图格内可直接完成（复用 settle） */}
                            <Button size="small" variant="ghost" icon="check" loading={busyId === jobId} onClick={() => void settle(jobId, 'done')}>
                              完成
                            </Button>
                            {/* 改期（第 115 轮巡检）：月视图格内与周视图/列表对齐 */}
                            <Button
                              size="small"
                              variant="ghost"
                              disabled={busyId === jobId}
                              onClick={() => openReschedule(jobId, item.title, item.subtitle ?? '')}
                            >
                              改期
                            </Button>
                            {/* 跳过（第 113 轮巡检）：月视图格内操作对齐周视图 */}
                            <Button size="small" variant="ghost" disabled={busyId === jobId} onClick={() => void settle(jobId, 'skipped')}>
                              跳过
                            </Button>
                            {/* 顺延（第 116 轮巡检）：今日到期/已逾期格内可推一天（与列表/周视图对齐） */}
                            {item.dueLabel.includes('今日到期') || item.dueLabel.includes('已到期') ? (
                              <Button
                                size="small"
                                variant="ghost"
                                disabled={busyId === jobId}
                                onClick={() => void postpone(jobId, item.subtitle ?? '')}
                              >
                                顺延
                              </Button>
                            ) : null}
                          </div>
                        );
                            })}
                            {/* 折叠开关在「超过 3 条」时常驻（展开后显示「收起」）——
                                若以 hiddenCount>0 为条件，展开态 hiddenCount=0 会把开关一并隐藏，无法收起 */}
                            {cell.jobIds.length > 3 ? (
                              <button
                                type="button"
                                className="hdu-cell-more"
                                onClick={() => toggleCell(cell.key)}
                                title={cellExpanded ? '收起本格作业' : '展开本格全部作业'}
                              >
                                {cellExpanded ? '收起' : `还有 ${hiddenCount} 项`}
                              </button>
                            ) : null}
                          </>
                        );
                      })()}
                    </div>
                    );
                    })}
                </div>
                <div className="hdu-hint" style={{ marginTop: 8 }}>
                  月视图为到期日总览；点击格头日期可切列表查看当日到期。
                </div>
              </div>
            ) : (
            <div className="hdu-todo-rows">
            {pendingShown.map((item) => {
              const hdFavorite = favoriteByJobId.get(item.jobId);
              const isTodayDue = item.dueLabel.includes('今日到期');
              const isOverdue = item.dueLabel.includes('已到期');
              return (
              <div
                className={cx('hdu-todo-row', isTodayDue ? 'is-today-due' : '', isOverdue ? 'is-overdue' : '', dayFilter ? 'is-day-target' : '')}
                key={item.jobId}
              >
                  <input
                    type="checkbox"
                    aria-label={`选择：${item.title}`}
                    checked={selectedIds.has(item.jobId)}
                    onChange={() => toggleSelect(item.jobId)}
                  />
                  <div className="hdu-list-main">
                    <div className="hdu-list-title">
                      {/* 点击标题展开详情（第 94 轮巡检）：内容摘要 + 标签 */}
                      <button
                        type="button"
                        style={{ all: 'unset', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                        onClick={() => setExpandedId((prev) => (prev === item.jobId ? null : item.jobId))}
                        title={expandedId === item.jobId ? '收起详情' : '展开详情'}
                      >
                        {item.title}
                        <Icon name={expandedId === item.jobId ? 'chevronDown' : 'chevronRight'} size={12} />
                      </button>
                    </div>
                    <div className="hdu-list-sub">
                      <span>{sourceByJobId.get(item.jobId)}</span>
                      <span>{templateByJobId.get(item.jobId)}</span>
                      <span>{roundByJobId.get(item.jobId)}</span>
                      {/* 倍增间隔刻度条（第 246 轮巡检）：紧跟轮次徽标的次要位（hdu-list-sub
                          行内 flex，基线对齐）；已完成档实色、当前档 accent 高亮、未来档淡色；
                          hover title 给「第 N 轮 · 间隔 X 天」+ 与完成建议同源说明 */}
                      {(() => {
                        const hit = intervalScaleByJobId.get(item.jobId);
                        if (!hit) return null;
                        return (
                          <span
                            className="hdu-interval-scale"
                            role="img"
                            aria-label={`复习间隔刻度：第 ${hit.round} 轮，当前档间隔 ${hit.scale.intervalDays} 天`}
                            title={`第 ${hit.round} 轮 · 间隔 ${hit.scale.intervalDays} 天（倍增档 3/7/14/30 天，与完成建议同口径）`}
                          >
                            {Array.from({ length: hit.scale.tiers }, (_, i) => (
                              <i
                                key={i}
                                className={cx(
                                  'hdu-interval-cell',
                                  i < hit.scale.index ? 'is-done' : i === hit.scale.index ? 'is-cur' : '',
                                )}
                              />
                            ))}
                          </span>
                        );
                      })()}
                      {item.typeLabel ? <span>{item.typeLabel}</span> : null}
                      {item.subtitle ? <span>{item.subtitle}</span> : null}
                      <span>{item.dueLabel}</span>
                    </div>
                    {expandedId === item.jobId ? (
                      <div style={{ marginTop: 4, fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>
                        <div>
                          {(() => {
                            const favorite = favoriteByJobId.get(item.jobId);
                            const content = favorite?.snapshot?.content ?? '';
                            return content ? content.replace(/\s+/g, ' ').slice(0, 140) : '（无内容摘要）';
                          })()}
                        </div>
                        {(() => {
                          const favorite = favoriteByJobId.get(item.jobId);
                          const tags = favorite?.tags ?? [];
                          const favoritedAt = favorite?.favoritedAt;
                          const job = pendingJobs.find((j) => j.id === item.jobId);
                          const log = Array.isArray(job?.rescheduleLog) ? job!.rescheduleLog! : [];
                          return (
                            <>
                              {tags.length > 0 ? <div>标签：{tags.join('、')}</div> : null}
                              {favoritedAt ? <div>收藏于 {new Date(favoritedAt).toLocaleString()}</div> : null}
                              {/* 改期留痕（第 111 轮巡检）：最近一次调整的轨迹 */}
                              {log.length > 0 ? (
                                <div>
                                  改期：{log.map((entry) => `${entry.from} → ${entry.to}`).join('；')}
                                </div>
                              ) : null}
                            </>
                          );
                        })()}
                      </div>
                    ) : null}
                    {/* 行内顺延浮层（第 244 轮巡检）：快捷 chips 点选即 review.reschedule 到所选日
                        （钳制与「今日保持不变」提示与弹层同口径）；「其他日期…」进完整改期弹层 */}
                    {reschedQuickJobId === item.jobId ? (
                      <div className="hdu-resched-pop" role="group" aria-label={`顺延「${item.title}」到指定日`}>
                        <div className="hdu-resched-pop-head">
                          <span className="hdu-resched-pop-title">顺延到指定日</span>
                          <button
                            type="button"
                            className="hdu-resched-pop-close"
                            aria-label="收起顺延选项"
                            title="收起"
                            onClick={() => setReschedQuickJobId(null)}
                          >
                            ×
                          </button>
                        </div>
                        <RescheduleOptionChips
                          options={rescheduleOptions}
                          selectedDate=""
                          ariaLabelPrefix="顺延快捷日期"
                          disabled={busyId === item.jobId}
                          onPick={(opt) => void rescheduleTo(item.jobId, opt.dateKey, opt.label, dueDateByJobId.get(item.jobId) ?? undefined)}
                        />
                        <div className="hdu-resched-pop-foot">
                          <button
                            type="button"
                            className="hdu-btn ghost small"
                            onClick={() => {
                              setReschedQuickJobId(null);
                              openReschedule(item.jobId, item.title, dueDateByJobId.get(item.jobId) ?? '');
                            }}
                          >
                            其他日期…
                          </button>
                          <span className="hdu-hint">目标日期不早于今日；选今天等于保持不变</span>
                        </div>
                      </div>
                    ) : null}
                  </div>
                  <div className="hdu-list-side" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {/* 站内收藏：去复习直达课次播放页（第 95 轮巡检）；B 站收藏行走外链 */}
                    {!item.url && hdFavorite?.courId != null ? (
                      <Button
                        size="small"
                        variant="ghost"
                        icon="play"
                        onClick={() => actions.openSessionInSite(hdFavorite.courId!, hdFavorite.teclId)}
                      >
                        去复习
                      </Button>
                    ) : null}
                    {item.url ? (
                      <a
                        className="hdu-btn ghost small"
                        href={item.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={`去复习：${item.title}`}
                      >
                        去复习
                      </a>
                    ) : null}
                    <Button
                      size="small"
                      icon="check"
                      loading={busyId === item.jobId}
                      onClick={() => void settle(item.jobId, 'done')}
                    >
                      完成
                    </Button>
                    {/* 顺延（第 107 轮巡检）：今日到期/已逾期行可推一天 */}
                    {isTodayDue || isOverdue ? (
                      <Button
                        size="small"
                        variant="ghost"
                        disabled={busyId === item.jobId}
                        onClick={() => void postpone(item.jobId, dueDateByJobId.get(item.jobId) ?? '')}
                      >
                        顺延
                      </Button>
                    ) : null}
                    {/* 顺延到指定日（第 244 轮巡检）：列表行「改期」先展开行内轻量浮层
                        （快捷 chips 点选即顺延，比弹层少一步确认）；「其他日期…」再进
                        完整改期弹层选任意日期。周视图/月视图行仍直达弹层 */}
                    <Button
                      size="small"
                      variant="ghost"
                      disabled={busyId === item.jobId}
                      aria-expanded={reschedQuickJobId === item.jobId}
                      title="顺延到指定日"
                      onClick={() => setReschedQuickJobId((prev) => (prev === item.jobId ? null : item.jobId))}
                    >
                      改期
                    </Button>
                    <Button
                      size="small"
                      variant="ghost"
                      disabled={busyId === item.jobId}
                      onClick={() => void settle(item.jobId, 'skipped')}
                    >
                      跳过
                    </Button>
                  </div>
                </div>
              );
              })}
            </div>
            )}
            {/* 待完成渐进显示「显示更多」（第 245 轮巡检）：与知识库同款 ghost 居中样式，
                每次追加 60 条（nextVisibleLimit 共享步长），附剩余条数提示 */}
            {displayPending.length > pendingShown.length ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '6px 0 2px' }}>
                <Button size="small" variant="ghost" onClick={() => setPendingLimit((v) => nextVisibleLimit(v))}>
                  显示更多（还有 {displayPending.length - pendingShown.length} 条）
                </Button>
              </div>
            ) : null}

            {/* ── 已完成（最近优先，最多 30 条） ── */}
            {/* 已完成/已跳过分区计数（第 100 轮巡检） */}
            {doneJobs.length > 0 ? (
              <div style={{ marginTop: 16 }}>
                <div className="hdu-todo-head">
                  已完成（{doneJobs.length}）
                  {/* 导出完成记录（第 110 轮巡检）：已完成分区 → Markdown */}
                  <Button size="small" variant="ghost" icon="download" onClick={exportDoneRecords}>
                    导出记录
                  </Button>
                  {/* 分区折叠（第 114 轮巡检） */}
                  <button type="button" className="hdu-folder" onClick={() => setDoneOpen((v) => !v)}>
                    {doneOpen ? '收起' : '展开'}
                  </button>
                </div>
                {doneOpen ? (
                <div className="hdu-todo-rows">
                  {displayDone.map((job) => (
                    <div className={cx('hdu-todo-row', 'is-done')} key={job.id}>
                      <div className="hdu-list-main">
                        <div className="hdu-list-title">{job.favorite?.snapshot?.title ?? '（收藏已删除）'}</div>
                        <div className="hdu-list-sub">
                          <span>{job.favorite?.courId != null ? '站内' : 'B 站'}</span>
                          <span>第 {job.round} 轮</span>
                          <span>到期 {job.dueDate}</span>
                          <span>完成于 {new Date(job.updatedAt).toLocaleString()}</span>
                        </div>
                      </div>
                      <div className="hdu-list-side" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Chip tone="jade" icon="check">已完成</Chip>
                        {/* 撤销完成（第 116 轮巡检）：done 作业回到 pending（到期日拉回今天起算） */}
                        <Button
                          size="small"
                          variant="ghost"
                          disabled={busyId === job.id}
                          onClick={() => void reopenDone(job.id)}
                        >
                          撤销完成
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
                ) : null}
                {/* 分页（第 85 轮巡检）：已完成超过当前页时「查看更多」每次 +30 */}
                {doneJobs.length > doneShown.length ? (
                  <div style={{ marginTop: 8, textAlign: 'center' }}>
                    <Button size="small" variant="ghost" onClick={() => setDoneLimit((limit) => limit + 30)}>
                      查看更多（还有 {doneJobs.length - doneShown.length} 条）
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}

            {/* 已跳过分区：≥2 项时可批量重新入计划（第 86 轮巡检） */}
            {skippedJobs.length > 0 ? (
              <div style={{ marginTop: 16 }}>
                <div className="hdu-todo-head">
                  已跳过（{skippedJobs.length}）
                  {skippedJobs.length > 1 ? (
                    <Button
                      size="small"
                      variant="ghost"
                      icon="refresh"
                      loading={busyId === '__batch_replan__'}
                      onClick={() => void replanAllSkipped()}
                    >
                      全部重新入计划
                    </Button>
                  ) : null}
                  {/* 分区折叠（第 114 轮巡检） */}
                  <button type="button" className="hdu-folder" onClick={() => setSkippedOpen((v) => !v)}>
                    {skippedOpen ? '收起' : '展开'}
                  </button>
                </div>
                {skippedOpen ? (
                <div className="hdu-todo-rows">
                  {displaySkipped.map((job) => (
                    <div className="hdu-todo-row is-done" key={job.id}>
                      <div className="hdu-list-main">
                        <div className="hdu-list-title">{job.favorite?.snapshot?.title ?? '（收藏已删除）'}</div>
                        <div className="hdu-list-sub">
                          <span>{job.favorite?.courId != null ? '站内' : 'B 站'}</span>
                          <span>第 {job.round} 轮</span>
                          <span>到期 {job.dueDate}</span>
                        </div>
                      </div>
                      <div className="hdu-list-side" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Chip>已跳过</Chip>
                        {/* 重新加入计划（第 85 轮巡检）：复用 review.plan 重新排期 */}
                        {job.favorite ? (
                          <Button
                            size="small"
                            variant="ghost"
                            loading={busyId === `replan-${job.favoriteId}`}
                            onClick={() => void replan(job.favoriteId)}
                          >
                            重新加入计划
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
                ) : null}
              </div>
            ) : null}

            <div className="hdu-hint" style={{ marginTop: 12 }}>
              复习作业按遗忘曲线排期（模板与间隔可在设置中调整）；「跳过」仅跳过当前这一轮，不影响后续轮次。
            </div>
          </>
        )}
      </div>
      {/* 自定义改期弹层（第 109 轮巡检）：日期选择 → review.reschedule */}
      <Modal
        open={rescheduleTarget !== null}
        title={rescheduleTarget ? `改期：${rescheduleTarget.title}` : '改期'}
        onClose={() => setRescheduleTarget(null)}
        width={320}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="hdu-hint">
            当前到期：{rescheduleTarget?.dueDate ?? '—'}；选择新的到期日（不早于今日，选今天等于保持不变）。
          </div>
          {/* 快捷档（第 244 轮巡检升级）：明天/后天/周X…/下周同一日/下月同一日 8 档
              （buildRescheduleOptions 共享纯函数，与行内浮层/批量弹层同源），点选即设日期再确认 */}
          <RescheduleOptionChips
            options={rescheduleOptions}
            selectedDate={rescheduleDate}
            ariaLabelPrefix="快捷改期日期"
            onPick={(opt) => setRescheduleDate(opt.dateKey)}
          />
          <input
            type="date"
            className="hdu-input"
            value={rescheduleDate}
            min={localDayKey()}
            onChange={(e) => setRescheduleDate(e.target.value)}
            aria-label="新的到期日"
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
            <Button size="small" variant="ghost" onClick={() => setRescheduleTarget(null)}>
              取消
            </Button>
            <Button
              size="small"
              variant="primary"
              loading={rescheduleBusy}
              disabled={!rescheduleDate}
              onClick={() => void confirmReschedule()}
            >
              确认改期
            </Button>
          </div>
        </div>
      </Modal>
      {/* 批量改期弹层（第 123 轮巡检）：多选行统一改到所选日期 → 逐条 review.reschedule */}
      <Modal
        open={batchRescheduleOpen}
        title={`批量改期（${selectedIds.size} 项）`}
        onClose={() => setBatchRescheduleOpen(false)}
        width={320}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="hdu-hint">已选 {selectedIds.size} 项；统一改到所选到期日（不早于今日，选今天等于保持不变）。</div>
          {/* 快捷档（第 244 轮巡检升级）：与单行改期弹层同源同款 8 档 */}
          <RescheduleOptionChips
            options={rescheduleOptions}
            selectedDate={rescheduleDate}
            ariaLabelPrefix="批量快捷改期日期"
            onPick={(opt) => setRescheduleDate(opt.dateKey)}
          />
          <input
            type="date"
            className="hdu-input"
            value={rescheduleDate}
            min={localDayKey()}
            onChange={(e) => setRescheduleDate(e.target.value)}
            aria-label="批量新的到期日"
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
            <Button size="small" variant="ghost" onClick={() => setBatchRescheduleOpen(false)}>
              取消
            </Button>
            <Button
              size="small"
              variant="primary"
              loading={rescheduleBusy}
              disabled={!rescheduleDate}
              onClick={() => void confirmBatchReschedule()}
            >
              确认批量改期
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// ───────────────────────── 复习统计摘要行（第 247 轮巡检） ─────────────────────────

/**
 * 「复习统计」摘要行（ReviewView 头部，预测柱图下方）：四 mini 指标横排——
 *  - 每格两行：数值（tabular-nums 加粗）+ 标签（muted 小字），格间 1px 细竖线分隔；
 *  - 跳过率 danger 淡色档（有跳过记录才渲染，null → 该格不出现）；
 *  - 无任何完成/跳过记录（hasRecords=false）渲染轻量空态文案（一句话说明口径），
 *    不渲染空骨架格；
 *  - 纯展示组件不写数据；export 仅为渲染单测可达（照 RescheduleOptionChips 先例）。
 */
export function ReviewStatsSummary({ stats }: { stats: ReviewStats }) {
  if (!stats.hasRecords) {
    return (
      <div className="hdu-review-stats-summary is-empty" role="status">
        暂无复习完成记录——完成或跳过一轮后，这里会显示累计完成、本周完成与连续天数。
      </div>
    );
  }
  return (
    <div className="hdu-review-stats-summary" role="group" aria-label="复习统计">
      <span className="hdu-review-stat-mini">
        <span className="hdu-review-stat-value">{stats.totalDone}</span>
        <span className="hdu-review-stat-label">累计完成</span>
      </span>
      <span className="hdu-review-stat-mini">
        <span className="hdu-review-stat-value">{stats.weekDone}</span>
        <span className="hdu-review-stat-label">本周完成</span>
      </span>
      <span className="hdu-review-stat-mini">
        <span className="hdu-review-stat-value">{stats.streakDays}</span>
        <span className="hdu-review-stat-label">连续天数</span>
      </span>
      {stats.skipRate != null ? (
        <span className="hdu-review-stat-mini is-skip">
          <span className="hdu-review-stat-value">{stats.skipRate}%</span>
          <span className="hdu-review-stat-label">跳过率</span>
        </span>
      ) : null}
    </div>
  );
}

// ───────────────────────── 顺延到指定日 · 快捷日期 chips（第 244 轮巡检） ─────────────────────────

/**
 * 快捷日期选项 chips 网格（改期弹层 / 行内顺延浮层 / 批量改期弹层三处共用渲染）：
 *  - 每枚 chip 两行：主行 label（明天 / 后天 / 周X / 下周同一日 / 下月同一日）+
 *    副行 dayLabel（M月D日 周X，muted 小字 tabular-nums）；
 *  - is-active 选中态（弹层内 rescheduleDate 命中该档；行内浮层点选即顺延不标选中）；
 *  - hover / :focus-visible 交互三件套与周历条 .hdu-week-col 同构（styles.ts 第 244 轮块）。
 * export 仅为渲染单测可达（照 ReviewForecastChart 先例）。
 */
export function RescheduleOptionChips({
  options,
  selectedDate,
  onPick,
  disabled,
  ariaLabelPrefix,
}: {
  options: RescheduleOption[];
  selectedDate: string;
  onPick: (opt: RescheduleOption) => void;
  disabled?: boolean;
  ariaLabelPrefix: string;
}) {
  return (
    <div className="hdu-resched-grid" role="group" aria-label={ariaLabelPrefix}>
      {options.map((opt) => (
        <button
          type="button"
          key={opt.key}
          className={cx('hdu-resched-chip', selectedDate && selectedDate === opt.dateKey ? 'is-active' : '')}
          disabled={disabled}
          title={`${opt.label} · ${opt.dayLabel}`}
          aria-pressed={Boolean(selectedDate) && selectedDate === opt.dateKey}
          onClick={() => onPick(opt)}
        >
          <span className="hdu-resched-chip-label">{opt.label}</span>
          <span className="hdu-resched-chip-date">{opt.dayLabel}</span>
        </button>
      ))}
    </div>
  );
}

// ───────────────────────── 7 日到期预测小柱图（第 241 轮巡检） ─────────────────────────

/**
 * 复用 .hdu-bars 家族的紧凑可点柱图：逾期/今日/明日/周X/以后 8-9 根柱。
 *  - 柱 hover 标题「N 月 N 日 · M 项」（forecastBarTitle，逾期/以后给文字标签）；
 *  - 最高柱（含并列）accent 高亮（is-peak），今日柱 jade 描边（与时长柱图今日色一致）；
 *  - 点日柱/逾期柱复用按日过滤（jumpToDay，与周历条/月历格同一 dayFilter state）；
 *    「以后」柱跨多日无单一筛选键，恒禁用仅展示；
 *  - 数字全 0 的空态由调用方渲染（hdu-forecast-empty），本组件不处理空图。
 */
function ReviewForecastChart({ bars, onPick }: { bars: ReviewForecastBar[]; onPick: (key: string) => void }) {
  const todayKey = localDayKey();
  const max = Math.max(1, ...bars.map((bar) => bar.count));
  return (
    <div className="hdu-review-forecast" role="group" aria-label="7 日到期预测">
      {bars.map((bar) => {
        const clickable = bar.key !== 'later' && bar.count > 0;
        // 「明」柱 hover/读屏标题附口径互认（第 242 轮巡检）：与今日待办「明日到期」Chip
        // 同口径；仅在有到期作业时附（0 项柱附后缀是噪声）
        const baseTitle = forecastBarTitle(bar);
        const title =
          bar.dayLabel === '明日' && bar.count > 0 ? `${baseTitle}，与今日待办「明日到期」同口径` : baseTitle;
        return (
          <button
            type="button"
            key={bar.key}
            className={cx(
              'hdu-forecast-col',
              bar.key === 'overdue' ? 'is-overdue' : '',
              bar.date === todayKey ? 'is-today' : '',
              bar.isPeak ? 'is-peak' : '',
            )}
            title={title}
            aria-label={title}
            disabled={!clickable}
            onClick={() => clickable && onPick(bar.key)}
          >
            <span className="hdu-forecast-track">
              <span
                className="hdu-forecast-fill"
                style={{ height: `${bar.count > 0 ? Math.max(4, (bar.count / max) * 100) : 0}%` }}
              />
            </span>
            <span className="hdu-forecast-count">{bar.count}</span>
            <span className="hdu-forecast-label">{bar.dayLabel}</span>
          </button>
        );
      })}
    </div>
  );
}
