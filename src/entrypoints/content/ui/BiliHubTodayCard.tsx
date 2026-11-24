/**
 * B 站学习中心「今日待办」卡（第 35 轮巡检；第 78 轮巡检扩为双分区）。
 *
 * 相对 HDU 学习中心 TodayTodoCard（五路信号聚合）的裁剪与取舍：
 *  - 到期复习：review.due 拉今日 pending 复习作业（含 favorite 快照），「完成」接
 *    review.complete（与 Dashboard 复习看板同一 op 同一语义），成功后重拉；
 *  - 待学视频（第 78 轮巡检并入）：B 站视频收藏（type=video）中未完看者进
 *    「待学视频」分区——每周计划今日批次（plan.weekly.get → weeklyPlansToday →
 *    weeklyTodayBvids）命中的排前并加「今日计划 · 」前缀；勾选状态走
 *    todo.today.get/set（键口径 `video:<bvid>`，与 HDU 今日待办同源同 kv），条目
 *    的「续看」链接由 buildTodayPlan 的 video 条目 action（url，含 ?t= 断点）给出；
 *    schedule.missed 依赖 HDU 课表体系，仍不引入（missedSessions 恒空）。
 *  - 跳转策略复用 core/plan/today 的聚合内核（buildTodayPlan 纯函数）：B 站收藏
 *    解析出站外链接（metadata.url / bvid，补 ?p= 分 P 与 ?t= 锚点）→ 新标签直跳；
 *    收藏已删除 / 脏数据 → 仅展示（标题给「（收藏已删除）」占位）。
 *  - 庆祝态（第 234 轮巡检，对齐 HDU 今日待办卡第 233 轮）：待办全部完成且总数 >0
 *    时显示同款 .hdu-celebrate 庆祝条 + 明日到期预告（复用既有 UI_CSS 类，无新增 CSS）。
 *
 * 视图模型：复习分区沿用 buildHubTodayItems（内部复用 buildTodayPlan 的复习分区，
 * 单测锁定）；视频分区直接取 buildTodayPlan 的 video 分区。样式全部沿用 UI_CSS
 * 既有类（hdu-section / hdu-card / hdu-todo-row / hdu-list-*），无新增 CSS；
 * 类名 hdu-hub-today 供 e2e 冒烟穿透查询。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { callOp } from '@/core/shared/client';
import { errorTextOf } from '@/core/shared/errors';
import { addDaysKey, localDayKey } from '@/core/shared/utils';
import type { FavoriteEntity, FavoriteType, ReviewJobEntity } from '@/core/shared/types';
import { buildTodayPlan, type TodayPlan, type TodayPlanInput } from '@/core/plan/today';
import { weeklyPlansToday, weeklyTodayBvids, type WeeklyPlan } from '@/core/plan/weekly';
import { buildRescheduleOptions, clampRescheduleDate } from '@/core/plan/rescheduleOptions';
import { buildAchievements } from '@/core/plan/achievements';
import { useAchievementCounts } from './learning/AchievementStrip';
import { RescheduleOptionChips } from './learning/ReviewView';
import { Button, Chip, EmptyState, SectionHead, Skeleton, pushToast, cx } from './components';
import { FAVORITE_META, videoBvidOf } from './VideoFavCard';
import { Icon } from './icons';

/** 复习条目 todoKey 前缀（todoKeyOf 的 review 分支口径），从 key 还原 jobId 用 */
const REVIEW_KEY_PREFIX = 'review:';

/** 今日待办精简卡的条目视图模型（纯展示，无行为） */
export interface HubTodayReviewItem {
  /** 复习作业 id（review.complete 的 jobId） */
  jobId: string;
  /** 标题：favorite 快照标题；收藏已删除时为聚合器的「（收藏已删除）」占位 */
  title: string;
  /** 收藏类型中文标签（视频/时间点/AI 回答/笔记…）；收藏缺失时为 null */
  typeLabel: string | null;
  /** 副标题：到期日（YYYY-MM-DD） */
  subtitle?: string;
  /** 到期提示：今日到期 / 已到期 N 天 / MM-DD 到期 / 到期日未知 */
  dueLabel: string;
  /**
   * B 站收藏解析出的站外跳转链接（已含 ?p= / ?t= 锚点）；
   * HDU 站内收藏 / 收藏已删除 / 解析失败为 null（仅展示，不给跳转）。
   */
  url: string | null;
}

/**
 * 纯函数：review.due 返回 → 今日待办精简卡复习条目（按到期日升序、轮次升序）。
 * 复用 buildTodayPlan 的复习分区（标题/到期标签/跳转解析/排序/脏数据防御同源），
 * 再补收藏类型标签与站外链接两个展示字段。today 可注入（单测固定时钟）。
 */
export function buildHubTodayItems(
  dueReviews: Array<ReviewJobEntity & { favorite: FavoriteEntity | null }>,
  today: string = localDayKey(),
): HubTodayReviewItem[] {
  const plan = buildTodayPlan({ dueReviews, missedSessions: [], videoFavorites: [], doneKeys: [], today });
  const reviewSection = plan.sections.find((section) => section.kind === 'review');
  if (!reviewSection) return [];
  // jobId → 收藏类型（favorite 可能缺失/删除；脏记录的非法 id 不进映射）
  const typeByJobId = new Map<string, FavoriteType | undefined>(
    dueReviews
      .filter((job): job is ReviewJobEntity & { favorite: FavoriteEntity | null } =>
        Boolean(job) && typeof (job as { id?: unknown }).id === 'string',
      )
      .map((job) => [job.id, job.favorite?.type]),
  );
  return reviewSection.items.map((item) => {
    const jobId = item.key.startsWith(REVIEW_KEY_PREFIX) ? item.key.slice(REVIEW_KEY_PREFIX.length) : item.key;
    const type = typeByJobId.get(jobId);
    return {
      jobId,
      title: item.title,
      typeLabel: type ? (FAVORITE_META[type]?.label ?? null) : null,
      subtitle: item.subtitle,
      dueLabel: item.dueLabel ?? '',
      url: item.action.type === 'url' ? item.action.url : null,
    };
  });
}

/**
 * B 站学习中心「今日待办」页签内容：到期复习 + 待学视频双分区。
 * 独立取数（review.due / fav.list(video) / plan.weekly.get / todo.today.get），
 * 挂载即拉取；复习完成与视频勾选的提示走本 portal 的 ToastHost。
 */
export function BiliHubTodayCard() {
  /** null = 首次加载中；加载后恒为对象（分区可能为空） */
  const [plan, setPlan] = useState<TodayPlan | null>(null);
  const [reviewItems, setReviewItems] = useState<HubTodayReviewItem[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  /** 正在提交「完成」的复习 jobId（按钮 loading；其余行不受影响） */
  const [completingId, setCompletingId] = useState<string | null>(null);
  // 明日到期预告（第 229 轮巡检）：与 HDU 今日待办卡同口径
  const [tomorrowCount, setTomorrowCount] = useState(0);
  // 学习成就角标（第 131 轮巡检）：今日卡头部显示已解锁徽章数（与总览/统计同一全局口径）
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

  // seq 守卫（第 38 轮巡检）：快速重挂载/手动重试叠加时，慢的旧响应不得覆盖新数据；
  // 失败重试走同一 load（序号递增），迟到响应（无论成功/失败分支）一律丢弃
  const loadSeqRef = useRef(0);
  // 最近一次聚合的输入，视频勾选切换时按新 doneKeys 重建计划（与 HDU 今日待办同口径）
  const inputRef = useRef<TodayPlanInput | null>(null);
  const doneRef = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    setLoadFailed(false);
    try {
      const date = localDayKey();
      // 四路并行；视频/计划/勾选三路失败降级为空（不拖垮复习主分区），review.due
      // 失败才整卡判失败（可重试）
      const [due, videoFavs, weeklyRes, doneKeys, tomorrowDue] = await Promise.all([
        callOp('review.due', {}),
        callOp('fav.list', { filter: { type: 'video', limit: 500 } }).catch(() => [] as FavoriteEntity[]),
        callOp('plan.weekly.get', {}).catch(() => ({ plans: [] as WeeklyPlan[] })),
        callOp('todo.today.get', { date }).catch(() => [] as string[]),
        // 明日到期预告（第 229 轮巡检）：与 HDU 今日待办卡同口径
        callOp('review.due', { date: localDayKey(Date.now() + 86_400_000) }).catch(() => []),
      ]);
      if (loadSeqRef.current !== seq) return;
      setTomorrowCount(Array.isArray(tomorrowDue) ? tomorrowDue.length : 0);
      const weeklyToday = weeklyPlansToday(Array.isArray(weeklyRes?.plans) ? weeklyRes.plans : [], date);
      doneRef.current = new Set(Array.isArray(doneKeys) ? doneKeys : []);
      inputRef.current = {
        dueReviews: Array.isArray(due) ? due : [],
        missedSessions: [],
        // B 站侧只收 B 站视频收藏（videoBvidOf 能解析出 bvid；HDU 站内不产 video 收藏）
        videoFavorites: (Array.isArray(videoFavs) ? videoFavs : []).filter((fav) => videoBvidOf(fav) !== ''),
        doneKeys: [...doneRef.current],
        today: date,
        weeklyBvids: weeklyTodayBvids(weeklyToday, date),
      };
      setReviewItems(buildHubTodayItems(inputRef.current.dueReviews, date));
      setPlan(buildTodayPlan(inputRef.current));
    } catch {
      if (loadSeqRef.current !== seq) return;
      // 失败与空态区分展示（照 BiliWatchCard 的失败口径），可重试
      setReviewItems([]);
      setPlan(null);
      setLoadFailed(true);
    }
  }, []);

  // 挂载即拉取：页签切换/面板重开都会重新挂载并刷新（SPA 常驻面板的数据面以进入为准）
  useEffect(() => {
    void load();
  }, [load]);

  /** 完成当日复习：review.complete(status='done')，成功后重拉（完成项移出 pending） */
  const handleComplete = useCallback(
    async (jobId: string) => {
      setCompletingId(jobId);
      try {
        await callOp('review.complete', { jobId, status: 'done' });
        pushToast('完成一轮复习', 'success');
        await load();
      } catch (err) {
        pushToast(errorTextOf(err, '完成复习失败，请重试'), 'error');
      } finally {
        setCompletingId(null);
      }
    },
    [load],
  );

  // 顺延（第 107 轮 HDU 对等，第 108 轮入 B 站今日卡）：逾期复习行一键推到明天
  //（review.reschedule 后重拉；仅逾期行露出——今日到期行以完成为主）
  const [postponingId, setPostponingId] = useState<string | null>(null);
  const postpone = useCallback(
    async (jobId: string, dueDate: string) => {
      setPostponingId(jobId);
      try {
        const today = localDayKey();
        const base = !dueDate || dueDate < today ? today : dueDate;
        await callOp('review.reschedule', { jobId, dueDate: addDaysKey(base, 1) ?? base });
        pushToast('已顺延一天', 'success');
        await load();
      } catch (err) {
        pushToast(errorTextOf(err, '顺延失败，请重试'), 'error');
      } finally {
        setPostponingId(null);
      }
    },
    [load],
  );

  // 顺延到指定日（第 248 轮巡检，B 站对齐收官）：对齐 HDU 复习计划第 244 轮的行内
  // 顺延浮层——「改期」展开快捷 chips（共享 RescheduleOptionChips + buildRescheduleOptions
  // 同一纯函数，快捷档与钳制口径完全同源），点选即 review.reschedule 到所选日。
  // 「其他日期…」完整改期弹层不引入：该弹层与 HDU 复习列表的批量/留痕体系强耦合，
  // B 站今日卡为精简卡，差异点记入面板对齐说明（见 BiliHubPanel foot）。
  const [reschedJobId, setReschedJobId] = useState<string | null>(null);
  const rescheduleOptions = useMemo(() => buildRescheduleOptions(localDayKey()), []);
  const rescheduleTo = useCallback(
    async (jobId: string, opt: { label: string; dateKey: string }) => {
      const clamped = clampRescheduleDate(opt.dateKey, localDayKey());
      if (!clamped) {
        pushToast('日期无效，请重试', 'error');
        return;
      }
      if (clamped.sameDay) {
        pushToast('已选今天，到期日保持不变', 'info');
        setReschedJobId(null);
        return;
      }
      setPostponingId(jobId);
      try {
        await callOp('review.reschedule', { jobId, dueDate: clamped.dateKey });
        pushToast(`已改期到${opt.label}（${clamped.dateKey.slice(5)}）`, 'success');
        setReschedJobId(null);
        await load();
      } catch (err) {
        pushToast(errorTextOf(err, '改期失败，请重试'), 'error');
      } finally {
        setPostponingId(null);
      }
    },
    [load],
  );

  // 逾期全部顺延（第 117 轮巡检）：全部逾期复习行推到明天（与 HDU 复习计划对齐）
  const overdueRows = (reviewItems ?? []).filter((item) => item.dueLabel.includes('已到期'));
  const postponeAllOverdue = useCallback(async () => {
    const today = localDayKey();
    const tomorrow = addDaysKey(today, 1) ?? today;
    if (overdueRows.length === 0) return;
    setPostponingId('__all__');
    let ok = 0;
    for (const item of overdueRows) {
      try {
        await callOp('review.reschedule', { jobId: item.jobId, dueDate: tomorrow });
        ok += 1;
      } catch {
        /* 单项失败继续 */
      }
    }
    pushToast(ok === overdueRows.length ? `已顺延 ${ok} 条逾期作业` : `已顺延 ${ok}/${overdueRows.length} 条（部分失败）`, ok > 0 ? 'success' : 'error');
    await load();
    setPostponingId(null);
  }, [overdueRows, load]);

  // 今日到期全部顺延（第 122 轮巡检）：全部今日到期复习行推到明天（与 HDU 复习计划第 119 轮对齐）
  const todayRows = (reviewItems ?? []).filter((item) => item.dueLabel.includes('今日到期'));
  const postponeAllToday = useCallback(async () => {
    const today = localDayKey();
    const tomorrow = addDaysKey(today, 1) ?? today;
    if (todayRows.length === 0) return;
    setPostponingId('__today__');
    let ok = 0;
    for (const item of todayRows) {
      try {
        await callOp('review.reschedule', { jobId: item.jobId, dueDate: tomorrow });
        ok += 1;
      } catch {
        /* 单项失败继续 */
      }
    }
    pushToast(ok === todayRows.length ? `已顺延 ${ok} 条今日到期作业` : `已顺延 ${ok}/${todayRows.length} 条（部分失败）`, ok > 0 ? 'success' : 'error');
    await load();
    setPostponingId(null);
  }, [todayRows, load]);

  /** 待学视频勾选：本地立即灰显 + todo.today.set 持久化到当天（与 HDU 今日待办同一 kv） */
  const toggleVideo = useCallback((key: string) => {
    const next = new Set(doneRef.current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    doneRef.current = next;
    const input = inputRef.current;
    if (input) setPlan(buildTodayPlan({ ...input, doneKeys: [...next] }));
    const date = input?.today ?? localDayKey();
    void callOp('todo.today.set', { date, keys: [...next] }).catch(() => pushToast('待办勾选保存失败', 'error'));
  }, []);

  const videoItems = plan?.sections.find((section) => section.kind === 'video')?.items ?? [];
  const reviewList = reviewItems ?? [];
  const loading = plan === null && !loadFailed;
  // 庆祝态（第 234 轮巡检，对齐 HDU 今日待办卡第 233 轮）：待办全部完成且总数 >0；
  // 加载中 / 失败态 / 空态天然不触发（plan 为 null 或 totalCount 为 0）
  const allDone = plan != null && plan.totalCount > 0 && plan.doneCount === plan.totalCount;

  return (
    <div className="hdu-section hdu-hub-today">
      <SectionHead
        title="今日待办"
        sub="今日到期复习与待学视频；B 站收藏可直跳视频，勾掉一件是一件"
        actions={
          // 完成度徽标（第 79 轮巡检，对齐 HDU 今日待办）：X / Y 已完成，全部完成转玉色；
          // 学习成就角标（第 131 轮巡检）：已解锁徽章数（>0 出现，与总览/统计同口径，置于完成度之后）
          plan && plan.totalCount > 0 ? (
            <>
              <Chip tone={plan.doneCount >= plan.totalCount ? 'jade' : 'info'}>
                {plan.doneCount} / {plan.totalCount} 已完成
              </Chip>
              {/* 逾期独立 danger chip（第 243 轮语义色审计）：风险语义（逾期）此前以
                  后缀藏在完成度 chip 的 info 色里，与「jade=达成、danger=风险」约定不符；
                  拆出后与 HDU 今日待办卡、复习统计条 is-overdue 同语义同色 */}
              {overdueRows.length > 0 ? (
                <Chip tone="danger" title="已逾期未完成的复习作业数；可一键顺延到明天">
                  逾期 {overdueRows.length}
                </Chip>
              ) : null}
              {/* 明日到期预告（第 229 轮巡检）：与 HDU 今日待办卡同口径；第 242 轮起
                  title 交叉指引复习页 7 日到期预测（与预测「明」柱同口径） */}
              {tomorrowCount > 0 ? <Chip icon="calendar" title="明日到期的复习作业数；可在复习页查看 7 日到期预测（同口径）">明日到期 {tomorrowCount}</Chip> : null}
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
      <div className="hdu-card pad">
        {/* 庆祝态（第 234 轮巡检，对齐 HDU 今日待办卡）：全部完成后显示同款 .hdu-celebrate
            庆祝条（B 站面板共用 UI_CSS，直接可用）；次行用明日到期预告（tomorrowCount 与
            HDU 同口径，第 229 轮起本卡已有），取消任一勾选 / 完成一条新待办即消失 */}
        {!loading && !loadFailed && allDone ? (
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Skeleton height={34} />
            <Skeleton height={34} />
            <Skeleton height={34} />
          </div>
        ) : loadFailed ? (
          <EmptyState
            icon="alert"
            title="加载失败"
            text="今日到期复习暂时读取失败，请稍后重试。"
            action={<Button size="small" variant="ghost" icon="refresh" onClick={() => void load()}>重试</Button>}
          />
        ) : (
          <>
            {/* ── 到期复习分区（review.due；完成接 review.complete）── */}
            {reviewList.length === 0 ? (
              <EmptyState
                icon="check"
                title="今日无到期复习"
                text={
                  videoItems.length > 0
                    ? '在知识库把收藏「加入复习计划」后，到期项会按日出现在这里；待学视频见下方分区。'
                    : '在知识库把收藏「加入复习计划」后，到期项会按日出现在这里；待补看课次请到 HDU 学习中心查看。'
                }
              />
            ) : (
              <div className="hdu-todo-rows">
                {/* 逾期全部顺延（第 117 轮巡检）：有逾期行时可一键推到明天（与 HDU 复习计划对齐） */}
                {overdueRows.length > 0 ? (
                  <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'flex-end' }}>
                    <Button
                      size="small"
                      variant="ghost"
                      loading={postponingId === '__all__'}
                      onClick={() => void postponeAllOverdue()}
                    >
                      逾期全部顺延
                    </Button>
                  </div>
                ) : null}
                {/* 今日到期全部顺延（第 122 轮巡检）：有今日到期行时可一键推到明天（对齐 HDU 第 119 轮） */}
                {todayRows.length > 0 ? (
                  <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'flex-end' }}>
                    <Button
                      size="small"
                      variant="ghost"
                      loading={postponingId === '__today__'}
                      onClick={() => void postponeAllToday()}
                    >
                      今日到期全部顺延
                    </Button>
                  </div>
                ) : null}
                {reviewList.map((item) => (
                  <div
                    className={cx('hdu-todo-row', item.dueLabel.includes('已到期') ? 'is-overdue' : '')}
                    key={item.jobId}
                  >
                    <div className="hdu-list-main">
                      <div className="hdu-list-title">{item.title}</div>
                      <div className="hdu-list-sub">
                        {item.typeLabel ? <span>{item.typeLabel}</span> : null}
                        {item.subtitle ? <span>{item.subtitle}</span> : null}
                        <span>{item.dueLabel}</span>
                      </div>
                      {/* 行内顺延浮层（第 248 轮巡检，B 站对齐收官）：与 HDU 复习计划第 244 轮
                          同结构同类名（.hdu-resched-pop，UI_CSS 双端同份样式）——快捷 chips
                          点选即改期；「其他日期…」完整弹层不引入（精简卡差异，见面板 foot） */}
                      {reschedJobId === item.jobId ? (
                        <div className="hdu-resched-pop" role="group" aria-label={`顺延「${item.title}」到指定日`}>
                          <div className="hdu-resched-pop-head">
                            <span className="hdu-resched-pop-title">顺延到指定日</span>
                            <button
                              type="button"
                              className="hdu-resched-pop-close"
                              aria-label="收起顺延选项"
                              title="收起"
                              onClick={() => setReschedJobId(null)}
                            >
                              ×
                            </button>
                          </div>
                          <RescheduleOptionChips
                            options={rescheduleOptions}
                            selectedDate=""
                            ariaLabelPrefix="顺延快捷日期"
                            disabled={postponingId === item.jobId}
                            onPick={(opt) => void rescheduleTo(item.jobId, opt)}
                          />
                          <div className="hdu-resched-pop-foot">
                            <span className="hdu-hint">目标日期不早于今日；选今天等于保持不变</span>
                          </div>
                        </div>
                      ) : null}
                    </div>
                    <div className="hdu-list-side" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {/* B 站收藏：直跳视频页（?t= 锚点 / ?p= 分 P 已在解析时拼好）；
                          HDU 站内 / 已删除：无链接，仅展示条目 */}
                      {item.url ? (
                        <a
                          className="hdu-btn ghost small"
                          href={item.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={`去复习：${item.title}`}
                        >
                          去复习 <Icon name="external" size={12} />
                        </a>
                      ) : null}
                      {/* 顺延（第 108 轮巡检）：仅逾期行露出，review.reschedule 推一天 */}
                      {item.dueLabel.includes('已到期') ? (
                        <Button
                          size="small"
                          variant="ghost"
                          disabled={postponingId === item.jobId}
                          onClick={() => void postpone(item.jobId, item.subtitle ?? '')}
                        >
                          顺延
                        </Button>
                      ) : null}
                      {/* 顺延到指定日（第 248 轮巡检，B 站对齐收官）：对齐 HDU 复习计划第 244 轮
                          「改期」入口——展开行内快捷 chips 浮层（aria-expanded 状态声明，
                          同 HDU 侧第 231 轮先例）；仅逾期行露出（今日到期行以完成为主） */}
                      {item.dueLabel.includes('已到期') ? (
                        <Button
                          size="small"
                          variant="ghost"
                          disabled={postponingId === item.jobId}
                          aria-expanded={reschedJobId === item.jobId}
                          title="顺延到指定日"
                          onClick={() => setReschedJobId((prev) => (prev === item.jobId ? null : item.jobId))}
                        >
                          改期
                        </Button>
                      ) : null}
                      <Button
                        size="small"
                        icon="check"
                        loading={completingId === item.jobId}
                        onClick={() => void handleComplete(item.jobId)}
                      >
                        完成
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* ── 待学视频分区（第 78 轮巡检并入：未完看 B 站视频收藏 + 每周计划今日批次排前；
                勾选走 todo.today kv，与 HDU 今日待办同源）── */}
            {videoItems.length > 0 ? (
              <div style={{ marginTop: reviewList.length > 0 ? 14 : 0 }}>
                <div className="hdu-todo-head">
                  待学视频
                  <span className="hdu-todo-count">待办 {videoItems.filter((item) => !item.done).length}</span>
                </div>
                <div className="hdu-todo-rows">
                  {videoItems.map((item) => (
                    <div className={cx('hdu-todo-row', item.done ? 'is-done' : '')} key={item.key}>
                      <input
                        type="checkbox"
                        className="hdu-todo-check"
                        checked={item.done}
                        onChange={() => toggleVideo(item.key)}
                        aria-label={item.done ? `取消完成：${item.title}` : `标记完成：${item.title}`}
                      />
                      <div className="hdu-list-main">
                        <div className="hdu-list-title">{item.title}</div>
                        <div className="hdu-list-sub">
                          {item.subtitle ? <span>{item.subtitle}</span> : null}
                          {item.dueLabel ? <span>{item.dueLabel}</span> : null}
                        </div>
                      </div>
                      <div className="hdu-list-side">
                        {item.action.type === 'url' ? (
                          <a
                            className="hdu-btn ghost small"
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}
                            href={item.action.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={`去学习：${item.title}`}
                          >
                            {item.action.label ?? '续看'} <Icon name="external" size={12} />
                          </a>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
