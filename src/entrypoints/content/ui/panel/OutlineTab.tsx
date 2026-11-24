/**
 * 本节助手「大纲」页签（第 48 轮自 PlayPanel.tsx 纯搬移拆分，逻辑/文案/类名逐行未变）：
 * 两级大纲节点列表 + 跟随播放高亮（followPlayback 时 scrollIntoView）。
 */

import { useEffect, useRef } from 'react';
import type { ContextWindowPreset } from '@/core/shared/types';
import { formatClock } from '@/core/shared/utils';
import { Button, Chip, EmptyState, cx } from '../components';
import { uiStore, useUiStore } from '../store';

export function OutlineTab({ windowPreset }: { windowPreset: ContextWindowPreset }) {
  const state = useUiStore();
  const actions = uiStore.actions;
  const listRef = useRef<HTMLDivElement | null>(null);
  const nodes = state.ai?.outline ?? [];
  const activeIndex = nodes.findIndex((n) => state.currentTime >= n.start && state.currentTime < n.end);
  const activeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (state.settings.ui.followPlayback && activeRef.current) {
      activeRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [activeIndex, state.settings.ui.followPlayback]);

  if (!state.ai) {
    return (
      <EmptyState
        icon="list"
        title="还没有课程大纲"
        text="大纲与知识标注同时生成，按两级结构组织本节内容，点击即可跳转。"
        action={
          <Button
            size="small"
            variant="primary"
            disabled={!state.transcript}
            loading={state.busy.ai}
            onClick={() => void actions.generateAi(false, { windowPreset })}
          >
            生成大纲
          </Button>
        }
      />
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <Chip tone="accent" icon="spark">AI 生成</Chip>
        <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5, fontSize: 10.5, color: 'var(--muted)' }}>
          <input
            type="checkbox"
            checked={state.settings.ui.followPlayback}
            onChange={(e) => void actions.saveSetting('ui', { ...state.settings.ui, followPlayback: e.target.checked })}
          />
          跟随播放
        </label>
      </div>
      <div className="hdu-outline" ref={listRef}>
        {nodes.map((node, i) => (
          <button
            type="button"
            key={`${node.title}-${i}`}
            ref={i === activeIndex ? activeRef : undefined}
            className={cx('hdu-outline-row', node.level === 2 ? 'l2' : 'l1', i === activeIndex ? 'is-active' : '')}
            onClick={() => actions.seek(node.start)}
          >
            <span className="hdu-outline-mark" />
            <span className="hdu-outline-title" title={node.title}>{node.title}</span>
            <span className="hdu-outline-time">{formatClock(node.start)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
