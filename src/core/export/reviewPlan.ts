/**
 * 复习计划整页导出序列化（第 124 轮巡检）：学习中心复习计划三分区
 * （待完成 / 已完成 / 已跳过，按当前筛选）一键导出 Markdown。
 * 纯函数、防御式：脏行跳过不抛错；待完成按到期日升序，已完成按完成时间降序。
 */

interface PlanRow {
  title?: unknown;
  round?: unknown;
  dueDate?: unknown;
  template?: unknown;
  updatedAt?: unknown;
  /** 收藏标签（第 133 轮巡检：导出行附标签列） */
  tags?: unknown;
  /** 课程名（第 137 轮巡检：待完成按课程分组） */
  course?: unknown;
}

export interface ReviewPlanExportInput {
  pending?: PlanRow[] | null;
  done?: PlanRow[] | null;
  skipped?: PlanRow[] | null;
  /** 页面标题（如「复习计划」），缺省「复习计划」 */
  title?: unknown;
  /** 筛选说明（UI 层拼好的一段文字，如「类型=全部 · 关键词=无」）；空则不输出该行 */
  filtersNote?: unknown;
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

function templateLabel(value: unknown): string {
  const t = asString(value);
  if (!t) return '';
  return t === 'regular' ? '常规' : t === 'exam' ? '考试' : '自定义';
}

/** 单行：- 标题（第 X 轮 · 到期 D · 附加片段… · 标签：a、b） */
function rowLine(row: PlanRow, extras: string[]): string {
  const tags = Array.isArray(row.tags)
    ? row.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
    : [];
  const parts = [
    asNum(row.round) !== null ? `第 ${row.round} 轮` : null,
    asString(row.dueDate) ? `到期 ${row.dueDate}` : null,
    ...extras,
    tags.length > 0 ? `标签：${tags.join('、')}` : null,
  ].filter(Boolean);
  return `- ${asString(row.title) || '（收藏已删除）'}${parts.length > 0 ? `（${parts.join(' · ')}）` : ''}`;
}

function rowsOf(value: PlanRow[] | null | undefined): PlanRow[] {
  return Array.isArray(value) ? value.filter((row) => row && typeof row === 'object') : [];
}

export function buildReviewPlanMarkdown(input: ReviewPlanExportInput | null | undefined): string {
  const title = asString(input?.title) || '复习计划';
  const pending = rowsOf(input?.pending).sort((a, b) =>
    asString(a.dueDate).localeCompare(asString(b.dueDate)),
  );
  const done = rowsOf(input?.done)
    .map((row) => ({ row, updatedAt: asNum(row.updatedAt) ?? 0 }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((entry) => entry.row);
  const skipped = rowsOf(input?.skipped).sort((a, b) =>
    asString(a.dueDate).localeCompare(asString(b.dueDate)),
  );
  const filtersNote = asString(input?.filtersNote);

  const lines: string[] = [
    `# 复习计划 · ${title}`,
    '',
    `- 待完成 ${pending.length} · 已完成 ${done.length} · 已跳过 ${skipped.length}`,
  ];
  // 完成率汇总行（第 130 轮巡检）：已完成 / 全部作业（含跳过）
  const total = pending.length + done.length + skipped.length;
  if (total > 0) {
    lines.push(`- 完成率：${Math.round((done.length / total) * 100)}%（${done.length}/${total}）`);
  }
  if (filtersNote) lines.push(`- 筛选：${filtersNote}`);
  lines.push('', '> 导出自智慧课堂学习助手', '');

  lines.push(`## 待完成（${pending.length}，按到期日升序）`, '');
  if (pending.length === 0) lines.push('（无）', '');
  const pendingExtras = (row: PlanRow): string[] => {
    const extras: string[] = [];
    const label = templateLabel(row.template);
    if (label) extras.push(label);
    return extras;
  };
  // 按课程分组（第 137 轮巡检；第 138 轮扩到已完成/已跳过）：任一分区任一行带课程名时
  // 三分区均分组呈现（组内保持各自排序，未分课程殿后）；全部无课程名时保持平铺列表
  const groupByCourse = (rows: PlanRow[]): Array<[string, PlanRow[]]> => {
    const groups = new Map<string, PlanRow[]>();
    for (const row of rows) {
      const course = asString(row.course) || '未分课程';
      const list = groups.get(course) ?? [];
      list.push(row);
      groups.set(course, list);
    }
    return [...groups.entries()].sort((a, b) => (a[0] === '未分课程' ? 1 : b[0] === '未分课程' ? -1 : 0));
  };
  const hasCourse =
    pending.some((row) => asString(row.course)) ||
    done.some((row) => asString(row.course)) ||
    skipped.some((row) => asString(row.course));
  const emitRows = (rows: PlanRow[], extrasOf: (row: PlanRow) => string[]): void => {
    if (!hasCourse) {
      for (const row of rows) lines.push(rowLine(row, extrasOf(row)));
      if (rows.length > 0) lines.push('');
      return;
    }
    for (const [course, groupRows] of groupByCourse(rows)) {
      lines.push(`### ${course}（${groupRows.length}）`, '');
      for (const row of groupRows) lines.push(rowLine(row, extrasOf(row)));
      lines.push('');
    }
  };

  lines.push(`## 待完成（${pending.length}，按到期日升序）`, '');
  if (pending.length === 0) lines.push('（无）', '');
  emitRows(pending, pendingExtras);

  lines.push(`## 已完成（${done.length}，按完成时间降序）`, '');
  if (done.length === 0) lines.push('（无）', '');
  emitRows(done, (row) => {
    const updatedAt = asNum(row.updatedAt);
    return updatedAt !== null ? [`完成于 ${shortStamp(updatedAt)}`] : [];
  });

  lines.push(`## 已跳过（${skipped.length}，按到期日升序）`, '');
  if (skipped.length === 0) lines.push('（无）', '');
  emitRows(skipped, () => []);

  return `${lines.join('\n')}\n`;
}
