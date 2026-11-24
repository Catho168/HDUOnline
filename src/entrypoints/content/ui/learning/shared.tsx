// 学习中心（LearningCenter）跨视图共享的类型与小件：
// BundleData（主装配下发的数据包）、sessionLabel（课次展示名）、MissedList（补看清单，
// 总览与课表页共用）、useTimeOfDayDistribution（学习时段取数 hook，第 239 轮巡检起
// 时段分布卡与总览黄金时段提示共用同一取数）。自 LearningCenter.tsx 第 40 轮巡检按
// 视图纯搬移拆分，逻辑不变。
import { useCallback, useEffect, useState } from 'react';
import { callOp } from '@/core/shared/client';
import { errorTextOf } from '@/core/shared/errors';
import type { MissedItem } from '@/core/shared/ops';
import type {
  CourseBundle,
  DashboardReport,
  FavoriteEntity,
  FolderEntity,
  NoteEntity,
  SessionEntity,
} from '@/core/shared/types';
import { formatDuration, localDayKey } from '@/core/shared/utils';
import {
  buildTimeOfDayDistribution,
  TIME_OF_DAY_DEFAULT_DAYS,
  type TimeOfDayBucket,
} from '@/core/stats/timeOfDay';
import { pushToast, Button } from '../components';
import { uiStore } from '../store';

export interface BundleData {
  bundles: CourseBundle[];
  report: DashboardReport | null;
  missed: MissedItem[];
  favorites: FavoriteEntity[];
  folders: FolderEntity[];
  notes: NoteEntity[];
  schedule: Array<{ courId: number; teclId: number; subjName: string; beginTime: number; endTime: number; clroName?: string; letiNumber?: number }>;
  /** 待完成复习作业数（review.stats.pending，第 83 轮巡检起新增，导航徽标用） */
  reviewPending: number;
  loading: boolean;
  error: string | null;
  reload?: () => Promise<void>;
}

export function sessionLabel(session: SessionEntity): string {
  if (session.courLabel) return session.courLabel;
  const d = new Date(session.beginTime);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return session.letiNumber ? `${date} / 第${session.letiNumber}节课` : date;
}

export function MissedList({ items, onExcluded }: { items: MissedItem[]; onExcluded: () => void }) {
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
                  // 写操作失败必须可感知（第 253 轮 callOp 审计唯一 catch 缺口）：
                  // 此前 .then() 后无 .catch()，schedule.exclude 拒绝会成为未处理
                  // rejection 且用户点击无任何反馈；补 catch + errorTextOf 文案 toast
                  void callOp('schedule.exclude', { courId: item.courId, excluded: true })
                    .then(() => {
                      pushToast('已标记为到课，不再进入补看清单', 'success');
                      onExcluded();
                    })
                    .catch((err) => {
                      pushToast(errorTextOf(err, '标记到课失败，请重试'), 'error');
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

// ───────────────────────── 学习时段取数 hook（第 239 轮巡检） ─────────────────────────

export interface TimeOfDayDistState {
  /** 时段分布（六桶全量；无有效数据 / 取数失败为 null） */
  buckets: TimeOfDayBucket[] | null;
  loading: boolean;
  failed: boolean;
  /** 重新拉取（TimeOfDayCard 失败态重试按钮用；提示行静默失败不暴露） */
  retry: () => void;
}

/**
 * 学习时段分布取数（第 239 轮巡检自 TimeOfDayCard 上收为共享 hook）：stats.records
 * op 近 30 天窗口（fromDay/toDay 本地日键含端点，取数窗口与聚合窗口同宽）→
 * buildTimeOfDayDistribution 纯函数（只计 valid 口径）。「今天」显式取挂载时刻
 * Date.now() 传入（纯函数约定，不内部取时间）。
 *
 * 共享动机：时段分布卡（StatsView）与总览黄金时段提示行（OverviewView）消费同一
 * 份数据，但两者分属不同视图、互斥挂载，运行期并无重复请求；抽 hook 是为让两处
 * 取数口径（窗口 / valid / 日键构造）从「两份代码约定一致」变成「同一份实现」，
 * 避免后续单边改动造成口径漂移。消费方：TimeOfDayCard（完整 loading/failed/retry）、
 * OverviewView.GoldenSlotHint（只取 buckets，失败静默不渲染）。
 */
export function useTimeOfDayDistribution(): TimeOfDayDistState {
  const [buckets, setBuckets] = useState<TimeOfDayBucket[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setFailed(false);
    const nowTs = Date.now();
    const toDay = localDayKey(nowTs);
    const fromDay = localDayKey(nowTs - (TIME_OF_DAY_DEFAULT_DAYS - 1) * 86_400_000);
    callOp('stats.records', { fromDay, toDay })
      .then((records) => {
        if (disposed) return;
        setBuckets(buildTimeOfDayDistribution(records, nowTs, TIME_OF_DAY_DEFAULT_DAYS));
        setLoading(false);
      })
      .catch(() => {
        if (!disposed) {
          setBuckets(null);
          setFailed(true);
          setLoading(false);
        }
      });
    return () => {
      disposed = true;
    };
  }, [attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { buckets, loading, failed, retry };
}
