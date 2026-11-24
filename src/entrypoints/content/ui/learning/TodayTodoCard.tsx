// 学习中心「今日待办」卡片（自 LearningCenter.tsx 第 40 轮巡检按视图纯搬移拆分，逻辑不变）。
// 含每周计划头部信息聚合（useTodayPlan / weeklyCardInfo）、计划摘要菜单（WeeklyPlanChip）
// 与待办渲染主体（TodayTodoCard，导出供单元测试 plan-menu.test.ts）。
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { callOp } from '@/core/shared/client';
import { errorTextOf } from '@/core/shared/errors';
import { buildTodayPlan, type TodayPlan, type TodayPlanInput, type TodayTodoItem } from '@/core/plan/today';
import { buildAchievements } from '@/core/plan/achievements';
import { useAchievementCounts } from './AchievementStrip';
import {
  planDaySlice,
  weeklyPlanProgress,
  weeklyPlansToday,
  weeklyTodayBvids,
  type WeeklyPlan,
} from '@/core/plan/weekly';
import type { FavoriteEntity } from '@/core/shared/types';
import type { MissedItem } from '@/core/shared/ops';
import { dayKeyToTs, localDayKey } from '@/core/shared/utils';
import { pushToast, Button, Chip, ConfirmButton, EmptyState, Ring, SectionHead, Skeleton, cx } from '../components';
import { Icon } from '../icons';
import { uiStore, useUiStore } from '../store';

/** 打开学习看板（dashboard.html 非 web_accessible，与 openOptions 同样经 SW 代开新标签页） */
function openDashboard(): void {
  try {
    void chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD' });
  } catch {
    /* 扩展重载时忽略 */
  }
}

// ───────────────────────── 今日待办 ─────────────────────────

/** 每周计划的今日展示信息（无「今日活跃」计划时为 null） */
interface WeeklyTodayInfo {
  /** 主计划 id（取消计划的 op 参数） */
  planId: string;
  /** 主计划来源收藏夹名（可选，菜单标题展示） */
  label?: string;
  /** 主计划今日的 dayIndex（展示为「第 x / y 天」，x = dayIndex + 1） */
  dayIndex: number;
  totalDays: number;
  /** 所有活跃计划合并 bvid（去重）的总数与整体完看比率（Ring 值） */
  total: number;
  ratio: number;
  /** 主计划每天条数（菜单摘要展示） */
  perDay: number;
  /** 计划区间「M月D日 – M月D日」（脏 startDate 降级为单日，仍不可用则为 null） */
  rangeLabel: string | null;
}

/** 'M月D日' 短日期（计划摘要用）；非法时间戳返回 null */
function shortDateLabel(ts: number): string | null {
  if (!Number.isFinite(ts)) return null;
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/**
 * 每周计划头部信息：主计划 = 最早创建的活跃计划
 * （repo 按 createdAt 升序返回，weeklyPlansToday 保序过滤）；多计划并存时
 * Chip / 菜单摘要用主计划口径（实现简单且不误导），Ring 与总数用合并口径反映整体进度。
 */
function weeklyCardInfo(plans: WeeklyPlan[], videoFavorites: FavoriteEntity[], date: string): WeeklyTodayInfo | null {
  const primary = plans[0];
  if (!primary) return null;
  const slice = planDaySlice(primary, date);
  const bvids = [...new Set(plans.flatMap((plan) => plan.bvids))];
  const progress = weeklyPlanProgress({ bvids }, videoFavorites);
  // 计划区间 = 起始日（含）~ 起始日 + totalDays - 1；脏 startDate（dayKeyToTs 得 NaN）时降级
  const startTs = dayKeyToTs(primary.startDate);
  const startLabel = shortDateLabel(startTs);
  const endLabel = slice.totalDays > 0 && startLabel != null ? shortDateLabel(startTs + (slice.totalDays - 1) * 86_400_000) : null;
  return {
    planId: primary.id,
    ...(primary.label ? { label: primary.label } : {}),
    dayIndex: slice.dayIndex,
    totalDays: slice.totalDays,
    total: progress.total,
    ratio: progress.ratio,
    perDay: primary.perDay,
    rangeLabel: startLabel != null && endLabel != null ? `${startLabel} – ${endLabel}` : startLabel,
  };
}

/**
 * 今日待办数据源：进入总览时并行加载五路信号
 * （review.due / schedule.missed / fav.list(video) / todo.today.get / plan.weekly.get），
 * 聚合为今日计划。任一路失败都降级为空数据，不互相拖垮；centerDataVersion
 * （课程/课表同步后自增）或 reloadKey（顶栏刷新）变化时重载。
 */
function useTodayPlan(reloadKey: number): {
  plan: TodayPlan | null;
  loading: boolean;
  toggle: (key: string) => void;
  weekly: WeeklyTodayInfo | null;
  /** 手动触发重载（取消每周计划后立即刷新） */
  reload: () => Promise<void>;
  /** 明日到期预告（第 229 轮巡检）：明日待复习作业数 */
  tomorrowCount: number;
  /** 逾期未完成（第 230 轮巡检）：今日之前到期的 pending 作业数 */
  overdueCount: number;
  /** 逾期作业（第 231/233 轮巡检）：id 供批量顺延，title 供失败明细点名 */
  overdueJobs: Array<{ id: string; title: string }>;
} {
  const version = useUiStore().centerDataVersion;
  const [plan, setPlan] = useState<TodayPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [weekly, setWeekly] = useState<WeeklyTodayInfo | null>(null);
  // 明日到期预告（第 229 轮巡检）：明日待复习作业数
  const [tomorrowCount, setTomorrowCount] = useState(0);
  // 逾期未完成（第 230 轮巡检，对齐 B 站今日卡「逾期 N」口径）：今日之前到期的 pending 作业数
  const [overdueCount, setOverdueCount] = useState(0);
  // 逾期作业（第 231/233 轮巡检）：id 供「顺延逾期」批量操作，title 供失败明细点名
  const [overdueJobs, setOverdueJobs] = useState<Array<{ id: string; title: string }>>([]);
  // 最近一次聚合的输入，勾选切换时按新 doneKeys 重建计划（复用同一纯函数，灰显口径一致）
  const inputRef = useRef<TodayPlanInput | null>(null);
  const doneRef = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    const date = localDayKey();
    const [doneKeys, dueReviews, missedSessions, videoFavorites, weeklyRes, tomorrowDue] = await Promise.all([
      callOp('todo.today.get', { date }).catch(() => [] as string[]),
      callOp('review.due', {}).catch(() => []),
      callOp('schedule.missed', {}).catch(() => [] as MissedItem[]),
      callOp('fav.list', { filter: { type: 'video', limit: 500 } }).catch(() => [] as FavoriteEntity[]),
      callOp('plan.weekly.get', {}).catch(() => ({ plans: [] as WeeklyPlan[] })),
      // 明日到期预告（第 229 轮巡检）：helps 用户预判明日的复习量
      callOp('review.due', { date: localDayKey(Date.now() + 86_400_000) }).catch(() => []),
    ]);
    // 每周计划降级为空数组：今日活跃计划的批次 bvid 传入聚合器（排序与前缀），头部信息单独展示
    const weeklyToday = weeklyPlansToday(Array.isArray(weeklyRes?.plans) ? weeklyRes.plans : [], date);
    doneRef.current = new Set(doneKeys);
    inputRef.current = {
      dueReviews,
      missedSessions,
      videoFavorites,
      doneKeys,
      today: date,
      weeklyBvids: weeklyTodayBvids(weeklyToday, date),
    };
    setPlan(buildTodayPlan(inputRef.current));
    setWeekly(weeklyCardInfo(weeklyToday, videoFavorites, date));
    setTomorrowCount(Array.isArray(tomorrowDue) ? tomorrowDue.length : 0);
    // 逾期口径（第 230 轮巡检）：到期日早于今日的 pending 作业
    const overdueList = Array.isArray(dueReviews)
      ? dueReviews.filter((job) => job?.status === 'pending' && typeof job.dueDate === 'string' && job.dueDate < date)
      : [];
    setOverdueCount(overdueList.length);
    setOverdueJobs(
      overdueList.map((job) => ({
        id: typeof job.id === 'string' ? job.id : '',
        title: job.favorite?.snapshot?.title ?? '（收藏已删除）',
      })),
    );
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load, version, reloadKey]);

  const toggle = useCallback((key: string) => {
    const next = new Set(doneRef.current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    doneRef.current = next;
    // 本地立即灰显，随后持久化到当天；失败仅提示，下次进入以 kv 为准
    const input = inputRef.current;
    if (input) setPlan(buildTodayPlan({ ...input, doneKeys: [...next] }));
    const date = input?.today ?? localDayKey();
    void callOp('todo.today.set', { date, keys: [...next] }).catch(() => pushToast('待办勾选保存失败', 'error'));
  }, []);

  return {
    plan,
    loading,
    toggle,
    weekly,
    reload: load,
    // 明日到期预告（第 229 轮巡检）：明日待复习作业数
    tomorrowCount,
    // 逾期未完成（第 230 轮巡检）：今日之前到期的 pending 作业数
    overdueCount,
    // 逾期作业（第 231/233 轮巡检）：id 供批量顺延，title 供失败明细点名
    overdueJobs,
  };
}

/** 按动作类型渲染条目右侧的操作控件（与知识库卡片 / 补看清单的现成跳转保持一致） */
function todoActionControl(item: TodayTodoItem): ReactNode {
  const actions = uiStore.actions;
  switch (item.action.type) {
    case 'dashboard':
      return (
        <Button size="small" variant="ghost" icon="refresh" onClick={() => openDashboard()}>
          去复习
        </Button>
      );
    case 'course': {
      const { courId, teclId } = item.action;
      if (courId == null) return null;
      return (
        <Button size="small" icon="play" onClick={() => actions.openSessionInSite(courId, teclId)}>
          去补看
        </Button>
      );
    }
    case 'url':
      return (
        <a
          className="hdu-btn ghost small"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}
          href={item.action.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          {/* 复习条目的 B 站跳转带「去复习」文案（action.label），video 条目维持「续看」 */}
          {item.action.label ?? '续看'} <Icon name="external" size={12} />
        </a>
      );
  }
}

/**
 * 每周计划 Chip + 摘要菜单（今日待办 video 分区头入口）：
 *  - 点击 Chip 弹出小浮层展示计划摘要（label / 总数 / 每天 N 个 / 起止日）；
 *  - 「取消计划」为两步确认：第一次点击仅进入确认态（红色文案「再点一次确认取消」，
 *    3 秒未点自动复原），确认后才真正调 plan.weekly.cancel，成功后关菜单 + toast + 重载今日待办；
 *  - 点击浮层外关闭：document 捕获 mousedown + composedPath 穿透 shadow 边界判定落点
 *    （照 TopBarSearch 的既有模式），Esc 亦可关闭。
 */
function WeeklyPlanChip({ info, onCancel }: { info: WeeklyTodayInfo; onCancel: (planId: string) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  // 「再点一次确认」的 3 秒复原定时器；卸载与关闭菜单时都要清掉
  const confirmTimerRef = useRef<number | null>(null);
  // 焦点归还（第 248 轮巡检，无障碍域）：菜单关闭后把焦点还给触发 chip——对齐共享
  // Modal 的 lastFocus 归还先例（components.tsx）。菜单本体无 tabIndex 入口，键盘用户
  // Esc 收起后焦点不能悬空丢失；toggle 点击收起时焦点本就在触发钮上（幂等），外点
  // 收起时浏览器 mousedown 默认行为随后会把焦点落到真实点击目标上，不受影响。
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const resetConfirm = useCallback(() => {
    setConfirming(false);
    if (confirmTimerRef.current != null) {
      window.clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    resetConfirm();
    triggerRef.current?.focus();
  }, [resetConfirm]);

  useEffect(() => resetConfirm, [resetConfirm]);

  // 点击浮层外关闭：捕获阶段监听 document，composedPath 判定真实落点（照顶栏搜索）
  useEffect(() => {
    if (!open) return undefined;
    const onDocMouseDown = (event: MouseEvent) => {
      const inside = event.composedPath().some(
        (node) => node instanceof Element && node.classList.contains('hdu-plan-menu-anchor'),
      );
      if (!inside) close();
    };
    const onDocKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDocMouseDown, true);
    document.addEventListener('keydown', onDocKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown, true);
      document.removeEventListener('keydown', onDocKeyDown, true);
    };
  }, [open, close]);

  const handleCancelClick = useCallback(async () => {
    // 两步确认：第一次点击只进入确认态（3 秒无操作自动复原），不发起取消
    if (!confirming) {
      resetConfirm();
      setConfirming(true);
      confirmTimerRef.current = window.setTimeout(() => setConfirming(false), 3000);
      return;
    }
    resetConfirm();
    setBusy(true);
    try {
      const ok = await onCancel(info.planId);
      if (ok) close();
    } finally {
      setBusy(false);
    }
  }, [confirming, info.planId, onCancel, resetConfirm, close]);

  return (
    <span className="hdu-plan-menu-anchor">
      <button
        type="button"
        ref={triggerRef}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => (open ? close() : setOpen(true))}
      >
        <Chip tone="info" title="查看计划摘要">
          每周计划 · 第 {info.dayIndex + 1}/{info.totalDays} 天
          <Icon name="chevronDown" size={11} />
        </Chip>
      </button>
      {open ? (
        <div className="hdu-plan-menu" role="dialog" aria-label="每周计划摘要">
          <div className="hdu-plan-menu-title">{info.label ?? '每周学习计划'}</div>
          <div className="hdu-plan-menu-rows">
            <span>共 {info.total} 个视频 · 每天 {info.perDay} 个</span>
            {info.rangeLabel ? <span>{info.rangeLabel} · 第 {info.dayIndex + 1}/{info.totalDays} 天</span> : null}
          </div>
          <div className="hdu-plan-menu-foot">按日历推进，不做补卡；看完（≥95%）的视频会自动移出待办。</div>
          <div className="hdu-plan-menu-actions">
            <Button
              size="small"
              variant="ghost"
              className={confirming ? 'is-confirm' : ''}
              loading={busy}
              onClick={() => void handleCancelClick()}
            >
              {confirming ? '再点一次确认取消' : '取消计划'}
            </Button>
          </div>
        </div>
      ) : null}
    </span>
  );
}

/** 导出供单元测试（plan-menu.test.ts）：两步确认取消与刷新联动的行为验证 */
export function TodayTodoCard({ reloadKey }: { reloadKey: number }) {
  const { plan, loading, toggle, weekly, reload, tomorrowCount, overdueCount, overdueJobs } = useTodayPlan(reloadKey);
  // 顺延逾期（第 231 轮巡检）：逾期作业逐个 reschedule 到明日，toast 汇总；第 233 轮失败明细点名；执行中禁用
  const [postponingOverdue, setPostponingOverdue] = useState(false);
  const postponeOverdue = useCallback(async () => {
    if (overdueJobs.length === 0 || postponingOverdue) return;
    setPostponingOverdue(true);
    const tomorrow = localDayKey(Date.now() + 86_400_000);
    const failedTitles: string[] = [];
    for (const job of overdueJobs) {
      try {
        await callOp('review.reschedule', { jobId: job.id, dueDate: tomorrow });
      } catch {
        failedTitles.push(job.title);
      }
    }
    setPostponingOverdue(false);
    if (failedTitles.length === 0) {
      pushToast(`已把 ${overdueJobs.length} 项逾期作业顺延到明日`, 'success');
    } else {
      pushToast(
        `已顺延 ${overdueJobs.length - failedTitles.length}/${overdueJobs.length} 项（部分失败）· 失败：${failedTitles.slice(0, 2).join('、')}${failedTitles.length > 2 ? ' 等' : ''}`,
        'error',
      );
    }
    if (failedTitles.length < overdueJobs.length) void reload();
  }, [overdueJobs, postponingOverdue, reload]);
  const allDone = plan != null && plan.totalCount > 0 && plan.doneCount === plan.totalCount;

  /** 取消每周计划（两步确认后的实际执行）：成功 toast + 立即重载今日待办；失败仅提示，菜单保持打开 */
  const cancelWeeklyPlan = useCallback(
    async (planId: string): Promise<boolean> => {
      try {
        await callOp('plan.weekly.cancel', { planId });
        pushToast('已取消每周计划，今日待办已更新', 'success');
        await reload();
        return true;
      } catch (err) {
        // errorTextOf：AppError 显示 userMessage，非 Error 异常值回退语境化兜底（第 29 轮清尾）
        pushToast(errorTextOf(err, '取消计划失败，请重试'), 'error');
        return false;
      }
    },
    [reload],
  );

  // 学习成就角标（第 132 轮巡检）：与 B 站今日卡/总览同全局口径（useAchievementCounts 现取）
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

  return (
    <section className="hdu-card pad hdu-today">
      <SectionHead
        title="今日待办"
        sub="到期复习、待补看课次与待学视频，勾掉一件是一件"
        actions={
          plan && plan.totalCount > 0 ? (
            <>
              <Chip tone={allDone ? 'jade' : 'default'} icon={allDone ? 'check' : undefined}>
                {plan.doneCount} / {plan.totalCount} 已完成
              </Chip>
              {/* 逾期独立 danger chip（第 243 轮语义色审计）：风险语义（逾期）此前以
                  后缀藏在完成度 chip 的 default/info 色里，与「jade=达成、danger=风险」
                  约定不符；拆出后与复习统计条 is-overdue、B 站今日卡同语义同色 */}
              {overdueCount > 0 ? (
                <Chip tone="danger" title="已逾期未完成的复习作业数；可一键顺延到明日">
                  逾期 {overdueCount}
                </Chip>
              ) : null}
              {/* 明日到期预告（第 229 轮巡检）：预判明日复习量，便于安排时间；第 242 轮起
                  title 交叉指引复习页 7 日到期预测（与预测「明」柱同口径，见 reviewForecast.ts） */}
              {tomorrowCount > 0 ? <Chip icon="calendar" title="明日到期的复习作业数；可在复习页查看 7 日到期预测（同口径）">明日到期 {tomorrowCount}</Chip> : null}
              {/* 顺延逾期（第 231 轮巡检）：逾期作业一键顺延到明日；第 232 轮 >3 项两步确认防误操作 */}
              {overdueCount > 3 ? (
                <ConfirmButton
                  size="small"
                  variant="ghost"
                  loading={postponingOverdue}
                  confirmLabel={`确认顺延 ${overdueCount} 项到明日？`}
                  onConfirm={() => void postponeOverdue()}
                >
                  顺延逾期（{overdueCount}）
                </ConfirmButton>
              ) : overdueCount > 0 ? (
                <Button size="small" variant="ghost" loading={postponingOverdue} onClick={() => void postponeOverdue()}>
                  顺延逾期（{overdueCount}）
                </Button>
              ) : null}
              {unlockedBadges > 0 ? (
                <Chip tone="jade" title="学习成就已解锁数">
                  🏅 {unlockedBadges}
                </Chip>
              ) : null}
            </>
          ) : unlockedBadges > 0 ? (
            <Chip tone="jade" title="学习成就已解锁数">
              🏅 {unlockedBadges}
            </Chip>
          ) : undefined
        }
      />
      {/* 今日待办庆祝态（第 233 轮巡检）：全部完成后显示庆祝条，附明日到期预告；取消任一勾选即消失。
          allDone 要求 plan 非空且 totalCount>0，加载中 / 空态天然不触发 */}
      {allDone ? (
        <div className="hdu-celebrate" role="status">
          <span className="hdu-celebrate-emoji" aria-hidden="true">🎉</span>
          <div>
            <div className="hdu-celebrate-title">今日待办全部完成</div>
            <div className="hdu-celebrate-hint">
              {tomorrowCount > 0 ? `明日还有 ${tomorrowCount} 项到期，保持节奏` : '明日暂无到期作业，可自由安排'}
            </div>
          </div>
        </div>
      ) : null}
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 6 }}>
          <Skeleton height={34} />
          <Skeleton height={34} />
          <Skeleton height={34} />
        </div>
      ) : !plan || plan.totalCount === 0 ? (
        /* 空态告知型（第 249 轮空态模板化）：title/text 不夹 emoji（视觉锚由 icon 承担） */
        <EmptyState
          icon="check"
          title="今日无待办"
          text="到期复习、待补看课次和 B 站待学视频会自动汇聚在这里；今天可以从容安排。"
        />
      ) : (
        <div className="hdu-today-body">
          {plan.sections.map((section) => {
            const remain = section.items.filter((i) => !i.done).length;
            return (
              <div key={section.kind}>
                <div className="hdu-todo-head">
                  {section.label}
                  {/* video 分区头：有今日活跃的每周计划时展示整体进度环（card 态 track，浅底可见）
                      与主计划天数 Chip（点击弹出摘要菜单，含取消计划入口） */}
                  {section.kind === 'video' && weekly ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <Ring value={weekly.ratio} size={40} variant="card" title="每周计划整体完看度" />
                      <WeeklyPlanChip info={weekly} onCancel={cancelWeeklyPlan} />
                    </span>
                  ) : null}
                  <span className="hdu-todo-count">{remain > 0 ? `待办 ${remain}` : '已完成'}</span>
                </div>
                <div className="hdu-todo-rows">
                  {section.items.map((item) => (
                    <div className={cx('hdu-todo-row', item.done ? 'is-done' : '')} key={item.key}>
                      <input
                        type="checkbox"
                        className="hdu-todo-check"
                        checked={item.done}
                        onChange={() => toggle(item.key)}
                        aria-label={item.done ? `取消完成：${item.title}` : `标记完成：${item.title}`}
                      />
                      <div className="hdu-list-main">
                        <div className="hdu-list-title">{item.title}</div>
                        <div className="hdu-list-sub">
                          {item.subtitle ? <span>{item.subtitle}</span> : null}
                          {item.dueLabel ? <span>{item.dueLabel}</span> : null}
                        </div>
                      </div>
                      <div className="hdu-list-side">{todoActionControl(item)}</div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
