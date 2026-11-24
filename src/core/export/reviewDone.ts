/**
 * 复习完成记录导出序列化（第 110 轮巡检）：学习中心复习计划「已完成」分区
 * 一键导出 Markdown。纯函数、防御式：脏行跳过，按完成时间降序。
 */

interface DoneRow {
  title?: unknown;
  round?: unknown;
  dueDate?: unknown;
  updatedAt?: unknown;
}

function asString(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : '';
}

function asNum(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function shortStamp(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function buildReviewDoneMarkdown(rows: DoneRow[] | null | undefined, title: string): string {
  const list = (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      title: asString(row?.title) || '（收藏已删除）',
      round: asNum(row?.round),
      dueDate: asString(row?.dueDate),
      updatedAt: asNum(row?.updatedAt),
    }))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const lines: string[] = [`# 复习完成记录 · ${title}`, '', `- 完成轮次：${list.length}`, '', '> 导出自智慧课堂学习助手', ''];
  for (const row of list) {
    const parts = [
      row.round !== null ? `第 ${row.round} 轮` : null,
      row.dueDate ? `到期 ${row.dueDate}` : null,
      row.updatedAt !== null ? `完成于 ${shortStamp(row.updatedAt)}` : null,
    ].filter(Boolean);
    lines.push(`- ${row.title}${parts.length > 0 ? `（${parts.join(' · ')}）` : ''}`);
  }
  return `${lines.join('\n')}\n`;
}
