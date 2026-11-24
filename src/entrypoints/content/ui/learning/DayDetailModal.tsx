/**
 * 单日学习明细弹层（第 236 轮巡检自 ActivityHeatmap 提为共享组件）：热力图与打卡
 * 月历两处入口共用同一 Modal 与数据流（stats.dayDetail op），交互一致化。
 *
 *  - 打开：date 非 null 即弹（标题「MM-DD 学习明细」）；关闭经 onClose 回传调用方
 *    （调用方自持 detailDate 状态，热力图 / 月历各自照原模式打开）；
 *  - 数据：date 变化时按日取数（关闭/换日即失效；失败置 null 走空态），站内
 *    invalid 行保留展示并标「不计入」，与报表口径一致（第 79 轮行为原样搬移）；
 *  - 明细行「回看」：缺省走 uiStore 站内课次跳转（HDU 学习中心/看板），B 站宿主经
 *    onOpenCourse 覆写为新标签深链（与统一搜索同一策略，第 80 轮巡检）；
 *  - e2e 兼容：弹层 DOM 结构（.hdu-modal-title 含「学习明细」/ .hdu-modal-body 含
 *    「回看」「不计入」）与拆分前逐字节一致，热力图两处下钻断言不受影响。
 */

import { useCallback, useEffect, useState } from 'react';
import { callOp } from '@/core/shared/client';
import type { DayDetailReport } from '@/core/stats/heatmap';
import { formatDuration, shortDayLabel } from '@/core/shared/utils';
import { Button, EmptyState, Modal, Skeleton } from '../components';
import { Icon } from '../icons';
import { uiStore } from '../store';

export function DayDetailModal({
  date,
  onClose,
  onOpenCourse,
}: {
  /** 当日日键（'YYYY-MM-DD'）；null = 关闭态 */
  date: string | null;
  onClose: () => void;
  /** 明细行「回看」跳转覆写（B 站学习中心宿主传新标签深链）；缺省走 uiStore 站内跳转 */
  onOpenCourse?: (courId: number, teclId?: number) => void;
}) {
  const [detail, setDetail] = useState<DayDetailReport | null>(null);
  const [loading, setLoading] = useState(false);

  // 当日明细取数：弹层打开时按日取数（关闭/换日即失效；失败置 null 走空态）
  useEffect(() => {
    if (!date) return undefined;
    let cancelled = false;
    setLoading(true);
    setDetail(null);
    callOp('stats.dayDetail', { date })
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [date]);

  // 明细行「回看」：缺省走 uiStore 站内课次跳转，B 站宿主经 onOpenCourse 覆写
  const openCourse = useCallback(
    (courId: number, teclId?: number) => {
      const go = onOpenCourse ?? ((c: number, t?: number) => uiStore.actions.openSessionInSite(c, t));
      go(courId, teclId);
    },
    [onOpenCourse],
  );

  return (
    <Modal open={date !== null} title={date ? `${shortDayLabel(date)} 学习明细` : '学习明细'} onClose={onClose} width={440}>
      {loading || !detail ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Skeleton height={26} />
          <Skeleton height={26} />
          <Skeleton height={26} />
        </div>
      ) : detail.internal.length === 0 && detail.external.length === 0 ? (
        <EmptyState icon="chart" title="当天没有学习记录" text="这一天没有站内或站外学习流水。" />
      ) : (
        <>
          {(
            [
              { key: 'internal', head: '站内课程', rows: detail.internal },
              { key: 'external', head: '站外视频', rows: detail.external },
            ] as const
          ).map(
            (bucket) =>
              bucket.rows.length > 0 ? (
                <div key={bucket.key} style={{ marginBottom: 12 }}>
                  <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 6 }}>{bucket.head}</div>
                  <div className="hdu-list">
                    {bucket.rows.map((row, i) => (
                      <div className="hdu-list-row" key={`${bucket.key}-${i}`}>
                        <div className="hdu-list-main">
                          <div className="hdu-list-title">{row.label}</div>
                          <div className="hdu-list-sub">{row.sub ? <span>{row.sub}</span> : null}</div>
                        </div>
                        <div className="hdu-list-side" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span className="hdu-time-badge">{formatDuration(row.seconds)}</span>
                          {/* 回放入口（第 80 轮巡检）：站内行跳课次播放页，站外行新标签打开视频页 */}
                          {bucket.key === 'internal' && row.courId ? (
                            <Button size="small" variant="ghost" icon="play" onClick={() => openCourse(row.courId!, row.teclId)}>
                              回看
                            </Button>
                          ) : null}
                          {bucket.key === 'external' && row.url ? (
                            <a
                              className="hdu-btn ghost small"
                              href={row.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={`打开 ${row.label}`}
                            >
                              打开 <Icon name="external" size={12} />
                            </a>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null,
          )}
          <div className="hdu-hint">
            站内有效 {formatDuration(detail.internalSec)} · 站外 {formatDuration(detail.externalSec)}；标「不计入」的流水不进报表。
          </div>
        </>
      )}
    </Modal>
  );
}
