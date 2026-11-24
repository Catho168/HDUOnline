// B 站视频页信息提取：BiliVideoInfo 结构、extractBiliVideoInfo（挂载时 DOM 一次性快照）
// 与 readBiliPageP（动作触发时实时读分 P）。自 bilibili.content.tsx 第 41 轮巡检纯搬移拆分，
// 逻辑不变；分 P 解析口径仍复用 core/bili/assistant.parseBiliPageParam（不重复实现）。

import { parseDurationSec } from '@/core/shared/duration';
import { parseBiliPageParam } from '@/core/bili/assistant';

export interface BiliVideoInfo {
  bvid: string;
  title: string;
  coverUrl: string;
  uploader: string;
  duration: string;
  durationSec: number | null;
  description: string;
  url: string;
}

/**
 * 当前分 P 序号（视频页 URL `?p=N`，缺省 1；非法值回退 1）。
 * B 站是 SPA：切分 P 不重载页面、内容脚本不重跑，videoInfo 只在挂载时提取一次，
 * 所以分 P 不存进 videoInfo，而是在字幕获取/问答提问/收藏此时刻等动作触发时实时读
 * URL（第 16 轮多 P 支持的既有跟随机制）。
 * 解析与回退口径抽到 core/bili/assistant.parseBiliPageParam 纯函数（含第 17 轮 P3-3
 * 的严格十进制限长规则），字幕/问答/收藏三处共用一份实现。
 */
export function readBiliPageP(): number {
  return parseBiliPageParam(new URLSearchParams(window.location.search).get('p'));
}

export function extractBiliVideoInfo(): BiliVideoInfo | null {
  const url = window.location.href;
  const bvidMatch = url.match(/\/video\/(BV[\w]+)/);
  if (!bvidMatch) return null;

  const bvid = bvidMatch[1] ?? '';
  // 标题优先取 DOM 文本（og:title 可能带 "_哔哩哔哩_bilibili" 后缀或过期）——移植远程修复 d64a602
  const title =
    document.querySelector('.video-title')?.textContent?.trim() ??
    document.querySelector('meta[property="og:title"]')?.getAttribute('content')?.replace(/_哔哩哔哩_bilibili$/, '') ??
    document.querySelector('h1')?.textContent?.trim() ??
    document.title;

  const coverUrl =
    document.querySelector('meta[property="og:image"]')?.getAttribute('content') ??
    document.querySelector('meta[itemprop="image"]')?.getAttribute('content') ??
    '';

  const uploader =
    document.querySelector('.up-name')?.textContent?.trim() ??
    document.querySelector('meta[name="author"]')?.getAttribute('content') ??
    '';

  // 时长：优先结构化 meta[property="video:duration"]（移植远程修复 d64a602），回退 DOM 文本（e2e fixture 依赖）
  const metaDurationSec = document.querySelector('meta[property="video:duration"]')?.getAttribute('content');
  const duration =
    metaDurationSec && Number.isFinite(Number(metaDurationSec)) && Number(metaDurationSec) > 0
      ? formatDuration(Number(metaDurationSec))
      : (document.querySelector('.video-duration')?.textContent?.trim() ?? '');

  // 时长秒数：优先 <video> 元素的 duration（有限数值），否则解析 DOM 时长文本
  const videoEl = document.querySelector('video');
  const playerDurationSec =
    videoEl && Number.isFinite(videoEl.duration) && videoEl.duration > 0 ? Math.floor(videoEl.duration) : null;
  const durationSec = playerDurationSec ?? parseDurationSec(duration);

  // 简介：以 .basic-desc-info 为主（og:description 混入推广文案，降为回退），过滤 "-" 占位——移植远程修复 d64a602
  const rawDesc =
    document.querySelector('.basic-desc-info')?.textContent?.trim() ??
    document.querySelector('meta[property="og:description"]')?.getAttribute('content') ??
    '';
  const description = rawDesc && rawDesc !== '-' ? rawDesc : '';

  return { bvid, title, coverUrl, uploader, duration, durationSec, description, url };
}

// 秒 → "m:ss"（配合 meta[property="video:duration"]，d64a602 引入）
function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
