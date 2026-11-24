/**
 * 本节助手「笔记」页签（第 48 轮自 PlayPanel.tsx 纯搬移拆分，逻辑/文案/类名逐行未变）：
 * 本节时间点笔记（转收藏 / 两步确认删除）+ 站点原生笔记只读展示 + 底部输入区。
 */

import { useState } from 'react';
import { formatClock, localDayKey } from '@/core/shared/utils';
import { buildNotesMarkdown } from '@/core/export/notes';
import { Button, Chip, ConfirmIconButton, EmptyState, IconButton } from '../components';
import { Icon } from '../icons';
import { downloadTextFile } from '../reviewCards';
import { uiStore, useUiStore } from '../store';

/** 导出供单元测试（two-step-confirm.test.ts）：播放页笔记删除两步确认的行为验证 */
export function NotesTab({
  noteText,
  setNoteText,
  onSubmit,
}: {
  noteText: string;
  setNoteText: (value: string) => void;
  onSubmit: () => void;
}) {
  const state = useUiStore();
  const actions = uiStore.actions;
  const [showSite, setShowSite] = useState(false);
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
        {/* 计数 chip 走 info（第 243 轮语义色审计）：条数为中性信息，不再占用
            accent（强调/品牌，留给「AI 生成」等标识）；与 FavoritesTab 同步 */}
        <Chip tone="info" icon="note">{state.notes.length} 条本节笔记</Chip>
        {/* 导出笔记（第 106 轮巡检）：本课次全部时间点笔记 → Markdown 下载 */}
        <button
          type="button"
          className="hdu-filter-pill"
          onClick={() => {
            const session = state.session;
            const label = session
              ? `${session.courseName}${session.letiNumber ? ` 第${session.letiNumber}节` : ''}`
              : '本节';
            downloadTextFile(`智慧课堂-笔记-${label}-${localDayKey()}.md`, buildNotesMarkdown(state.notes, label));
          }}
        >
          <Icon name="download" size={12} /> 导出笔记
        </button>
        <button type="button" className="hdu-filter-pill" style={{ marginLeft: 'auto' }} onClick={() => setShowSite((v) => !v)}>
          <Icon name="eye" size={12} /> 站点笔记 {state.siteNotes.length}
        </button>
      </div>
      {showSite ? (
        <div className="hdu-card" style={{ padding: 10, marginBottom: 10 }}>
          <div className="hdu-hint" style={{ marginBottom: 6 }}>站点原生笔记（只读，不写入站点）</div>
          {state.siteNotes.length === 0 ? (
            <div className="hdu-hint">本节暂无站点笔记。</div>
          ) : (
            state.siteNotes.map((note) => (
              <div className="hdu-note" key={note.id}>
                <button type="button" className="hdu-note-time" onClick={() => note.anchorTime != null && actions.seek(note.anchorTime)}>
                  {note.anchorTime != null ? formatClock(note.anchorTime) : '—'}
                </button>
                <div className="hdu-note-body"><div className="hdu-note-text">{note.text}</div></div>
              </div>
            ))
          )}
        </div>
      ) : null}
      {state.notes.length === 0 ? (
        <EmptyState icon="note" title="随手记下这一刻" text="笔记会自动带上当前播放时间，可回溯、可转收藏、可导出。" />
      ) : (
        <div>
          {state.notes.map((note) => (
            <div className="hdu-note" key={note.id}>
              <button type="button" className="hdu-note-time" onClick={() => actions.seek(note.anchorTime)}>
                {formatClock(note.anchorTime)}
              </button>
              <div className="hdu-note-body">
                <div className="hdu-note-text">{note.text}</div>
                <div className="hdu-hint" style={{ marginTop: 3 }}>{localDayKey(new Date(note.createdAt))}</div>
              </div>
              <div className="hdu-note-actions">
                <IconButton icon="star" label="转为收藏" onClick={() => void actions.convertNote(note.id)} />
                {/* 两步确认：第一次点击仅进入确认态（图标变警示色 + title 切换，3 秒复原），第二次点击才删除（软删除进回收站） */}
                <ConfirmIconButton icon="trash" label="删除笔记" confirmLabel="再点一次确认删除" onConfirm={() => void actions.deleteNote(note.id)} />
              </div>
            </div>
          ))}
        </div>
      )}
      <div style={{ marginTop: 12 }}>
        <div className="hdu-composer">
          <textarea
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            placeholder={`记在 ${formatClock(state.currentTime)}…`}
            rows={2}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                onSubmit();
              }
            }}
          />
          <Button size="small" variant="primary" icon="plus" onClick={onSubmit} />
        </div>
        <div className="hdu-composer-hint">Enter 保存 · Shift+Enter 换行 · 自动带当前时间</div>
      </div>
    </div>
  );
}
