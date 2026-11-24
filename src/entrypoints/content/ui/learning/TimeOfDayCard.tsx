/**
 * 学习时段分布卡（第 238 轮巡检，信息 / 自我认知视角；第 239 轮黄金时段建议升级）：
 * HDU 学习中心统计页挂载，紧邻课程分布卡。
 *
 * 与热力图的定位差异（避免重复感）：ActivityHeatmap 看「哪天学」（日级强度趋势），
 * 本卡看「几点学」——近 30 天观看流水按**本地开始小时**分六桶（清晨 / 上午 / 午后 /
 * 傍晚 / 晚间 / 深夜），复用 .hdu-dist-* 分布条家族（与课程分布卡同线），最高占比
 * 桶 accent 高亮 + foot 洞察文案。
 *
 *  - 数据：useTimeOfDayDistribution 共享 hook（learning/shared，第 239 轮自本卡
 *    上收）——stats.records op（近 30 天窗口，fromDay/toDay 本地日键；含端点），
 *    喂 buildTimeOfDayDistribution 纯函数（core/stats/timeOfDay）——只计 valid=true
 *    的有效口径（与报表「有效时长」同线），分桶按开始时刻、跨零点归深夜桶；
 *  - foot 洞察（第 239 轮升级为建议视角）：数据达「黄金时段」门槛（总有效 ≥60
 *    分钟且最高桶占比 ≥25%，suggestGoldenSlot 纯函数判断）时输出「你的黄金时段：
 *    晚间（18–23 点），占比 X%」；不达门槛维持第 238 轮中性文案（「你最常在…」）；
 *  - 卡面口径标注（第 239 轮，分布卡口径统一）：.hdu-hint 口径行（.hdu-caliber-hint
 *    徽标句式）注明「站内有效时长 · 近 30 天」；与热力图 / 打卡月历的相互指引维持
 *    副标题一句话（不堆叠）；
 *  - 加载 Skeleton / 空态 EmptyState / 失败态与空态分开提示、可重试（hook 内
 *    attempt 递增，照 CheckinMonthCard / MilestoneWall 模式）；
 *  - 样式复用 .hdu-dist-* + .hdu-dist-tod 修饰（四列行 + 最高桶高亮，见 UI_CSS
 *    第 238 轮块），暗色主题由既有 --* 变量整组跟随。
 */

import { useMemo } from 'react';
import {
  suggestGoldenSlot,
  timeOfDayHourLabel,
  TIME_OF_DAY_DEFAULT_DAYS,
  type TimeOfDayBucket,
} from '@/core/stats/timeOfDay';
import { formatDuration } from '@/core/shared/utils';
import { Button, EmptyState, SectionHead, Skeleton, cx } from '../components';
import { useTimeOfDayDistribution } from './shared';

export function TimeOfDayCard() {
  const { buckets, failed, loading, retry } = useTimeOfDayDistribution();

  // 最高占比桶（并列取固定桶序靠前者）：totalSec > 0 才有（null 已被空态拦截）
  const { totalSec, topKey, topPct } = useMemo(() => {
    const total = (buckets ?? []).reduce((acc, b) => acc + b.sec, 0);
    const top = (buckets ?? []).reduce<TimeOfDayBucket | null>(
      (best, b) => (best === null || b.sec > best.sec ? b : best),
      null,
    );
    return {
      totalSec: total,
      topKey: top && top.sec > 0 ? top.key : null,
      topPct: top && total > 0 ? Math.round((top.sec / total) * 100) : 0,
    };
  }, [buckets]);

  // 黄金时段建议（第 239 轮）：达门槛（总有效 ≥60 分钟且最高桶占比 ≥25%）才有值
  const golden = useMemo(() => suggestGoldenSlot(buckets), [buckets]);

  const maxSec = useMemo(() => Math.max(1, ...(buckets ?? []).map((b) => b.sec)), [buckets]);

  return (
    <div className="hdu-section">
      <SectionHead title="学习时段" sub={`近 ${TIME_OF_DAY_DEFAULT_DAYS} 天 · 按开始时刻分桶（与热力图互补：热力图看哪天学，这里看几点学）`} />
      <div className="hdu-card pad">
        {loading ? (
          <div className="hdu-dist" aria-label="学习时段加载中">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} height={12} />
            ))}
          </div>
        ) : failed ? (
          <EmptyState icon="chart" title="暂时拿不到时段数据" text="学习流水读取失败，点下方重试再试一次。" />
        ) : buckets === null ? (
          <EmptyState icon="chart" title="暂无数据" text="近 30 天还没有有效观看记录，完成一次观看后这里会显示你的学习时段。" />
        ) : (
          <>
            <div className="hdu-dist hdu-dist-tod">
              {buckets.map((bucket) => {
                const pct = totalSec > 0 ? Math.round((bucket.sec / totalSec) * 100) : 0;
                const isTop = bucket.key === topKey;
                return (
                  <div className={cx('hdu-dist-row', 'is-tod', isTop ? 'is-top' : '')} key={bucket.key}>
                    <span className="hdu-dist-name" title={`${bucket.label}（${timeOfDayHourLabel(bucket.key)}）`}>
                      {bucket.label}
                    </span>
                    {/* 条形 hover 显示时长与次数（title；空桶不弹无意义提示） */}
                    <div
                      className="hdu-dist-bar"
                      title={
                        bucket.sec > 0
                          ? `${bucket.label}（${timeOfDayHourLabel(bucket.key)}）${formatDuration(bucket.sec)} · ${bucket.count} 次 · 占比 ${pct}%`
                          : `${bucket.label}（${timeOfDayHourLabel(bucket.key)}）无有效学习`
                      }
                    >
                      <i style={{ width: `${(bucket.sec / maxSec) * 100}%` }} />
                    </div>
                    <span className="hdu-dist-pct">{pct}%</span>
                    <span className="hdu-dist-val">{formatDuration(bucket.sec)}</span>
                  </div>
                );
              })}
            </div>
            {/* foot 洞察文案（.hdu-hint 与各卡 foot 同风格）：达「黄金时段」门槛 →
                建议视角文案；不达门槛维持第 238 轮中性自我认知文案（防噪声） */}
            {topKey ? (
              <div className="hdu-hint" style={{ marginTop: 10 }}>
                {golden
                  ? `你的黄金时段：${golden.label}（${timeOfDayHourLabel(golden.key)}），占比 ${Math.round(golden.share * 100)}%`
                  : (() => {
                      const top = buckets.find((b) => b.key === topKey)!;
                      return `你最常在${top.label}（${timeOfDayHourLabel(top.key)}）学习，占比 ${topPct}%，共 ${formatDuration(top.sec)} / ${top.count} 次`;
                    })()}
              </div>
            ) : null}
            {/* 卡面口径标注（第 239 轮，分布卡口径统一）：.hdu-caliber-hint 徽标句式，
                与课程分布 / 热力图 / 打卡月历卡的口径行同一句式与观感 */}
            <div className="hdu-hint hdu-caliber-hint" style={{ marginTop: 8 }}>
              <span className="hdu-caliber-tag">口径</span>
              站内有效时长 · 近 {TIME_OF_DAY_DEFAULT_DAYS} 天 · 按开始时刻归桶
            </div>
          </>
        )}
        {/* 失败态重试（空态不显示——没有可重试的东西，等有观看记录即可）；icon 统一 refresh（第 249 轮重试钮全仓同款） */}
        {failed && !loading ? (
          <div style={{ marginTop: 8 }}>
            <Button size="small" variant="ghost" icon="refresh" onClick={retry}>
              重试
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
