/**
 * 标签维度统计聚合（第 125 轮巡检）：每标签的收藏数 / 复习中收藏数 / 已完成收藏数。
 * 纯函数、防御式：脏行跳过不抛错；复习状态来自该收藏下的复习作业
 *（有 pending 计「复习中」，有 done 计「已完成」，两者可同时成立分列展示）。
 */

export interface TagStatRow {
  tag: string;
  /** 打该标签的收藏数 */
  favorites: number;
  /** 其中存在待完成复习作业的收藏数 */
  reviewing: number;
  /** 其中存在已完成复习作业的收藏数 */
  done: number;
}

interface FavLike {
  id?: unknown;
  tags?: unknown;
  /** 收藏快照（listTagDoneInWindow 取标题用） */
  snapshot?: unknown;
}

interface JobLike {
  favoriteId?: unknown;
  status?: unknown;
}

export function buildTagStats(
  favorites: Array<FavLike | null> | null | undefined,
  reviewJobs: Array<JobLike | null> | null | undefined,
  limit: number = 12,
): TagStatRow[] {
  const favs = Array.isArray(favorites) ? favorites : [];
  const jobs = Array.isArray(reviewJobs) ? reviewJobs : [];
  const stateByFav = new Map<string, { pending: boolean; done: boolean }>();
  for (const job of jobs) {
    if (!job || typeof job.favoriteId !== 'string' || !job.favoriteId) continue;
    const fid = job.favoriteId;
    const state = stateByFav.get(fid) ?? { pending: false, done: false };
    if (job.status === 'pending') state.pending = true;
    else if (job.status === 'done') state.done = true;
    stateByFav.set(fid, state);
  }
  const rows = new Map<string, TagStatRow>();
  for (const fav of favs) {
    const tags = Array.isArray(fav?.tags) ? fav.tags : [];
    const fid = typeof fav?.id === 'string' ? fav.id : '';
    const state = stateByFav.get(fid);
    for (const tag of tags) {
      if (typeof tag !== 'string' || !tag) continue;
      const row = rows.get(tag) ?? { tag, favorites: 0, reviewing: 0, done: 0 };
      row.favorites += 1;
      if (state?.pending) row.reviewing += 1;
      if (state?.done) row.done += 1;
      rows.set(tag, row);
    }
  }
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 12;
  return [...rows.values()]
    .sort((a, b) => (b.favorites !== a.favorites ? b.favorites - a.favorites : a.tag < b.tag ? -1 : 1))
    .slice(0, max);
}

/** 每标签最近一次复习完成时间（第 154 轮巡检）：done 作业按 updatedAt 取最新，经收藏映射到标签；
 *  纯函数、防御式：脏行跳过；无完成记录的标签不在结果中。 */
export function lastTagDoneAt(
  reviewJobs: Array<{ favoriteId?: unknown; status?: unknown; updatedAt?: unknown } | null> | null | undefined,
  favorites: Array<FavLike | null> | null | undefined,
): Map<string, number> {
  const jobs = Array.isArray(reviewJobs) ? reviewJobs : [];
  const favs = Array.isArray(favorites) ? favorites : [];
  const tagsByFav = new Map<string, string[]>();
  for (const fav of favs) {
    const fid = typeof fav?.id === 'string' && fav.id ? fav.id : null;
    const tags = Array.isArray(fav?.tags) ? fav.tags.filter((t): t is string => typeof t === 'string' && !!t) : [];
    if (fid && tags.length > 0) tagsByFav.set(fid, tags);
  }
  const latest = new Map<string, number>();
  for (const job of jobs) {
    if (!job || job.status !== 'done') continue;
    const fid = typeof job.favoriteId === 'string' && job.favoriteId ? job.favoriteId : null;
    if (!fid) continue;
    const ts = typeof job.updatedAt === 'number' && Number.isFinite(job.updatedAt) ? job.updatedAt : NaN;
    if (Number.isNaN(ts)) continue;
    for (const tag of tagsByFav.get(fid) ?? []) {
      const prev = latest.get(tag);
      if (prev === undefined || ts > prev) latest.set(tag, ts);
    }
  }
  return latest;
}

/** 标签统计 → CSV（第 127 轮巡检；第 132 轮起可附近 4 周趋势列；第 140 轮起可附健康度列；
 *  第 151 轮起可附未打标收藏行；第 152 轮起可附覆盖率元信息行；第 153 轮起元信息行可附目标状态；
 *  第 154 轮起可附最近完成列；第 157 轮起元信息行可附导出时间戳）：首行（可选）标签覆盖率,已打标/总数,百分比（,目标 G%,已达标/未达标）；
 *  表头 标签,收藏,复习中,已完成,完成率（,3 周前,2 周前,上周,本周,健康度,最近完成）；
 *  含逗号/引号/换行的标签按 RFC 4180 转义；健康度 = ⚠ 零完成（有完成记录但窗口内零完成）或 正常；
 *  未打标行仅计数提示——复习中/已完成/完成率/趋势/健康度/最近完成列留空（不适用）。 */
export function buildTagStatsCsv(
  rows: TagStatRow[] | null | undefined,
  trend?: Array<Array<{ tag: string; done: number }>> | null,
  staleTags?: string[] | null,
  untaggedCount?: number | null,
  coverage?: { tagged: number; total: number; pct: number; goal?: number; exportedAt?: string } | null,
  lastDone?: Map<string, number> | null,
  meta?: { sort?: string; filter?: string; goal?: string } | null,
): string {
  const list = Array.isArray(rows) ? rows : [];
  const weeks = Array.isArray(trend) ? trend : [];
  const stale = Array.isArray(staleTags) ? staleTags : null;
  const esc = (value: string): string => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0);
  // 最近完成列（第 154 轮巡检）：'MM/DD HH:mm' 短格式；无记录显示 —
  const stamp = (ts: number | undefined): string => {
    if (ts === undefined || !Number.isFinite(ts)) return '—';
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const lines: string[] = [];
  // 覆盖率元信息行（第 152 轮巡检）：合法输入时置于表头之前，离线留档可查；
  // 第 153 轮起设了目标（goal > 0）时附「目标 G%」与达标状态两列
  if (coverage && Number.isFinite(coverage.tagged) && Number.isFinite(coverage.total) && Number.isFinite(coverage.pct)) {
    const goal = num(coverage.goal);
    const goalCells = goal > 0 ? `,目标 ${goal}%,${coverage.pct >= goal ? '已达标' : '未达标'}` : '';
    // 导出时间戳（第 157 轮巡检）：可选，多份导出按时间归档
    const exportedAt = typeof coverage.exportedAt === 'string' && coverage.exportedAt.trim().length > 0 ? `,导出于 ${coverage.exportedAt.trim()}` : '';
    lines.push(`标签覆盖率,${Math.max(0, Math.floor(coverage.tagged))}/${Math.max(0, Math.floor(coverage.total))},${Math.round(coverage.pct)}%${goalCells}${exportedAt}`);
  }
  // 统计口径行（第 162 轮巡检）：附当前排序/筛选状态，离线留档可追溯；
  // 第 163 轮起附当时的覆盖率目标档位，完整还原导出语境
  const sortLabel = typeof meta?.sort === 'string' && meta.sort.trim().length > 0 ? meta.sort.trim() : '';
  const filterLabel = typeof meta?.filter === 'string' && meta.filter.trim().length > 0 ? meta.filter.trim() : '';
  const goalLabel = typeof meta?.goal === 'string' && meta.goal.trim().length > 0 ? meta.goal.trim() : '';
  if (sortLabel || filterLabel || goalLabel) {
    lines.push(
      `统计口径${sortLabel ? `,排序 ${sortLabel}` : ''}${filterLabel ? `,筛选 ${filterLabel}` : ''}${goalLabel ? `,${goalLabel}` : ''}`,
    );
  }
  lines.push(
    `标签,收藏,复习中,已完成,完成率${weeks.length > 0 ? ',3 周前,2 周前,上周,本周' : ''}${stale ? ',健康度' : ''}${lastDone ? ',最近完成' : ''}`,
  );
  for (const row of list) {
    if (!row || typeof row.tag !== 'string' || !row.tag) continue;
    const weekCells = weeks.map((week) => num(week?.find((entry) => entry?.tag === row.tag)?.done));
    const health = stale ? (stale.includes(row.tag) ? '⚠ 零完成' : '正常') : '';
    const rate = `${Math.round((num(row.done) / Math.max(1, num(row.favorites))) * 100)}%`;
    const lastCell = lastDone ? `,${stamp(lastDone.get(row.tag))}` : '';
    lines.push(
      `${esc(row.tag)},${num(row.favorites)},${num(row.reviewing)},${num(row.done)},${rate}${
        weekCells.length > 0 ? `,${weekCells.join(',')}` : ''
      }${stale ? `,${health}` : ''}${lastCell}`,
    );
  }
  // 未打标收藏行（第 151 轮巡检）：正整数时表尾追加；其余列按列数留空补齐对齐
  if (typeof untaggedCount === 'number' && Number.isFinite(untaggedCount) && untaggedCount > 0) {
    const blankCols = 3 + weeks.length + (stale ? 1 : 0) + (lastDone ? 1 : 0);
    lines.push(`⚠ 未打标收藏,${Math.floor(untaggedCount)}${','.repeat(blankCols)}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * 本周完成（第 129 轮巡检）：统计窗口内（按完成日 updatedAt 的本地日键，含首尾）
 * 每标签完成的复习项数。纯函数、防御式：脏行跳过；按完成数降序、同频字典序。
 */
export function countTagDoneInWindow(
  reviewJobs: Array<(JobLike & { updatedAt?: unknown }) | null> | null | undefined,
  favorites: Array<FavLike | null> | null | undefined,
  startDay: string,
  endDay: string,
): Array<{ tag: string; done: number }> {
  const jobs = Array.isArray(reviewJobs) ? reviewJobs : [];
  const favs = Array.isArray(favorites) ? favorites : [];
  if (typeof startDay !== 'string' || typeof endDay !== 'string' || !startDay || !endDay) return [];
  // favoriteId → 标签名集合
  const tagsByFav = new Map<string, string[]>();
  for (const fav of favs) {
    const fid = typeof fav?.id === 'string' && fav.id ? fav.id : null;
    const tags = Array.isArray(fav?.tags) ? fav.tags.filter((t): t is string => typeof t === 'string' && !!t) : [];
    if (fid && tags.length > 0) tagsByFav.set(fid, tags);
  }
  const counts = new Map<string, number>();
  for (const job of jobs) {
    if (!job || job.status !== 'done') continue;
    const fid = typeof job.favoriteId === 'string' && job.favoriteId ? job.favoriteId : null;
    if (!fid) continue;
    const tags = tagsByFav.get(fid);
    if (!tags || tags.length === 0) continue;
    const day = typeof job.updatedAt === 'number' && Number.isFinite(job.updatedAt) ? dayKeyOfTs(job.updatedAt) : '';
    if (!day || day < startDay || day > endDay) continue;
    for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, done]) => ({ tag, done }))
    .sort((a, b) => (b.done !== a.done ? b.done - a.done : a.tag < b.tag ? -1 : 1));
}

/** 本地时间戳 → 'YYYY-MM-DD'（与 core/shared/utils.localDayKey 同口径） */
function dayKeyOfTs(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 近期零完成的标签清单（第 158 轮巡检重构）：有完成记录（ever done）但窗口内（含今天）零完成
 *  的标签名列表，按最近完成时间升序（最久未复习在前，无记录视为最久）；纯函数、防御式。 */
export function listStaleTags(
  reviewJobs: Array<{ favoriteId?: unknown; status?: unknown; updatedAt?: unknown } | null> | null | undefined,
  favorites: Array<FavLike | null> | null | undefined,
  now: number,
  windowDays: number = 28,
): string[] {
  const jobs = Array.isArray(reviewJobs) ? reviewJobs : [];
  const favs = Array.isArray(favorites) ? favorites : [];
  const endDay = dayKeyOfTs(now);
  const startDay = dayKeyOfTs(now - Math.max(1, Math.floor(windowDays)) * 86_400_000);
  if (!endDay || !startDay) return [];
  const tagsByFav = new Map<string, string[]>();
  for (const fav of favs) {
    if (!fav) continue;
    const fid = typeof fav.id === 'string' && fav.id ? fav.id : null;
    if (!fid) continue;
    const tags = Array.isArray(fav.tags) ? fav.tags.filter((t): t is string => typeof t === 'string' && !!t) : [];
    if (tags.length > 0) tagsByFav.set(fid, tags);
  }
  const everDone = new Set<string>();
  const recentDone = new Set<string>();
  const lastDone = new Map<string, number>();
  for (const job of jobs) {
    if (!job || job.status !== 'done') continue;
    const fid = typeof job.favoriteId === 'string' && job.favoriteId ? job.favoriteId : null;
    if (!fid) continue;
    const tags = tagsByFav.get(fid);
    if (!tags || tags.length === 0) continue;
    const ts = typeof job.updatedAt === 'number' && Number.isFinite(job.updatedAt) ? job.updatedAt : NaN;
    const day = Number.isNaN(ts) ? '' : dayKeyOfTs(ts);
    for (const tag of tags) {
      everDone.add(tag);
      if (day && day >= startDay && day <= endDay) recentDone.add(tag);
      if (!Number.isNaN(ts)) {
        const prev = lastDone.get(tag);
        if (prev === undefined || ts > prev) lastDone.set(tag, ts);
      }
    }
  }
  const stale: string[] = [];
  for (const tag of everDone) if (!recentDone.has(tag)) stale.push(tag);
  return stale.sort((a, b) => (lastDone.get(a) ?? 0) - (lastDone.get(b) ?? 0) || (a < b ? -1 : 1));
}

/** 近期零完成的标签数（第 141 轮巡检；第 158 轮起复用 listStaleTags） */
export function countStaleTags(
  reviewJobs: Array<{ favoriteId?: unknown; status?: unknown; updatedAt?: unknown } | null> | null | undefined,
  favorites: Array<FavLike | null> | null | undefined,
  now: number,
  windowDays: number = 28,
): number {
  return listStaleTags(reviewJobs, favorites, now, windowDays).length;
}

/** 某标签某周窗口的完成明细行（趋势柱点选查看，第 134 轮巡检；第 146 轮增轮次/到期日/标签） */
export interface TagDoneItem {
  /** 收藏标题（快照缺失时占位） */
  title: string;
  /** 完成时间短格式 'MM/DD HH:mm' */
  doneAt: string;
  /** 完成时间戳（排序用） */
  ts: number;
  /** 复习轮次（作业缺失时 null） */
  round: number | null;
  /** 到期日 'YYYY-MM-DD' */
  dueDate: string;
  /** 收藏标签 */
  tags: string[];
}

/** 某标签在某周窗口（本地日键，含首尾）内完成的作业明细。纯函数、防御式；按完成时间降序。 */
export function listTagDoneInWindow(
  reviewJobs: Array<{ favoriteId?: unknown; status?: unknown; updatedAt?: unknown; round?: unknown; dueDate?: unknown; favorite?: { snapshot?: { title?: unknown } } | null } | null> | null | undefined,
  favorites: Array<FavLike | null> | null | undefined,
  tag: string,
  startDay: string,
  endDay: string,
): TagDoneItem[] {
  const jobs = Array.isArray(reviewJobs) ? reviewJobs : [];
  const favs = Array.isArray(favorites) ? favorites : [];
  const tagTrim = typeof tag === 'string' ? tag.trim() : '';
  if (!tagTrim || typeof startDay !== 'string' || typeof endDay !== 'string' || !startDay || !endDay) return [];
  const titleByFav = new Map<string, string>();
  const tagsByFav = new Map<string, string[]>();
  for (const fav of favs) {
    if (!fav) continue;
    const fid = typeof fav.id === 'string' && fav.id ? fav.id : null;
    if (!fid) continue;
    const tags = Array.isArray(fav.tags) ? fav.tags.filter((t): t is string => typeof t === 'string' && !!t) : [];
    if (!tags.includes(tagTrim)) continue;
    const snap = fav.snapshot as { title?: unknown } | null | undefined;
    const title = typeof snap?.title === 'string' && snap.title.trim().length > 0 ? snap.title : '（收藏已删除）';
    titleByFav.set(fid, title);
    tagsByFav.set(fid, tags);
  }
  const asNum = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  const out: TagDoneItem[] = [];
  for (const job of jobs) {
    if (!job || job.status !== 'done') continue;
    const fid = typeof job.favoriteId === 'string' && job.favoriteId ? job.favoriteId : null;
    if (!fid || !titleByFav.has(fid)) continue;
    const ts = typeof job.updatedAt === 'number' && Number.isFinite(job.updatedAt) ? job.updatedAt : NaN;
    const day = Number.isNaN(ts) ? '' : dayKeyOfTs(ts);
    if (!day || day < startDay || day > endDay) continue;
    const stamp = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, '0');
    out.push({
      title: titleByFav.get(fid) ?? '（收藏已删除）',
      doneAt: `${day.slice(5).replace('-', '/')} ${pad(stamp.getHours())}:${pad(stamp.getMinutes())}`,
      ts,
      round: asNum(job.round),
      dueDate: typeof job.dueDate === 'string' ? job.dueDate : '',
      tags: tagsByFav.get(fid) ?? [],
    });
  }
  return out.sort((a, b) => b.ts - a.ts);
}

/**
 * 近 N 周标签完成趋势（第 144 轮巡检）：按本地周一为界滚动 N 周（旧 → 新），
 * 每周调用 countTagDoneInWindow。纯函数、防御式；weeks clamp 1..24。
 * 零完成的周返回空数组（调用方按 find ?? 0 兜底）。
 */
export function computeTagTrend(
  reviewJobs: Array<{ favoriteId?: unknown; status?: unknown; updatedAt?: unknown } | null> | null | undefined,
  favorites: Array<FavLike | null> | null | undefined,
  now: number,
  weeks: number,
): Array<Array<{ tag: string; done: number }>> {
  const total = Math.max(1, Math.min(24, Math.floor(Number.isFinite(weeks) ? weeks : 4)));
  const base = new Date(now);
  const day = (base.getDay() + 6) % 7;
  const trend: Array<Array<{ tag: string; done: number }>> = [];
  for (let w = total - 1; w >= 0; w -= 1) {
    const monday = new Date(base.getFullYear(), base.getMonth(), base.getDate() - day - w * 7);
    const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
    trend.push(countTagDoneInWindow(reviewJobs, favorites, dayKeyOfTs(monday.getTime()), dayKeyOfTs(sunday.getTime())));
  }
  return trend;
}
