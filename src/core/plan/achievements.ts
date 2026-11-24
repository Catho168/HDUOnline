/**
 * 学习成就徽章（第 125 轮巡检）：由既有统计量（累计有效学习秒数 / 当前连续天数 /
 * 知识库收藏数 / 站外学习秒数）推导徽章清单与进度。
 * 纯函数、防御式：非法输入按 0 处理，不抛错。
 */

export interface AchievementBadge {
  id: string;
  name: string;
  desc: string;
  /** 是否已达成 */
  unlocked: boolean;
  /** 达成进度 0..1（已达成恒 1） */
  progress: number;
  /** 当前值（按徽章口径换算后的展示值） */
  value: number;
  /** 达成阈值 */
  threshold: number;
  /** 进度展示单位 */
  unit: '天' | '分钟' | '个';
  /** 展示图标（emoji；预置徽章缺省 🏅，自定义徽章可选） */
  icon?: string;
}

export interface AchievementInput {
  /** 累计有效学习秒数（站内口径） */
  totalSec?: unknown;
  /** 当前连续学习天数 */
  streakDays?: unknown;
  /** 知识库收藏数 */
  favoriteCount?: unknown;
  /** 站外视频学习秒数 */
  externalSec?: unknown;
  /** 已完成复习作业数（第 126 轮巡检新增维度） */
  reviewDoneCount?: unknown;
  /** 笔记条数（第 126 轮巡检新增维度） */
  noteCount?: unknown;
  /** 成就目标倍率（第 133 轮巡检：1=标准；设置中可调 1.5/2 等挑战档） */
  goalScale?: unknown;
  /** 自定义徽章（第 139 轮巡检：用户在设置中自建，阈值按同一倍率缩放） */
  customBadges?: unknown;
}

function asNum(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

export function buildAchievements(input: AchievementInput | null | undefined): AchievementBadge[] {
  const totalSec = asNum(input?.totalSec);
  const streakDays = asNum(input?.streakDays);
  const favoriteCount = asNum(input?.favoriteCount);
  const externalSec = asNum(input?.externalSec);
  const reviewDoneCount = asNum(input?.reviewDoneCount);
  const noteCount = asNum(input?.noteCount);
  const totalMin = Math.floor(totalSec / 60);
  const externalMin = Math.floor(externalSec / 60);
  // 目标倍率（第 133 轮巡检）：设置可调（1=标准）；非法/过小回退 1，上限 5
  const rawScale = asNum(input?.goalScale);
  const goalScale = rawScale >= 1 ? Math.min(5, rawScale) : 1;
  const badge = (
    id: string,
    name: string,
    desc: string,
    value: number,
    threshold: number,
    unit: AchievementBadge['unit'],
  ): AchievementBadge => {
    const target = Math.max(1, Math.round(threshold * goalScale));
    return {
      id,
      name,
      desc,
      unlocked: value >= target,
      progress: Math.max(0, Math.min(1, target > 0 ? value / target : 0)),
      value,
      threshold: target,
      unit,
    };
  };
  // 自定义徽章（第 139 轮巡检）：设置中自建（名称 + 维度 + 阈值），阈值同受目标倍率缩放；
  // id 加 custom- 前缀与预置徽章区分，非法项跳过、重复 id 去重
  const metricValues: Record<string, number> = {
    streak: streakDays,
    totalMin,
    externalMin,
    favorites: favoriteCount,
    reviewDone: reviewDoneCount,
    notes: noteCount,
  };
  const customRows: AchievementBadge[] = [];
  const seenCustomIds = new Set<string>();
  const customList = Array.isArray(input?.customBadges) ? input!.customBadges : [];
  for (const raw of customList) {
    const item = raw as { id?: unknown; name?: unknown; metric?: unknown; threshold?: unknown; icon?: unknown } | null;
    const rawId = typeof item?.id === 'string' && item.id.trim().length > 0 ? item.id.trim() : '';
    const name = typeof item?.name === 'string' && item.name.trim().length > 0 ? item.name.trim() : '';
    const metric = typeof item?.metric === 'string' && item.metric in metricValues ? item.metric : '';
    const threshold = asNum(item?.threshold);
    const icon = typeof item?.icon === 'string' && item.icon.trim().length > 0 ? item.icon.trim() : '';
    if (!rawId || !name || !metric || threshold <= 0 || seenCustomIds.has(rawId)) continue;
    seenCustomIds.add(rawId);
    const value = metricValues[metric] ?? 0;
    const target = Math.max(1, Math.round(threshold * goalScale));
    customRows.push({
      id: `custom-${rawId}`,
      name,
      desc: `自定义目标：${name}`,
      unlocked: value >= target,
      progress: Math.max(0, Math.min(1, value / target)),
      value,
      threshold: target,
      unit: metric === 'streak' ? '天' : metric === 'totalMin' || metric === 'externalMin' ? '分钟' : '个',
      icon: icon || '🏅',
    });
  }
  return [
    badge('streak-3', '养成习惯', '连续学习满 3 天', streakDays, 3, '天'),
    badge('streak-7', '恒心毅力', '连续学习满 7 天', streakDays, 7, '天'),
    badge('min-30', '半小时俱乐部', '累计有效学习满 30 分钟', totalMin, 30, '分钟'),
    badge('hour-1', '一小时选手', '累计有效学习满 1 小时', totalMin, 60, '分钟'),
    badge('hour-3', '三小时大师', '累计有效学习满 3 小时', totalMin, 180, '分钟'),
    badge('fav-10', '知识收藏家', '知识库收藏满 10 个', favoriteCount, 10, '个'),
    badge('external-10', '双线学习', '站外视频学习满 10 分钟', externalMin, 10, '分钟'),
    badge('review-10', '复习达人', '完成复习满 10 项', reviewDoneCount, 10, '个'),
    badge('note-5', '笔记勤耕', '积累笔记满 5 条', noteCount, 5, '个'),
    ...customRows,
  ];
}
