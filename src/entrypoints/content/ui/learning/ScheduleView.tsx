// 学习中心「课表与补看」视图（自 LearningCenter.tsx 第 40 轮巡检按视图纯搬移拆分，逻辑不变）：
// 本周课表网格 + 同步入口 + 补看清单（MissedList 见 ./shared）。
import { useCallback, useMemo, useState } from 'react';
import { WEEKDAY_LABELS } from '@/core/shared/constants';
import { localDayKey, shortDayLabel, startOfLocalWeek } from '@/core/shared/utils';
import { Button, Chip, EmptyState, SectionHead, Skeleton, SkeletonRows, cx } from '../components';
import { uiStore } from '../store';
import { MissedList, type BundleData } from './shared';

// ───────────────────────── 课表 / 补看 ─────────────────────────

export function ScheduleView({ data }: { data: BundleData }) {
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
        {/* 加载态骨架（第 253 轮，视图域 / 反馈一致性）：BundleData 异步装载期间
            不再闪现「尚未同步课表」误导文案（盘点结论：本视图此前无 loading 态，
            空态文案在数据未达时先行渲染——与课程库同批修的跳版/闪现缺口） */}
        {data.loading ? (
          <div style={{ marginTop: 12 }}>
            <SkeletonRows widths={['45%', '30%']} height={14} />
          </div>
        ) : weekItems.length === 0 ? (
          <div className="hdu-hint" style={{ marginTop: 12 }}>
            {data.schedule.length > 0
              ? '本周暂无课程安排。'
              : '尚未同步课表。点击右上角「同步课表」，或打开站点「我的课表」页面后，插件会自动读取本周课程；课表只保存在本机。'}
          </div>
        ) : null}
      </div>

      <div className="hdu-section">
        <SectionHead title="补看清单" sub="课次结束超过设定时间且无有效观看时列入" actions={<Button size="small" variant="ghost" icon="refresh" onClick={() => void data.reload?.()}>刷新</Button>} />
        {/* 装载期间以同构骨架行占位（.hdu-missed 卡壳 + 内嵌骨架，高度≈真实行，
            数据到达后不跳版）； loading 期不再闪现「没有待补看的课次」空态 */}
        {data.loading ? (
          <div className="hdu-missed-list">
            {[0, 1].map((i) => (
              <div className="hdu-missed" key={i}>
                <Skeleton height={46} width="62%" />
              </div>
            ))}
          </div>
        ) : data.missed.length === 0 ? (
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
