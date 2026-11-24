/**
 * 看课页「本课学习小条」（第 241 轮巡检，情境感知视角）：
 * 挂在 PlayPanel 头部与页签栏之间的可折叠小条——收起态一行摘要
 * （本课今日已学 · 本课累计），点击展开细节与本课待办提示。
 *
 * 数据口径（全部走现有 op，不新增）：
 *  - 本课累计：uiStore.watchedSec（playerSync 每 30s 经 stats.sessionSummary 刷新，
 *    按 watchRecords.valid 汇总，与报表同口径）；
 *  - 本课今日已学：stats.records（今日窗口）按 courId 过滤 valid 合计，
 *    聚合走 core/stats/lessonToday.sumLessonValidSec 纯函数；挂载即拉 + 60s 低频
 *    轮询（看课中数字会增长，失败静默保持现值）；
 *  - 本课待办：review.due（今日）按 favorite.courId 过滤计数；>0 显示 danger 行
 *    （点击复用 actions.openCenter('review') 跳复习视图），=0 显示 jade 行；
 *  - 本课笔记（第 243 轮巡检，情境延续视角）：note.listAll 单独一路按 courId 过滤
 *    （存活口径与 buildNoteStats 同源：deletedAt 为空），N>0 显示「本课笔记 N 条」
 *    可点跳知识库我的笔记分区（openCenter('library')），行尾附「最近一条 X」
 *    （favoritedAgoLabel 相对时间分桶，第 241 轮抽共享到 core/shared/relativeTime）；
 *    N=0 显示「记一条笔记」弱化轻入口（虚线 + 半透明）；取数失败静默隐藏该行
 *    （成功后失败保持现值，与今日已学同策略），不影响主条。
 *
 * 不干扰播放器：默认收起为一行；courId 未识别（resolution.phase 未 resolved）
 * 时整条不渲染——识别完成由 store patch 自动浮现。
 */

import { useEffect, useState } from 'react';
import { callOp } from '@/core/shared/client';
import { formatDuration, localDayKey } from '@/core/shared/utils';
import { favoritedAgoLabel } from '@/core/shared/relativeTime';
import { sumLessonValidSec } from '@/core/stats/lessonToday';
import { uiStore, useUiStore } from '../store';
import { cx } from '../components';
import { Icon } from '../icons';

/** 复习待办低频轮询间隔：与 Dock 到期徽标同量级（5 分钟内够用，这里取 60s
 *  只因今日已学数字也随该次重取一起刷新） */
const REFRESH_INTERVAL_MS = 60_000;

/** 本课笔记行的展示状态：条数 + 最近一条的相对时间标签（空串 = 不附） */
interface LessonNoteStat {
  count: number;
  lastLabel: string;
}

/** note.listAll 结果按 courId 过滤出本课存活笔记（口径与 buildNoteStats 同源：
 *  deletedAt 为空；note.listAll 内部 isLive 过滤，这里对脏字段再防御一层） */
function summarizeLessonNotes(notes: unknown, courId: number): LessonNoteStat | null {
  if (!Array.isArray(notes)) return null;
  let count = 0;
  let lastUpdatedAt = 0;
  for (const note of notes) {
    if (!note || typeof note !== 'object') continue;
    const rec = note as { courId?: unknown; updatedAt?: unknown; deletedAt?: unknown };
    if (rec.courId !== courId) continue; // B 站外部笔记无 courId，天然不匹配
    if (rec.deletedAt != null) continue;
    count += 1;
    const updatedAt = typeof rec.updatedAt === 'number' && Number.isFinite(rec.updatedAt) ? rec.updatedAt : 0;
    if (updatedAt > lastUpdatedAt) lastUpdatedAt = updatedAt;
  }
  return { count, lastLabel: lastUpdatedAt > 0 ? favoritedAgoLabel(lastUpdatedAt) : '' };
}

export function LessonStudyStrip() {
  const state = useUiStore();
  const actions = uiStore.actions;
  const courId = state.resolution.courId;
  const [expanded, setExpanded] = useState(false);
  // null = 尚未取到（显示骨架态文案「统计中」），取到后为秒数；失败保持现值
  const [todaySec, setTodaySec] = useState<number | null>(null);
  const [dueCount, setDueCount] = useState(0);
  // null = 未取到 / 取数失败（笔记行隐藏）；取到后为 {count, lastLabel}
  const [noteStat, setNoteStat] = useState<LessonNoteStat | null>(null);

  // 数据拉取（courId 变化即重拉；stats.records 只取今日窗口，review.due 只取今日到期）
  useEffect(() => {
    if (courId == null) return;
    let cancelled = false;
    const load = () => {
      const today = localDayKey();
      // Promise.resolve 包一层：callOp 万一被桩替身返回非 Promise（如未覆盖该 op 的
      // 旧测试桩返回 undefined）也不至于抛 TypeError，聚合函数对 undefined 已防御
      Promise.resolve(callOp('stats.records', { fromDay: today, toDay: today }))
        .then((records) => {
          if (!cancelled) setTodaySec(sumLessonValidSec(records, courId));
        })
        .catch(() => undefined);
      Promise.resolve(callOp('review.due', { date: today }))
        .then((jobs) => {
          if (cancelled) return;
          const count = Array.isArray(jobs)
            ? jobs.filter((job) => job?.favorite?.courId === courId).length
            : 0;
          setDueCount(count);
        })
        .catch(() => undefined);
      // 本课笔记（第 243 轮巡检）：单独一路 note.listAll，失败静默隐藏该行
      // （首取失败保持 null = 不渲染；成功后失败保持现值，与今日已学同策略）
      Promise.resolve(callOp('note.listAll', {}))
        .then((notes) => {
          if (!cancelled) setNoteStat(summarizeLessonNotes(notes, courId));
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [courId]);

  // 课程页无法取到 courId 时整条不渲染（第 241 轮巡检约定）
  if (courId == null) return null;

  const dueLine = dueCount > 0 ? `本课今日有 ${dueCount} 项复习到期` : '本课今日无到期复习';
  const noteLine =
    noteStat != null
      ? noteStat.count > 0
        ? `本课笔记 ${noteStat.count} 条${noteStat.lastLabel ? ` · 最近一条 ${noteStat.lastLabel}` : ''}`
        : '本课暂无笔记，记一条'
      : '';
  return (
    <div className={cx('hdu-lesson-strip', expanded ? 'is-expanded' : '')}>
      <button
        type="button"
        className="hdu-lesson-strip-head"
        aria-expanded={expanded}
        aria-label={expanded ? '收起本课学习小条' : '展开本课学习小条'}
        title={expanded ? '收起' : '本课学习小条'}
        onClick={() => setExpanded((v) => !v)}
      >
        <Icon name={expanded ? 'chevronDown' : 'clock'} size={12} />
        <span className="hdu-lesson-strip-summary">
          今日已学 <b className="hdu-num">{todaySec == null ? '统计中' : formatDuration(todaySec)}</b>
          <span className="hdu-lesson-strip-sep">·</span>
          本课累计 <b className="hdu-num">{formatDuration(state.watchedSec)}</b>
        </span>
        {!expanded && dueCount > 0 ? (
          <span className="hdu-lesson-strip-badge" aria-label={dueLine}>
            待办 {dueCount}
          </span>
        ) : null}
        {!expanded ? <Icon name="chevronDown" size={11} /> : null}
      </button>
      {expanded ? (
        <div className="hdu-lesson-strip-body">
          <div className="hdu-lesson-strip-row">
            <span className="hdu-lesson-strip-label">本课今日已学</span>
            <span className="hdu-lesson-strip-value hdu-num">
              {todaySec == null ? '统计中' : formatDuration(todaySec)}
            </span>
          </div>
          <div className="hdu-lesson-strip-row">
            <span className="hdu-lesson-strip-label">本课累计有效时长</span>
            <span className="hdu-lesson-strip-value hdu-num">{formatDuration(state.watchedSec)}</span>
          </div>
          {dueCount > 0 ? (
            <button
              type="button"
              className="hdu-lesson-todo is-danger"
              onClick={() => actions.openCenter('review')}
              title="跳转到复习计划"
            >
              <Icon name="alert" size={12} />
              {dueLine}
              <span className="hdu-lesson-todo-action">去复习 ›</span>
            </button>
          ) : (
            <div className="hdu-lesson-todo is-jade">
              <Icon name="check" size={12} />
              {dueLine}
            </div>
          )}
          {noteStat != null && noteStat.count > 0 ? (
            <button
              type="button"
              className="hdu-lesson-todo hdu-lesson-note is-info"
              onClick={() => actions.openCenter('library')}
              title="跳转到知识库我的笔记"
            >
              <Icon name="note" size={12} />
              {noteLine}
              <span className="hdu-lesson-todo-action">查看 ›</span>
            </button>
          ) : noteStat != null ? (
            <button
              type="button"
              className="hdu-lesson-todo hdu-lesson-note is-empty"
              onClick={() => actions.openCenter('library')}
              title="跳转到知识库记笔记"
            >
              <Icon name="note" size={12} />
              {noteLine}
              <span className="hdu-lesson-todo-action">去记 ›</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
