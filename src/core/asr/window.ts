/**
 * 局部转写时间窗（§5.2 B1："只转写当前进度前后 x 分钟"，片段流式转写的口径来源）。
 *
 * 该口径被多处共用，必须逐字一致，故集中在此模块：
 *  - SW 编排（entrypoints/background/asr.ts）：按设置与当前播放位置规划窗口与分片范围；
 *  - 主路径管线（core/asr/pipeline.ts）：只处理与窗口相交的分片，进度按窗口内音频计；
 *  - 兜底回灌（entrypoints/asr-worker.ts）：跳过窗口外的分片，不向其请求 PCM；
 *  - 跟随决策（core/asr/follow.ts）：以同一口径计算窗口内待转分片。
 *
 * 为什么需要它：整段转写大文件时内存/流量随视频长度线性增长；只转写当前进度前后各 x 分钟
 * 走的是"音轨流式"主路径，只需拉取该窗口的音频字节，内存与流量都可控。
 */

import { ASR_PARAMS } from '../shared/constants';

export interface TranscribeWindow {
  /** 起点（秒，含） */
  start: number;
  /** 终点（秒，不含） */
  end: number;
}

/** 片段半径（分钟）→ 秒；越界/非法一律收进允许范围（设置在页面上可被手改） */
export function clampWindowMinutes(raw: unknown): number {
  const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : ASR_PARAMS.windowMinutesDefault;
  return Math.min(ASR_PARAMS.windowMinutesMax, Math.max(ASR_PARAMS.windowMinutesMin, Math.round(value)));
}

/** 片段半径（秒）：由设置里的分钟数换算，供 SW / 管线共用同一口径 */
export function windowHalfSecFromMinutes(minutes: unknown): number {
  return clampWindowMinutes(minutes) * 60;
}

/** 以 aroundSec 为中心、前后各 halfSec 的窗口；裁剪到 [0, durationSec] */
export function resolveWindow(
  aroundSec: number | undefined,
  halfSec: number,
  durationSec: number,
): TranscribeWindow {
  const center = typeof aroundSec === 'number' && Number.isFinite(aroundSec) ? Math.max(0, aroundSec) : 0;
  const half = Math.max(0, halfSec);
  const start = Math.max(0, center - half);
  // 时长未知（0）时不做上界裁剪，只按中心 ±half
  const upper = durationSec > 0 ? durationSec : center + half;
  const end = Math.max(start, Math.min(upper, center + half));
  return { start, end };
}

/** 分片是否与窗口相交（半开区间相交；无窗口恒为 true） */
export function chunkInWindow(
  index: number,
  chunkSec: number,
  durationSec: number,
  window?: TranscribeWindow,
): boolean {
  if (!window) return true;
  const startSec = index * chunkSec;
  const endSec = durationSec > 0 ? Math.min(startSec + chunkSec, durationSec) : startSec + chunkSec;
  return endSec > window.start && startSec < window.end;
}

/**
 * 与窗口相交的分片索引闭区间。
 * 窗口完全落在分片表之外（例如时长未知导致的分片数不足）时返回 null。
 */
export function windowChunkRange(
  window: TranscribeWindow,
  durationSec: number,
  chunkSec: number,
): { first: number; last: number } | null {
  const count = Math.max(1, Math.ceil(durationSec / chunkSec));
  const first = Math.max(0, Math.min(count - 1, Math.floor(window.start / chunkSec)));
  const last = Math.max(0, Math.min(count - 1, Math.ceil(window.end / chunkSec) - 1));
  if (last < first) return null;
  return { first, last };
}

/** 窗口内的音频秒数：作为进度分母，避免"窗口作业只跑到 40% 就结束"的错觉 */
export function windowAudioSec(window: TranscribeWindow, durationSec: number): number {
  const end = durationSec > 0 ? Math.min(window.end, durationSec) : window.end;
  return Math.max(0, end - window.start);
}
