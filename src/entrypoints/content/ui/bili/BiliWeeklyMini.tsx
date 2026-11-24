/**
 * B 站速览页签「本周学习小结」mini 卡（第 81 轮巡检）：stats.period（近 2 周）
 * 取数，展示本周站内外合计时长与较上周环比；完整周报在学习中心「统计」页签。
 * 自取数组件：加载中 / 失败一律返回 null（速览页签的辅助信息，静默降级不占位）。
 */

import { useEffect, useState } from 'react';
import { callOp } from '@/core/shared/client';
import { formatPeriodDelta } from '@/core/stats/period';
import type { PeriodReport } from '@/core/stats/period';
import { formatDuration } from '@/core/shared/utils';

export function BiliWeeklyMini() {
  const [report, setReport] = useState<PeriodReport | null>(null);

  useEffect(() => {
    let cancelled = false;
    callOp('stats.period', { kind: 'week', count: 2 })
      .then((result) => {
        if (!cancelled) setReport(result);
      })
      .catch(() => {
        if (!cancelled) setReport(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const current = report?.buckets[report.buckets.length - 1];
  const previous = report && report.buckets.length >= 2 ? report.buckets[report.buckets.length - 2] : undefined;
  if (!report || !current) return null;

  const total = (bucket: typeof current): number => bucket.internalSec + bucket.externalSec;
  const delta = previous ? formatPeriodDelta(total(current), total(previous)) : null;
  const deltaTone = delta ? (delta.startsWith('+') ? ' is-up' : delta.startsWith('-') ? ' is-down' : '') : '';

  return (
    <div className="bili-qa-weekly" title="本周学习小结（站内 + 站外合计，与学习中心统计同口径）">
      <span className="bili-qa-weekly-label">本周学习</span>
      <span className="bili-qa-weekly-value">{formatDuration(total(current))}</span>
      {delta ? <span className={`bili-qa-weekly-delta${deltaTone}`}>较上周{delta}</span> : null}
      <span className="bili-qa-weekly-hint">完整周报见学习中心 · 统计</span>
    </div>
  );
}
