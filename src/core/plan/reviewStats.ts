/**
 * 复习统计摘要（第 247 轮巡检，复习域收官 / 信息视角）：
 * 从全量复习作业（review.list op 返回，status/updatedAt 可得）推导四项 mini 指标，
 * 供 ReviewView 头部「复习统计」摘要行渲染：
 *  - 累计完成次数：当前 status='done' 的作业计数。留存口径探查结论：completeReview
 *    只改 status/updatedAt 不删行（db.getAll 全量返回），done 作业长期留存，撤销
 *    完成（review.reopen）会把 done 回退 pending——所以本口径是「当前仍在完成态的
 *    作业数」，与 ReviewView 已完成分区头部计数完全一致；
 *  - 本周完成：done 且 updatedAt ≥ 本周一 00:00（本地周界，startOfLocalWeek 既有
 *    惯例，与周报 / 近 12 周柱图同口径）。updatedAt 即完成时刻（completeReview 落
 *    Date.now()），改期等其他写路径也会刷新 updatedAt 但只有 done 才计入，偏差可忽略；
 *  - 跳过率：skipped / (done + skipped)，0–100 取整；分母为 0（无任何完成/跳过记录）
 *    返回 null，调用方不渲染该格（除零防御）；
 *  - 连续完成天数：done updatedAt 的本地日键集合回放，复用 computeStudyStreak
 *    （第 125 轮 streak 口径：今天未完成从昨天起算，不因跨日未学而提前断档）。
 * 纯函数、防御式：jobs 非数组 / 条目非对象 / updatedAt 缺失或非法（NaN、字符串、
 * Infinity）逐条跳过不抛错；status 其他取值（脏数据）不计入任何指标。
 */
import { localDayKey, startOfLocalWeek } from '@/core/shared/utils';
import { computeStudyStreak } from './streak';

/** 复习统计摘要（四 mini 指标 + 空态标记） */
export interface ReviewStats {
  /** 累计完成次数（当前 done 作业数；撤销完成会回退，与已完成分区头部计数同口径） */
  totalDone: number;
  /** 本周完成次数（done 且 updatedAt ≥ 本周一 00:00，startOfLocalWeek 本地周界） */
  weekDone: number;
  /** 跳过率 skipped/(done+skipped) 的百分数（0–100 取整）；无完成/跳过记录时 null */
  skipRate: number | null;
  /** 连续完成天数（done updatedAt 日键回放，computeStudyStreak 同口径） */
  streakDays: number;
  /** 是否有任何完成/跳过记录（false 时 UI 渲染轻量空态文案） */
  hasRecords: boolean;
}

export function buildReviewStats(jobs: unknown, now: number | Date = Date.now()): ReviewStats {
  const list = Array.isArray(jobs) ? jobs : [];
  let totalDone = 0;
  let totalSkipped = 0;
  let weekDone = 0;
  const doneDays = new Set<string>();
  const nowTs = now instanceof Date ? now.getTime() : now;
  const weekStartTs = startOfLocalWeek(nowTs);
  const todayKey = localDayKey(nowTs);
  for (const job of list) {
    if (!job || typeof job !== 'object') continue;
    const status = (job as { status?: unknown }).status;
    const rawUpdatedAt = (job as { updatedAt?: unknown }).updatedAt;
    // updatedAt 只接受有限数值（毫秒时间戳）；缺失 / NaN / 字符串 / Infinity 一律跳过
    const updatedAt = typeof rawUpdatedAt === 'number' && Number.isFinite(rawUpdatedAt) ? rawUpdatedAt : null;
    if (status === 'done') {
      totalDone += 1;
      if (updatedAt != null) {
        if (updatedAt >= weekStartTs) weekDone += 1;
        doneDays.add(localDayKey(updatedAt));
      }
    } else if (status === 'skipped') {
      totalSkipped += 1;
    }
  }
  const denominator = totalDone + totalSkipped;
  const skipRate = denominator > 0 ? Math.round((totalSkipped / denominator) * 100) : null;
  const { current } = computeStudyStreak([...doneDays], todayKey);
  return { totalDone, weekDone, skipRate, streakDays: current, hasRecords: denominator > 0 };
}
