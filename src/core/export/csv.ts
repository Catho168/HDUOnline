/**
 * 收藏清单 CSV 导出（第 92 轮巡检）：纯函数版清单序列化，列口径与 SW 侧
 * exportListCsv（core/export/exporters.ts）完全一致；供学习中心知识库 /
 * B 站学习中心在页面内直接下载（Blob + a[download]，不经 exportJobs 通道）。
 */

import type { FavoriteEntity } from '../shared/types';

export function favoriteTypeLabel(type: string): string {
  switch (type) {
    case 'time':
      return '时间点';
    case 'ai':
      return 'AI 回答';
    case 'outline':
      return '大纲节点';
    case 'screenshot':
      return '截图';
    case 'note':
      return '笔记';
    default:
      return '收藏';
  }
}

function csvCell(value: unknown): string {
  const str = value === undefined || value === null ? '' : String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

/** 收藏列表 → CSV 文本（BOM 头让 Excel 正确识别 UTF-8；CRLF 行尾） */
export function buildFavoritesCsv(favorites: FavoriteEntity[]): string {
  const header = ['类型', '标题', '内容摘要', '课程ID', '课次ID', '时间点(秒)', '标签', '备注', '收藏时间'];
  const rows = (Array.isArray(favorites) ? favorites : []).map((f) => [
    favoriteTypeLabel(f.type),
    f.snapshot.title,
    f.snapshot.content.replace(/\s+/g, ' ').slice(0, 200),
    f.teclId ?? '',
    f.courId ?? '',
    f.anchorTime !== undefined ? Math.floor(f.anchorTime) : '',
    f.tags.join('|'),
    f.note ?? '',
    new Date(f.favoritedAt).toLocaleString('zh-CN'),
  ]);
  return `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}`;
}
