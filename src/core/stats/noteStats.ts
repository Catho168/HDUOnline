/**
 * 笔记统计聚合（第 240 轮巡检，纯函数无 IO）：
 * 供统计页「笔记」小卡使用——总数 / 近 7 天新增 / 有笔记的课程 Top3。
 *
 * 口径（与既有统计对齐）：
 *  - 总数 = 实时存活笔记（deletedAt 为空）条数，与成就徽章「笔记勤耕」同源
 *    （AchievementStrip 走 note.listAll 现取长度，note.listAll 内部即按 isLive 过滤，
 *    本函数对 deletedAt 再防御一层，两端口径一致）；
 *  - 近 7 天新增 = createdAt 落在 (now - 7 天, now] 的笔记数——「新增」按**创建时间**
 *    计（updatedAt 会随编辑漂移，不能代表新增）；窗口含 now 端点、不含 7 天前端点；
 *    未来时间戳（createdAt > now，时钟漂移防御）不计入；
 *  - 课程 Top3 = 站内课程笔记（courId 有效）按条数分组取前 3，并列按课程名
 *    zh-Hans-CN 字典序取序（稳定、不随机）；B 站等外部笔记（mediaKey，无课程归属）
 *    计入总数与新增，但不进课程行。
 *
 * 防御式：notes 非数组 / 字段非法一律跳过或按 0，不抛错（与 buildReviewWeekColumns
 * 等聚合函数同约定）。
 */

/** 近 7 天新增窗口（自然日口径：7 × 24h 毫秒窗口，锁定于单测） */
export const NOTE_RECENT_WINDOW_MS = 7 * 86_400_000;

/** 有笔记的课程行（Top3 元素） */
export interface NoteStatsCourseRow {
  /** 分组键：courId 字符串形态 */
  key: string;
  /** 展示名：courseNames[courId] 优先，缺失回退「课程 #<id>」 */
  label: string;
  /** 该课程笔记条数 */
  count: number;
}

export interface NoteStatsResult {
  /** 实时存活笔记总数（含站内 + B 站外部笔记） */
  total: number;
  /** 近 7 天新增（按 createdAt，窗口 (now-7d, now]） */
  recent7: number;
  /** 有笔记的课程 Top3（按笔记数降序、并列按课程名字典序；仅站内课程笔记） */
  topCourses: NoteStatsCourseRow[];
}

export interface NoteStatsOptions {
  /** 统计时刻（毫秒）；非法按 0（recent7 自然为 0，总数不受影响） */
  now: number;
  /** courId → 课程名映射（调用方由 course.bundles 组装；缺失回退「课程 #<id>」） */
  courseNames?: Record<number, string>;
}

/** 结构化入参：NoteEntity / ExternalNoteEntity 的公共形状（未知字段忽略） */
export interface NoteStatsInputNote {
  createdAt: unknown;
  deletedAt?: unknown;
  courId?: unknown;
}

export function buildNoteStats(
  notes: unknown,
  opts: NoteStatsOptions,
): NoteStatsResult {
  const list = Array.isArray(notes) ? notes : [];
  const now = typeof opts?.now === 'number' && Number.isFinite(opts.now) ? opts.now : 0;
  const windowStart = now - NOTE_RECENT_WINDOW_MS;
  const courseNames = opts?.courseNames ?? {};
  const courseCounts = new Map<number, number>();
  let total = 0;
  let recent7 = 0;
  for (const note of list) {
    if (!note || typeof note !== 'object') continue;
    const rec = note as NoteStatsInputNote;
    // 存活口径：deletedAt 为空（note.listAll isLive 同线，双保险）
    if (rec.deletedAt != null) continue;
    total += 1;
    const createdAt = typeof rec.createdAt === 'number' && Number.isFinite(rec.createdAt) ? rec.createdAt : null;
    if (createdAt !== null && createdAt > windowStart && createdAt <= now) recent7 += 1;
    const courId = typeof rec.courId === 'number' && Number.isFinite(rec.courId) ? rec.courId : null;
    if (courId !== null) courseCounts.set(courId, (courseCounts.get(courId) ?? 0) + 1);
  }
  const topCourses = [...courseCounts.entries()]
    .map(([courId, count]) => ({
      key: String(courId),
      label: courseNames[courId] ?? `课程 #${courId}`,
      count,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-Hans-CN'))
    .slice(0, 3);
  return { total, recent7, topCourses };
}
