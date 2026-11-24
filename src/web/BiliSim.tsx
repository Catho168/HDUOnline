import { useEffect, useRef, useState } from 'react';
import { formatClock } from '@/core/shared/utils';
import { BiliCollectApp } from '@/entrypoints/content/ui/bili/BiliCollectApp';
import { BILI_CSS } from '@/entrypoints/content/ui/bili/bili-styles';
import { setupProgressTracking } from '@/entrypoints/content/ui/bili/progressTracking';

interface BiliSimProps {
  dark?: boolean;
  bvid?: string;
}

const DEMO_BILI_VIDEOS = [
  {
    bvid: 'BV1DEMO7X4Kq',
    title: '线性代数公开课：特征值与相似对角化',
    uploader: '线性代数小课堂',
    durationSec: 980,
    durationText: '16:20',
    description: '从特征方程、特征向量到实对称矩阵正交对角化的完整推导与例题。',
  },
  {
    bvid: 'BV1DEMO2LpVe',
    title: '数据结构 30 题精讲：二叉树与哈希',
    uploader: '算法手写板',
    durationSec: 2450,
    durationText: '40:50',
    description: '二叉树非递归遍历、平衡因子与哈希冲突解决高频面试题。',
  },
  {
    bvid: 'BV1DEMO9PhYs',
    title: '大学物理期末速通：电磁学',
    uploader: '物理速通社',
    durationSec: 1800,
    durationText: '30:00',
    description: '高斯定理、安培环路定理与法拉第电磁感应定律典型计算。',
  },
];

export function BiliSim({ dark, bvid }: BiliSimProps) {
  const initialVideo = DEMO_BILI_VIDEOS.find((v) => v.bvid === bvid) ?? DEMO_BILI_VIDEOS[0]!;
  const [selectedBvid, setSelectedBvid] = useState(initialVideo.bvid);
  const [pageP, setPageP] = useState(1);
  const [urlReady, setUrlReady] = useState(false);
  const [paused, setPaused] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const meta = DEMO_BILI_VIDEOS.find((v) => v.bvid === selectedBvid) ?? DEMO_BILI_VIDEOS[0]!;
  const stateRef = useRef({ currentTime: 0, duration: meta.durationSec, paused: true });

  // 在 B 站助手视图期间把浏览器 URL 路径暂置为 /video/BV...（供 extractBiliVideoInfo/readBiliPageP 识别），退出恢复
  useEffect(() => {
    const savedHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const targetPath = `/video/${selectedBvid}${pageP > 1 ? `?p=${pageP}` : ''}`;
    window.history.replaceState(null, '', targetPath);
    setUrlReady(true);

    return () => {
      window.history.replaceState(null, '', savedHref);
    };
  }, [selectedBvid, pageP]);

  // 给模拟 B 站播放器挂载时长/seek/canvas 画面流 + 进度追踪
  useEffect(() => {
    if (!urlReady) return;
    const video = videoRef.current;
    if (!video) return;

    stateRef.current = { currentTime: 0, duration: meta.durationSec, paused: true };
    setCurrentTime(0);
    setPaused(true);

    const canvas = document.createElement('canvas');
    canvas.width = 960;
    canvas.height = 540;
    const ctx = canvas.getContext('2d');
    if (typeof canvas.captureStream === 'function') {
      try {
        video.srcObject = canvas.captureStream(12);
      } catch {
        /* ignore */
      }
    }

    const emit = (name: string) => video.dispatchEvent(new Event(name));
    Object.defineProperties(video, {
      duration: {
        configurable: true,
        get: () => stateRef.current.duration,
      },
      currentTime: {
        configurable: true,
        get: () => stateRef.current.currentTime,
        set: (val: number) => {
          const next = Number.isFinite(val) ? Math.max(0, Math.min(val, stateRef.current.duration)) : 0;
          stateRef.current.currentTime = next;
          setCurrentTime(next);
          emit('seeking');
          emit('timeupdate');
          emit('seeked');
        },
      },
      paused: {
        configurable: true,
        get: () => stateRef.current.paused,
      },
      play: {
        configurable: true,
        value: async () => {
          stateRef.current.paused = false;
          setPaused(false);
          emit('play');
          emit('timeupdate');
          try {
            await HTMLMediaElement.prototype.play.call(video);
          } catch {
            /* ignore */
          }
        },
      },
      pause: {
        configurable: true,
        value: () => {
          stateRef.current.paused = true;
          setPaused(true);
          emit('pause');
        },
      },
    });

    const cleanups: Array<() => void> = [];
    setupProgressTracking(meta.bvid, meta.title, (fn) => cleanups.push(fn));

    let lastAt = performance.now();
    let lastEmit = performance.now();
    let rafId = 0;

    const tick = (now: number) => {
      const dt = (now - lastAt) / 1000;
      lastAt = now;
      if (!stateRef.current.paused && dt > 0 && dt < 1) {
        const next = Math.min(stateRef.current.duration, stateRef.current.currentTime + dt);
        stateRef.current.currentTime = next;
        if (now - lastEmit >= 250) {
          lastEmit = now;
          setCurrentTime(next);
          emit('timeupdate');
        }
        if (next >= stateRef.current.duration) {
          stateRef.current.paused = true;
          setPaused(true);
          emit('ended');
        }
      }
      if (ctx) {
        const grad = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
        grad.addColorStop(0, '#0f1722');
        grad.addColorStop(1, '#182b3f');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        ctx.fillStyle = '#00a1d6';
        ctx.fillRect(42, 44, 92, 26);
        ctx.fillStyle = '#fff';
        ctx.font = '600 13px sans-serif';
        ctx.textBaseline = 'top';
        ctx.fillText(`bilibili P${pageP}`, 52, 50);

        ctx.font = '600 26px "PingFang SC", sans-serif';
        ctx.fillText(meta.title, 42, 92);

        ctx.fillStyle = 'rgba(255,255,255,0.72)';
        ctx.font = '15px sans-serif';
        ctx.fillText(`UP 主：${meta.uploader} · ${meta.bvid}`, 42, 136);

        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.fillRect(42, 186, canvas.width - 84, 180);
        ctx.fillStyle = '#fb7299';
        ctx.font = '600 18px Consolas, monospace';
        ctx.fillText(
          `${formatClock(stateRef.current.currentTime)} / ${formatClock(stateRef.current.duration)}  ${stateRef.current.paused ? '[PAUSED]' : '[PLAYING]'}`,
          64,
          216,
        );
        ctx.fillStyle = 'rgba(255,255,255,0.76)';
        ctx.font = '15px sans-serif';
        ctx.fillText(meta.description, 64, 260);
      }
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafId);
      for (const fn of cleanups) fn();
    };
  }, [urlReady, meta, pageP]);

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  };

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    if (videoRef.current) videoRef.current.currentTime = ratio * meta.durationSec;
  };

  const pct = Math.max(0, Math.min(100, (currentTime / Math.max(1, meta.durationSec)) * 100));

  return (
    <div className={`hdu-bili-sim${dark ? ' is-dark' : ''}`} data-theme={dark ? 'dark' : undefined}>
      <style>{BILI_SIM_CSS}</style>
      <style>{BILI_CSS}</style>

      <div className="bili-sim-page">
        <div className="bili-sim-main">
          <div className="bili-sim-head">
            <h1 className="video-title">{meta.title}</h1>
            <div className="bili-sim-meta">
              <span className="up-name">{meta.uploader}</span>
              <span>·</span>
              <span>{meta.bvid}</span>
              <span>·</span>
              <span className="video-duration">{meta.durationText}</span>
            </div>
          </div>

          <div className="bili-sim-player">
            <video ref={videoRef} playsInline muted />
            <div className="bili-sim-controls">
              <button type="button" onClick={togglePlay}>
                {paused ? '播放' : '暂停'}
              </button>
              <div className="bili-sim-bar" onClick={handleSeek} title="点击进度条跳转">
                <div className="bili-sim-bar-fill" style={{ width: `${pct}%` }} />
              </div>
              <span className="bili-sim-clock">
                {formatClock(currentTime)} / {formatClock(meta.durationSec)}
              </span>
            </div>
          </div>

          <div className="video-toolbar-left-main">
            <span>模拟工具栏 · 右下角「学习」按钮可展开收藏 / 字幕 / 问答 / 学习中心</span>
            <div className="bili-sim-chips">
              <button
                type="button"
                className={pageP === 1 ? 'is-active' : ''}
                onClick={() => setPageP(1)}
              >
                P1 主课
              </button>
              <button
                type="button"
                className={pageP === 2 ? 'is-active' : ''}
                onClick={() => setPageP(2)}
              >
                P2 习题课
              </button>
            </div>
          </div>

          <div className="basic-desc-info">{meta.description}</div>
        </div>

        <aside className="bili-sim-side">
          <div className="bili-sim-side-head">演示视频切换</div>
          {DEMO_BILI_VIDEOS.map((item) => (
            <button
              key={item.bvid}
              type="button"
              className={`bili-sim-card${item.bvid === selectedBvid ? ' is-active' : ''}`}
              onClick={() => {
                setSelectedBvid(item.bvid);
                setPageP(1);
              }}
            >
              <div className="bili-sim-card-title">{item.title}</div>
              <div className="bili-sim-card-sub">
                {item.uploader} · {item.durationText}
              </div>
            </button>
          ))}
        </aside>
      </div>

      {urlReady ? <BiliCollectApp key={`${selectedBvid}-p${pageP}`} /> : null}
    </div>
  );
}

const BILI_SIM_CSS = String.raw`
.hdu-bili-sim {
  min-height: calc(100vh - 38px);
  background: #f6f7f8;
  color: #18191c;
  font-family: "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
}
.hdu-bili-sim.is-dark {
  background: #131518;
  color: #ece8dd;
}
.bili-sim-page {
  max-width: 1320px;
  margin: 0 auto;
  padding: 20px 24px 90px;
  display: flex;
  gap: 20px;
  align-items: flex-start;
}
.bili-sim-main {
  flex: 1;
  min-width: 0;
}
.bili-sim-head h1.video-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  line-height: 1.4;
}
.bili-sim-meta {
  display: flex;
  gap: 8px;
  margin-top: 6px;
  font-size: 12.5px;
  color: #61666d;
}
.hdu-bili-sim.is-dark .bili-sim-meta {
  color: #948f84;
}
.bili-sim-player {
  margin-top: 14px;
  background: #0f1722;
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid rgba(0,0,0,0.08);
}
.bili-sim-player video {
  width: 100%;
  display: block;
  aspect-ratio: 16 / 9;
}
.bili-sim-controls {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  background: #16181d;
  color: #fff;
}
.bili-sim-controls button {
  padding: 4px 12px;
  border-radius: 6px;
  border: 1px solid #383e47;
  background: rgba(255,255,255,0.06);
  color: #fff;
  cursor: pointer;
  font-size: 12.5px;
}
.bili-sim-controls button:hover {
  border-color: #00a1d6;
}
.bili-sim-bar {
  flex: 1;
  height: 7px;
  background: #333842;
  border-radius: 4px;
  cursor: pointer;
  overflow: hidden;
}
.bili-sim-bar-fill {
  height: 100%;
  background: #00a1d6;
}
.bili-sim-clock {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: #c9ccd0;
}
.video-toolbar-left-main {
  margin-top: 12px;
  padding: 10px 14px;
  background: #fff;
  border: 1px solid #e3e5e7;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 12.5px;
  color: #61666d;
}
.hdu-bili-sim.is-dark .video-toolbar-left-main {
  background: #1a1d21;
  border-color: #2c3137;
  color: #bcb6a8;
}
.bili-sim-chips {
  display: flex;
  gap: 8px;
}
.bili-sim-chips button {
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid #e3e5e7;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 12px;
}
.bili-sim-chips button.is-active {
  border-color: #00a1d6;
  background: rgba(0, 161, 214, 0.12);
  color: #00a1d6;
  font-weight: 600;
}
.basic-desc-info {
  margin-top: 12px;
  padding: 12px 14px;
  background: #fff;
  border: 1px solid #e3e5e7;
  border-radius: 8px;
  font-size: 13px;
  color: #474d52;
}
.hdu-bili-sim.is-dark .basic-desc-info {
  background: #1a1d21;
  border-color: #2c3137;
  color: #bcb6a8;
}
.bili-sim-side {
  width: 310px;
  flex: 0 0 310px;
  background: #fff;
  border: 1px solid #e3e5e7;
  border-radius: 10px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.hdu-bili-sim.is-dark .bili-sim-side {
  background: #1a1d21;
  border-color: #2c3137;
}
.bili-sim-side-head {
  font-size: 13px;
  font-weight: 600;
  padding: 2px 4px 6px;
}
.bili-sim-card {
  text-align: left;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid #e3e5e7;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.hdu-bili-sim.is-dark .bili-sim-card {
  border-color: #2c3137;
}
.bili-sim-card.is-active {
  border-color: #00a1d6;
  background: rgba(0, 161, 214, 0.08);
}
.bili-sim-card-title {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
}
.bili-sim-card-sub {
  margin-top: 4px;
  font-size: 11.5px;
  color: #61666d;
}
.hdu-bili-sim.is-dark .bili-sim-card-sub {
  color: #948f84;
}
@media (max-width: 960px) {
  .bili-sim-page { flex-direction: column; }
  .bili-sim-side { width: 100%; flex: none; }
}
`;
