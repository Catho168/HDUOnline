import { useEffect, useMemo, useState } from 'react';
import type { TranscriptSegment } from '@/core/shared/types';
import { formatClock } from '@/core/shared/utils';
import { LearningCenter } from './LearningCenter';
import { PlayPanel } from './PlayPanel';
import { ToastHost } from './components';
import { Icon } from './icons';
import { uiStore, useUiStore, isPlayRoute } from './store';
import { cx } from './components';

function useResolvedTheme(): 'light' | 'dark' {
  const state = useUiStore();
  const [systemDark, setSystemDark] = useState(() => {
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    let mq: MediaQueryList | null = null;
    try {
      mq = window.matchMedia('(prefers-color-scheme: dark)');
    } catch {
      return;
    }
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq?.removeEventListener?.('change', onChange);
  }, []);
  if (state.settings.theme === 'dark') return 'dark';
  if (state.settings.theme === 'light') return 'light';
  return systemDark ? 'dark' : 'light';
}

export function App() {
  const state = useUiStore();
  const theme = useResolvedTheme();
  const play = isPlayRoute(state.route.kind);
  return (
    <div className="hdu-root" data-theme={theme}>
      {state.centerOpen ? (
        <LearningCenter />
      ) : (
        <>
          {play ? <SessionCapsule /> : null}
          <Dock />
          {play ? <PlayPanel /> : null}
          {play ? <SubtitleLayer /> : null}
          {play && state.settings.ui.showTimelineMarkers ? <TimelineLayer /> : null}
        </>
      )}
      <ToastHost />
    </div>
  );
}

function SessionCapsule() {
  const state = useUiStore();
  const actions = uiStore.actions;
  const session = state.session;
  const resolution = state.resolution;
  if (!session && resolution.phase === 'idle') return null;
  const status = resolution.phase === 'resolved' ? 'ok' : resolution.phase === 'unresolved' ? 'err' : 'warn';
  return (
    <button type="button" className="hdu-capsule" onClick={() => actions.togglePanel()} title="打开本节助手">
      <Icon name="book" size={14} />
      <b>{session?.courseName ?? '智慧课堂'}</b>
      <span>· {session?.courLabel ?? (resolution.phase === 'resolving' ? '识别课次中' : '待识别课次')}</span>
      <span className={cx('hdu-dot', status)} />
    </button>
  );
}

function Dock() {
  const state = useUiStore();
  const actions = uiStore.actions;
  const play = isPlayRoute(state.route.kind);
  return (
    <div className="hdu-dock">
      <div className="hdu-dock-mark">学</div>
      <button
        type="button"
        className="hdu-dock-btn"
        onClick={() => {
          if (state.centerSuppressed) actions.restoreCenter();
          else actions.openCenter();
        }}
      >
        <Icon name="library" />
        学习中心
      </button>
      {play ? (
        <button
          type="button"
          className={cx('hdu-dock-btn', state.panelOpen ? 'is-active' : '')}
          onClick={() => actions.togglePanel()}
        >
          <Icon name="panel" />
          本节助手
        </button>
      ) : null}
    </div>
  );
}

function SubtitleLayer() {
  const state = useUiStore();
  const style = state.settings.captionStyle;
  const segment = useMemo<TranscriptSegment | null>(() => {
    const segments = state.transcript?.segments;
    if (!segments || segments.length === 0) return null;
    return segments.find((seg) => state.currentTime >= seg.s && state.currentTime < seg.e) ?? null;
  }, [state.transcript, state.currentTime]);
  if (!style.enabled || !segment) return null;
  const rect = state.videoRect;
  const bottom = rect ? Math.max(64, window.innerHeight - rect.bottom + 64) : 120;
  const maxWidth = rect ? Math.min(rect.width * 0.78, 900) : 720;
  return (
    <div
      className="hdu-caption"
      style={{
        bottom,
        maxWidth,
        fontSize: style.fontSize,
        color: style.color,
        background: style.background,
      }}
    >
      {segment.text}
    </div>
  );
}

function TimelineLayer() {
  const state = useUiStore();
  const actions = uiStore.actions;
  const topics = state.ai?.topics ?? [];
  const duration = state.duration || state.session?.durationSec || 0;
  const rect = state.timelineRect;
  if (topics.length === 0 || duration <= 0 || !rect) return null;
  return (
    <div
      className="hdu-timeline"
      style={{ left: rect.left, top: rect.top - 10, width: rect.width }}
      aria-hidden="true"
    >
      {topics.flatMap((topic, ti) =>
        topic.intervals.map(([start, end], ii) => {
          const left = Math.max(0, Math.min(100, (start / duration) * 100));
          const width = Math.max(0.35, Math.min(100 - left, ((end - start) / duration) * 100));
          const active = state.currentTime >= start && state.currentTime < end;
          return (
            <button
              type="button"
              key={`${ti}-${ii}`}
              className={cx('hdu-timeline-mark', topic.confidence === 'low' ? 'low' : '', active ? 'is-active' : '')}
              style={{ left: `${left}%`, width: `${width}%` }}
              title={`${topic.name} · ${formatClock(start)}–${formatClock(end)}`}
              onClick={() => actions.seek(start)}
            />
          );
        }),
      )}
    </div>
  );
}

// 供内容脚本在路由变化时直接更新
export { uiStore };
