/**
 * 学习成就速览条（第 127 轮巡检总览新增；第 130 轮抽为共享组件）：
 * 已解锁 X/N + 最近徽章 chips + 距下一枚徽章提示。
 * 数据自取（stats.report / review.list / fav.list / note.listAll 现取，失败按 0），
 * 不依赖宿主视图的数据包——HDU 总览与 B 站学习中心面板可同挂。
 */
import { useEffect, useMemo, useState } from 'react';
import { callOp } from '@/core/shared/client';
import { loadSettings } from '@/core/shared/settings';
import { isDemoActive } from '@/core/demo';
import { buildAchievements } from '@/core/plan/achievements';
import { uiStore } from '../store';
import { Button, Progress } from '../components';

/** 成就计数现取 hook（第 130 轮抽共享；第 131 轮供今日卡角标等更多宿主复用）：
 *  stats.report + review.list + fav.list + note.listAll 现取，失败按 0；
 *  第 133 轮起连同成就目标倍率（settings.achievementGoalScale）一并返回；
 *  第 252 轮口径核对：站外秒数改用 externalTotalSec（与 totalSec 同为流水取数
 *  窗口累计），旧快照缺省回退 externalSeconds（展示窗口口径，防御兜底） */
export function useAchievementCounts() {
  const [counts, setCounts] = useState({
    reviewDone: 0,
    totalSec: 0,
    externalSec: 0,
    streakDays: 0,
    favorites: 0,
    notes: 0,
    goalScale: 1,
    weeklyGoalHit: false,
    customBadges: [] as Array<{ id: string; name: string; metric: string; threshold: number }>,
  });
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [jobs, dash, favs, notes, settings] = await Promise.all([
          callOp('review.list', {}),
          callOp('stats.report', {}),
          callOp('fav.list', {}),
          callOp('note.listAll', {}),
          loadSettings().catch(() => null),
        ]);
        if (!cancelled) {
          setCounts({
            reviewDone: Array.isArray(jobs) ? jobs.filter((job) => job.status === 'done').length : 0,
            totalSec: dash?.totalSec ?? 0,
            externalSec: dash?.externalTotalSec ?? dash?.externalSeconds ?? 0,
            streakDays: dash?.streakDays ?? 0,
            favorites: Array.isArray(favs) ? favs.length : 0,
            notes: Array.isArray(notes) ? notes.length : 0,
            goalScale: settings?.achievementGoalScale ?? 1,
            // 本周亮点联动（第 252 轮口径核对收官）：判定式与 weeklyHighlight ① 档
            // （targetSec > 0 && weekSec >= targetSec）逐字同线，数据零新增
            weeklyGoalHit:
              (dash?.goal?.weeklyTargetSec ?? 0) > 0 && (dash?.weekSec ?? 0) >= (dash?.goal?.weeklyTargetSec ?? 0),
            customBadges: Array.isArray(settings?.ui?.customAchievements) ? settings.ui.customAchievements : [],
          });
        }
      } catch {
        /* 统计失败按 0 处理 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return counts;
}

/** 首次解锁时间登记（第 135 轮巡检）：把新解锁的徽章 id 记入 settings.ui.achievementUnlockedAt
 *  （已有记录的 id 不改写；无新增不写库）。供成就条与统计页成就卡共用。
 *  演示模式（第 319 轮）：演示期间解锁只进内存视图，不落 settings——真实成就时间线不被演示数据污染。 */
export function recordAchievementUnlocks(ids: string[]): void {
  if (ids.length === 0) return;
  const settings = uiStore.getState().settings;
  const existing = settings.ui?.achievementUnlockedAt ?? {};
  const next = { ...existing };
  let changed = false;
  for (const id of ids) {
    if (!(id in next)) {
      next[id] = Date.now();
      changed = true;
    }
  }
  if (!changed) return;
  void isDemoActive().then((demo) => {
    if (demo) return;
    const ui = { ...settings.ui, achievementUnlockedAt: next };
    uiStore.patch({ settings: { ...settings, ui } });
    void uiStore.actions.saveSetting('ui', ui);
  });
}

export function AchievementStrip({ onViewAll }: { onViewAll?: () => void }) {
  const counts = useAchievementCounts();
  const achievementRows = useMemo(
    () =>
      buildAchievements({
        totalSec: counts.totalSec,
        streakDays: counts.streakDays,
        favoriteCount: counts.favorites,
        externalSec: counts.externalSec,
        reviewDoneCount: counts.reviewDone,
        noteCount: counts.notes,
        goalScale: counts.goalScale,
        customBadges: counts.customBadges,
      }),
    [counts],
  );
  const unlockedBadges = useMemo(() => achievementRows.filter((row) => row.unlocked), [achievementRows]);
  // 距下一枚徽章（第 129 轮巡检）：未解锁中进度最高者，给出剩余量提示
  const nextBadge = useMemo(
    () => achievementRows.filter((row) => !row.unlocked).sort((a, b) => b.progress - a.progress)[0] ?? null,
    [achievementRows],
  );
  // 首次解锁时间登记（第 135 轮巡检）：新解锁徽章记录时间戳（settings.ui.achievementUnlockedAt，时间线用）
  useEffect(() => {
    recordAchievementUnlocks(achievementRows.filter((row) => row.unlocked).map((row) => row.id));
  }, [achievementRows]);
  return (
    <div className="hdu-card pad hdu-achv-strip">
      <div className="hdu-achv-strip-head">
        <span className="hdu-achv-strip-title">
          {unlockedBadges.length > 0 && unlockedBadges.length === achievementRows.length
            ? '🏅 学习成就 · 全部解锁 🎉'
            : `🏅 学习成就 · 已解锁 ${unlockedBadges.length}/${achievementRows.length}`}
        </span>
        {onViewAll ? (
          <Button size="small" variant="ghost" onClick={onViewAll}>
            查看成就
          </Button>
        ) : null}
      </div>
      <div className="hdu-achv-strip-row">
        {unlockedBadges.length > 0 ? (
          unlockedBadges.slice(-4).map((row) => (
            <span key={row.id} className="hdu-achv-chip" title={row.desc}>
              🏅 {row.name}
            </span>
          ))
        ) : (
          <span className="hdu-hint">还没有解锁徽章——先从「连续学习 3 天」开始。</span>
        )}
      </div>
      <div className="hdu-hint">
        {nextBadge
          ? `距下一枚徽章「${nextBadge.name}」还差 ${Math.max(0, nextBadge.threshold - nextBadge.value)} ${nextBadge.unit}`
          : '全部徽章已解锁 🎉'}
      </div>
      {/* 距下一枚进度（第 140 轮巡检）：进度条可视化 */}
      {nextBadge ? <Progress value={nextBadge.progress} jade /> : null}
      {/* 本周亮点联动（第 252 轮口径核对收官，激励域 / 一致性视角）：本周达成周目标时
          在进度条 foot 补一句 jade 联动提示——「累计学习」类徽章（min-30 / hour-1 /
          hour-3）的分子与周目标同一份 valid 流水，本周达标即距下一枚更近一步。
          纯展示联动：数据全部来自 hook 已取的 dash 字段（weekSec / goal.weeklyTargetSec），
          零新增 op；判定式与 buildWeeklyHighlight ① 档同线（见 useAchievementCounts）。 */}
      {counts.weeklyGoalHit ? (
        <div className="hdu-achv-weekly-link" role="status">⭐ 本周已达成周目标——距下一枚徽章又近一步 ✅</div>
      ) : null}
    </div>
  );
}
