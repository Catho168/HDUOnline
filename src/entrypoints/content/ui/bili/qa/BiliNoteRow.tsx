/**
 * B 站「学习助手」笔记条目（第 26 轮引入；第 50 轮自 BiliQaPanel.tsx 纯搬移拆分，
 * 逻辑/文案/类名逐行未变）：时间戳点击 seek 回该时刻；「转收藏」（第 33 轮）经回调
 * 交宿主走 note.toFavorite；删除走两步确认——复用 components.tsx 的
 * useTwoStepConfirm 原语（第一次点击进入确认态、3 秒自动复原，第二次点击才真正
 * 删除），按钮样式用面板自己的 .bili-note-del / .bili-note-convert（hdu-* 样式不进
 * B 站 shadow root，故只复用行为原语不复用其按钮皮）。
 */

import { formatClock, summarize } from '@/core/shared/utils';
import type { NoteEntity } from '@/core/shared/types';
import { useTwoStepConfirm } from '../../components';

export function BiliNoteRow({
  note,
  onSeek,
  onConvert,
  onDelete,
}: {
  note: NoteEntity;
  onSeek: (sec: number) => void;
  onConvert: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const { confirming, step } = useTwoStepConfirm();
  return (
    <div className="bili-note-item">
      <button
        type="button"
        className="bili-note-time"
        onClick={() => onSeek(note.anchorTime)}
        title={`跳到 ${formatClock(note.anchorTime)}`}
      >
        {formatClock(note.anchorTime)}
      </button>
      <div className="bili-note-text">{summarize(note.text, 120)}</div>
      <button
        type="button"
        className="bili-note-convert"
        onClick={() => onConvert(note.id)}
        title="把这条笔记转为收藏"
      >
        转收藏
      </button>
      <button
        type="button"
        className={`bili-note-del${confirming ? ' is-confirm' : ''}`}
        onClick={() => {
          if (step()) onDelete(note.id);
        }}
      >
        {confirming ? '确认删除' : '删除'}
      </button>
    </div>
  );
}
