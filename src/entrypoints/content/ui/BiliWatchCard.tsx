/**
 * B 站视频学习统计卡（学习中心统计页与 Dashboard 概览共用的唯一实现）。
 *
 * 背景：组件原内联在学习中心 StatsView（第 25 轮引入），第 28 轮抽到独立文件供
 * Dashboard「本周学习」摘要区复用——两处只差一个取数区间形态：学习中心提供周/月
 * PillTabs 切换，Dashboard 固定本周（kind='week'）。差异经 props 表达：
 *  - `range` 不传（学习中心，缺省）：内部 useState 持有区间，渲染周/月切换，行为与
 *    抽取前完全一致；
 *  - `range` 传入（Dashboard）：区间固定为该值，不渲染切换 tabs。
 *
 * 数据经 stats.bili.overview op 现取（聚合口径见 core/db/repo/bili）：
 *  - TopN 复用 hdu-dist 分布条（宽度按区间内最大值归一，文本显示占比）；
 *  - 最近观看行点击经 safeExternalUrl → withTimeParam 新标签跳回 B 站续看；
 *  - 无任何站外记录时显示中性空态；请求失败显示「加载失败 + 重试」（与空态区分，
 *    不把失败误显示成「还没有站外观看记录」）。
 * 样式全部沿用现有令牌与类（hdu-section / hdu-card / hdu-dist / hdu-list），无新增 CSS。
 */
import { useCallback, useEffect, useState } from 'react';
import { callOp } from '@/core/shared/client';
import type { BiliOverviewResult, BiliRecentWatchedRow } from '@/core/shared/types';
import { formatClock, formatDuration, safeExternalUrl, withTimeParam } from '@/core/shared/utils';
import { Button, Chip, EmptyState, PillTabs, SectionHead, Skeleton } from './components';
import { Icon } from './icons';

export type BiliRangeKey = 'week' | 'month';

/** B 站 TopN 的紧凑周期切换项：本周 / 本月（区间边界口径与周月报一致） */
const BILI_RANGE_OPTIONS: Array<{ value: BiliRangeKey; label: string }> = [
  { value: 'week', label: '本周' },
  { value: 'month', label: '本月' },
];

/** 最近观看行 → 站外跳转链接：有进度拼 ?t=（多 P 的 ?p= 随收藏 url 自带） */
export function biliResumeUrl(row: BiliRecentWatchedRow): string | null {
  const base = safeExternalUrl(row.url);
  if (!base) return null;
  return row.lastPositionSec > 0 ? withTimeParam(base, row.lastPositionSec) : base;
}

export interface BiliWatchCardProps {
  /**
   * 固定取数区间（Dashboard 摘要区用，kind='week'）：传入时隐藏周/月切换 tabs。
   * 缺省（学习中心统计页）= 内部状态 + 周/月 PillTabs，与抽取前行为一致。
   */
  range?: BiliRangeKey;
}

export function BiliWatchCard({ range: fixedRange }: BiliWatchCardProps) {
  const [internalRange, setInternalRange] = useState<BiliRangeKey>('week');
  const rangeKey = fixedRange ?? internalRange;
  const [overview, setOverview] = useState<BiliOverviewResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setLoadFailed(false);
    callOp('stats.bili.overview', { kind: rangeKey })
      .then((result) => {
        if (!cancelled) setOverview(result);
      })
      .catch(() => {
        if (!cancelled) {
          setOverview(null);
          setLoadFailed(true);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rangeKey]);

  useEffect(() => load(), [load]);

  const top = overview?.top ?? [];
  const recent = overview?.recent ?? [];
  const rangeLabel = rangeKey === 'week' ? '本周' : '本月';
  const maxTopSec = Math.max(1, ...top.map((row) => row.totalSec));

  return (
    <div className="hdu-section">
      <SectionHead
        title="B 站视频"
        sub="站外视频学习时长聚合（独立口径，不并入站内累计）"
        actions={
          <>
            {overview && overview.streakDays > 0 ? (
              <Chip tone="jade" icon="flame" title="externalWatch 有记录的自然日连续计数；今天还没学不立即断链">
                连续 {overview.streakDays} 天
              </Chip>
            ) : null}
            {/* 固定区间形态（Dashboard）不提供切换：口径与所在周报摘要区一致 */}
            {fixedRange ? null : <PillTabs value={rangeKey} items={BILI_RANGE_OPTIONS} onChange={setInternalRange} />}
          </>
        }
      />
      <div className="hdu-card pad">
        {loading && !overview ? (
          <>
            <Skeleton height={22} width="40%" />
            <div style={{ height: 16 }} />
            <Skeleton height={120} />
          </>
        ) : loadFailed ? (
          <EmptyState
            icon="video"
            title="加载失败"
            text="站外观看统计暂时读取失败，请稍后重试。"
            action={
              <Button onClick={() => load()} disabled={loading}>
                重试
              </Button>
            }
          />
        ) : top.length === 0 && recent.length === 0 ? (
          <EmptyState
            icon="video"
            title="还没有站外观看记录"
            text="在 B 站观看视频学习一段时间后，这里会出现观看 TopN、最近观看与连续天数。"
          />
        ) : (
          <>
            <div className="hdu-list-sub" style={{ marginBottom: 8 }}>{rangeLabel}观看 TopN</div>
            {top.length === 0 ? (
              <div className="hdu-hint">{rangeLabel}暂无站外观看时长</div>
            ) : (
              <div className="hdu-dist">
                {top.map((row) => (
                  <div className="hdu-dist-row" key={row.bvid}>
                    <span className="hdu-dist-name" title={`${row.title}（${row.bvid}）`}>{row.title}</span>
                    <div className="hdu-dist-bar"><i style={{ width: `${(row.totalSec / maxTopSec) * 100}%` }} /></div>
                    <span className="hdu-dist-val">
                      {formatDuration(row.totalSec)} · {Math.round(row.share * 100)}%
                    </span>
                  </div>
                ))}
              </div>
            )}

            {recent.length > 0 ? (
              <>
                <div style={{ height: 14 }} />
                <div className="hdu-list">
                  {recent.map((row) => {
                    const href = biliResumeUrl(row);
                    return (
                      <a
                        className="hdu-list-row"
                        key={row.bvid}
                        href={href ?? undefined}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={href ? `继续观看：${row.title}` : row.title}
                      >
                        <div className="hdu-list-main">
                          <div className="hdu-list-title">{row.title}</div>
                          <div className="hdu-list-sub">
                            <span>最近 {row.lastDay}</span>
                            <span>累计 {formatDuration(row.totalSec)}</span>
                            {row.lastPositionSec > 0 ? (
                              <span>
                                看到 {formatClock(row.lastPositionSec)}
                                {row.durationSec ? ` / ${formatClock(row.durationSec)}` : ''}
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <div className="hdu-list-side">
                          <span className="hdu-time-badge">
                            <Icon name="external" /> 续看
                          </span>
                        </div>
                      </a>
                    );
                  })}
                </div>
              </>
            ) : null}

            <div className="hdu-hint" style={{ marginTop: 12 }}>
              TopN 口径：{rangeLabel}（{overview?.range.startDay ?? ''} 起）externalWatch 累计秒数降序，N=5；
              点击最近观看按上次进度续看。
            </div>
          </>
        )}
      </div>
    </div>
  );
}
