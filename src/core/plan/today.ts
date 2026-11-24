/**
 * 今日待办聚合器（纯函数，无 IO）。
 *
 * 把三类现成的学习信号聚合成学习中心「今日待办」视图：
 *  - 到期复习：`review.due`（复习计划引擎的 pending 项，带 favorite 快照）；
 *  - 待补看课次：`schedule.missed`（课次结束超期且无有效观看）；
 *  - 待学视频：`fav.list({ type: 'video' })` 中尚未看完的 B 站视频收藏
 *    （进度回写见 repo/video.ts，watchedRatio/lastPositionSec 存于收藏 metadata）；
 *    另可传入每周学习计划的「今日批次」bvid（weeklyBvids），命中条目排分区前部
 *    并加「今日计划 · 」前缀，键与计数口径不变（见 core/plan/weekly）。
 *
 * 输入可能来自 IndexedDB 原始数据（字段缺失 / 类型不符），全部防御式解析，
 * 单条脏数据只影响自身条目，不允许抛错。勾选状态（doneKeys）由调用方经
 * `todo.today.get/set` 持久化在 kv: `hdu.todo.done.<YYYY-MM-DD>`。
 */

import type { MissedItem } from '../shared/ops';
import type { FavoriteEntity, ReviewJobEntity } from '../shared/types';
// asRecord/safeExternalUrl/withTimeParam 全仓收敛（第 16-18 轮）：shared/utils 单份实现
import { asRecord, dayKeyToTs, localDayKey, safeExternalUrl, withTimeParam } from '../shared/utils';
import { formatSeconds } from '../shared/duration';

export type TodoKind = 'review' | 'missed' | 'video';

/** 勾选状态的 kv 键前缀：`hdu.todo.done.<YYYY-MM-DD>`，值为已勾选的 todoKey 列表 */
export const TODAY_KV_PREFIX = 'hdu.todo.done.';

/** 完看阈值：比率 ≥0.95 视为看完，不再进入待学分区（与 repo/video.ts 口径一致） */
const FINISHED_RATIO = 0.95;

export interface TodayTodoItem {
  /** 稳定键：review:<jobId> / missed:<courId>:<teclId>:<beginTime> / video:<bvid> */
  key: string;
  kind: TodoKind;
  title: string;
  /** 副标题：复习到期日 / 课次时间 / UP 主 */
  subtitle?: string;
  /**
   * url 动作的按钮文案（可选）：复习条目的 B 站跳转让按钮保持「去复习」语义，
   * 与 video 条目的「续看」区分；缺省时 UI 回退「续看」，旧数据行为不变。
   */
  action:
    | { type: 'dashboard' }
    | { type: 'course'; courId?: number; teclId?: number }
    | { type: 'url'; url: string; label?: string };
  /** 展示用：如「已到期 3 天」「14:00 开始」「剩 12:34」 */
  dueLabel?: string;
}

export interface TodayPlanSection {
  kind: TodoKind;
  label: string;
  items: Array<TodayTodoItem & { done: boolean }>;
}

export interface TodayPlan {
  sections: TodayPlanSection[];
  /** 全部条目数（含已勾选） */
  totalCount: number;
  /** 已勾选条目数 */
  doneCount: number;
}

export interface TodayPlanInput {
  /** `review.due` 的返回（favorite 可能为 null：收藏已删除） */
  dueReviews: Array<ReviewJobEntity & { favorite: FavoriteEntity | null }>;
  /** `schedule.missed` 的返回（标记 excluded 的课次在聚合器内剔除） */
  missedSessions: MissedItem[];
  /** `fav.list({ type: 'video' })` 的返回 */
  videoFavorites: FavoriteEntity[];
  /** 已勾选的 todoKey（`todo.today.get` 的返回） */
  doneKeys: string[];
  /** 「今天」的本地日键（YYYY-MM-DD）；缺省取当前本地时间，测试可注入 */
  today?: string;
  /**
   * 每周学习计划「今日批次」的 bvid 并集（core/plan/weekly 的 weeklyTodayBvids）：
   * 命中的条目排到 video 分区前部并在 dueLabel 前加「今日计划 · 」前缀。
   * 条目键（video:<bvid>）、分区计数与通知口径都不变；缺省 / 空数组时行为与旧版完全一致。
   */
  weeklyBvids?: string[];
}

/** 分区标题（UI 层与聚合器共用一份文案） */
export const TODO_SECTION_LABELS: Record<TodoKind, string> = {
  review: '到期复习',
  missed: '待补看课次',
  video: '待学视频',
};

/** 命中每周计划的条目 dueLabel 前缀（原标签保留在前缀之后） */
const WEEKLY_DUE_PREFIX = '今日计划 · ';
/** 命中每周计划但原 dueLabel 缺失时的兜底标签（防御式：video 条目本总有 dueLabel） */
const WEEKLY_DUE_FALLBACK = '今日计划';

// ───────────────────────── 防御式读取 ─────────────────────────

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 键生成规则单独导出，便于单测对齐与跨处复用 */
export type TodoKeyRef =
  | { kind: 'review'; id: unknown }
  | { kind: 'missed'; courId: unknown; teclId: unknown; beginTime: unknown }
  | { kind: 'video'; bvid: unknown };

export function todoKeyOf(ref: TodoKeyRef): string {
  switch (ref.kind) {
    case 'review':
      return `review:${asString(ref.id) ?? ''}`;
    case 'missed': {
      // 字段可能缺失：以空串占位，保持键结构稳定（勾选状态按整串匹配）
      const part = (v: unknown) => {
        const n = asNumber(v);
        return n === null ? (asString(v) ?? '') : String(n);
      };
      return `missed:${part(ref.courId)}:${part(ref.teclId)}:${part(ref.beginTime)}`;
    }
    case 'video':
      return `video:${asString(ref.bvid) ?? ''}`;
  }
}

/** 「YYYY-MM-DD」日差（按本地日键计算，today 早于 due 时为负） */
function overdueDays(dueDate: string, today: string): number {
  return Math.round((dayKeyToTs(today) - dayKeyToTs(dueDate)) / 86_400_000);
}

// ───────────────────────── 各分区条目构造 ─────────────────────────

/** 复习条目跳转动作：B 站收藏直跳视频页，其余维持「打开学习看板」的既有行为 */
export type ReviewJumpTarget = { type: 'dashboard' } | { type: 'url'; url: string; label: string };

/** B 站复习跳转按钮文案（与 dashboard 动作的「去复习」共用一份语义） */
export const REVIEW_JUMP_LABEL = '去复习';

/** B 站 bvid 口径（与 VideoFavCard 的 videoBvidOf / bilibili.content.tsx 的 BV 正则同源） */
const BILI_BVID_PATTERN = /^BV[A-Za-z0-9]{8,}$/;

/**
 * B 站收藏的站外基础链接（待学视频与复习跳转共用的解析内核）：
 * metadata.url 过协议白名单优先（兼容 ?p= 分 P），缺失/非法时按 bvid
 * （metadata.bvid ?? refId）还原官方链接；两者都拿不到返回 null。
 * bvid 回退统一过 BV 正则（第 38 轮巡检，与 videoBvidOf 口径一致）：脏 bvid
 * （带 path/查询串/非 BV 前缀）不生成跳转链接（返回 null，仅展示），
 * 避免拼出 bilibili.com 下任意 path。
 */
function biliFavoriteBaseUrl(record: Record<string, unknown>): string | null {
  const meta = asRecord(record.metadata) ?? {};
  const bvid = asString(meta.bvid) ?? asString(record.refId);
  const fallback =
    bvid !== null && BILI_BVID_PATTERN.test(bvid) ? `https://www.bilibili.com/video/${bvid}` : null;
  return safeExternalUrl(meta.url) ?? fallback;
}

/**
 * 收藏 → 复习跳转目标（纯函数，今日待办「去复习」统一走它）：
 *  - B 站收藏（无 courId 且能解析出视频链接）→ url 动作：
 *    基础链接之上，metadata.p ≥2 且 URL 未带分 P 时补 `?p=N`（时间点收藏在多 P 页
 *    收藏时 p 落 metadata）；type='time' 收藏的 anchorTime > 0 时经 withTimeParam
 *    追加 `?t=<取整非负秒>`，直接落到要复习的时间点；
 *  - HDU 收藏（有 courId）→ dashboard：维持既有「打开学习看板复习页」跳转，
 *    HDU 侧行为零变化；
 *  - 收藏已删除 / 脏数据 / 解析不出链接 → dashboard 兜底（与旧版占位行为一致）。
 */
export function reviewJumpTargetOf(favorite: unknown): ReviewJumpTarget {
  const record = asRecord(favorite);
  if (!record) return { type: 'dashboard' };
  if (asNumber(record.courId) !== null) return { type: 'dashboard' };
  let url = biliFavoriteBaseUrl(record);
  if (!url) return { type: 'dashboard' };
  const meta = asRecord(record.metadata) ?? {};
  const p = asNumber(meta.p);
  if (p !== null && p >= 2 && !/[?&]p=\d+/.test(url)) {
    url = `${url}${url.includes('?') ? '&' : '?'}p=${p}`;
  }
  const anchor = asNumber(record.anchorTime);
  if (anchor !== null && anchor > 0) url = withTimeParam(url, anchor);
  return { type: 'url', url, label: REVIEW_JUMP_LABEL };
}

interface ReviewEntry {
  item: TodayTodoItem;
  /** 排序键：到期日键 + 轮次 */
  dueDate: string;
  round: number;
}

function buildReviewEntry(
  job: ReviewJobEntity & { favorite: FavoriteEntity | null },
  today: string,
): ReviewEntry | null {
  const record = asRecord(job);
  if (!record) return null;
  const id = asString(record.id);
  if (!id) return null;
  // 收藏已删除 / 快照缺失时沿用看板的「（收藏已删除）」占位
  const favRecord = asRecord(record.favorite);
  const snapshot = asRecord(favRecord?.snapshot);
  const title = asString(snapshot?.title) ?? '（收藏已删除）';
  const dueDate = asString(record.dueDate) ?? '';
  const round = asNumber(record.round) ?? 0;
  let dueLabel: string;
  if (!dueDate) {
    dueLabel = '到期日未知';
  } else if (dueDate < today) {
    dueLabel = `已到期 ${Math.max(1, overdueDays(dueDate, today))} 天`;
  } else if (dueDate === today) {
    dueLabel = '今日到期';
  } else {
    // 未来日键（review.due 只回今日，此处为防御式兜底）
    dueLabel = `${dueDate.slice(5)} 到期`;
  }
  return {
    dueDate,
    round,
    item: {
      key: todoKeyOf({ kind: 'review', id }),
      kind: 'review',
      title,
      subtitle: dueDate ? `到期 ${dueDate}` : undefined,
      // 跳转按收藏类型解析：B 站收藏直跳视频（?t= 锚点），HDU/兜底维持学习看板
      action: reviewJumpTargetOf(record.favorite),
      dueLabel,
    },
  };
}

interface MissedEntry {
  item: TodayTodoItem;
  /** 排序键：课次开始时间（毫秒） */
  beginTime: number;
}

function buildMissedEntry(item: MissedItem): MissedEntry | null {
  const record = asRecord(item);
  if (!record) return null;
  // 用户已标记「已到课」的课次不再进入待办
  if (record.excluded === true) return null;
  const courId = asNumber(record.courId);
  const teclId = asNumber(record.teclId);
  if (courId === null) return null;
  const beginTime = asNumber(record.beginTime) ?? 0;
  const courseName = asString(record.courseName) ?? (teclId !== null ? `教学班 ${teclId}` : '未知课程');
  const courLabel = asString(record.courLabel);
  const begin = new Date(beginTime);
  const beginValid = beginTime > 0 && !Number.isNaN(begin.getTime());
  // 展示口径与补看清单一致：只强调「几点开始」，日期信息在副标题的课次标签里
  const dueLabel = beginValid
    ? `${String(begin.getHours()).padStart(2, '0')}:${String(begin.getMinutes()).padStart(2, '0')} 开始`
    : undefined;
  return {
    beginTime,
    item: {
      key: todoKeyOf({ kind: 'missed', courId, teclId: teclId ?? '', beginTime }),
      kind: 'missed',
      title: courseName,
      subtitle:
        courLabel ??
        (beginValid
          ? `${begin.getFullYear()}-${String(begin.getMonth() + 1).padStart(2, '0')}-${String(begin.getDate()).padStart(2, '0')}`
          : undefined),
      action: { type: 'course', courId, teclId: teclId ?? undefined },
      dueLabel,
    },
  };
}

/** 读视频收藏的进度口径（与知识库卡片一致：watchedRatio 优先，其次位置/时长推算） */
function videoWatchRatio(record: Record<string, unknown>): { ratio: number | null; lastPositionSec: number; durationSec: number | null } {
  const meta = asRecord(record.metadata) ?? {};
  const watchedRatio = asNumber(meta.watchedRatio);
  const lastPositionSec = asNumber(meta.lastPositionSec) ?? 0;
  const durationSec = asNumber(meta.durationSec);
  if (watchedRatio !== null) return { ratio: Math.min(1, Math.max(0, watchedRatio)), lastPositionSec, durationSec };
  if (lastPositionSec > 0 && durationSec !== null && durationSec > 0) {
    return { ratio: Math.min(1, lastPositionSec / durationSec), lastPositionSec, durationSec };
  }
  return { ratio: null, lastPositionSec, durationSec };
}

/** 续看链接拼接规则已收敛 shared/utils 的 withTimeParam（第 18 轮，四处副本归一） */

interface VideoEntry {
  item: TodayTodoItem;
  /** 排序键：进度比率（未开始按 0，即没看过的排前） */
  ratio: number;
  /** 解析出的 bvid（与条目键 `video:<bvid>` 的后半段一致），供每周计划命中判断 */
  bvid: string;
}

function buildVideoEntry(fav: FavoriteEntity): VideoEntry | null {
  const record = asRecord(fav);
  if (!record) return null;
  // 已删除的收藏不出待办；非 video 类型由调用方过滤，这里再兜一层
  if (record.deletedAt != null || record.type !== 'video') return null;
  const meta = asRecord(record.metadata) ?? {};
  const refId = asString(record.refId);
  const bvid = asString(meta.bvid) ?? refId;
  // 第 17 轮 P2-1 收口：url 直通「去补看」anchor href，过协议白名单（与 unified 搜索跳转同口径）；
  // 基础链接解析与复习跳转共用 biliFavoriteBaseUrl（第 26 轮收敛，行为不变）
  const url = biliFavoriteBaseUrl(record);
  if (!url) return null;
  const snapshot = asRecord(record.snapshot);
  const { ratio, lastPositionSec, durationSec } = videoWatchRatio(record);
  // 已看完（比率 ≥0.95）的收藏不属于「待学」
  if (ratio !== null && ratio >= FINISHED_RATIO) return null;
  let dueLabel: string;
  if (lastPositionSec > 0) {
    dueLabel =
      durationSec !== null && durationSec > lastPositionSec
        ? `剩 ${formatSeconds(durationSec - lastPositionSec)}`
        : `看到 ${formatSeconds(lastPositionSec)}`;
  } else {
    dueLabel = '未开始';
  }
  return {
    ratio: ratio ?? 0,
    bvid: bvid ?? '',
    item: {
      key: todoKeyOf({ kind: 'video', bvid: bvid ?? '' }),
      kind: 'video',
      title: asString(snapshot?.title) ?? '未命名视频',
      subtitle: asString(meta.uploader) ?? undefined,
      action: { type: 'url', url: lastPositionSec > 0 ? withTimeParam(url, lastPositionSec) : url },
      dueLabel,
    },
  };
}

// ───────────────────────── 聚合 ─────────────────────────

/**
 * 聚合今日待办：
 *  - 分区顺序固定 review → missed → video，空分区不输出；
 *  - review 按到期时间升序、missed 按 beginTime 降序（最近错过在前）、video 按进度升序（没看过的在前）；
 *  - weeklyBvids 命中的 video 条目排到分区前部（组内保持进度升序）并加 dueLabel 前缀，
 *    键与计数口径不变；weeklyBvids 缺省时行为与旧版完全一致；
 *  - doneKeys 命中的条目不出分区，仅置 done 供前端灰显；
 *  - 不设总数上限（滚动交给 UI 层）。
 */
export function buildTodayPlan(input: TodayPlanInput): TodayPlan {
  const today = asString(input?.today) ?? localDayKey();
  const doneSet = new Set(asArray(input?.doneKeys).filter((k): k is string => typeof k === 'string'));
  const weeklySet = new Set(asArray(input?.weeklyBvids).filter((b): b is string => typeof b === 'string' && b.length > 0));

  const reviewItems = asArray(input?.dueReviews)
    .map((job) => buildReviewEntry(job as ReviewJobEntity & { favorite: FavoriteEntity | null }, today))
    .filter((entry): entry is ReviewEntry => entry !== null)
    .sort((a, b) => {
      // 到期时间升序（YYYY-MM-DD 字典序即时间序）；同日按轮次、再按键稳定
      if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
      if (a.round !== b.round) return a.round - b.round;
      return a.item.key < b.item.key ? -1 : 1;
    })
    .map((entry) => entry.item);

  const missedItems = asArray(input?.missedSessions)
    .map((item) => buildMissedEntry(item as MissedItem))
    .filter((entry): entry is MissedEntry => entry !== null)
    // 最近错过的在前：beginTime 降序
    .sort((a, b) => b.beginTime - a.beginTime)
    .map((entry) => entry.item);

  const videoEntries = asArray(input?.videoFavorites)
    .map((fav) => buildVideoEntry(fav as FavoriteEntity))
    .filter((entry): entry is VideoEntry => entry !== null)
    // 进度升序：没看过的（含未开始，按 0）排前
    .sort((a, b) => a.ratio - b.ratio);
  // 每周计划的今日批次排前部（计划内 / 计划外两组各自保持进度升序）；键与计数不变
  const plannedEntries = videoEntries.filter((entry) => weeklySet.has(entry.bvid));
  const restEntries = videoEntries.filter((entry) => !weeklySet.has(entry.bvid));
  const videoItems = [...plannedEntries, ...restEntries].map((entry) =>
    weeklySet.has(entry.bvid)
      ? {
          ...entry.item,
          dueLabel: entry.item.dueLabel ? `${WEEKLY_DUE_PREFIX}${entry.item.dueLabel}` : WEEKLY_DUE_FALLBACK,
        }
      : entry.item,
  );

  const sections: TodayPlanSection[] = [];
  let totalCount = 0;
  let doneCount = 0;
  const push = (kind: TodoKind, items: TodayTodoItem[]): void => {
    if (items.length === 0) return;
    const decorated = items.map((item) => {
      const done = doneSet.has(item.key);
      if (done) doneCount += 1;
      totalCount += 1;
      return { ...item, done };
    });
    sections.push({ kind, label: TODO_SECTION_LABELS[kind], items: decorated });
  };
  push('review', reviewItems);
  push('missed', missedItems);
  push('video', videoItems);
  return { sections, totalCount, doneCount };
}

/**
 * 今日到期徽标文案（第 77 轮巡检）：学习入口（HDU 入口坞 / B 站 FAB 主钮）上的
 * 「今日到期复习数」角标。0 / 缺失 / 非有限 → null（不渲染徽标）；>99 封顶显示
 * '99+'（角标宽度可控）；其余取整数字符串。纯函数，双端共用同一文案口径。
 */
export function dueBadgeLabel(count: number | null | undefined): string | null {
  if (count == null || !Number.isFinite(count) || count <= 0) return null;
  const value = Math.floor(count);
  if (value <= 0) return null;
  return value > 99 ? '99+' : String(value);
}
