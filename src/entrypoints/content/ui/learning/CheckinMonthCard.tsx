/**
 * 打卡月历卡（第 234 轮巡检）：HDU 学习中心统计页挂载，紧邻学习热力图。
 *
 * 与热力图的定位差异（避免重复感）：ActivityHeatmap 看窗口内的强度趋势
 * （站内 + 站外合并、四分位分档），本卡看「哪些天达成了打卡」——逐月月历，
 * 达标日（当日站内有效学习 ≥ 打卡线，与 hitDaysThisWeek 同线）玉色打勾，
 * 有学习未达标淡色显示时长，无学习留空；今日描边高亮。
 *
 *  - 数据：复用既有 stats.report op（days=400 覆盖 12 个月回看窗口），取
 *    report.days 的 { date, validSec } 行喂 buildCheckinMonthGrid 纯函数
 *    （core/stats/checkinMonth），不新增 op；打卡线复用 aggregate.CHECKIN_MIN_SEC；
 *  - 当日明细下钻（第 236 轮，可用性 / 一致性视角）：有学习的非空格（is-hit 或
 *    is-partial）变为可点击 button——点击弹当日学习明细，复用热力图同款
 *    DayDetailModal（stats.dayDetail op，第 236 轮自 ActivityHeatmap 提为共享
 *    组件）；is-out 补位格与未来格不可点；格子带 aria-label（「N 月 N 日学习
 *    X 分钟，已打卡」），Enter / Space 原生可触发，focus-visible 描边可达；
 *  - 导航：‹ 上一月 / 下一月 ›，不越界到未来月，回看不超过 12 个月（与数据窗口一致）；
 *  - 失败可重试（attempt 递增走同一 effect，照 ActivityHeatmap 模式）；
 *  - 样式复用 .hdu-month-weekdays 月历家族 + 新增 .hdu-checkin-*（UI_CSS 第 234 轮块，
 *    可点击态第 236 轮块），暗色主题由既有 --* 变量整组跟随。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { callOp } from '@/core/shared/client';
import { CHECKIN_MIN_SEC } from '@/core/stats/aggregate';
import { buildCheckinMonthGrid, type CheckinMonthCell, type CheckinMonthGrid } from '@/core/stats/checkinMonth';
import { clampDailyGoalMin } from '@/core/plan/dailyGoal';
import { formatDuration, localDayKey } from '@/core/shared/utils';
import { Button, EmptyState, SectionHead, Skeleton, cx } from '../components';
import { useUiStore } from '../store';
import { DayDetailModal } from './DayDetailModal';

/** 月历可回看月数（与数据窗口匹配，防止导航进无数据月份） */
const MAX_BACK_MONTHS = 12;

/** stats.report 取数窗口天数：12 个月回看 + 当月余量 + 缓冲 */
const REPORT_DAYS = 400;

/** 'YYYY-MM' 日键片段 */
type MonthKey = string;

function monthKeyOf(year: number, month: number): MonthKey {
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** 'YYYY-MM' → { year, month }；非法返回 null */
function parseMonthKey(key: string): { year: number; month: number } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  if (!match) return null;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return { year: Number(match[1]), month };
}

/** 'YYYY-MM' ± delta 个月（delta 可负），越界（年 < 1970）返回 null */
function shiftMonth(key: string, delta: number): MonthKey | null {
  const parsed = parseMonthKey(key);
  if (!parsed) return null;
  const total = parsed.year * 12 + (parsed.month - 1) + delta;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  if (year < 1970) return null;
  return monthKeyOf(year, month);
}

/** 格是否可下钻当日明细（第 236 轮）：目标月内、非未来日且当日有学习（is-hit 或 is-partial）；
 *  is-out 补位格与未来格不可点（无学习 / 未到期，无明细可看） */
function cellClickable(cell: CheckinMonthCell): boolean {
  return cell.inMonth && !cell.isFuture && (cell.hit || cell.sec > 0);
}

/** 可点格 aria-label：「N 月 N 日学习 X 分钟，已打卡 / 未达标」（仅供有学习的格子） */
function cellAriaLabel(cell: CheckinMonthCell): string {
  const month = Number(cell.key.slice(5, 7));
  const day = Number(cell.key.slice(8, 10));
  return `${month} 月 ${day} 日学习 ${Math.round(cell.sec / 60)} 分钟，${cell.hit ? '已打卡' : '未达标'}`;
}

export function CheckinMonthCard() {
  const [days, setDays] = useState<Array<{ date: string; validSec: number }> | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  // 当前浏览月份（'YYYY-MM'；默认当前月，不持久化——月历是即时查阅视图）
  const [monthKey, setMonthKey] = useState<MonthKey>(() => localDayKey().slice(0, 7));
  // 当日明细弹层（第 236 轮）：点击可点格 → 共享 DayDetailModal（stats.dayDetail 同款数据流）
  const [detailDate, setDetailDate] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    callOp('stats.report', { days: REPORT_DAYS })
      .then((report) => {
        if (cancelled) return;
        const rows = Array.isArray(report?.days) ? report.days : [];
        setDays(
          rows
            .filter((row) => typeof row?.date === 'string' && Number.isFinite(row?.validSec))
            .map((row) => ({ date: row.date, validSec: Math.max(0, row.validSec) })),
        );
      })
      .catch(() => {
        if (!cancelled) setDays(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const todayKey = localDayKey();
  const currentMonthKey = todayKey.slice(0, 7);
  // 每日目标线（第 261 轮，目标域 / 双口径延伸）：月历格在打卡 ✓ 之外叠加「目标达成」
  // 金色描边层——设置未就绪时 clamp 回退默认 30 分钟
  const settings = useUiStore().settings;
  const dailyGoalMin = clampDailyGoalMin(settings?.dailyGoalMin);
  // 回看下界：当前月回退 MAX_BACK_MONTHS 个月（shiftMonth 对越界返回 null 即到底）
  const earliestMonthKey = useMemo(() => shiftMonth(currentMonthKey, -MAX_BACK_MONTHS) ?? currentMonthKey, [currentMonthKey]);

  const grid: CheckinMonthGrid | null = useMemo(() => {
    const parsed = parseMonthKey(monthKey);
    if (!parsed) return null;
    return buildCheckinMonthGrid(days ?? [], parsed.year, parsed.month, CHECKIN_MIN_SEC, todayKey, dailyGoalMin);
  }, [days, monthKey, todayKey, dailyGoalMin]);

  const navPrev = useCallback(() => {
    setMonthKey((prev) => shiftMonth(prev, -1) ?? prev);
  }, []);
  const navNext = useCallback(() => {
    // 不越界到未来月：下一月超出当前月时保持不动
    setMonthKey((prev) => {
      const next = shiftMonth(prev, 1);
      return next && next <= currentMonthKey ? next : prev;
    });
  }, [currentMonthKey]);

  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  const failed = !loading && days === null;
  const atEarliest = monthKey <= earliestMonthKey;
  const atLatest = monthKey >= currentMonthKey;

  // 达标率（X>0 才显示；分母 = 本月已过天数）
  const rateLabel =
    grid && grid.hitDays > 0 && grid.elapsedDays > 0 ? `${Math.round((grid.hitDays / grid.elapsedDays) * 100)}%` : null;
  // 目标达成率（第 265 轮，目标域 / 双口径延伸）：金色徽标与打卡达标率并排——
  // 分母同为本月已过天数，分子为 goalHitDays（每日目标线口径）
  const goalRateLabel =
    grid && grid.goalHitDays > 0 && grid.elapsedDays > 0 ? `${Math.round((grid.goalHitDays / grid.elapsedDays) * 100)}%` : null;

  return (
    <div className="hdu-section hdu-checkin-wrap">
      <SectionHead
        title="打卡月历"
        sub={`逐月查看哪些天达成了打卡（当日有效学习 ≥ ${Math.round(CHECKIN_MIN_SEC / 60)} 分钟，站内口径）`}
        actions={
          <span className="hdu-month-nav" style={{ gap: 8 }}>
            <button type="button" className="hdu-folder" onClick={navPrev} disabled={atEarliest} aria-label="上一月">
              ‹
            </button>
            <span className="hdu-month-label">{grid?.label ?? monthKey}</span>
            <button type="button" className="hdu-folder" onClick={navNext} disabled={atLatest} aria-label="下一月">
              ›
            </button>
          </span>
        }
      />
      <div className="hdu-card pad">
        {loading ? (
          <>
            <Skeleton height={16} width="40%" />
            <div style={{ height: 14 }} />
            <Skeleton height={180} />
          </>
        ) : failed || !grid ? (
          <EmptyState
            icon="calendar"
            title="打卡月历暂不可用"
            text="稍后重试；打卡记录来自本机流水，不上报。"
            action={<Button size="small" variant="ghost" icon="refresh" onClick={retry}>重试</Button>}
          />
        ) : (
          <>
            {/* 头部摘要：本月打卡 X 天 · 达标率 Y%（X>0 才显示达标率，分母=本月已过天数） */}
            <div className="hdu-checkin-summary">
              <span>
                本月打卡 <b>{grid.hitDays}</b> 天
              </span>
              {/* 目标达标天数（第 263 轮，目标域 / 双口径延伸）：与打卡天数并列的第二口径
                  摘要（goalHitDays，见 checkinMonth.ts）——金框格的月度汇总 */}
              <span>
                目标达标 <b>{grid.goalHitDays}</b> 天
              </span>
              {rateLabel ? <span className="hdu-checkin-rate">达标率 {rateLabel}</span> : null}
              {/* 目标达成率徽标（第 265 轮）：金色变体与打卡达标率（jade）并排——双口径的率级汇总 */}
              {goalRateLabel ? (
                <span className="hdu-checkin-rate is-goal">目标达成率 {goalRateLabel}</span>
              ) : null}
              {grid.totalSec > 0 ? <span className="hdu-checkin-total">累计有效 {formatDuration(grid.totalSec)}</span> : null}
            </div>
            <div className="hdu-month-weekdays" aria-hidden="true">
              {['一', '二', '三', '四', '五', '六', '日'].map((d) => (
                <span key={d}>{d}</span>
              ))}
            </div>
            {/* 月历格（第 236 轮起统一 button 语义）：有学习的格子加 is-clickable +
                aria-label + onClick（Enter/Space 原生触发）；补位 / 未来 / 无学习格
                disabled（不可聚焦不可点，视觉由既有 is-out / is-future / 留白保持）。
                容器不再用 role="img"——img 语义会把内部 button 对读屏隐藏，月份摘要由
                上方 summary 行与可点格 aria-label 承担 */}
            <div className="hdu-checkin-grid" aria-label={`${grid.label}打卡月历`}>
              {grid.weeks.flat().map((cell) => {
                const clickable = cellClickable(cell);
                const title = `${cell.key.slice(5).replace('-', '/')} · ${cell.sec > 0 ? formatDuration(cell.sec) : '无学习'}`;
                return (
                  <button
                    key={cell.key}
                    type="button"
                    disabled={!clickable}
                    className={cx(
                      'hdu-checkin-cell',
                      cell.inMonth ? '' : 'is-out',
                      cell.isFuture ? 'is-future' : '',
                      cell.isToday ? 'is-today' : '',
                      cell.hit ? 'is-hit' : cell.sec > 0 ? 'is-partial' : '',
                      // 目标线层（第 261 轮）：达成每日目标的格叠加金色内描边（与打卡 ✓
                      // jade 底叠加可同格并存——打卡回答「学没学」，目标线回答「够不够」）
                      cell.goalHit ? 'is-goal' : '',
                      clickable ? 'is-clickable' : '',
                    )}
                    title={title}
                    aria-label={clickable ? cellAriaLabel(cell) : undefined}
                    onClick={clickable ? () => setDetailDate(cell.key) : undefined}
                    tabIndex={clickable ? undefined : -1}
                  >
                    <span className="hdu-checkin-day">{cell.dayLabel}</span>
                    {cell.hit ? (
                      <span className="hdu-checkin-mark">
                        ✓ <span className="hdu-checkin-sec">{formatDuration(cell.sec)}</span>
                      </span>
                    ) : cell.sec > 0 ? (
                      <span className="hdu-checkin-sec">{formatDuration(cell.sec)}</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
            <div className="hdu-checkin-legend">
              <span>
                <i className="is-hit" /> 达标打卡
              </span>
              <span>
                <i className="is-partial" /> 有学习未达标
              </span>
              {/* 目标线图例（第 261 轮，目标域 / 双口径延伸）：金框 = 当日有效学习达到
                  每日目标（settings.dailyGoalMin，clamp 兜底）——与打卡线并列的第二口径 */}
              <span>
                <i className="is-goal" /> 目标达成（≥ {dailyGoalMin} 分钟）
              </span>
              <span>热力图看趋势强度，月历看哪些天打了卡；点有学习的格子看当日明细</span>
            </div>
            {/* 卡面口径标注（第 239 轮巡检，分布卡口径统一）：打卡判定线复用
                aggregate.CHECKIN_MIN_SEC（与总览「本周打卡」hitDaysThisWeek 同线），
                第 234 轮副标题注明过，本轮补统一「口径」徽标句式；互补指引已在
                图例行承担（每卡最多一句，不另起行） */}
            <div className="hdu-hint hdu-caliber-hint" style={{ marginTop: 10 }}>
              <span className="hdu-caliber-tag">口径</span>
              站内有效时长 · 当月逐日 · 打卡线（≥ {Math.round(CHECKIN_MIN_SEC / 60)} 分钟）与总览一致；金框 = 每日目标线（≥ {dailyGoalMin} 分钟，第 261 轮起叠加）
            </div>
          </>
        )}
      </div>

      {/* 当日明细弹层（第 236 轮）：复用热力图同款共享 DayDetailModal（stats.dayDetail
          数据流同源）；明细行「回看」走缺省 uiStore 站内课次跳转 */}
      <DayDetailModal date={detailDate} onClose={() => setDetailDate(null)} />
    </div>
  );
}
