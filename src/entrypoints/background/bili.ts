/**
 * B 站 Web API 编排（收藏夹导入；请求管线在 core/bili/apiClient.ts，此处只做业务组装）。
 *
 * 约定（与 apiClient.ts 一致）：
 *  - 请求统一带 credentials: 'include'，URL 先过 assertUrlAllowed（与 LLM 请求一致防御口径）；
 *  - B 站业务错误为 HTTP 200 + body.code != 0（如 -101 未登录、-412 风控），
 *    统一抛出 BILI_API_FAILED 的 AppError，userMessage 带常见 code 的中文语义提示；
 *  - 不做任何分页爬取循环——分页由前端逐页调用 op 完成。
 *  - 官方字幕获取（fetchBiliSubtitle）在 core/bili/subtitle.ts，与本文件共用同一请求底座。
 */

import { fetchBiliNav, fetchBiliBody, getWbiKeys, requireBiliData, toQuery } from '@/core/bili/apiClient';
import { signWbiParams } from '@/core/bili/wbi';
import { mapFavFolder, mapFavItem, type BiliFavFolder, type BiliFavItem } from '@/core/bili/favlist';
import { AppError } from '@/core/shared/errors';
import { clamp } from '@/core/shared/utils';

// nav（登录态 + wbi key）的解析已随请求底座下沉 core/bili/apiClient.ts；保持原导出供 op 层使用
export { fetchBiliNav };

const FOLDER_LIST_ALL_API = 'https://api.bilibili.com/x/v3/fav/folder/created/list-all';
const RESOURCE_LIST_API = 'https://api.bilibili.com/x/v3/fav/resource/list';

/** 资源列表单页条数上限（调用方可传更小的 ps） */
const ITEMS_PS_MAX = 30;
const ITEMS_PS_DEFAULT = 20;

/** 收藏夹列表（wbi 签名）。upMid 缺省时取当前登录用户 mid。 */
export async function fetchBiliFavFolders(upMid?: number): Promise<{ folders: BiliFavFolder[]; total: number }> {
  let mid = upMid;
  if (mid === undefined) mid = (await fetchBiliNav()).mid ?? undefined;
  if (mid === undefined) {
    throw new AppError('BILI_API_FAILED', {
      userMessage: 'B 站账号未登录，请先在浏览器登录 bilibili.com',
      detail: 'up_mid 缺省且 nav 未返回 mid',
    });
  }
  const keys = await getWbiKeys();
  const url = `${FOLDER_LIST_ALL_API}?${toQuery(signWbiParams({ up_mid: mid }, keys.imgKey, keys.subKey))}`;
  const data = requireBiliData(await fetchBiliBody(url), 'fav/folder/created/list-all');
  const list = Array.isArray(data.list) ? data.list : [];
  const folders = list.map(mapFavFolder).filter((folder): folder is BiliFavFolder => folder !== null);
  const total = typeof data.count === 'number' && Number.isFinite(data.count) ? data.count : folders.length;
  return { folders, total };
}

/** 收藏夹内容单页（wbi 签名；type=2 只取稿件、order=mtime 按收藏时间、platform=web） */
export async function fetchBiliFavItems(args: {
  mediaId: number;
  pn: number;
  ps?: number;
}): Promise<{ items: BiliFavItem[]; hasMore: boolean; total: number }> {
  if (!Number.isFinite(args.mediaId) || args.mediaId <= 0) {
    throw new AppError('INVALID_INPUT', { detail: `mediaId 不合法：${args.mediaId}` });
  }
  const pn = Number.isFinite(args.pn) ? Math.max(1, Math.floor(args.pn)) : 1;
  const psRaw = typeof args.ps === 'number' && Number.isFinite(args.ps) ? Math.floor(args.ps) : ITEMS_PS_DEFAULT;
  const ps = clamp(psRaw, 1, ITEMS_PS_MAX);
  const keys = await getWbiKeys();
  const url = `${RESOURCE_LIST_API}?${toQuery(
    signWbiParams({ media_id: args.mediaId, pn, ps, order: 'mtime', type: 2, platform: 'web' }, keys.imgKey, keys.subKey),
  )}`;
  const data = requireBiliData(await fetchBiliBody(url), 'fav/resource/list');
  const medias = Array.isArray(data.medias) ? data.medias : [];
  const items = medias.map(mapFavItem).filter((item): item is BiliFavItem => item !== null);
  return {
    items,
    hasMore: data.has_more === 1 || data.has_more === true,
    total: typeof data.total === 'number' && Number.isFinite(data.total) ? Math.max(0, data.total) : items.length,
  };
}
