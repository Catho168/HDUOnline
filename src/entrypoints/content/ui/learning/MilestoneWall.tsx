/**
 * 学习里程碑时间线墙（第 235 轮巡检；第 236 轮追加一键复制分享）：HDU 学习中心
 * 统计页挂载，紧邻学习成就卡。
 *
 * 定位（回顾视角）：成就徽章卡看「现在的进度」，本卡回放「走过的路」——从
 * stats.report 的 days[]（回看窗口）回放派生里程碑时刻：累计学习档位跨越
 * （1h/5h/10h/25h/50h/100h）、连续学习新高（≥3 天）、单日新高（≥30 分钟）、
 * 首次打卡。纯函数 deriveMilestones 见 core/stats/milestones.ts，不新增表/op/kv。
 *
 *  - 数据：复用既有 stats.report op（days=400 覆盖 12 个月回看窗口，与打卡月历卡
 *    同款取数路径），不新增 op；
 *  - 展示：纵向时间轴（左日期 / 中节点圆点+竖线 / 右标题+说明），节点按 kind 着色；
 *    取最近 12 条，超出显示「共 X 个里程碑」foot；
 *  - 行点击下钻（第 237 轮，可用性 / 一致性视角）：里程碑行整体可点（button 语义）
 *    ——点击弹当日学习明细（热力图 / 打卡月历同款共享 DayDetailModal，stats.dayDetail
 *    同一数据流），弹层状态与骨架 / 重试态互不影响（兄弟节点、互不覆盖）；
 *  - 一键复制（第 236 轮，分享视角）：foot 追加「复制里程碑」ghost 小按钮——
 *    buildMilestoneShareText 纯函数序列化（标题行 + 逐行「日期 标题 · detail」）→
 *    copyTextToClipboard（writeText 优先 / execCommand 回退），loading 态 + 成功/
 *    失败 toast，与 PeriodReportCard「复制摘要」同一模式；空列表不显示按钮；
 *  - 失败可重试（attempt 递增走同一 effect，照 CheckinMonthCard 模式）；
 *  - 样式新增 .hdu-milestone-* 家族（UI_CSS 第 235 轮块，第 237 轮补可点态），
 *    颜色全走既有 CSS 变量，暗色主题随 data-theme 自动生效。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { callOp } from '@/core/shared/client';
import { buildMilestoneShareText, deriveMilestones, type MilestonesResult, type StudyMilestone } from '@/core/stats/milestones';
import { Button, EmptyState, SectionHead, Skeleton, cx, pushToast } from '../components';
import { copyTextToClipboard } from '../clipboard';
import { DayDetailModal } from './DayDetailModal';

/** stats.report 取数窗口天数：12 个月回看 + 当月余量 + 缓冲（与 CheckinMonthCard 一致） */
const REPORT_DAYS = 400;

/** kind → 节点着色类 + 图标（emoji 级，不引新图标资源） */
const KIND_META: Record<StudyMilestone['kind'], { cls: string; icon: string }> = {
  cumulative: { cls: 'is-total', icon: '📚' },
  streak: { cls: 'is-streak', icon: '🔥' },
  daily: { cls: 'is-daily', icon: '⚡' },
  checkin: { cls: 'is-checkin', icon: '✅' },
};

/** 日键 → 'MM/DD'（时间轴左列窄排版；非法键原样回退） */
function shortDate(key: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(key) ? key.slice(5).replace('-', '/') : key;
}

/** 日键 → 读屏语义「N 月 N 日」（非法键回退「该」日，保证 aria-label 恒可读） */
function dayCnLabel(key: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(key)) {
    const month = Number(key.slice(5, 7));
    const day = Number(key.slice(8, 10));
    if (Number.isFinite(month) && Number.isFinite(day)) return `${month} 月 ${day} 日`;
  }
  return '该';
}

export function MilestoneWall() {
  const [days, setDays] = useState<Array<{ date: string; validSec: number }> | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);

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

  // 里程碑回放（纯函数）：days 为 null（取数失败）与 []（无数据）都按空回放
  const milestones: MilestonesResult = useMemo(() => deriveMilestones(days ?? []), [days]);

  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  const failed = !loading && days === null;

  // 一键复制（第 236 轮，分享视角）：里程碑列表 → 纯文本 → 剪贴板；成功/失败均
  // toast，执行中 loading 态（模式与 PeriodReportCard「复制摘要」一致）。
  // buildMilestoneShareText 对空列表返回空串——foot 按钮仅在非空分支渲染，天然防御。
  const [sharing, setSharing] = useState(false);
  const shareMilestones = useCallback(async () => {
    if (milestones.items.length === 0) {
      pushToast('暂无里程碑', 'info');
      return;
    }
    setSharing(true);
    try {
      const text = buildMilestoneShareText(milestones.items, milestones.total);
      const ok = await copyTextToClipboard(text);
      if (ok) pushToast('已复制，可粘贴分享', 'success');
      else pushToast('复制失败，请手动选择文本复制', 'error');
    } catch {
      pushToast('复制失败，请手动选择文本复制', 'error');
    } finally {
      setSharing(false);
    }
  }, [milestones.items, milestones.total]);

  // 行点击下钻（第 237 轮）：点击里程碑行 → 弹当日学习明细（热力图 / 打卡月历同款
  // 共享 DayDetailModal）。弹层为卡片的兄弟节点、自持取数 loading，与骨架 / 重试态
  // 互不影响（照 CheckinMonthCard.detailDate 同一状态管理模式）。
  const [detailDate, setDetailDate] = useState<string | null>(null);

  return (
    <div className="hdu-section hdu-milestone-wrap">
      <SectionHead title="学习里程碑" sub="累计档位、连续新高、单日新高与首次打卡的历史时刻" />
      <div className="hdu-card pad">
        {loading ? (
          <>
            <Skeleton height={16} width="40%" />
            <div style={{ height: 14 }} />
            <Skeleton height={150} />
          </>
        ) : failed ? (
          <EmptyState
            icon="spark"
            title="里程碑暂不可用"
            text="稍后重试；里程碑由本机流水回放，不上报。"
            action={<Button size="small" variant="ghost" icon="refresh" onClick={retry}>重试</Button>}
          />
        ) : milestones.items.length === 0 ? (
          <EmptyState icon="star" title="还没有里程碑" text="继续学习，第一个里程碑就在前方。" />
        ) : (
          <>
            <div className="hdu-milestone-list" role="list" aria-label="学习里程碑时间线">
              {milestones.items.map((m, i) => (
                <div className="hdu-milestone-row" key={`${m.date}:${m.kind}:${i}`} role="listitem" data-kind={m.kind}>
                  {/* 行点击下钻（第 237 轮）：里程碑行整体 button 语义（原生 Enter/Space
                      触发 + focus-visible），aria-label 带日期语义；右侧「›」为可点暗示 */}
                  <button
                    type="button"
                    className="hdu-milestone-btn"
                    aria-label={`打开 ${dayCnLabel(m.date)}学习明细`}
                    onClick={() => setDetailDate(m.date)}
                  >
                    <span className="hdu-milestone-date">{shortDate(m.date)}</span>
                    <span className={cx('hdu-milestone-node', KIND_META[m.kind].cls)} aria-hidden="true">
                      <i className="hdu-milestone-dot" />
                    </span>
                    <span className="hdu-milestone-main">
                      <span className="hdu-milestone-title">
                        {KIND_META[m.kind].icon} {m.title}
                      </span>
                      <span className="hdu-milestone-detail">{m.detail}</span>
                    </span>
                    <span className="hdu-milestone-arrow" aria-hidden="true">
                      ›
                    </span>
                  </button>
                </div>
              ))}
            </div>
            {/* foot（第 236 轮起左计数右复制按钮）：空列表不进本分支（按钮不显示） */}
            <div className="hdu-milestone-foot">
              {milestones.total > milestones.items.length ? (
                <span className="hdu-hint">
                  共 {milestones.total} 个里程碑，当前展示最近 {milestones.items.length} 个
                </span>
              ) : (
                <span className="hdu-hint">共 {milestones.total} 个里程碑</span>
              )}
              <Button size="small" variant="ghost" icon="send" loading={sharing} onClick={() => void shareMilestones()}>
                复制里程碑
              </Button>
            </div>
          </>
        )}
      </div>
      {/* 当日明细弹层（第 237 轮）：里程碑行点击下钻，与热力图 / 打卡月历同款共享组件 */}
      <DayDetailModal date={detailDate} onClose={() => setDetailDate(null)} />
    </div>
  );
}
