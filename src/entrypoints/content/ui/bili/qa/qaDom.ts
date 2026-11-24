/**
 * B 站「学习助手」面板的页内 <video> 读取 helper（第 50 轮自 BiliQaPanel.tsx
 * 纯搬移拆分，逻辑逐行未变）：直接查页内 <video>（B 站 SPA 换节点后由调用方的
 * 轮询/监听跟随），全部为纯 DOM 读取函数，便于单测。
 */

import { formatClock } from '@/core/shared/utils';

/** 笔记页签 placeholder 跟随播放时间的读取节流间隔（ms） */
export const NOTE_PLACEHOLDER_THROTTLE_MS = 500;

/** 速览/大纲页签播放位置与当前节点高亮的刷新节流间隔（ms，与笔记 placeholder 同数量级） */
export const PLAY_CLOCK_THROTTLE_MS = 500;

/** 读取页内 <video> 当前播放秒数（问答 anchorTime；无播放器/异常时回退 0） */
export function readVideoCurrentTime(): number {
  const video = document.querySelector('video');
  const t = video?.currentTime;
  return typeof t === 'number' && Number.isFinite(t) && t > 0 ? Math.floor(t) : 0;
}

/**
 * 读取页内 <video> 当前时间的 mm:ss 文本（笔记页签实时 placeholder 用）；
 * 无播放器/时间非法时返回 null，调用方据此回退静态文案（与 readVideoCurrentTime
 * 同一「直接查页内 <video>」的读取模式，返回值区分「不可用」与「00:00」）。
 */
export function readVideoClockLabel(): string | null {
  const video = document.querySelector('video');
  const t = video?.currentTime;
  return typeof t === 'number' && Number.isFinite(t) && t >= 0 ? formatClock(Math.floor(t)) : null;
}

/**
 * 读取页内 <video> 时长秒数（速览「视频时长」格）：优先实时 duration（SPA 切 P 后
 * 各分 P 时长不同，props 快照会失真），播放器元数据未就绪（NaN/0）时回退调用方
 * 传入的挂载时快照。无播放器且无快照返回 null（渲染「--」）。
 */
export function readVideoDurationSec(fallback: number | null | undefined): number | null {
  const video = document.querySelector('video');
  const d = video?.duration;
  if (typeof d === 'number' && Number.isFinite(d) && d > 0) return Math.floor(d);
  return typeof fallback === 'number' && Number.isFinite(fallback) && fallback > 0 ? Math.floor(fallback) : null;
}
