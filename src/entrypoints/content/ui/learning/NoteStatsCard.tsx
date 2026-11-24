/**
 * 笔记统计小卡（第 240 轮巡检，笔记域 / 信息视角）：HDU 学习中心统计页挂载，
 * 紧邻课程分布 / 学习时段卡。三段信息——
 *  - 指标行：笔记总数 + 近 7 天新增（口径见 core/stats/noteStats.buildNoteStats，
 *    与成就徽章「笔记勤耕」同源：实时存活笔记条数）；
 *  - 课程 Top3：序号徽标 + 课程名截断 + 计数右对齐（.hdu-notestat-* 家族，第 240 轮）；
 *  - foot「查看笔记」：setCenterView('library') 跳知识库——「我的笔记」分区在
 *    知识库视图内（LibraryView 无独立页签，跳转即达）。
 * 空态（total=0）：「还没有笔记，看课时随手记一条」轻文案 + 查看入口仍可用。
 * 数据不入卡（调用方传 data.notes / 课程名映射），不额外发起 op。
 */

import { useMemo } from 'react';
import { buildNoteStats } from '@/core/stats/noteStats';
import { Button, EmptyState, SectionHead } from '../components';
import { uiStore } from '../store';
import type { BundleData } from './shared';

export function NoteStatsCard({
  notes,
  courseNames,
}: {
  notes: BundleData['notes'];
  courseNames: Record<number, string>;
}) {
  const actions = uiStore.actions;
  const stats = useMemo(() => buildNoteStats(notes, { now: Date.now(), courseNames }), [notes, courseNames]);
  return (
    <div className="hdu-section">
      <SectionHead title="笔记" sub="看课随手记的时间戳笔记（站内 + B 站）" />
      <div className="hdu-card pad">
        {stats.total === 0 ? (
          /* 空态引导型（第 249 轮空态模板化）：CTA 收进 EmptyState action（.hdu-empty-action
             统一节奏）；text 去掉与 title 重复的「还没有笔记」开头 */
          <EmptyState
            icon="note"
            title="还没有笔记"
            text="看课时随手记一条，播放页按 N 打开笔记页签即可；笔记会自动带上当前播放时间。"
            action={
              <Button size="small" variant="ghost" icon="library" onClick={() => actions.setCenterView('library')}>
                查看笔记
              </Button>
            }
          />
        ) : (
          <>
            <div className="hdu-notestat-metrics">
              <span className="hdu-notestat-metric">
                <b>{stats.total}</b> 条笔记
              </span>
              <span className="hdu-notestat-metric is-recent">
                <b>+{stats.recent7}</b> 近 7 天新增
              </span>
            </div>
            {stats.topCourses.length > 0 ? (
              <div className="hdu-notestat-top" role="list" aria-label="有笔记的课程 Top3">
                {stats.topCourses.map((row, index) => (
                  <div className="hdu-notestat-row" role="listitem" key={row.key} title={`${row.label}：${row.count} 条笔记`}>
                    <span className="hdu-notestat-rank" aria-hidden="true">{index + 1}</span>
                    <span className="hdu-notestat-name">{row.label}</span>
                    <span className="hdu-notestat-count">{row.count}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="hdu-hint" style={{ marginTop: 8 }}>
                笔记都在 B 站视频上（外部笔记不按课程统计）。
              </div>
            )}
            <div className="hdu-notestat-foot">
              <button type="button" className="hdu-notestat-link" onClick={() => actions.setCenterView('library')}>
                查看笔记
              </button>
            </div>
            <div className="hdu-hint hdu-caliber-hint" style={{ marginTop: 8 }}>
              <span className="hdu-caliber-tag">口径</span>
              实时存活笔记（与成就徽章「笔记勤耕」同源） · 近 7 天按创建时间 · 课程 Top3 仅站内
            </div>
          </>
        )}
      </div>
    </div>
  );
}
