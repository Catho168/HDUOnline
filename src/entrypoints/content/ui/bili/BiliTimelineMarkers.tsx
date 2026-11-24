// AI 标注时间轴叠加条（BiliTimelineMarkers）：aiResult.topics 存在时在播放器视频区
// 上方叠加区间标记，播放到区间高亮、点击 seek（行为对标 HDU 侧 TimelineLayer）。
// 自 bilibili.content.tsx 第 41 轮巡检纯搬移拆分，逻辑/类名/文案不变；
// 供单测（jsdom 冒烟）复用，生产由同目录 BiliCollectApp 挂载。

import { useState, useEffect, useMemo, useRef } from 'react';
import { callOp } from '@/core/shared/client';
import { formatClock } from '@/core/shared/utils';
import { biliMediaKey } from '@/core/shared/mediaRef';
import type { Topic } from '@/core/shared/types';
import { activeMarkerKey, buildTimelineMarkers } from '@/core/bili/aiMarkers';
import { watchVideoElement } from '@/entrypoints/content/ui/videoWatcher';

/**
 * AI 标注时间轴叠加条（第 25 轮功能扩展第二批）：aiResult.topics 存在时，在播放器
 * 视频区域上方叠加区间标记，行为对标 HDU 侧 TimelineLayer——标记按 intervals 换算
 * left/width 百分比、播放到区间高亮、点击 seek。
 *
 * 跟随方案：
 *  - 位置/时长：经 watchVideoElement 持续跟随当前 <video>（SPA 切 P/切清晰度换节点后
 *    重新捕获），onVideo 与每次 timeupdate（节流 500ms）用 getBoundingClientRect 重测，
 *    另监听 window resize；任何测量异常 fail-soft（保留上次结果，不影响播放）；
 *  - 数据：mediaKey 随分 P 变化——B 站切 P 无页面事件可监听，低频轮询 readPageP，
 *    变化即 ai.get 重读；无 aiResult / 无 topics 不渲染。
 * 供单测（jsdom 冒烟）复用；生产由 BiliCollectApp 挂载。
 */
export function BiliTimelineMarkers({ bvid, readPageP }: { bvid: string; readPageP: () => number }) {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null);
  const [currentTime, setCurrentTime] = useState<number | undefined>(undefined);
  const [duration, setDuration] = useState(0);
  const mediaKeyRef = useRef<string>('');

  // 分 P 跟随：?p= 变化 → 新 mediaKey → 重读 ai.get（1s 轮询足够，切 P 是低频操作）
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      try {
        const key = biliMediaKey(bvid, readPageP());
        if (key === mediaKeyRef.current) return;
        mediaKeyRef.current = key;
        void callOp('ai.get', { mediaKey: key })
          .then((r) => {
            // 迟到响应复核（第 25 轮复核 P2-2）：分 P 快速翻转时，旧 P 的迟到响应
            // 不得覆盖新 P 的结果——仅当响应所属 mediaKey 仍是当前 mediaKey 才写入
            if (!cancelled && key === mediaKeyRef.current) setTopics(r.result?.topics ?? []);
          })
          .catch(() => {
            if (!cancelled && key === mediaKeyRef.current) setTopics([]);
          });
      } catch {
        /* readPageP 异常不中断轮询（fail-soft） */
      }
    };
    load();
    const timer = window.setInterval(load, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [bvid, readPageP]);

  // 有标注才启用 <video> 跟随与测量（无标注期间不空转）
  useEffect(() => {
    if (topics.length === 0) return undefined;
    let video: HTMLVideoElement | null = null;
    let lastAt = 0;
    const measure = () => {
      try {
        const el = video;
        if (!el || !el.isConnected) return;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) setRect({ left: r.left, top: r.top, width: r.width });
        if (Number.isFinite(el.duration) && el.duration > 0) setDuration(el.duration);
      } catch {
        /* 测量异常保留上次结果（fail-soft，不影响播放） */
      }
    };
    const onTimeUpdate = () => {
      const now = Date.now();
      if (now - lastAt < 500) return;
      lastAt = now;
      setCurrentTime(video?.currentTime);
      measure();
    };
    const watcher = watchVideoElement({
      onVideo: (el) => {
        if (video === el) return;
        video?.removeEventListener('timeupdate', onTimeUpdate);
        video = el;
        setCurrentTime(el.currentTime);
        measure();
        el.addEventListener('timeupdate', onTimeUpdate);
      },
    });
    window.addEventListener('resize', measure);
    return () => {
      watcher.stop();
      video?.removeEventListener('timeupdate', onTimeUpdate);
      window.removeEventListener('resize', measure);
    };
  }, [topics]);

  const markers = useMemo(() => buildTimelineMarkers(topics, duration), [topics, duration]);
  // 起点越出视频时长的区间换算为 left=100%/width=0（不再叠加最小宽度，避免溢出播放器
  // 右缘，第 27 轮 P3）；这些标记永远不可能命中高亮（currentTime < duration），渲染层直接过滤
  const visibleMarkers = useMemo(() => markers.filter((m) => m.widthPercent > 0), [markers]);
  const activeKey = useMemo(() => activeMarkerKey(markers, currentTime), [markers, currentTime]);

  if (visibleMarkers.length === 0 || !rect) return null;

  const seekTo = (sec: number) => {
    try {
      const video = document.querySelector('video');
      if (video) video.currentTime = Math.max(0, Math.floor(sec));
    } catch {
      /* seek 失败不影响播放 */
    }
  };

  return (
    <div
      className="bili-timeline"
      style={{ left: rect.left, top: Math.max(0, rect.top - 10), width: rect.width }}
      aria-hidden="true"
    >
      {visibleMarkers.map((m) => (
        <button
          type="button"
          key={m.key}
          className={`bili-timeline-mark${m.confidence === 'low' ? ' is-low' : ''}${m.key === activeKey ? ' is-active' : ''}`}
          style={{ left: `${m.leftPercent}%`, width: `${m.widthPercent}%` }}
          title={`${m.name} · ${formatClock(m.start)}–${formatClock(m.end)}`}
          onClick={() => seekTo(m.start)}
        />
      ))}
    </div>
  );
}
