/**
 * 本节助手底部操作栏（第 48 轮自 PlayPanel.tsx 纯搬移拆分，逻辑/文案/类名逐行未变）：
 * 转写起停 / AI 标注 / 截图 + 学习中心入口。
 */

import { Button, IconButton } from '../components';
import { uiStore, useUiStore } from '../store';

export function PanelFooter({
  jobRunning,
  onTranscribe,
  onCancel,
  onGenerateAi,
  onCapture,
  busy,
}: {
  jobRunning: boolean;
  onTranscribe: () => void;
  onCancel: () => void;
  onGenerateAi: () => void;
  onCapture: () => void;
  busy: { session: boolean; transcript: boolean; ai: boolean; ask: boolean; capture: boolean };
}) {
  const state = useUiStore();
  return (
    <div className="hdu-panel-actions">
      <Button size="small" icon={jobRunning ? 'stop' : 'wand'} variant={jobRunning ? 'default' : 'primary'} onClick={jobRunning ? onCancel : onTranscribe} loading={busy.transcript}>
        {jobRunning ? '停止转写' : state.transcript?.segments.length ? '继续转写' : '生成字幕'}
      </Button>
      <Button size="small" icon="spark" onClick={onGenerateAi} loading={busy.ai} disabled={!state.transcript || state.transcript.segments.length === 0}>
        标注
      </Button>
      <Button size="small" icon="camera" onClick={onCapture} loading={busy.capture}>
        截图
      </Button>
      <div style={{ marginLeft: 'auto' }}>
        <IconButton icon="library" label="学习中心" onClick={() => uiStore.actions.openCenter()} />
      </div>
    </div>
  );
}
