/**
 * 笔记导出序列化（第 106 轮巡检）：当前视频/课次的时间点笔记 → Markdown。
 * 纯函数、防御式：非数组/空文本笔记跳过；按锚点升序（无锚点排最后）；
 * 输入取最小结构 { text, anchorTime? }，HDU NoteEntity 与 B 站 ExternalNoteEntity 通用。
 */

interface NoteLike {
  text?: unknown;
  anchorTime?: unknown;
}

function formatClockOf(sec: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** 清洗 + 按锚点升序（无锚点排尾）；空文本/非对象项跳过 */
function sanitizeNotes(notes: NoteLike[] | null | undefined): Array<{ text: string; anchorTime: number | null }> {
  return (Array.isArray(notes) ? notes : [])
    .filter((note) => note && typeof note.text === 'string' && (note.text as string).trim().length > 0)
    .map((note) => ({
      text: note.text as string,
      anchorTime: typeof note.anchorTime === 'number' && Number.isFinite(note.anchorTime) ? note.anchorTime : null,
    }))
    .sort((a, b) => (a.anchorTime ?? Number.MAX_SAFE_INTEGER) - (b.anchorTime ?? Number.MAX_SAFE_INTEGER));
}

function noteLine(anchorTime: number | null, text: string, bullet: boolean): string {
  if (anchorTime === null) return bullet ? `- ${text}` : `## ${text}`;
  const clock = formatClockOf(anchorTime);
  return bullet ? `- [${clock}] ${text}` : `## [${clock}] ${text}`;
}

export function buildNotesMarkdown(notes: NoteLike[] | null | undefined, title: string): string {
  const list = sanitizeNotes(notes);
  const lines: string[] = [`# 学习笔记 · ${title}`, '', `- 笔记数：${list.length}`, '', '> 导出自智慧课堂学习助手', ''];
  for (const note of list) {
    lines.push(noteLine(note.anchorTime, note.text, false));
  }
  return `${lines.join('\n')}\n`;
}

/** 分组汇编（第 109 轮巡检）：按课程/视频分组的笔记导出（组内锚点升序，空组剔除） */
export function buildGroupedNotesMarkdown(
  groups: Array<{ label: unknown; notes: NoteLike[] }> | null | undefined,
  title: string,
): string {
  const clean = (Array.isArray(groups) ? groups : [])
    .map((group) => ({
      label: typeof group?.label === 'string' && group.label.trim().length > 0 ? group.label : '其他',
      notes: sanitizeNotes(group?.notes),
    }))
    .filter((group) => group.notes.length > 0);
  const total = clean.reduce((sum, group) => sum + group.notes.length, 0);
  const lines: string[] = [`# 学习笔记 · ${title}`, '', `- 笔记数：${total}（${clean.length} 个分组）`, '', '> 导出自智慧课堂学习助手', ''];
  for (const group of clean) {
    lines.push(`## ${group.label}（${group.notes.length}）`, '');
    for (const note of group.notes) {
      lines.push(noteLine(note.anchorTime, note.text, true));
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
