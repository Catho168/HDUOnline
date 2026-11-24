/**
 * 复习卡片导出（第 37 轮巡检）：从 HDU 学习中心 LibraryView 的内联 exportCards
 * 抽出的可复用实现，HDU 学习中心与 B 站学习中心面板（BiliHubPanel）共用同一份
 * md 口径与下载方式，两端行为一致。
 *
 *  - buildReviewCardsMarkdown：纯函数，收藏列表 → 复习卡片 md 文本（标题/正文/
 *    备注/时间点/类型行，与既有 HDU 内联实现逐行同构）；类型中文标签取
 *    FAVORITE_META 唯一来源，不在此处复制一份；
 *  - downloadTextFile：第 239 轮起收敛为单点实现——原内联（Blob → objectURL →
 *    <a download> 点击、无清理保证）上收至 ./download（临时 append + click +
 *    try/finally 清理 + 延迟 revoke），此处同名 re-export 兼容旧引用（BiliHubPanel
 *    收藏清单 CSV 等调用点行为不变、仅下载实现升级）；
 *  - exportReviewCards：生成 + 下载 + 成功 toast 的组合入口，文件名沿用既有
 *    「智慧课堂-复习卡片-<本地日键>.md」口径。
 */

import type { FavoriteEntity } from '@/core/shared/types';
import { formatClock, localDayKey } from '@/core/shared/utils';
import { FAVORITE_META } from './VideoFavCard';
import { pushToast } from './components';
import { downloadTextFile } from './download';

// 第 239 轮起收敛为 ./download 单点实现，同名 re-export 兼容旧引用（BiliHubPanel CSV 等）
export { downloadTextFile };

/** 纯函数：收藏列表 → 复习卡片 md 文本（对入参只读，不改序不排序——筛选/排序由调用方完成） */
export function buildReviewCardsMarkdown(favorites: readonly FavoriteEntity[]): string {
  const lines: string[] = ['# 智慧课堂复习卡片', ''];
  for (const fav of favorites) {
    lines.push(`## ${fav.snapshot.title}`, '', fav.snapshot.content, '');
    if (fav.note) lines.push(`> ${fav.note}`, '');
    if (fav.anchorTime != null) lines.push(`- 时间点：${formatClock(fav.anchorTime)}`);
    lines.push(`- 类型：${FAVORITE_META[fav.type].label}`, '');
  }
  return lines.join('\n');
}

/** 组合入口：对给定收藏列表生成复习卡片 md 并触发下载，成功后提示（两端同文案） */
export function exportReviewCards(favorites: readonly FavoriteEntity[]): void {
  downloadTextFile(`智慧课堂-复习卡片-${localDayKey()}.md`, buildReviewCardsMarkdown(favorites));
  pushToast('复习卡片已导出', 'success');
}
