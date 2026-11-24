import { useEffect, useMemo, useState } from 'react';
import type { TranscriptSegment } from '@/core/shared/types';
import { formatClock } from '@/core/shared/utils';
import { callOp } from '@/core/shared/client';
import { dueBadgeLabel } from '@/core/plan/today';
import { timelineMarkerRect } from '@/core/shared/timelineMarkers';
import { useResolvedTheme as useSharedResolvedTheme } from '@/core/shared/useResolvedTheme';
import { LearningCenter } from './LearningCenter';
import { PlayPanel } from './PlayPanel';
import { ToastHost } from './components';
import { Icon } from './icons';
import { uiStore, useUiStore, isPlayRoute } from './store';
import { cx } from './components';

function useResolvedTheme(): 'light' | 'dark' {
  const state = useUiStore();
  // 与 Dashboard/Options/Popup 共用同一底层实现（shared/useResolvedTheme）；
  // 差异仅在 settings 来源：面板内嵌 UI 从 uiStore 订阅，而非组件入参。
  return useSharedResolvedTheme(state.settings);
}

export function App() {
  const state = useUiStore();
  const theme = useResolvedTheme();
  const play = isPlayRoute(state.route.kind);
  // 用户交互时间戳（第 203 轮巡检）：mousedown/keydown 更新 uiStore.lastInteractionAt，
  // 供说明卡 Esc 等交互前提判断（非响应式，不触发重渲染）
  useEffect(() => {
    const mark = (): void => uiStore.markInteraction();
    document.addEventListener('mousedown', mark);
    document.addEventListener('keydown', mark);
    return () => {
      document.removeEventListener('mousedown', mark);
      document.removeEventListener('keydown', mark);
    };
  }, []);
  return (
    <div className="hdu-root" data-theme={theme}>
      {state.centerOpen ? (
        <LearningCenter />
      ) : (
        <>
          {/* 顶栏 chip 注入成功时隐藏浮窗胶囊，保持单入口（降级时胶囊自动回归） */}
          {play && !state.anchorChipActive ? <SessionCapsule /> : null}
          {/* 注入式入口（锚点探针）挂载成功时隐藏浮层 Dock，保持单入口（降级时 Dock 自动回归；
              Dock 提供的「本节助手 / 学习中心」两个能力由注入入口菜单等价承接） */}
          {!state.injectedEntryActive ? <Dock /> : null}
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
  // 今日到期复习徽标（第 77 轮巡检）：「学」标右上角角标显示今日到期复习数。
  // 挂载即拉取 + 5 分钟低频轮询；打开学习中心后 Dock 卸载，关闭回来自动重挂再拉
  // （完成复习后计数即时回落）。失败静默保持现值，徽标是辅助信息不闪灭。
  const [dueCount, setDueCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      callOp('review.due', {})
        .then((jobs) => {
          if (!cancelled) setDueCount(Array.isArray(jobs) ? jobs.length : 0);
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 5 * 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
  const dueBadge = dueBadgeLabel(dueCount);
  return (
    <div className="hdu-dock">
      <div className="hdu-dock-mark">
        学
        {dueBadge ? (
          <span className="hdu-dock-badge" aria-label={`今日 ${dueBadge} 项复习到期`}>
            {dueBadge}
          </span>
        ) : null}
      </div>
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
          // 几何换算收口到 shared 纯函数（与 B 站 aiMarkers 同口径）：
          // 起点越出时长的区间 width=0，避免近缘区间叠加最小宽度后溢出播放器右缘
          const { leftPercent: left, widthPercent: width } = timelineMarkerRect(start, end, duration);
          // 标记条有 min-width:3px，零宽标记若渲染仍会画出右缘，这里直接过滤
          if (width <= 0) return null;
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
