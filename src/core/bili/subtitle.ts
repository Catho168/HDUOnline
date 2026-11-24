/**
 * B 站官方字幕获取适配器（纯 core 模块，fetch/wbi key 可注入以供单测）。
 *
 * 方向变更（2026-11-15 用户裁决）：B 站不做本地 ASR 转写（音频适配器已剔除），
 * 改为拉取 B 站官方字幕；**视频无字幕则作罢**——返回 { status:'none' }，
 * 不抛错、不落库、不视为失败。
 *
 * 链路（docs/B站字幕获取专项设计.md §3）：
 *  1. x/player/pagelist?bvid= → cid（多 P 按 p 取对应分 P，缺省 P1）与该 P 时长；
 *     pagelist 的 data 是数组（业务 code 语义与 requireBiliData 相同，data 形状不同）；
 *  2. x/player/wbi/v2?bvid=&cid=（wbi 签名复用 signWbiParams；credentials:'include'；
 *     15s 超时；SSRF 校验沿用 urlGuard）→ data.subtitle.subtitles[]；
 *  3. subtitles 为空 → { status:'none' }（无字幕作罢）；非空 → 选轨（pickSubtitleTrack）；
 *  4. subtitle_url（协议相对 `//` 补 https）拉 JSON → body[].from/to/content（秒）
 *     → TranscriptSegment。
 *
 * 时间单位换算依据（核读 TranscriptEntity 后确定）：仓库 TranscriptSegment.s/e 本身
 * 就是秒（unified search 的 startSec、QA anchorTime、跳转 ?t= 均按秒消费，HDU 本地
 * ASR 也直接落秒），B 站字幕 JSON 的 from/to 亦是秒（社区文档 bilibili-API-collect
 * 口径），**故直接映射，不做倍率换算**（需真机验证项：字段语义见 §5）。
 */

import { fetchBiliBody, getWbiKeys, requireBiliCode, requireBiliData, toQuery } from './apiClient';
import { signWbiParams } from './wbi';
import { AppError } from '../shared/errors';
import { asRecord } from '../shared/utils';
import type { TranscriptCoverageRange, TranscriptSegment } from '../shared/types';

const PAGELIST_API = 'https://api.bilibili.com/x/player/pagelist';
const PLAYER_API = 'https://api.bilibili.com/x/player/wbi/v2';

/**
 * 字幕正文 CDN 域白名单（第 15 轮审计 P2-1，防御纵深）：B 站 player 接口返回的
 * subtitle_url 拉正文前必须落在官方域（.hdslb.com 后缀）。先紧后松——真机若出现
 * 其它官方子域再增量放宽。player 响应被污染时，SW 持有扩展 host_permissions 的
 * Cookie 域，无限域的 fetch 会被用来携带受信站点 Cookie 读响应（影响=本地数据污染）。
 */
const SUBTITLE_CDN_SUFFIX = '.hdslb.com';

export function assertSubtitleCdnUrl(url: string): void {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    throw new AppError('BILI_API_FAILED', {
      userMessage: '字幕地址无法解析，已拦截',
      detail: 'subtitle_url 解析失败',
      retryable: false,
    });
  }
  if (!host.endsWith(SUBTITLE_CDN_SUFFIX)) {
    throw new AppError('BILI_API_FAILED', {
      userMessage: '字幕地址非官方域名，已拦截',
      detail: `subtitle_url host=${host}`,
      retryable: false,
    });
  }
}

// ───────────────────────── 防御式读取 ─────────────────────────

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// ───────────────────────── 选轨与解析（纯函数） ─────────────────────────

/** 单条字幕轨（player/wbi/v2 的 subtitles[] 项，已按最小语义校验） */
export interface BiliSubtitleTrack {
  /** 字幕语言代码（如 zh-CN / ai-zh） */
  lan: string;
  /** 语言名称（人类可读，如「中文（自动识别）」） */
  lanDoc: string;
  /** 是否 AI 生成字幕 */
  ai: boolean;
  /** 字幕 JSON 地址（协议相对 `//` 已补 https） */
  url: string;
}

/** 字幕正文解析 + coverage 聚合结果 */
export interface BiliSubtitleContent {
  lan: string;
  lanDoc: string;
  /** 选中的轨是否 AI 字幕 */
  ai: boolean;
  cid: number;
  /** 分 P 时长（pagelist 的 duration，秒）；缺失为 null */
  durationSec: number | null;
  segments: TranscriptSegment[];
  /** 字幕实际覆盖区间（有文字的区间并集，非音频全程） */
  coverage: TranscriptCoverageRange[];
  coveredSec: number;
}

export type BiliSubtitleFetchResult = { status: 'none' } | ({ status: 'ok' } & BiliSubtitleContent);

/** 协议相对地址补 https；空串原样返回 */
export function normalizeSubtitleUrl(url: string): string {
  if (!url) return '';
  return url.startsWith('//') ? `https:${url}` : url;
}

/**
 * 单轨解析：subtitle_url 缺失视为无效轨（无法拉取正文）返回 null。
 * AI 判定口径（注释即规格）：`ai_type` 为主（社区文档：1 = AI 识别生成）；
 * `ai_type` 缺失时才以 `ai_status === 1` 兜底——ai_status 的独立语义未在文档中
 * 明确，仅作降级信号（需真机验证）。
 */
export function parseSubtitleTrack(raw: unknown): BiliSubtitleTrack | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const url = normalizeSubtitleUrl(asText(rec.subtitle_url));
  if (!url) return null;
  const aiType = asNumber(rec.ai_type);
  const aiStatus = asNumber(rec.ai_status);
  const ai = aiType !== null ? aiType === 1 : aiStatus === 1;
  return { lan: asText(rec.lan), lanDoc: asText(rec.lan_doc), ai, url };
}

/** player/wbi/v2 的 data → 字幕轨列表（data.subtitle.subtitles 缺失/非数组一律为空） */
export function parseSubtitleTracks(data: unknown): BiliSubtitleTrack[] {
  const rec = asRecord(data);
  const subtitle = rec ? asRecord(rec.subtitle) : null;
  const list = subtitle && Array.isArray(subtitle.subtitles) ? subtitle.subtitles : [];
  return list.map(parseSubtitleTrack).filter((track): track is BiliSubtitleTrack => track !== null);
}

/** zh/中文判定：lan 以 zh 开头（zh-CN / zh-Hans / zh-TW…）或语言名含「中文」 */
export function isChineseSubtitle(track: BiliSubtitleTrack): boolean {
  if (track.lan.toLowerCase().startsWith('zh')) return true;
  return track.lanDoc.includes('中文');
}

/**
 * 选轨口径（规格即注释）：
 *  1. UP 主字幕（ai=false）优先于 AI 字幕（ai=true）——AI 识别文本质量低于人工字幕；
 *  2. 同为一级（同为 UP 主或同为 AI）时 zh/中文优先；
 *  3. 其余保持接口返回顺序（稳定排序），作为最后兜底。
 *  空列表返回 null（调用方按「无字幕作罢」处理）。
 */
export function pickSubtitleTrack(tracks: BiliSubtitleTrack[]): BiliSubtitleTrack | null {
  if (tracks.length === 0) return null;
  const scored = tracks.map((track, index) => ({
    track,
    index,
    aiRank: track.ai ? 1 : 0,
    zhRank: isChineseSubtitle(track) ? 0 : 1,
  }));
  scored.sort((a, b) => a.aiRank - b.aiRank || a.zhRank - b.zhRank || a.index - b.index);
  return scored[0]?.track ?? null;
}

/**
 * pagelist（data 为分 P 数组）→ 目标分 P 的 cid 与时长。
 * p 从 1 计；非法/越界回退到 P1（不抛错，按最常见的单 P 场景兜底）；
 * 无分页记录或 cid 缺失返回 null（调用方抛 INVALID_INPUT 语义的上层错误）。
 */
export function resolvePageCid(pages: unknown, p: number): { cid: number; durationSec: number | null } | null {
  const list = Array.isArray(pages) ? pages : [];
  if (list.length === 0) return null;
  const index = Number.isFinite(p) && p >= 1 ? Math.min(Math.floor(p), list.length) - 1 : 0;
  const rec = asRecord(list[index]);
  const cid = rec ? asNumber(rec.cid) : null;
  if (cid === null) return null;
  const duration = rec ? asNumber(rec.duration) : null;
  return { cid: Math.floor(cid), durationSec: duration !== null && duration > 0 ? duration : null };
}

/** coverage 区间合并：按 start 排序后合并重叠/相接区间；空段（end<=start）丢弃 */
export function mergeCoverage(ranges: TranscriptCoverageRange[]): TranscriptCoverageRange[] {
  const sorted = ranges.filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  const merged: TranscriptCoverageRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ start: range.start, end: range.end });
    }
  }
  return merged;
}

/**
 * 字幕 JSON（`{ body: [{ from, to, content }, …] }`，容忍直接给数组）→ 仓库 segments。
 *  - from/to 为秒（B 站口径，需真机验证）；仓库 s/e 亦为秒，直接映射不换算；
 *  - from < 0 为脏数据直接丢弃（防 coverage 虚增；formatSeconds/seek 下游已有兜底，
 *    此处做源头治理）；
 *  - to < from 时按 from 收口（防御脏数据）；无 content / 时间缺失的行跳过；
 *  - 按 from 升序排序（接口一般有序，排序保证 coverage 合并与 UI 顺序稳定）。
 */
export function parseSubtitleSegments(json: unknown): {
  segments: TranscriptSegment[];
  coverage: TranscriptCoverageRange[];
  coveredSec: number;
} {
  const rec = asRecord(json);
  const list = rec && Array.isArray(rec.body) ? rec.body : Array.isArray(json) ? json : [];
  const segments: TranscriptSegment[] = [];
  for (const raw of list) {
    const item = asRecord(raw);
    if (!item) continue;
    const from = asNumber(item.from);
    const to = asNumber(item.to);
    const text = asText(item.content);
    if (from === null || to === null || !text) continue;
    if (from < 0) continue;
    segments.push({ s: from, e: Math.max(to, from), text });
  }
  segments.sort((a, b) => a.s - b.s);
  const coverage = mergeCoverage(segments.map((seg) => ({ start: seg.s, end: seg.e })));
  const coveredSec = coverage.reduce((acc, range) => acc + (range.end - range.start), 0);
  return { segments, coverage, coveredSec };
}

// ───────────────────────── 编排（网络） ─────────────────────────

export interface BiliSubtitleDeps {
  /** 网络层注入（单测）；缺省走全局 fetch（SW 内执行） */
  fetchImpl?: typeof fetch;
  /** wbi key 来源注入（单测）；缺省走 apiClient 的缓存 nav 流程 */
  getWbiKeys?: () => Promise<{ imgKey: string; subKey: string }>;
}

export interface BiliSubtitleOptions {
  /** 多 P 视频的分 P 序号（从 1 计）；缺省 P1（UI 自第 16 轮起从 URL `?p=` 实时读取透传） */
  p?: number;
  deps?: BiliSubtitleDeps;
}

/**
 * 拉取一条 B 站官方字幕（完整链路）。无字幕 / 有轨无正文 → `{ status:'none' }`
 * （作罢，不抛错）；接口错误（含 -352/-412/-799 风控等）照常抛 BILI_API_FAILED
 * 的 AppError（语义沿用 apiClient 的风控分类）。
 */
export async function fetchBiliSubtitle(
  bvid: string,
  opts: BiliSubtitleOptions = {},
): Promise<BiliSubtitleFetchResult> {
  const id = typeof bvid === 'string' ? bvid.trim() : '';
  if (!id.startsWith('BV') || id.length < 3) {
    throw new AppError('INVALID_INPUT', { detail: `bvid 不合法：${bvid}` });
  }
  const fetchImpl = opts.deps?.fetchImpl ?? fetch;
  const keys = await (opts.deps?.getWbiKeys ?? getWbiKeys)();

  // ① cid：pagelist（data 为数组，业务 code 校验复用 requireBiliCode）
  const pageListRec = await fetchBiliBody(`${PAGELIST_API}?bvid=${encodeURIComponent(id)}`, fetchImpl);
  requireBiliCode(pageListRec, 'player/pagelist');
  const page = resolvePageCid(pageListRec.data, opts.p ?? 1);
  if (!page) {
    throw new AppError('BILI_API_FAILED', {
      userMessage: '未找到该视频的分 P 信息，无法获取字幕',
      detail: 'player/pagelist 缺少 cid',
      retryable: true,
    });
  }

  // ② 字幕轨列表：player/wbi/v2（wbi 签名）
  const playerUrl = `${PLAYER_API}?${toQuery(signWbiParams({ bvid: id, cid: page.cid }, keys.imgKey, keys.subKey))}`;
  const data = requireBiliData(await fetchBiliBody(playerUrl, fetchImpl), 'player/wbi/v2');
  const tracks = parseSubtitleTracks(data);
  const track = pickSubtitleTrack(tracks);
  // 无字幕作罢：不抛错、不落库，由调用方决定 UI 提示
  if (!track) return { status: 'none' };

  // ③ 字幕正文：字幕 JSON 不是业务包装（无 code 字段），fetchBiliBody 只做解析。
  // 拉取前先过官方域白名单（P2-1：subtitle_url 来源信任 player 响应，加防御纵深）
  assertSubtitleCdnUrl(track.url);
  const json = await fetchBiliBody(track.url, fetchImpl);
  const { segments, coverage, coveredSec } = parseSubtitleSegments(json);
  // 有轨但无有效正文同样按作罢处理（空字幕对用户无价值）
  if (segments.length === 0) return { status: 'none' };

  return {
    status: 'ok',
    lan: track.lan,
    lanDoc: track.lanDoc,
    ai: track.ai,
    cid: page.cid,
    durationSec: page.durationSec,
    segments,
    coverage,
    coveredSec,
  };
}
