/**
 * 本节助手「收藏」页签（第 48 轮自 PlayPanel.tsx 纯搬移拆分，逻辑/文案/类名逐行未变）：
 * 本节收藏列表（时间点/回答/大纲/截图）与「收藏此刻」入口。
 */

import { formatClock } from '@/core/shared/utils';
import { Button, Chip, EmptyState } from '../components';
import { Icon } from '../icons';
import { uiStore, useUiStore } from '../store';

export function FavoritesTab() {
  const state = useUiStore();
  const actions = uiStore.actions;
  if (state.favorites.length === 0) {
    return (
      <EmptyState
        icon="star"
        title="本节还没有收藏"
        text="收藏时间点、AI 回答、大纲节点或截图，统一进入知识库，可加标签、写备注、导出复习卡片。"
        action={<Button size="small" variant="ghost" icon="star" onClick={() => void actions.addTimeFavorite()}>收藏当前时间点</Button>}
      />
    );
  }
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        {/* 计数 chip 走 info（第 243 轮语义色审计）：条数为中性信息，不再占用
            accent（强调/品牌，留给置顶等标识）；与 NotesTab 同步 */}
        <Chip tone="info" icon="star">{state.favorites.length} 条</Chip>
        <Button size="small" variant="ghost" icon="star" style={{ marginLeft: 'auto' }} onClick={() => void actions.addTimeFavorite()}>
          收藏此刻
        </Button>
      </div>
      {state.favorites.map((fav) => (
        <div className="hdu-fav-row" key={fav.id}>
          <div className="hdu-fav-icon"><Icon name={fav.type === 'ai' ? 'spark' : fav.type === 'screenshot' ? 'camera' : fav.type === 'outline' ? 'list' : fav.type === 'note' ? 'note' : 'clock'} /></div>
          <div className="hdu-fav-body">
            <div className="hdu-fav-title">{fav.snapshot.title}</div>
            <div className="hdu-fav-sub">
              {fav.anchorTime != null ? <button type="button" className="hdu-time-badge" onClick={() => actions.seek(fav.anchorTime!)}>{formatClock(fav.anchorTime)}</button> : null}
              <span>{fav.snapshot.content.slice(0, 48)}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
