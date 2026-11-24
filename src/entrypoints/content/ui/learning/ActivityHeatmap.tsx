/**
 * 学习热力图卡（第 77 轮巡检）：HDU 学习中心统计页与 B 站学习中心统计页签共用
 * 同一实现（与 PeriodReportCard 同模式）。
 *
 *  - 数据经 stats.heatmap / stats.heatmapMonthly op 现取（不含任何 HDU 会话参数，
 *    天然双端可用；聚合口径见 core/stats/heatmap 纯函数：站内 valid 流水 + 站外
 *    externalWatch 按本地自然日合并，周界 = 本地周一，档位 = 有学习日四分位）；
 *  - 周视图（第 77 轮）：「周列 × 7 行」日格；月视图（第 81 轮）：「月列 × 当月
 *    天数」日格（近 12 个月，缺日补位隐藏）；格子颜色按 data-level 0–4 分档，
 *    今天描边高亮，未来日透明占位；title 提供逐格 tooltip（MM-DD · 时长）；
 *  - 失败可重试（重试走同一 effect，序号 attempt 递增）；空数据仍渲染网格 +
 *    引导提示，不空转；
 *  - 当日明细弹层（第 79/80 轮）：第 236 轮起取数与 Modal 提为共享组件
 *    DayDetailModal（./DayDetailModal），打卡月历卡共用同一入口，本卡行为与
 *    DOM 结构不变（e2e 下钻断言兼容）；
 *  - 样式为新增 .hdu-heatmap-*（UI_CSS），随所在 shadow root 注入，暗色主题由
 *    既有 --* 变量整组跟随。
 */

import { useCallback, useEffect, useState } from 'react';
import { callOp } from '@/core/shared/client';
import type {
  ActivityHeatmapData,
  HeatmapDayCell,
  HeatmapLevel,
  MonthlyHeatmapData,
} from '@/core/stats/heatmap';
import { HEATMAP_DEFAULT_WEEKS, MONTHLY_HEATMAP_DEFAULT_MONTHS } from '@/core/stats/heatmap';
import { formatDuration, shortDayLabel } from '@/core/shared/utils';
import { Button, cx, EmptyState, PillTabs, SectionHead, Skeleton } from '../components';
import { uiStore } from '../store';
import { DayDetailModal } from './DayDetailModal';

/** 图例的 5 档色阶（0–4） */
const LEGEND_LEVELS: HeatmapLevel[] = [0, 1, 2, 3, 4];

/** 周数切换项（PillTabs 字符串键 → 传给 op 的周数；第 78 轮巡检） */
const WEEK_OPTIONS: Array<{ value: '13' | '26' | '52'; label: string; weeks: number }> = [
  { value: '13', label: '近 13 周', weeks: 13 },
  { value: '26', label: '近 26 周', weeks: 26 },
  { value: '52', label: '近 52 周', weeks: 52 },
];

/** 视图模式切换项（第 81 轮巡检） */
const MODE_OPTIONS: Array<{ value: 'week' | 'month'; label: string }> = [
  { value: 'week', label: '周视图' },
  { value: 'month', label: '月视图' },
];

/** 月视图列数（近 12 个月；grid 31 行对齐当月天数，缺日补位隐藏） */
const MONTHLY_ROWS = 31;

/** 月数切换项（第 100 轮巡检） */
const MONTH_OPTIONS: Array<{ value: '6' | '12' | '24'; label: string; months: number }> = [
  { value: '6', label: '近 6 个月', months: 6 },
  { value: '12', label: '近 12 个月', months: 12 },
  { value: '24', label: '近 24 个月', months: 24 },
];

/** 逐格 tooltip：MM-DD · 时长（无学习日如实标注） */
function cellTitle(cell: HeatmapDayCell): string {
  const label = shortDayLabel(cell.date);
  return cell.sec > 0 ? `${label} · ${formatDuration(cell.sec)}` : `${label} · 无学习`;
}

/** 月份标签：本周列的周一月份与上列不同时标注（首列不标，避免半窗误导） */
function monthLabelFor(weeks: ActivityHeatmapData['weeks'], index: number): string | null {
  if (index <= 0) return null;
  const current = weeks[index]?.startDay.slice(5, 7);
  const previous = weeks[index - 1]?.startDay.slice(5, 7);
  if (!current || !previous || current === previous) return null;
  return `${Number(current)}月`;
}

/** 单元格通用渲染（周/月视图共用：档位、今天描边、未来占位、点击看当日明细） */
function HeatCell({ cell, onPick }: { cell: HeatmapDayCell; onPick: (date: string) => void }) {
  return (
    <span
      className={cx(
        'hdu-heatmap-cell',
        cell.isToday ? 'is-today' : '',
        cell.isFuture ? 'is-future' : '',
        !cell.isFuture ? 'is-clickable' : '',
      )}
      data-level={cell.level}
      title={cellTitle(cell)}
      onClick={cell.isFuture ? undefined : () => onPick(cell.date)}
    />
  );
}

export function ActivityHeatmap({
  weeks: weeksProp = HEATMAP_DEFAULT_WEEKS,
  onOpenCourse,
}: {
  weeks?: number;
  /** 明细行「回看」跳转覆写（第 80 轮巡检）：B 站学习中心宿主传新标签深链；缺省走 uiStore 站内跳转 */
  onOpenCourse?: (courId: number, teclId?: number) => void;
} = {}) {
  const [data, setData] = useState<ActivityHeatmapData | null>(null);
  const [monthData, setMonthData] = useState<MonthlyHeatmapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [monthLoading, setMonthLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // 窗口周数（第 78 轮巡检：近 13/26/52 周切换；缺省 26）；第 141 轮起选择持久化
  const [weekOption, setWeekOptionState] = useState<string>(() => {
    const stored = uiStore.getState().settings.ui?.heatmapWeekOption;
    return stored === '13' || stored === '26' || stored === '52' ? stored : String(weeksProp);
  });
  const setWeekOption = useCallback((value: string) => {
    setWeekOptionState(value);
    const settings = uiStore.getState().settings;
    const ui = { ...settings.ui, heatmapWeekOption: value };
    uiStore.patch({ settings: { ...settings, ui } });
    void uiStore.actions.saveSetting('ui', ui);
  }, []);
  const weeks = Number(weekOption) || weeksProp;
  // 视图模式（第 81 轮巡检：周视图 / 月视图）
  const [mode, setMode] = useState<'week' | 'month'>('week');
  // 月数（第 100 轮巡检：近 6/12/24 个月切换；缺省 12）；第 141 轮起选择持久化
  const [monthOption, setMonthOptionState] = useState<string>(() => {
    const stored = uiStore.getState().settings.ui?.heatmapMonthOption;
    return stored === '6' || stored === '12' || stored === '24' ? stored : String(MONTHLY_HEATMAP_DEFAULT_MONTHS);
  });
  const setMonthOption = useCallback((value: string) => {
    setMonthOptionState(value);
    const settings = uiStore.getState().settings;
    const ui = { ...settings.ui, heatmapMonthOption: value };
    uiStore.patch({ settings: { ...settings, ui } });
    void uiStore.actions.saveSetting('ui', ui);
  }, []);
  const months = Number(monthOption) || MONTHLY_HEATMAP_DEFAULT_MONTHS;
  // 单日明细弹层（第 79 轮巡检）：点击格子 → stats.dayDetail 拉当日流水；
  // 第 236 轮起取数与 Modal 渲染提为共享组件 DayDetailModal（月历卡同款入口）
  const [detailDate, setDetailDate] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== 'week') return undefined;
    let cancelled = false;
    setLoading(true);
    callOp('stats.heatmap', { weeks })
      .then((result) => {
        if (!cancelled) {
          setData(result);
        }
      })
      .catch(() => {
        if (!cancelled) setData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, weeks, attempt]);

  // 月视图取数（第 81 轮巡检）：进入月模式 / 重试时拉取（月数可切换，第 100 轮巡检）
  useEffect(() => {
    if (mode !== 'month') return undefined;
    let cancelled = false;
    setMonthLoading(true);
    callOp('stats.heatmapMonthly', { months })
      .then((result) => {
        if (!cancelled) setMonthData(result);
      })
      .catch(() => {
        if (!cancelled) setMonthData(null);
      })
      .finally(() => {
        if (!cancelled) setMonthLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, months, attempt]);

  // 明细行「回看」覆写透传：缺省走 uiStore 站内课次跳转（HDU 学习中心/看板），B 站
  // 宿主经 onOpenCourse 覆写为新标签深链（与统一搜索同一策略，第 80 轮巡检）；
  // 缺省逻辑随第 236 轮共享化收进 DayDetailModal
  const pickDay = useCallback((date: string) => setDetailDate(date), []);
  const retry = useCallback(() => setAttempt((a) => a + 1), []);

  const monthView = mode === 'month';
  const busy = monthView ? monthLoading && !monthData : loading && !data;
  const failed = monthView ? !monthLoading && !monthData : !loading && !data;

  return (
    <div className="hdu-section hdu-heatmap-wrap">
      <SectionHead
        title="学习热力图"
        sub="每日学习时长强度（站内 + 站外，按自然日合并）"
        actions={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <PillTabs value={mode} items={MODE_OPTIONS} onChange={setMode} />
            {monthView ? (
              <PillTabs
                value={monthOption}
                items={MONTH_OPTIONS.map(({ value, label }) => ({ value, label }))}
                onChange={setMonthOption}
              />
            ) : (
              <PillTabs
                value={weekOption}
                items={WEEK_OPTIONS.map(({ value, label }) => ({ value, label }))}
                onChange={setWeekOption}
              />
            )}
          </span>
        }
      />
      <div className="hdu-card pad">
        {busy ? (
          <>
            <Skeleton height={16} width="30%" />
            <div style={{ height: 14 }} />
            <Skeleton height={120} />
          </>
        ) : failed ? (
          <EmptyState
            icon="chart"
            title="热力图暂不可用"
            text="稍后重试；热力图数据全部来自本机流水，不上报。"
            action={<Button size="small" variant="ghost" icon="refresh" onClick={retry}>重试</Button>}
          />
        ) : monthView && monthData ? (
          /* ── 月视图（第 81 轮巡检）：月列 × 当月天数（31 行对齐，缺日补位隐藏） ── */
          <div className="hdu-heatmap">
            <div className="hdu-heatmap-scroll">
              <div className="hdu-heatmap-inner">
                {/* 纵轴日期标注（1/11/21），行高与日格网格逐行对齐 */}
                <div className="hdu-heatmap-axis is-monthly" aria-hidden="true">
                  {Array.from({ length: MONTHLY_ROWS }, (_, i) => (
                    <span key={i}>{i === 0 || i === 10 || i === 20 ? String(i + 1) : ''}</span>
                  ))}
                </div>
                <div className="hdu-heatmap-body">
                  <div className="hdu-heatmap-months" aria-hidden="true">
                    {monthData.months.map((month, i) => (
                      <span
                        key={month.key}
                        className="hdu-heatmap-month"
                        title={`${month.label}（${month.days[0]?.date ?? ''} ~ ${month.days[month.days.length - 1]?.date ?? ''}）`}
                      >
                        {i % 3 === 0 || i === monthData.months.length - 1 ? month.label : ''}
                      </span>
                    ))}
                  </div>
                  <div className="hdu-heatmap-grid is-monthly" role="img" aria-label={`近 ${monthData.monthCount} 个月学习热力图`}>
                    {monthData.months.map((month) => (
                      <span key={month.key} style={{ display: 'contents' }}>
                        {month.days.map((cell) => (
                          <HeatCell key={cell.date} cell={cell} onPick={pickDay} />
                        ))}
                        {/* 缺日补位：31 行网格对齐（2 月等短月尾部隐藏占位） */}
                        {Array.from({ length: MONTHLY_ROWS - month.days.length }, (_, i) => (
                          <span key={`${month.key}-pad-${i}`} className="hdu-heatmap-cell is-future" />
                        ))}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
            <div className="hdu-heatmap-foot">
              <span>
                近 {monthData.monthCount} 个月 · 累计 {formatDuration(monthData.totalSec)} · 活跃 {monthData.activeDays} 天
                {monthData.maxDaySec > 0 ? ` · 峰值 ${formatDuration(monthData.maxDaySec)}/日` : ''}
              </span>
              <span className="hdu-heatmap-legend">
                少
                {LEGEND_LEVELS.map((level, i) => (
                  <i key={level} data-level={level} title={['无学习', '较少', '中等', '较多', '很多'][i]} />
                ))}
                多
              </span>
            </div>
            {monthData.activeDays === 0 ? (
              <div className="hdu-hint" style={{ marginTop: 8 }}>
                窗口内暂无学习记录；完成一次观看后，这里会按日点亮。
              </div>
            ) : null}
          </div>
        ) : data ? (
          /* ── 周视图（第 77 轮）：周列 × 7 行 ── */
          <div className="hdu-heatmap">
            <div className="hdu-heatmap-scroll">
              <div className="hdu-heatmap-inner">
                {/* 纵轴星期标注（一/三/五），行高与日格网格逐行对齐 */}
                <div className="hdu-heatmap-axis" aria-hidden="true">
                  <span>一</span>
                  <span />
                  <span>三</span>
                  <span />
                  <span>五</span>
                  <span />
                  <span />
                </div>
                <div className="hdu-heatmap-body">
                  <div className="hdu-heatmap-months" aria-hidden="true">
                    {data.weeks.map((week, i) => (
                      <span
                        key={week.startDay}
                        className="hdu-heatmap-month"
                        title={`周 ${week.startDay} ~ ${week.days[6]?.date ?? ''}`}
                      >
                        {monthLabelFor(data.weeks, i) ?? ''}
                      </span>
                    ))}
                  </div>
                  <div className="hdu-heatmap-grid" role="img" aria-label={`近 ${data.weekCount} 周学习热力图`}>
                    {data.weeks.flatMap((week) => week.days.map((cell) => (
                      <HeatCell key={cell.date} cell={cell} onPick={pickDay} />
                    )))}
                  </div>
                </div>
              </div>
            </div>
            <div className="hdu-heatmap-foot">
              <span>
                近 {data.weekCount} 周 · 累计 {formatDuration(data.totalSec)} · 活跃 {data.activeDays} 天
                {data.maxDaySec > 0 ? ` · 峰值 ${formatDuration(data.maxDaySec)}/日` : ''}
              </span>
              <span className="hdu-heatmap-legend">
                少
                {LEGEND_LEVELS.map((level, i) => (
                  <i key={level} data-level={level} title={['无学习', '较少', '中等', '较多', '很多'][i]} />
                ))}
                多
              </span>
            </div>
            {data.activeDays === 0 ? (
              <div className="hdu-hint" style={{ marginTop: 8 }}>
                窗口内暂无学习记录；完成一次观看后，这里会按日点亮。
              </div>
            ) : null}
          </div>
        ) : null}
        {/* 卡面口径标注（第 239 轮巡检，分布卡口径统一）：热力图是四张分布卡里唯一
            站内外合并的口径，如实注明；互补指引一句带过（每卡最多一句不堆叠） */}
        {!busy && !failed ? (
          <div className="hdu-hint hdu-caliber-hint" style={{ marginTop: 10 }}>
            <span className="hdu-caliber-tag">口径</span>
            站内有效时长 + 站外视频 · 按自然日合并 · 窗口随上方档位；互补：几点学见「学习时段」、打卡与否见「打卡月历」
          </div>
        ) : null}
      </div>

      {/* 单日明细弹层（第 79 轮巡检；第 236 轮起为共享组件）：点击格子 →
          stats.dayDetail 当日流水；站内 invalid 行保留展示并标「不计入」，与报表
          口径一致。打卡月历卡（第 236 轮）经同款组件获得同一下钻入口 */}
      <DayDetailModal date={detailDate} onClose={() => setDetailDate(null)} onOpenCourse={onOpenCourse} />
    </div>
  );
}
