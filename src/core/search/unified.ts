/**
 * 统一搜索聚合器（纯函数，无 IO）。
 *
 * 学习中心顶栏「统一搜索」经 `search.all` 把四类本地数据一次查出并归并展示：
 *  - 课程字幕：repo 的跨课次聚合命中（searchTranscriptsByCourse，按课次聚合计数）；
 *  - 收藏：fav.list 的 keyword 过滤（标题 + 内容 + 备注，见 repo/library.ts）；
 *  - 笔记：repo 的 searchNotes（正文包含匹配，matchNoteQuery 归一化兜底复检）；
 *  - 复习作业（第 245 轮巡检补第四组）：pending 作业按收藏标题 + 标签匹配
 *    （op 层 listReviewJobs × listFavorites 归并后交 buildReviewEntries）。
 *
 * 输入可能来自 IndexedDB 原始数据（字段缺失 / 类型不符），全部防御式解析，
 * 单条脏数据只影响自身条目，不允许抛错。跳转规则与今日待办 / 知识库卡片一致：
 *  - 字幕 / 笔记（有 courId）→ course（courId/teclId 必须是有限数值才带）；
 *    当前没有跨页锚点回跳机制，锚点秒数只展示在摘要里；
 *  - 站外字幕（仅 mediaKey，B 站官方字幕）→ url：跳 `?t=<命中秒>` 落到字幕时间点
 *    （第 15 轮收口；URL 优先取 op 层从收藏 metadata 补齐的值，兼容 ?p= 分 P，
 *    缺失时按 bvid 还原，标题兜底「B 站视频 <bvid>」；第 16 轮：p≥2 的分 P 键
 *    跳转 URL 追加分 P 参数，且所有站外 URL 过 http(s) 协议白名单）；
 *  - video 收藏 → url（有进度带 ?t= 续看，无进度从片头开始）；
 *  - 其他收藏有 courId → course；否则跳 metadata.url。
 */

import type { FavoriteEntity, NoteEntity } from '../shared/types';
import { parseMediaKey, type MediaKey } from '../shared/mediaRef';
import { asRecord, formatClock, safeExternalUrl, withTimeParam } from '../shared/utils';

export type UnifiedKind = 'transcript' | 'favorite' | 'note' | 'review';

export type UnifiedJump =
  | { type: 'course'; courId: number; teclId?: number; anchorSec?: number }
  | { type: 'url'; url: string };

export interface UnifiedHit {
  kind: UnifiedKind;
  /** transcript: 课次标题；favorite: 收藏标题；note: 内容首行 */
  title: string;
  /** 关键词上下文摘要（命中词以【】标注） */
  snippet: string;
  /** transcript 命中的最佳命中点秒数；note 有 anchorTime 时带上 */
  anchorSec?: number;
  /**
   * transcript 组专用：该课次的命中段数（repo 聚合的 hitCount，封顶 limitPerCourse）。
   * 仅 transcript 条目携带；UI 在 hitCount > 1 时展示「命中 N 段」meta 行（第 256 轮）。
   */
  hitCount?: number;
  /**
   * transcript 组专用：命中段列表（第 257 轮，字幕时间序，text 已截断 120 字符）。
   * 仅 hitCount > 1 且段列表非空时透传；UI 据此渲染「命中 N 段」meta 行（第 256 轮）。
   */
  hitSegments?: Array<{ startSec: number; text: string }>;
  /** favorite 组专用：置顶收藏（第 287 轮）——UI 渲染「置顶」徽标 */
  pinned?: boolean;
  /** 跳转信息；三类输入都拿不到任何跳转目标时缺省（UI 渲染为不可点击条目） */
  jump?: UnifiedJump;
}

export interface UnifiedSearchGroup {
  kind: UnifiedKind;
  label: string;
  /** 展示条目（截断至 capPerSource；第 259 轮起 UI 可经 all 展开全量） */
  items: UnifiedHit[];
  /**
   * 全量条目（第 260 轮，检索域 / 完整性）：截断前的完整列表（与 items 同序）。
   * 聚合器恒填；可选仅为兼容测试桩——UI 在 total > items.length 且带 all 时提供
   * 「展开全部」切换（缺省回退 items，无展开按钮）。体积可控：字幕 ≤12 课次
   * 条目 / 收藏 ≤31 / 笔记 ≤30。
   */
  all?: UnifiedHit[];
  /** 截断前的命中条数（每组最多展示 capPerSource 条） */
  total: number;
}

export interface UnifiedSearchResult {
  groups: UnifiedSearchGroup[];
  /** 全部命中条数（截断前，供「全部 N 条」提示） */
  totalCount: number;
  /**
   * 收藏组是否被截断（如实的降级标记，第 18 轮审计留观项）：op 层收藏路查询
   * 触顶（匹配数 > SEARCH_FAVORITES_LIMIT）时为 true，UI 据此在收藏组末尾
   * 显示中性提示；不改变分组内容与排序。
   */
  favoritesTruncated: boolean;
}

/** 字幕路输入：repo 的聚合命中（op 层补齐媒体标题后传入） */
export interface UnifiedTranscriptPart {
  /** 站内课次 ID（有 sessions 可回查标题/跳转；B 站等站外媒体缺省） */
  courId?: number;
  /** 媒体主键（转写链路主键；B 站键无 courId 时按下方 url 出站外跳转） */
  mediaKey?: MediaKey;
  teclId?: number;
  hitCount: number;
  best?: { startSec: number; text: string } | null;
  /**
   * 命中段列表（第 257 轮）：repo searchTranscriptsByCourse 收集的字幕时间序命中段
   * （text 截断 120 字符）。op 层原样透传，聚合器防御式解析后进 hitSegments。
   */
  segments?: Array<{ startSec: number; text: string }>;
  title?: string;
  /**
   * 站外媒体可跳转 URL（op 层从收藏 metadata.url 补齐，可能带 ?p= 分 P；
   * 缺失且 mediaKey 为 bili 键时按 bvid 还原）。有 courId 的站内条目忽略此字段。
   */
  url?: string;
}

export interface UnifiedSearchParts {
  transcripts: UnifiedTranscriptPart[];
  favorites: FavoriteEntity[];
  notes: NoteEntity[];
  /**
   * 复习作业路输入（第 245 轮巡检补第四组）：pending 作业 + favorite 快照的
   * 松散拼接（op 层 listReviewJobs × listFavorites 归并，favorite 可能 null）。
   * 匹配与去重在 buildReviewEntries 纯函数内完成，输入脏数据只影响自身条目。
   */
  reviews?: unknown[];
  /** 收藏路是否触顶截断（op 层依据 listFavorites 是否还有更多匹配传入；缺省按未截断处理） */
  favoritesTruncated?: boolean;
}

/** 组标题（UI 层与聚合器共用一份文案，kind 徽标同用） */
export const UNIFIED_GROUP_LABELS: Record<UnifiedKind, string> = {
  transcript: '字幕',
  favorite: '收藏',
  note: '笔记',
  review: '复习',
};

/** 每组默认截断数 */
export const DEFAULT_CAP_PER_SOURCE = 5;

/**
 * 统一搜索收藏路的查询上限（第 18 轮审计留观项「listFavorites 截断」）：
 * repo 的 listFavorites 本身无硬限（缺省 MAX_SAFE_INTEGER），截断发生在 op 层——
 * search.all 按 keyword 检索收藏时只取最近 SEARCH_FAVORITES_LIMIT 条匹配，
 * 超出的更旧匹配不进入搜索（与 capPerSource=5 的「展示条数上限」是两回事）。
 * op 层多取 1 条探测触顶并把 favoritesTruncated 传回；UI 提示文案引用本常量。
 */
export const SEARCH_FAVORITES_LIMIT = 30;

/** 摘要窗口半径：命中词前后各取 radius 个字符 */
const SNIPPET_RADIUS = 40;

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

// ───────────────────────── 摘要与跳转 ─────────────────────────

/**
 * 关键词上下文摘要：不区分大小写找首次命中位置，取 ±radius 字符窗口，
 * 命中词用【】标注（保留原文大小写）；无命中返回前 radius*2 字符，过短原样返回。
 */
export function buildSnippet(content: string, keyword: string, radius = SNIPPET_RADIUS): string {
  const text = typeof content === 'string' ? content : '';
  const kw = normalizeKeyword(keyword).toLowerCase();
  if (!text) return '';
  const half = Math.max(1, Math.floor(radius));
  const idx = kw ? text.toLowerCase().indexOf(kw) : -1;
  if (!kw || idx < 0) {
    // 无命中（含空关键词）：取前 radius*2 字符，过短原样返回
    return text.length <= half * 2 ? text : `${text.slice(0, half * 2)}…`;
  }
  const start = Math.max(0, idx - half);
  const end = Math.min(text.length, idx + kw.length + half);
  const body = `${text.slice(start, idx)}【${text.slice(idx, idx + kw.length)}】${text.slice(idx + kw.length, end)}`;
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
}

/** 摘要片段：marked=true 表示该段是命中词（UI 渲染为高亮 <mark>） */
export interface SnippetSegment {
  text: string;
  marked: boolean;
}

/**
 * 把 buildSnippet 产物的【】标注解析为片段序列（第 256 轮，检索域）：
 * 仅当【】内文本与关键词逐字相等（大小写不敏感）才标为命中段——摘要窗口内
 * 原文自带的【】（如《【公开课】…》标题）不被误标高亮；无标注 / 全不匹配时
 * 返回单段原文（marked=false）。纯函数，输入脏值按空串处理。
 */
export function snippetToSegments(snippet: unknown, keyword: unknown): SnippetSegment[] {
  const text = typeof snippet === 'string' ? snippet : '';
  const kw = normalizeKeyword(keyword).toLowerCase();
  if (!text) return [];
  if (!kw || !text.includes('【')) return [{ text, marked: false }];
  const segments: SnippetSegment[] = [];
  const re = /【([^【】]*)】/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const inner = match[1] ?? '';
    if (match.index > last) segments.push({ text: text.slice(last, match.index), marked: false });
    if (inner.length > 0) segments.push({ text: inner, marked: inner.toLowerCase() === kw });
    last = match.index + match[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last), marked: false });
  return segments;
}

/**
 * 原文关键词标注（第 258 轮，检索域）：在未标注的原始文本中定位关键词的全部出现
 * （大小写不敏感、不重叠、从左到右），命中段 marked=true——供命中段展开行的段内
 * 高亮（段文本是原始字幕，不带 buildSnippet 的【】标注，snippetToSegments 不适用）。
 * 纯函数，输入脏值按空串处理；空关键词返回单段原文。
 */
export function markTextSegments(text: unknown, keyword: unknown): SnippetSegment[] {
  const source = typeof text === 'string' ? text : '';
  const kw = normalizeKeyword(keyword).toLowerCase();
  if (!source) return [];
  if (!kw) return [{ text: source, marked: false }];
  const segments: SnippetSegment[] = [];
  const lower = source.toLowerCase();
  let cursor = 0;
  let idx = lower.indexOf(kw);
  while (idx >= 0) {
    if (idx > cursor) segments.push({ text: source.slice(cursor, idx), marked: false });
    segments.push({ text: source.slice(idx, idx + kw.length), marked: true });
    cursor = idx + kw.length;
    idx = lower.indexOf(kw, cursor);
  }
  if (cursor < source.length) segments.push({ text: source.slice(cursor), marked: false });
  return segments;
}

/** 关键词规范化：trim；长度 <1 时调用方直接返回空结果（不发起查询） */
export function normalizeKeyword(keyword: unknown): string {
  return typeof keyword === 'string' ? keyword.trim() : '';
}

/**
 * 查询文本归一化（第 245 轮巡检，统一搜索匹配共用）：trim + 连续空白折叠为单个
 * 空格 + 小写。大小写 / 多余空白 / 全半角空格混排不再影响包含匹配；特殊字符
 * （标点、正则元字符）按字面参与匹配——本实现是纯 contains，不解析正则。
 */
export function normalizeQueryText(query: unknown): string {
  return typeof query === 'string' ? query.trim().replace(/\s+/g, ' ').toLowerCase() : '';
}

/**
 * 笔记匹配（第 245 轮巡检）：笔记正文（NoteEntity.text）按归一化包含匹配。
 *  - 空 / 纯空白 query → false（调用方应先短路，不把空 query 当全量命中）；
 *  - 已删除（deletedAt）或无正文（text 非字符串）的笔记 → false；
 *  - 输入为任意脏数据（非对象）时按无正文处理，不抛错。
 */
export function matchNoteQuery(note: unknown, query: unknown): boolean {
  const q = normalizeQueryText(query);
  if (q.length < 1) return false;
  const record = asRecord(note);
  if (!record || record.deletedAt != null) return false;
  const text = asString(record.text);
  if (text === null) return false;
  return normalizeQueryText(text).includes(q);
}

/** 带锚点的摘要：课程跳转没有跨页锚点机制，锚点秒数展示在摘要最前（如「05:12 · …」） */
function anchorSnippet(content: string, keyword: string, anchorSec: number | null): string {
  const body = buildSnippet(content, keyword);
  if (!body) return '';
  return anchorSec !== null ? `${formatClock(anchorSec)} · ${body}` : body;
}

/** course 跳转：courId/teclId 必须是有限数值才带（openSessionInSite 依赖数值参数） */
function courseJumpOf(courId: unknown, teclId: unknown, anchorSec: unknown): UnifiedJump | null {
  const cid = asNumber(courId);
  if (cid === null) return null;
  const tid = asNumber(teclId);
  const anchor = asNumber(anchorSec);
  return {
    type: 'course',
    courId: cid,
    ...(tid !== null ? { teclId: tid } : {}),
    ...(anchor !== null ? { anchorSec: anchor } : {}),
  };
}

/** 续看链接拼接规则已收敛 shared/utils 的 withTimeParam（第 18 轮，四处副本归一） */

/**
 * 站外字幕跳转（仅 mediaKey、无 courId 的条目，如 B 站官方字幕）：
 *  - URL 优先取 op 层补齐的收藏 metadata.url（可能带 ?p= 分 P，过协议白名单），
 *    缺失/非法时按 bvid 还原（与收藏 video 卡片 / 今日待办 buildVideoEntry 同口径）；
 *  - mediaKey 解析出分 P（p≥2 的 `bili:<bvid>:p<N>` 键，第 16 轮）且目标 URL 未带分 P
 *    时追加 `?p=N`（withTimeParam 已处理 `?`→`&`，?t= 紧随其后）；
 *  - 命中秒数带进 `?t=`，搜索结果直接落到字幕时间点（与 B 站字幕浮层的行点击同口径）；
 *  - 非 bili 键（且无 url）拿不到跳转目标 → null（条目退化为不可点击，不抛错）。
 */
function externalTranscriptJumpOf(mediaKey: unknown, url: unknown, startSec: unknown): UnifiedJump | null {
  const key = asString(mediaKey);
  if (!key) return null;
  const parsed = parseMediaKey(key);
  // 第 17 轮 P2-1 收口：safeExternalUrl 下沉 shared/utils（today/LearningCenter 三处 sink 同口径）
  let target = safeExternalUrl(url) ?? (parsed?.kind === 'bili' ? `https://www.bilibili.com/video/${parsed.bvid}` : null);
  if (!target) return null;
  if (parsed?.kind === 'bili' && parsed.p !== undefined && !/[?&]p=\d+/.test(target)) {
    target = `${target}${target.includes('?') ? '&' : '?'}p=${parsed.p}`;
  }
  const anchor = asNumber(startSec);
  return { type: 'url', url: anchor !== null ? withTimeParam(target, anchor) : target };
}

/** 收藏跳转：video 优先外链（无进度从片头开始），其余有 courId 走课次，最后回退 metadata.url。
 *  第 245 轮起 export：统一搜索复习组（buildReviewEntries）复用同一跳转规则。 */
export function favoriteJumpOf(fav: Record<string, unknown>): UnifiedJump | null {
  const meta = asRecord(fav.metadata) ?? {};
  const url = safeExternalUrl(meta.url);
  if (fav.type === 'video') {
    // URL 缺失/非法时按 refId 还原（与今日待办 buildVideoEntry 同口径）
    const bvid = asString(meta.bvid) ?? asString(fav.refId);
    const target = url ?? (bvid ? `https://www.bilibili.com/video/${bvid}` : null);
    if (target) {
      const pos = asNumber(meta.lastPositionSec);
      return { type: 'url', url: pos !== null && pos > 0 ? withTimeParam(target, pos) : target };
    }
  }
  const courJump = courseJumpOf(fav.courId, fav.teclId, fav.anchorTime);
  if (courJump) return courJump;
  return url ? { type: 'url', url } : null;
}

// ───────────────────────── 各路条目构造 ─────────────────────────

interface TranscriptEntry {
  item: UnifiedHit;
  /** 排序键：课次命中段数 */
  hitCount: number;
  /** 次级排序键：最佳锚点越靠前越优先 */
  order: number;
}

function buildTranscriptEntry(part: unknown, kw: string): TranscriptEntry | null {
  const record = asRecord(part);
  if (!record) return null;
  const courId = asNumber(record.courId);
  const mediaKey = asString(record.mediaKey);
  const hitCount = asNumber(record.hitCount);
  // 旧形状（只有 courId）与新形状（mediaKey）都接受；两者都缺失则无法成条
  if ((courId === null && mediaKey === null) || hitCount === null || hitCount <= 0) return null;
  const best = asRecord(record.best);
  const startSec = best ? asNumber(best.startSec) : null;
  // 标题兜底：B 站键给「B 站视频 <bvid>」（op 层通常会从收藏补齐更好的标题），其余维持课次占位
  const parsedKey = mediaKey !== null ? parseMediaKey(mediaKey) : null;
  const title =
    asString(record.title) ??
    (parsedKey?.kind === 'bili' ? `B 站视频 ${parsedKey.bvid}` : `课次 ${courId ?? mediaKey ?? '?'}`);
  // best.text 缺失时退回标题做摘要源（命中词未必在标题里，最多退化为前缀摘要）
  const snippetSource = (best ? asString(best.text) : null) ?? title;
  // 站内课次 → course 跳转；站外媒体（仅 mediaKey）→ url 跳转（?t= 命中秒，第 15 轮收口）
  const jump =
    courId !== null ? courseJumpOf(courId, record.teclId, startSec) : externalTranscriptJumpOf(record.mediaKey, record.url, startSec);
  // 命中段列表（第 257 轮）：防御式解析（startSec 有限 + text 非空），仅多段命中透传
  const hitSegments =
    hitCount > 1
      ? asArray(record.segments)
          .map((seg) => {
            const segRecord = asRecord(seg);
            if (!segRecord) return null;
            const segStart = asNumber(segRecord.startSec);
            const segText = asString(segRecord.text);
            if (segStart === null || segText === null) return null;
            return { startSec: segStart, text: segText };
          })
          .filter((seg): seg is { startSec: number; text: string } => seg !== null)
      : [];
  return {
    hitCount,
    order: startSec !== null ? startSec : Number.MAX_SAFE_INTEGER,
    item: {
      kind: 'transcript',
      title,
      snippet: anchorSnippet(snippetSource, kw, startSec),
      ...(startSec !== null ? { anchorSec: startSec } : {}),
      // 命中段数透传（第 256 轮）：repo 聚合值原样带出，供 UI「命中 N 段」meta 行
      ...(hitCount > 1 ? { hitCount } : {}),
      // 命中段列表透传（第 257 轮）：多段命中且解析非空才带（UI 渲染可展开定位列表）
      ...(hitSegments.length > 1 ? { hitSegments } : {}),
      ...(jump ? { jump } : {}),
    },
  };
}

interface DatedEntry {
  item: UnifiedHit;
  /** 排序键：updatedAt（收藏缺省回退 favoritedAt） */
  updatedAt: number;
}

function buildFavoriteEntry(fav: unknown, kw: string): DatedEntry | null {
  const record = asRecord(fav);
  if (!record) return null;
  // 已删除的收藏不出结果（repo 的 keyword 过滤不含软删除口径，这里兜一层）
  if (record.deletedAt != null) return null;
  const snapshot = asRecord(record.snapshot) ?? {};
  const title = asString(snapshot.title) ?? '未命名收藏';
  const content = asString(snapshot.content) ?? '';
  const note = asString(record.note) ?? '';
  // repo（fav.list）已按 title+content+note 过滤；这里兜底复检并挑选包含关键词的字段做摘要
  const lowerKw = kw.toLowerCase();
  if (![title, content, note].some((text) => text.toLowerCase().includes(lowerKw))) return null;
  const source = content.toLowerCase().includes(lowerKw) ? content : note.toLowerCase().includes(lowerKw) ? note : title;
  const jump = favoriteJumpOf(record);
  return {
    updatedAt: asNumber(record.updatedAt) ?? asNumber(record.favoritedAt) ?? 0,
    item: {
      kind: 'favorite',
      title,
      snippet: buildSnippet(source, kw),
      // 置顶徽标（第 287 轮）：置顶收藏在结果中标识
      ...(record.pinned === true ? { pinned: true } : {}),
      ...(jump ? { jump } : {}),
    },
  };
}

function buildNoteEntry(note: unknown, kw: string): DatedEntry | null {
  const record = asRecord(note);
  if (!record) return null;
  // repo（searchNotes）已按正文过滤；这里兜底复检（归一化匹配，matchNoteQuery 第 245 轮收口）
  if (!matchNoteQuery(record, kw)) return null;
  const text = asString(record.text);
  // 无正文的笔记没有检索价值
  if (text === null) return null;
  const anchorTime = asNumber(record.anchorTime);
  const firstLine = text.split('\n').find((line) => line.trim().length > 0)?.trim() ?? '';
  const jump = courseJumpOf(record.courId, record.teclId, anchorTime);
  return {
    updatedAt: asNumber(record.updatedAt) ?? 0,
    item: {
      kind: 'note',
      title: firstLine || '笔记',
      snippet: anchorSnippet(text, kw, anchorTime),
      ...(anchorTime !== null ? { anchorSec: anchorTime } : {}),
      ...(jump ? { jump } : {}),
    },
  };
}

// ───────────────────────── 复习作业路（第 245 轮巡检补第四组） ─────────────────────────

/**
 * 复习作业匹配（统一搜索第四组）：pending 作业按收藏标题 + 标签归一化包含匹配。
 *
 * 口径研判（日志已记录）：
 *  - 只收 pending：搜索定位「需要去复习的作业」，done/skipped 历史由收藏组 /
 *    笔记组承接（同一收藏的 done 命中会与收藏组重复标题，徒增噪声）；
 *  - 同收藏多轮 pending（计划排期即多轮并存）只保留最早到期一条，组内不重复标题；
 *  - favorite 缺失 / 已删除 / 无标题的作业不成条（无展示面，跳转也无从谈起）；
 *  - 匹配字段 = 收藏标题 + 标签（正文不参与：复习作业的检索意图是「哪份资料要复习」，
 *    标题/标签足够定位，避免与收藏组正文命中大面积重叠）。
 *
 * 摘要带轮次与到期日（M月D日），是收藏组没有的复习语境信息；跳转复用
 * favoriteJumpOf（video 收藏 → ?t= 续看外链，站内 → course，与知识库卡片同口径）。
 */
export function buildReviewEntries(jobs: unknown, keyword: string): UnifiedHit[] {
  const q = normalizeQueryText(keyword);
  if (q.length < 1) return [];
  interface ReviewRow {
    favoriteId: string;
    dueDate: string;
    round: number | null;
    favorite: Record<string, unknown>;
    title: string;
  }
  const rows: ReviewRow[] = [];
  for (const job of asArray(jobs)) {
    const record = asRecord(job);
    if (!record) continue;
    // 只收 pending；favorite 缺失（收藏已删除）或无标题不成条
    if (record.status !== 'pending') continue;
    const favorite = asRecord(record.favorite);
    if (!favorite || favorite.deletedAt != null) continue;
    const snapshot = asRecord(favorite.snapshot) ?? {};
    const title = asString(snapshot.title);
    if (title === null) continue;
    const tags = asArray(favorite.tags).filter((tag): tag is string => typeof tag === 'string' && tag.length > 0);
    // 标题 + 标签归一化包含匹配（normalizeQueryText：大小写 / 空白不敏感）
    if (!normalizeQueryText(`${title} ${tags.join(' ')}`).includes(q)) continue;
    rows.push({
      favoriteId: asString(record.favoriteId) ?? '',
      dueDate: asString(record.dueDate) ?? '',
      round: asNumber(record.round),
      favorite,
      title,
    });
  }
  // 同收藏只留最早到期一条（日键字典序即时间序；脏/缺到期日排最后且不覆盖有效条目）
  rows.sort((a, b) => {
    const av = /^\d{4}-\d{2}-\d{2}$/.test(a.dueDate) ? a.dueDate : '9999-12-31';
    const bv = /^\d{4}-\d{2}-\d{2}$/.test(b.dueDate) ? b.dueDate : '9999-12-31';
    return av < bv ? -1 : av > bv ? 1 : 0;
  });
  const best = new Map<string, ReviewRow>();
  for (const row of rows) {
    if (!best.has(row.favoriteId)) best.set(row.favoriteId, row);
  }
  return [...best.values()].map((row) => {
    const roundText = row.round !== null && row.round > 0 ? `第 ${row.round} 轮` : '复习作业';
    const dueText = /^\d{4}-\d{2}-\d{2}$/.test(row.dueDate) ? ` · ${row.dueDate} 到期` : '';
    const jump = favoriteJumpOf(row.favorite);
    return {
      kind: 'review' as const,
      title: row.title,
      snippet: `${roundText}${dueText}`,
      ...(jump ? { jump } : {}),
    };
  });
}

// ───────────────────────── 聚合 ─────────────────────────

/**
 * 归并四路检索结果（第 245 轮起 +复习组）：
 *  - 组顺序固定 transcript → favorite → note → review，空组不输出；
 *  - 组内 transcript 按课次命中数降序，favorite / note 按 updatedAt / favoritedAt 降序，
 *    review 按到期日升序（同收藏只留最早一条，见 buildReviewEntries）；
 *  - 每组截断至 capPerSource（默认 5），total 保留截断前计数供「全部 N 条」提示；
 *  - favoritesTruncated（收藏路查询触顶标记）原样透传到结果，不改分组内容与排序；
 *  - 空关键词直接返回空结果（调用方据此短路，不发起查询）。
 */
export function mergeSearchResults(
  parts: UnifiedSearchParts,
  keyword: string,
  opts: { capPerSource?: number } = {},
): UnifiedSearchResult {
  const kw = normalizeKeyword(keyword);
  if (kw.length < 1) return { groups: [], totalCount: 0, favoritesTruncated: false };
  const cap = Math.max(1, Math.floor(opts?.capPerSource ?? DEFAULT_CAP_PER_SOURCE));
  const record = asRecord(parts) ?? {};
  // 防御式读取：脏标记（非 true）一律按未截断处理
  const favoritesTruncated = record.favoritesTruncated === true;

  const transcriptItems = asArray(record.transcripts)
    .map((part) => buildTranscriptEntry(part, kw))
    .filter((entry): entry is TranscriptEntry => entry !== null)
    .sort((a, b) => b.hitCount - a.hitCount || a.order - b.order)
    .map((entry) => entry.item);

  const favoriteItems = asArray(record.favorites)
    .map((fav) => buildFavoriteEntry(fav, kw))
    .filter((entry): entry is DatedEntry => entry !== null)
    // 置顶优先（第 287 轮，检索域）：pinnedFirst 的 repo 排序在此保持——
    // 同为非置顶时按 updatedAt 降序
    .sort(
      (a, b) =>
        (b.item.pinned ? 1 : 0) - (a.item.pinned ? 1 : 0) || b.updatedAt - a.updatedAt,
    )
    .map((entry) => entry.item);

  const noteItems = asArray(record.notes)
    .map((note) => buildNoteEntry(note, kw))
    .filter((entry): entry is DatedEntry => entry !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((entry) => entry.item);

  const reviewItems = buildReviewEntries(record.reviews, kw);

  const groups: UnifiedSearchGroup[] = [];
  let totalCount = 0;
  const push = (kind: UnifiedKind, items: UnifiedHit[]): void => {
    if (items.length === 0) return;
    totalCount += items.length;
    groups.push({ kind, label: UNIFIED_GROUP_LABELS[kind], items: items.slice(0, cap), all: items, total: items.length });
  };
  push('transcript', transcriptItems);
  push('favorite', favoriteItems);
  push('note', noteItems);
  push('review', reviewItems);
  return { groups, totalCount, favoritesTruncated };
}
