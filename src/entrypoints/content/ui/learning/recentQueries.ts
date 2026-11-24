/**
 * 最近搜索记录纯函数（第 246 轮巡检，搜索域 / 效率延续视角）。
 *
 * 顶栏统一搜索每次非空提交把关键词记进 `settings.ui.recentQueries`（最新在前、
 * 去重前移、最多 5 条，跨打开保留）——聚焦且输入为空时在输入框下方回放成 chips，
 * 点击即重搜。仿 learning/progressive.ts 先例：纯函数无 IO、无 React 依赖，
 * 便于单测覆盖边界（去重前移 / cap 截断 / 空白与非法防御 / 删除）。
 *
 * 防御式口径：入参可能是 settings.ui 里持久化的旧数据（脏类型），list 非数组按
 * 空表处理不抛错；query 非字符串或 trim 后为空不记录；单条上限 MAX_LEN 字符
 * （截断存储，超长词不进 chips 布局；UI 另有 CSS ellipsis 展示截断 + title 全文）。
 */

/** 最多保留条数（超限淘汰最旧） */
export const RECENT_QUERY_CAP = 5;

/** 单条存储长度上限（字符；防御超长粘贴词撑爆 settings 与 chips 行） */
export const RECENT_QUERY_MAX_LEN = 120;

/** 规范化单条 query：非字符串 / trim 后为空返回 null；否则截断到存储上限 */
function normalizeQuery(q: unknown): string | null {
  if (typeof q !== 'string') return null;
  const trimmed = q.trim();
  if (!trimmed) return null;
  return trimmed.length > RECENT_QUERY_MAX_LEN ? trimmed.slice(0, RECENT_QUERY_MAX_LEN) : trimmed;
}

/**
 * 记录一条最近搜索：去重前移（最新在前）、cap 截断、空白与非法入参防御。
 *  - list 非数组（脏持久化数据）按空表处理；
 *  - q 非法（非字符串 / 空白）返回规范化后的原列表（数量不减、顺序不变）；
 *  - cap 非法（非正数 / 非有限值）回退默认 5。
 */
export function pushRecentQuery(list: unknown, q: unknown, cap: number = RECENT_QUERY_CAP): string[] {
  const base = Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
  const query = normalizeQuery(q);
  if (!query) return base;
  const limit = typeof cap === 'number' && Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : RECENT_QUERY_CAP;
  const next = base.filter((item) => item !== query);
  next.unshift(query);
  return next.slice(0, limit);
}

/** 删除单条最近搜索（不存在时原样返回等价副本；list 脏数据防御同上） */
export function removeRecentQuery(list: unknown, q: unknown): string[] {
  const base = Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
  if (typeof q !== 'string') return base;
  return base.filter((item) => item !== q);
}

/** chips 展示文本：超长词截断显示（title 仍给全文） */
export function recentQueryLabel(q: string, maxLen: number = 16): string {
  if (typeof q !== 'string') return '';
  return q.length > maxLen ? `${q.slice(0, maxLen)}…` : q;
}

/** 空结果建议词（第 308 轮，检索域/可用性）：关键词超过阈值时点名字数，引导只取核心词
 *  重搜；统一搜索与 B 站字幕空结果共用同一口径（阈值 16 字，与 recentQueryLabel 截断
 *  展示同量级）。纯函数无 IO，便于单测覆盖 16/17 字边界与非字符串防御。 */
export function emptySearchTip(keyword: unknown, threshold = 16): string {
  const len = typeof keyword === 'string' ? keyword.trim().length : 0;
  return len > threshold
    ? `关键词较长（${len} 字）——试试更短的关键词，或只取核心词重搜`
    : '试试更短的关键词，或换个说法';
}
