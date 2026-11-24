/**
 * B 站「学习助手」纯逻辑（第 24 轮功能扩展第一批：字幕搜索 / 时间点收藏 / AI 时间点问答）。
 *
 * 把可单测的判定与组装逻辑从 UI 组件中抽出（照 core/bili/theme.ts 的纯函数惯例）：
 *  - 分 P 参数解析（P1 裸键 / p≥2 分 P 键的 mediaKey 构造统一走 mediaRef.biliMediaKey）；
 *  - 「收藏此时刻」的 fav.put payload 组装（type='time'，命名惯例照 HDU 站内
 *    addTimeFavorite：`标题 · mm:ss`）；
 *  - 字幕关键词过滤（前端过滤即可，段数 ≤ 数千，无需动用 transcript.search RPC）；
 *  - 问答可用性判定（无官方字幕 → 友好空态，不发 qa.ask）。
 *
 * 全部为纯函数，不触 DOM / RPC，便于 vitest node 环境直测。
 */

import { errorTextOf } from '../shared/errors';
import { biliMediaKey } from '../shared/mediaRef';
import { formatClock, summarize } from '../shared/utils';
import type { FavoriteEntity, OutlineNode, TranscriptEntity, TranscriptSegment } from '../shared/types';

/** 无官方字幕时问答入口的统一空态文案（UI 与单测共用一份措辞） */
export const QA_NO_SUBTITLE_MESSAGE = '该视频暂无可用字幕，无法基于内容问答';

/** 笔记输入框的静态回退文案（页内 <video> 不可用/时间非法时使用，UI 与单测共用措辞） */
export const NOTE_PLACEHOLDER_FALLBACK = '记录这一刻的想法（自动带当前播放时间）';

/**
 * 笔记输入框 placeholder 文案：有实时播放时间（mm:ss）→「记一笔（mm:ss）」；
 * <video> 不可用时回退静态文案（调用方传 null）。纯函数便于单测。
 */
export function notePlaceholderText(currentClock: string | null | undefined): string {
  return currentClock ? `记一笔（${currentClock}）` : NOTE_PLACEHOLDER_FALLBACK;
}

/**
 * 解析 B 站视频页 URL 的分 P 参数（`?p=N`）。
 * 严格 1–4 位十进制且 ≥1 才认（拒 0x/1e 记法与超长数字串，防 mediaKey roundtrip
 * 精度问题）；缺省/非法一律回退 P1。口径与 bilibili.content.tsx 原 readBiliPageP
 * 完全一致（不做 trim，保持既有行为）。
 */
export function parseBiliPageParam(raw: string | null | undefined): number {
  const value = raw ?? '';
  return /^\d{1,4}$/.test(value) && Number(value) >= 1 ? Number(value) : 1;
}

export interface MomentFavoriteArgs {
  /** 收藏实体 ID（调用方用 uuid() 生成） */
  id: string;
  bvid: string;
  /** 分 P 序号；P1 传 1/缺省（payload 里 p=1 时省略，与 mediaKey 裸键口径一致） */
  p?: number;
  /** 视频标题（og:title 等，调用方已解析） */
  title: string;
  /** 收藏时刻（<video>.currentTime，秒；内部向下取整） */
  currentTime: number;
  /** 当前页面 URL（存 metadata 供回跳） */
  url: string;
  /** favoritedAt 时间戳（调用方传 Date.now()，便于单测断言） */
  now: number;
}

/**
 * 组装「收藏此时刻」的收藏实体：type 取 FavoriteType 的 'time'（时间点类收藏的
 * 语义取值，与 HDU 站内 addTimeFavorite 同型）；标题默认「视频标题 · 时刻」。
 * mediaKey / 分 P / bvid 落 metadata，便于知识库侧按 B 站视频检索与回跳。
 */
export function buildMomentFavorite(args: MomentFavoriteArgs): Omit<FavoriteEntity, 'updatedAt'> {
  const p = args.p !== undefined && args.p >= 2 ? Math.floor(args.p) : undefined;
  const anchorTime = Math.max(0, Math.floor(Number.isFinite(args.currentTime) ? args.currentTime : 0));
  const clock = formatClock(anchorTime);
  const pageLabel = p !== undefined ? ` P${p}` : '';
  return {
    id: args.id,
    type: 'time',
    snapshot: {
      title: `${args.title} · ${clock}`,
      content: `B站视频${pageLabel}的时间点 ${clock}`,
    },
    anchorTime,
    folderId: null,
    tags: [],
    pinned: false,
    favoritedAt: args.now,
    metadata: {
      platform: 'bilibili',
      bvid: args.bvid,
      ...(p !== undefined ? { p } : {}),
      mediaKey: biliMediaKey(args.bvid, p),
      url: args.url,
    },
  };
}

/**
 * 面板 → 宿主的「收藏 AI 回答」载荷（第 33 轮）：chat 键字段 + 组装收藏所需的上下文。
 * 面板持有消息列表（含同会话的用户提问），宿主持有 videoInfo/title 落库上下文，
 * 两边经此载荷在回调里衔接（面板不直接触达 fav.put，与收藏此时刻同一模式）。
 */
export interface AiFavoriteChatRef {
  /** 被收藏的 AI 回答消息 id（落 refId，供防重与回查） */
  chatId: string;
  /** 该回答对应的用户提问（同会话中最近一条用户消息；metadata.question 留档） */
  question: string;
  /** AI 回答正文（snapshot.content） */
  answer: string;
  /** 回答锚点时间（qa.ask 落库时的播放位置；缺省不落 anchorTime） */
  anchorTime?: number;
  /** 所属会话 groupId（metadata 留档，便于回溯会话） */
  groupId?: string;
}

export interface AiFavoriteArgs {
  /** 收藏实体 ID（调用方用 uuid() 生成） */
  id: string;
  bvid: string;
  /** 分 P 序号；P1 传 1/缺省（payload 里 p=1 时省略，与 mediaKey 裸键口径一致） */
  p?: number;
  /** 视频标题（og:title 等，调用方已解析；落 metadata.videoTitle 留档） */
  title: string;
  /** 被收藏的问答内容（chatId/问题/回答/锚点/会话） */
  chat: AiFavoriteChatRef;
  /** 当前页面 URL（存 metadata 供回跳） */
  url: string;
  /** favoritedAt 时间戳（调用方传 Date.now()，便于单测断言） */
  now: number;
}

/**
 * 组装「收藏 AI 回答」的收藏实体（第 33 轮）：type='ai'，字段口径对齐 HDU 站内
 * favoriteChat——refId=chatId、snapshot.title=回答摘要（summarize 36）、
 * snapshot.content=回答全文、anchorTime=回答锚点；B 站侧另落 metadata
 * （platform/bvid/p/mediaKey/url 与 buildMomentFavorite 同惯例，另附 question/
 * groupId/videoTitle 留档），知识库侧可按 bvid/mediaKey 检索回跳。
 */
export function buildAiFavorite(args: AiFavoriteArgs): Omit<FavoriteEntity, 'updatedAt'> {
  const p = args.p !== undefined && args.p >= 2 ? Math.floor(args.p) : undefined;
  // 锚点时间：非法值不落 anchorTime（HDU 侧 chat.anchorTime 本就可选）
  const rawAnchor = args.chat.anchorTime;
  const anchorTime =
    typeof rawAnchor === 'number' && Number.isFinite(rawAnchor) && rawAnchor >= 0 ? Math.floor(rawAnchor) : undefined;
  return {
    id: args.id,
    type: 'ai',
    refId: args.chat.chatId,
    snapshot: { title: summarize(args.chat.answer, 36), content: args.chat.answer },
    ...(anchorTime !== undefined ? { anchorTime } : {}),
    folderId: null,
    tags: [],
    pinned: false,
    favoritedAt: args.now,
    metadata: {
      platform: 'bilibili',
      bvid: args.bvid,
      ...(p !== undefined ? { p } : {}),
      mediaKey: biliMediaKey(args.bvid, p),
      url: args.url,
      videoTitle: args.title,
      question: args.chat.question,
      ...(args.chat.groupId ? { groupId: args.chat.groupId } : {}),
    },
  };
}

/**
 * 按关键词过滤字幕段（大小写不敏感的子串匹配；空白查询返回全部段的原样副本）。
 * 只做前端内存过滤：单个 mediaKey 的字幕段数量级为 hundreds～thousands，
 * 无需动用 transcript.search RPC（那是跨 mediaKey 全库搜索的通道）。
 */
export function filterTranscriptSegments(segments: TranscriptSegment[], query: string): TranscriptSegment[] {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return [...segments];
  return segments.filter((seg) => seg.text.toLowerCase().includes(keyword));
}

/**
 * 当前播放位置落在的字幕段下标（s<=t<e；行间隙/未播放返回 -1）。
 * 抽成纯函数：搜索过滤后行序变化，高亮需在过滤结果上重算。
 */
export function currentSegmentIndex(segments: TranscriptSegment[], currentTime: number | undefined): number {
  if (typeof currentTime !== 'number' || !Number.isFinite(currentTime)) return -1;
  return segments.findIndex((seg) => seg.s <= currentTime && currentTime < seg.e);
}

/** 问答可用性判定结果：available=false 时 message 为给用户看的空态说明 */
export interface QaAvailability {
  available: boolean;
  message: string;
}

/**
 * 判定当前 mediaKey 能否发起 AI 问答：有 transcript 且至少一条有效段落才可用。
 * 方向裁决（第 14 轮）：B 站不做本地 ASR，无官方字幕即作罢——入口保持可见，
 * 点击后展示友好空态，不发起 qa.ask 请求。
 */
export function qaAvailability(transcript: TranscriptEntity | null | undefined): QaAvailability {
  if (transcript && transcript.segments.length > 0) {
    return { available: true, message: '' };
  }
  return { available: false, message: QA_NO_SUBTITLE_MESSAGE };
}

/**
 * qa.ask 失败的 B 站面板文案（第 27 轮审计 P2-1）：SW 侧问答编排与 HDU 共用，
 * 「转写缺失」类错误沿用 HDU 话术（如「本节还没有转写文本，请先生成转写后再提问」），
 * 对 B 站不适用——B 站字幕来自官方 CC，不存在本地转写作业。凡错误文案提及「转写」
 * 一律映射为 B 站语境的「暂无可用字幕」口径（qaAvailability 空态同款措辞）；
 * 其余错误（LLM 未配置、限流、网络失败等）原样透传。
 */
export function biliQaAskErrorText(err: unknown): string {
  // 第 255 轮错误文案盘点：缺省兜底补「提问」语境词（非 AppError 的兜底此前落
  // 泛化「操作失败，请重试」），与面板生成失败兜底「生成失败，请稍后重试」同族
  const text = errorTextOf(err, '提问失败，请稍后重试');
  return text.includes('转写') ? QA_NO_SUBTITLE_MESSAGE : text;
}

/**
 * 大纲 [ ] 快捷键步进（第 44 轮，移植 HDU 侧 controller/playerSync.stepOutline 的纯逻辑）：
 * 按 start 升序重排后，取「当前播放位置所在节点」（最后一个 start <= time 的节点）
 * 沿 direction 前进/后退一步，返回目标节点的 start 秒；无大纲/越界钳制后无目标返回 null。
 * 纯函数便于单测，UI 侧拿到非空返回值后自行 seek。
 */
export function outlineStepTarget(outline: OutlineNode[], time: number, direction: -1 | 1): number | null {
  if (!Array.isArray(outline) || outline.length === 0) return null;
  const ordered = [...outline].sort((a, b) => a.start - b.start);
  let current = -1;
  for (let i = 0; i < ordered.length; i += 1) {
    if ((ordered[i]?.start ?? 0) <= time) current = i;
  }
  const next = ordered[Math.max(0, Math.min(ordered.length - 1, current + direction))];
  return next ? next.start : null;
}

/** 速览页签「回到上次的位置」锚点条目（第 44 轮，移植 HDU 侧 OverviewTab anchors 聚合） */
export interface OverviewAnchor {
  label: string;
  seconds: number;
  kind: 'resume' | 'chat' | 'note';
}

export interface OverviewAnchorArgs {
  /** 上次播放位置（video.progress.get 的 lastPositionSec；≥30s 才提示，与续看 chip 同阈值） */
  lastPositionSec: number | null | undefined;
  /** 当前 mediaKey 的问答消息（只取用户消息的锚点，最近 2 条） */
  chats: Array<{ role: string; anchorTime?: number | null }>;
  /** 当前 mediaKey 的时间点笔记（最近 2 条） */
  notes: Array<{ anchorTime: number }>;
}

/**
 * 聚合速览页签的「回到上次的位置」锚点 chips：站点/官方进度断点 + 上次提问 + 最近笔记。
 * 纯函数：无任何可用锚点时返回空数组（UI 不渲染该区块）。
 */
export function buildOverviewAnchors(args: OverviewAnchorArgs): OverviewAnchor[] {
  const list: OverviewAnchor[] = [];
  const last = args.lastPositionSec;
  if (typeof last === 'number' && Number.isFinite(last) && last >= 30) {
    const seconds = Math.floor(last);
    list.push({ label: `上次看到 ${formatClock(seconds)}`, seconds, kind: 'resume' });
  }
  const chatAnchors = args.chats
    .filter((c) => c.role === 'user' && typeof c.anchorTime === 'number' && Number.isFinite(c.anchorTime))
    .slice(-2);
  for (const chat of chatAnchors) {
    const seconds = Math.floor(chat.anchorTime as number);
    list.push({ label: `上次提问 ${formatClock(seconds)}`, seconds, kind: 'chat' });
  }
  const noteAnchors = args.notes.filter((n) => Number.isFinite(n.anchorTime)).slice(-2);
  for (const note of noteAnchors) {
    const seconds = Math.max(0, Math.floor(note.anchorTime));
    list.push({ label: `笔记 ${formatClock(seconds)}`, seconds, kind: 'note' });
  }
  return list;
}
