/**
 * B 站收藏夹数据的防御式映射（纯函数）。
 *
 * B 站接口字段无契约保证（可能缺失/类型漂移/混入非视频条目），这里参照
 * llm/validate.ts 的严格校验风格逐字段校验：不满足最小语义的条目返回 null，
 * 由调用方跳过；可选字段缺失时回退为空串/0/null。
 */

// 宽松对象判断收敛为 shared/utils 单份实现（第 16 轮 P3：全仓收敛，apiClient 不再转出）
import { asRecord } from '../shared/utils';

export interface BiliFavFolder {
  /** 收藏夹 id（resource/list 的 media_id 参数） */
  id: number;
  title: string;
  mediaCount: number;
}

export interface BiliFavItem {
  bvid: string;
  title: string;
  coverUrl: string;
  uploader: string;
  /** 时长秒数（B 站 API 数字字段）；缺失/无效时为 null */
  durationSec: number | null;
  intro: string;
}

/** 有限数值 → 整数（B 站 id / 时长均为数字字段），其余返回 null */
function asInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.floor(value);
}

/** 仅接受字符串并去首尾空白，其余类型回退为空串 */
function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 收藏夹（folder/created/list-all 的 list 项）；id 或 title 缺失视为无效 */
export function mapFavFolder(raw: unknown): BiliFavFolder | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const id = asInt(rec.id);
  if (id === null) return null;
  const title = asText(rec.title);
  if (!title) return null;
  const mediaCount = asInt(rec.media_count);
  return { id, title, mediaCount: Math.max(0, mediaCount ?? 0) };
}

/**
 * 收藏条目（resource/list 的 medias 项）→ 视频信息。
 * 只接受带 bvid 的视频稿件（兼容旧字段 bv_id）；剧集/合集/音频等无 bvid 的条目
 * 一律返回 null，调用方跳过。
 */
export function mapFavItem(raw: unknown): BiliFavItem | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const bvid = asText(rec.bvid) || asText(rec.bv_id);
  if (!bvid) return null;
  const title = asText(rec.title);
  if (!title) return null;
  const upper = asRecord(rec.upper);
  const duration = asInt(rec.duration);
  return {
    bvid,
    title,
    coverUrl: asText(rec.cover),
    uploader: upper ? asText(upper.name) : '',
    durationSec: duration !== null && duration > 0 ? duration : null,
    intro: asText(rec.intro),
  };
}
