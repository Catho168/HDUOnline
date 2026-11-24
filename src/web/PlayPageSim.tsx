import { useEffect, useMemo, useRef, useState } from 'react';
import { getDb } from '@/core/db';
import type { CourseEntity, SessionEntity } from '@/core/shared/types';
import { formatClock } from '@/core/shared/utils';

interface PlayPageSimProps {
  dark?: boolean;
  onSessionChange?: (courId: number, teclId: number) => void;
}

const RATES = [1, 1.25, 1.5, 2, 0.75] as const;

function parseHashQuery(): { teclId: number; courId: number } {
  const hash = window.location.hash || '';
  const qIdx = hash.indexOf('?');
  const params = new URLSearchParams(qIdx >= 0 ? hash.slice(qIdx + 1) : '');
  const teclId = Number(params.get('teclId') ?? 0) || 9102;
  const courId = Number(params.get('courseId') ?? params.get('courId') ?? 0) || 1227052;
  return { teclId, courId };
}

function formatDateTime(raw: string | number): string {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return String(raw);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function drawLectureFrame(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  courseName: string,
  courLabel: string,
  teacherText: string,
  currentSec: number,
  durationSec: number,
  paused: boolean,
) {
  const grad = ctx.createLinearGradient(0, 0, width, height);
  grad.addColorStop(0, '#161b24');
  grad.addColorStop(1, '#243042');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  for (let x = 40; x < width; x += 64) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 40; y < height; y += 64) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  ctx.fillStyle = 'rgba(255, 253, 248, 0.94)';
  ctx.textBaseline = 'top';
  ctx.font = '600 28px "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.fillText(courseName || '智慧课堂回放', 44, 44);

  ctx.fillStyle = 'rgba(223, 160, 90, 0.92)';
  ctx.font = '500 16px "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.fillText(courLabel || '课堂录像', 44, 86);

  ctx.fillStyle = 'rgba(236, 232, 221, 0.72)';
  ctx.font = '14px "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.fillText(teacherText ? `主讲：${teacherText}` : '课堂录制画面', 44, 114);

  // 模拟板书卡片
  ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.fillRect(44, 154, width - 88, 178);
  ctx.strokeRect(44, 154, width - 88, 178);

  const chapterIdx = Math.floor((currentSec / Math.max(1, durationSec)) * 4) + 1;
  ctx.fillStyle = '#ece8dd';
  ctx.font = '600 18px "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.fillText(`课堂精讲 · 阶段 ${chapterIdx}`, 66, 176);

  ctx.fillStyle = 'rgba(236, 232, 221, 0.78)';
  ctx.font = '15px "SFMono-Regular", Consolas, monospace';
  ctx.fillText(`Playhead: ${formatClock(currentSec)} / ${formatClock(durationSec)}   ${paused ? '[PAUSED]' : '[PLAYING]'}`, 66, 214);

  ctx.fillStyle = 'rgba(99, 216, 197, 0.85)';
  ctx.font = '14px "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.fillText('支持右侧助手栏 AI 摘要 · 课堂问答 · 实时字幕 · 时间点收藏与笔记跳转', 66, 252);

  // 底部装饰波纹条
  const barWidth = width - 88;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.fillRect(44, height - 38, barWidth, 4);
  const progress = Math.max(0, Math.min(1, currentSec / Math.max(1, durationSec)));
  ctx.fillStyle = '#dfa05a';
  ctx.fillRect(44, height - 38, barWidth * progress, 4);
}

export function PlayPageSim({ dark, onSessionChange }: PlayPageSimProps) {
  const [courses, setCourses] = useState<CourseEntity[]>([]);
  const [sessions, setSessions] = useState<SessionEntity[]>([]);
  const [{ teclId, courId }, setIds] = useState(() => parseHashQuery());
  const [currentTime, setCurrentTime] = useState(0);
  const [paused, setPaused] = useState(true);
  const [rateIdx, setRateIdx] = useState(0);

  const primaryRef = useRef<HTMLVideoElement | null>(null);
  const secondaryRef = useRef<HTMLVideoElement | null>(null);
  const stateRef = useRef({
    currentTime: 0,
    duration: 2820,
    paused: true,
    rate: 1,
  });

  // 监听 hash 变化以跟随学习中心直达或切课
  useEffect(() => {
    const sync = () => setIds(parseHashQuery());
    window.addEventListener('hashchange', sync);
    const id = window.setInterval(sync, 400);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.clearInterval(id);
    };
  }, []);

  // 从 IndexedDB 读取当前课程与课次列表
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const db = await getDb();
        const [allCourses, allSessions] = await Promise.all([db.getAll('courses'), db.getAll('sessions')]);
        if (cancelled) return;
        setCourses(allCourses);
        const targetSession = allSessions.find((s) => s.courId === courId) ?? allSessions[0];
        const effectiveTeclId = targetSession?.teclId ?? teclId;
        const filtered = allSessions
          .filter((s) => s.teclId === effectiveTeclId)
          .sort((a, b) => new Date(a.beginTime).getTime() - new Date(b.beginTime).getTime());
        setSessions(filtered.length > 0 ? filtered : allSessions.slice(0, 6));
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [teclId, courId]);

  const activeSession = useMemo(
    () => sessions.find((s) => s.courId === courId) ?? sessions[0] ?? null,
    [sessions, courId],
  );
  const activeCourse = useMemo(
    () => courses.find((c) => c.teclId === (activeSession?.teclId ?? teclId)) ?? courses[0] ?? null,
    [courses, activeSession, teclId],
  );

  const durationSec = activeSession?.durationSec || 2820;
  const courseName = activeSession?.courseName || activeCourse?.subjName || '智慧课堂课程回放';
  const teacherNames = activeCourse?.teacherNames?.length ? activeCourse.teacherNames : ['主讲教师'];
  const teacherText = teacherNames.join('、');
  const courLabel = activeSession?.courLabel || (activeSession?.beginTime ? formatDateTime(activeSession.beginTime) : '第1周');

  // 切换课次时更新虚拟时长与初始断点
  useEffect(() => {
    const initial = activeSession?.lastPositionSec && activeSession.lastPositionSec < durationSec ? activeSession.lastPositionSec : 0;
    stateRef.current.duration = durationSec;
    stateRef.current.currentTime = initial;
    setCurrentTime(initial);
    const el = primaryRef.current;
    if (el) {
      el.dispatchEvent(new Event('durationchange'));
      el.dispatchEvent(new Event('loadedmetadata'));
      el.dispatchEvent(new Event('timeupdate'));
    }
  }, [activeSession?.courId, durationSec]);

  // 给主 <video> 挂载可寻址虚拟时间与 Canvas 画面流
  useEffect(() => {
    const video = primaryRef.current;
    if (!video) return;

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

    const secCanvas = document.createElement('canvas');
    secCanvas.width = 480;
    secCanvas.height = 270;
    const sctx = secCanvas.getContext('2d');
    if (sctx && secondaryRef.current && typeof secCanvas.captureStream === 'function') {
      sctx.fillStyle = '#1b2029';
      sctx.fillRect(0, 0, 480, 270);
      sctx.fillStyle = '#d9b969';
      sctx.font = '600 18px sans-serif';
      sctx.fillText('讲台全景机位 · View 2', 24, 44);
      sctx.fillStyle = 'rgba(255,255,255,0.65)';
      sctx.font = '13px sans-serif';
      sctx.fillText(courseName, 24, 74);
      try {
        secondaryRef.current.srcObject = secCanvas.captureStream(4);
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
      playbackRate: {
        configurable: true,
        get: () => stateRef.current.rate,
        set: (val: number) => {
          stateRef.current.rate = Number.isFinite(val) && val > 0 ? val : 1;
          emit('ratechange');
        },
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
            /* autoplay policy ignored */
          }
        },
      },
      pause: {
        configurable: true,
        value: () => {
          stateRef.current.paused = true;
          setPaused(true);
          emit('pause');
          try {
            HTMLMediaElement.prototype.pause.call(video);
          } catch {
            /* ignore */
          }
        },
      },
    });

    emit('loadedmetadata');
    emit('canplay');

    let lastFrameAt = performance.now();
    let lastEmitAt = performance.now();
    let rafId = 0;

    const renderLoop = (now: number) => {
      const dt = (now - lastFrameAt) / 1000;
      lastFrameAt = now;
      if (!stateRef.current.paused && dt > 0 && dt < 1) {
        const next = stateRef.current.currentTime + dt * stateRef.current.rate;
        if (next >= stateRef.current.duration) {
          stateRef.current.currentTime = stateRef.current.duration;
          stateRef.current.paused = true;
          setPaused(true);
          setCurrentTime(stateRef.current.duration);
          emit('timeupdate');
          emit('ended');
        } else {
          stateRef.current.currentTime = next;
          if (now - lastEmitAt >= 250) {
            lastEmitAt = now;
            setCurrentTime(next);
            emit('timeupdate');
          }
        }
      }
      if (ctx) {
        drawLectureFrame(
          ctx,
          canvas.width,
          canvas.height,
          courseName,
          courLabel,
          teacherText,
          stateRef.current.currentTime,
          stateRef.current.duration,
          stateRef.current.paused,
        );
      }
      rafId = requestAnimationFrame(renderLoop);
    };

    rafId = requestAnimationFrame(renderLoop);
    return () => cancelAnimationFrame(rafId);
  }, [courseName, courLabel, teacherText]);

  const togglePlay = () => {
    const video = primaryRef.current;
    if (!video) return;
    if (video.paused) void video.play();
    else video.pause();
  };

  const cycleRate = () => {
    const nextIdx = (rateIdx + 1) % RATES.length;
    setRateIdx(nextIdx);
    const nextRate = RATES[nextIdx] ?? 1;
    if (primaryRef.current) primaryRef.current.playbackRate = nextRate;
  };

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    if (primaryRef.current) primaryRef.current.currentTime = ratio * durationSec;
  };

  const selectSession = (item: SessionEntity) => {
    const nextHash = `#/play-center?teclId=${item.teclId}&courseId=${item.courId}&target=video`;
    window.history.replaceState(null, '', nextHash);
    setIds({ teclId: item.teclId, courId: item.courId });
    onSessionChange?.(item.courId, item.teclId);
  };

  const ratio = Math.max(0, Math.min(1, currentTime / Math.max(1, durationSec)));

  return (
    <div className={`hdu-sim-play${dark ? ' is-dark' : ''}`}>
      <style>{PLAY_SIM_CSS}</style>
      <div className="play-header">
        <span className="title">{courseName}</span>
        <span className="meta">教师：{teacherText}</span>
        <span className="meta">{courLabel}</span>
      </div>

      <div className="play-center layout">
        <div className="play-video">
          <div className="play-video-main-container">
            <div className="left-module-wrapper">
              <div className="player-wrapper">
                <video ref={primaryRef} playsInline muted />
              </div>
            </div>
            <div className="kmd-control-bar">
              <button className="kmd-btn" type="button" onClick={togglePlay}>
                {paused ? '播放' : '暂停'}
              </button>
              <button className="kmd-btn" type="button" onClick={cycleRate}>
                {RATES[rateIdx]}×
              </button>
              <div className="jy-control-progress" onClick={handleProgressClick} title="点击进度条跳转">
                <div className="buffered" style={{ width: `${Math.min(100, ratio * 100 + 18)}%` }} />
                <div className="played" style={{ width: `${ratio * 100}%` }} />
              </div>
              <span className="kmd-clock">
                {formatClock(currentTime)} / {formatClock(durationSec)}
              </span>
            </div>
          </div>

          <div className="second-player-container">
            <video ref={secondaryRef} muted playsInline />
          </div>
        </div>

        <aside className="right-body">
          <div className="head">课程课次（{sessions.length} 节）</div>
          <div className="body-content">
            {sessions.map((item, idx) => {
              const active = item.courId === (activeSession?.courId ?? courId);
              const beginStr = item.beginTime ? formatDateTime(item.beginTime) : '';
              return (
                <div
                  key={item.courId}
                  className={`body-item${active ? ' active' : ''}`}
                  data-course-id={item.courId}
                  aria-selected={active}
                  onClick={() => selectSession(item)}
                >
                  <span className="idx">{String(idx + 1).padStart(2, '0')}</span>
                  <span className="main">
                    <div className="name">
                      {item.courLabel || (item.letiNumber ? `第 ${item.letiNumber} 节` : `课次 #${item.courId}`)}
                    </div>
                    <div className="time">
                      <span className="body-container-time">{beginStr}</span>
                      {activeCourse?.clroName ? ` · ${activeCourse.clroName}` : ''}
                    </div>
                  </span>
                </div>
              );
            })}
          </div>
        </aside>
      </div>
    </div>
  );
}

const PLAY_SIM_CSS = String.raw`
.hdu-sim-play {
  min-height: calc(100vh - 38px);
  background: #f5f1e8;
  color: #171a1d;
  font-family: "PingFang SC", "Microsoft YaHei", "Segoe UI", system-ui, sans-serif;
}
.hdu-sim-play.is-dark {
  background: #131518;
  color: #ece8dd;
}
.hdu-sim-play .play-header {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 14px;
  padding: 12px 24px;
  background: #fffdf8;
  border-bottom: 1px solid #e2d9c8;
}
.hdu-sim-play.is-dark .play-header {
  background: #1a1d21;
  border-bottom-color: #2c3137;
}
.hdu-sim-play .play-header .title {
  font-size: 16px;
  font-weight: 700;
}
.hdu-sim-play .play-header .meta {
  font-size: 13px;
  color: #6a6e71;
}
.hdu-sim-play.is-dark .play-header .meta {
  color: #948f84;
}
.hdu-sim-play .layout {
  display: flex;
  gap: 18px;
  padding: 18px 24px 80px;
  align-items: flex-start;
  max-width: 1440px;
}
.hdu-sim-play .play-video {
  flex: 1;
  min-width: 0;
}
.hdu-sim-play .play-video-main-container {
  background: #0d1016;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid rgba(255,255,255,0.08);
}
.hdu-sim-play .player-wrapper video {
  width: 100%;
  display: block;
  background: #12161f;
  aspect-ratio: 16 / 9;
}
.hdu-sim-play .kmd-control-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: #16181d;
  color: #e8eaed;
}
.hdu-sim-play .kmd-btn {
  background: rgba(255,255,255,0.06);
  border: 1px solid #3a3f47;
  color: #e8eaed;
  border-radius: 6px;
  padding: 4px 10px;
  cursor: pointer;
  font-size: 12.5px;
}
.hdu-sim-play .kmd-btn:hover {
  border-color: #dfa05a;
}
.hdu-sim-play .jy-control-progress {
  flex: 1;
  height: 8px;
  background: #333842;
  border-radius: 4px;
  position: relative;
  cursor: pointer;
}
.hdu-sim-play .jy-control-progress > .buffered {
  position: absolute;
  inset: 0 auto 0 0;
  background: #4e5664;
  border-radius: 4px;
}
.hdu-sim-play .jy-control-progress > .played {
  position: absolute;
  inset: 0 auto 0 0;
  background: #dfa05a;
  border-radius: 4px;
}
.hdu-sim-play .kmd-clock {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: #bcb6a8;
}
.hdu-sim-play .second-player-container {
  display: flex;
  gap: 12px;
  margin-top: 12px;
}
.hdu-sim-play .second-player-container video {
  width: 240px;
  border-radius: 8px;
  background: #16181d;
  aspect-ratio: 16 / 9;
  border: 1px solid #e2d9c8;
}
.hdu-sim-play.is-dark .second-player-container video {
  border-color: #2c3137;
}
.hdu-sim-play .right-body {
  width: 360px;
  flex: 0 0 360px;
  background: #fffdf8;
  border: 1px solid #e2d9c8;
  border-radius: 12px;
  overflow: hidden;
}
.hdu-sim-play.is-dark .right-body {
  background: #1a1d21;
  border-color: #2c3137;
}
.hdu-sim-play .right-body .head {
  padding: 12px 14px;
  font-size: 13px;
  font-weight: 600;
  border-bottom: 1px solid #e2d9c8;
}
.hdu-sim-play.is-dark .right-body .head {
  border-bottom-color: #2c3137;
}
.hdu-sim-play .body-content {
  max-height: 480px;
  overflow: auto;
  padding: 6px 0;
}
.hdu-sim-play .body-item {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 10px 14px;
  cursor: pointer;
  font-size: 13px;
  border-left: 3px solid transparent;
}
.hdu-sim-play .body-item:hover {
  background: rgba(164, 85, 27, 0.06);
}
.hdu-sim-play .body-item.active {
  background: rgba(164, 85, 27, 0.12);
  border-left-color: #a4551b;
}
.hdu-sim-play.is-dark .body-item.active {
  background: rgba(223, 160, 90, 0.14);
  border-left-color: #dfa05a;
}
.hdu-sim-play .body-item .idx {
  color: #6a6e71;
  font-variant-numeric: tabular-nums;
}
.hdu-sim-play .body-item .main {
  flex: 1;
  min-width: 0;
}
.hdu-sim-play .body-item .name {
  font-weight: 600;
}
.hdu-sim-play .body-item .time {
  color: #6a6e71;
  font-size: 11.5px;
  margin-top: 2px;
}
.hdu-sim-play.is-dark .body-item .time {
  color: #948f84;
}
@media (max-width: 960px) {
  .hdu-sim-play .layout { flex-direction: column; }
  .hdu-sim-play .right-body { width: 100%; flex: none; }
}
`;
