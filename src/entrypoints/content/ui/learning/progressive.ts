/**
 * 列表渐进显示共享切分（第 245 轮巡检，性能域）。
 *
 * 现状盘点（审计结论）：知识库收藏列表与回收站此前各有一份内联 `slice(0, visibleLimit)`
 * + 「显示更多」实现（第 225/226 轮），复习待完成列表则无上限全量渲染。本轮把
 * 「前 N 条 + 追加步长」的切分口径抽成纯函数，复习待完成列表先接入；知识库两处
 * 为既有稳定渲染路径（e2e 覆盖），无行为收益不动，避免单轮改动过大。
 *
 * 纯函数无 IO、无 React 依赖，便于单测覆盖边界（恰 60 / 61 / 0 条）。
 */

/** 首批与每次追加条数（与知识库第 225/226 轮策略同值） */
export const VISIBLE_PAGE_STEP = 60;

/**
 * 取前 limit 条：limit 非正数 / 非有限值时返回空数组（防御式，不抛错）。
 * rows 非 null/undefined 时按数组处理（调用方传 state 数组，恒为数组）。
 */
export function visibleRowsOf<T>(rows: readonly T[] | null | undefined, limit: number): T[] {
  const list = Array.isArray(rows) ? rows : [];
  const cap = typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  return list.slice(0, cap);
}

/** 「显示更多」后的下一个上限：当前上限 + 步长（非法入参回退步长） */
export function nextVisibleLimit(current: number, step: number = VISIBLE_PAGE_STEP): number {
  const base = typeof current === 'number' && Number.isFinite(current) && current > 0 ? Math.floor(current) : 0;
  const stride = typeof step === 'number' && Number.isFinite(step) && step > 0 ? Math.floor(step) : VISIBLE_PAGE_STEP;
  return base + stride;
}
