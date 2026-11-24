/**
 * HDU 播放器时间轴标记的几何换算（纯函数，供 content/ui/App.tsx 的 TimelineLayer 使用）。
 *
 * 换算口径与 B 站侧 core/bili/aiMarkers.ts 的 buildTimelineMarkers 一致：起点越出视频时长的
 * 区间不再叠加最小宽度，避免 left+width 溢出播放器右缘。历史脉络：第 27 轮 B 站先修（当时仅
 * 在 left>=100 时钳 0），第 28 轮 HDU 补齐近缘带钳制，第 29 轮审计#1 双端单份化——B 站侧已改为
 * 直接复用本函数，两端几何口径完全一致，不再存在差异。
 * 放在 core/shared 而非直接复用 core/bili：HDU 内容脚本 UI 不应反向依赖 B 站站点模块（分层耦合），
 * 且 core/bili 正由问答/档位改动占用；本模块只承载 HDU 侧需要的最小换算，便于脱离 jsdom 直测。
 */

/** 标记条最小宽度百分比（过窄区间仍可点中；口径与 B 站 aiMarkers 的 0.35 一致） */
const MIN_MARKER_WIDTH_PERCENT = 0.35;

/** 单个时间轴标记在播放器宽度上的定位（百分比） */
export interface TimelineMarkerRect {
  /** 起点百分比（0–100，已钳制） */
  leftPercent: number;
  /** 宽度百分比；起点越出时长（left 已钳到 100）时为 0，渲染层应过滤零宽标记 */
  widthPercent: number;
}

/**
 * 单个时间区间 → 播放器宽度百分比定位（left/width）。
 * 前置条件：durationSec > 0（调用方 TimelineLayer 已在 duration<=0 时整体不渲染）。
 *  - left 钳 0–100；
 *  - 先按「区间占比」算宽（窄区间保 MIN 最小可点宽度），再以 100-left 钳制右缘：
 *    近缘区间（left∈(99.65,100)）不再因 0.35 下限溢出播放器右缘（修复前
 *    left+width 最高 100.35%），left>=100（起点越出时长）时 width=0；
 *  - 双端共用本实现（第 29 轮审计#1）：core/bili/aiMarkers.buildTimelineMarkers 与 HDU
 *    TimelineLayer 都走本函数，近缘带整带钳制、left>=100 时 width=0 的口径两端一致，
 *    不再有「B 站近缘带保 0.35 下限」的旧差异。
 */
export function timelineMarkerRect(start: number, end: number, durationSec: number): TimelineMarkerRect {
  const left = Math.max(0, Math.min(100, (start / durationSec) * 100));
  const ratio = ((end - start) / durationSec) * 100;
  const width = left >= 100 ? 0 : Math.min(Math.max(MIN_MARKER_WIDTH_PERCENT, ratio), 100 - left);
  return { leftPercent: left, widthPercent: width };
}
