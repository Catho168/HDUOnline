/**
 * 本节助手「速览」页签（第 48 轮自 PlayPanel.tsx 纯搬移拆分，逻辑/文案/类名逐行未变）：
 * 四格指标（本节时长/播放位置/转写覆盖/知识标注）+ 转写作业卡 + 回到上次的位置锚点。
 */

import { useMemo } from 'react';
import { formatClock, formatDuration } from '@/core/shared/utils';
import { Button, Chip, EmptyState, Progress, cx } from '../components';
import { Icon, type IconName } from '../icons';
import { uiStore, useUiStore } from '../store';

export function OverviewTab() {
  const state = useUiStore();
  const actions = uiStore.actions;
  const session = state.session;
  const transcript = state.transcript;
  const job = state.job;
  const ai = state.ai;
  const anchors = useMemo(() => {
    const list: Array<{ label: string; seconds: number; icon: IconName }> = [];
    if (session?.lastPlayTime) list.push({ label: `站点断点 ${formatClock(session.lastPlayTime)}`, seconds: session.lastPlayTime, icon: 'clock' });
    const chatAnchors = state.chats.filter((c) => c.role === 'user' && c.anchorTime != null).slice(-2);
    for (const chat of chatAnchors) list.push({ label: `上次提问 ${formatClock(chat.anchorTime!)}`, seconds: chat.anchorTime!, icon: 'message' });
    const noteAnchors = state.notes.slice(-2);
    for (const note of noteAnchors) list.push({ label: `笔记 ${formatClock(note.anchorTime)}`, seconds: note.anchorTime, icon: 'note' });
    return list;
  }, [session?.lastPlayTime, state.chats, state.notes]);

  if (!session && state.resolution.phase !== 'resolved') {
    return (
      <EmptyState
        icon="target"
        title="还没有识别到课次"
        text="站点新播放页的 URL 不含课次 ID。插件会从播放地址、站点接口、页面课次列表多路识别；也可以手动选择。"
        action={
          <Button size="small" variant="ghost" icon="target" onClick={() => actions.openCourPicker()}>
            从课次列表选择
          </Button>
        }
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
      <div className="hdu-overview-grid">
        <div className="hdu-overview-cell">
          <div className="hdu-overview-label">本节时长</div>
          <div className="hdu-overview-value">{formatClock(state.duration || session?.durationSec || 0)}</div>
        </div>
        <div className="hdu-overview-cell">
          <div className="hdu-overview-label">播放位置</div>
          <div className="hdu-overview-value">{formatClock(state.currentTime)}</div>
        </div>
        <div className="hdu-overview-cell">
          <div className="hdu-overview-label">转写覆盖</div>
          <div className="hdu-overview-value">
            {transcript
              ? transcript.segments.length > 0
                ? `${Math.round((transcript.coveredSec ?? 0) / 60)} 分钟`
                : `已处理 ${Math.round((transcript.coveredSec ?? 0) / 60)} 分钟 · 无文字`
              : '未生成'}
          </div>
        </div>
        <div className="hdu-overview-cell">
          <div className="hdu-overview-label">知识标注</div>
          <div className="hdu-overview-value small">{ai ? `${ai.topics.length} 个知识点` : '未生成'}</div>
        </div>
      </div>

      {job ? <JobCard job={job} /> : null}

      {anchors.length > 0 ? (
        <div>
          <div className="hdu-section-title" style={{ fontSize: 13, marginBottom: 7 }}>回到上次的位置</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {anchors.map((anchor, i) => (
              <button
                type="button"
                key={`${anchor.seconds}-${i}`}
                className="hdu-chip accent"
                onClick={() => actions.seek(anchor.seconds)}
                title={`跳转到 ${formatClock(anchor.seconds)}`}
              >
                <Icon name={anchor.icon} /> {anchor.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {!transcript ? (
        <div className="hdu-note-text">
          转写只在本机进行，音频不会上传。默认按当前进度前后 10 分钟滚动补齐，边看边生成；
          可在设置中调整范围或改为整段。
        </div>
      ) : null}
    </div>
  );
}

function JobCard({ job }: { job: NonNullable<ReturnType<typeof useUiStore>['job']> }) {
  const actions = uiStore.actions;
  const running = ['queued', 'extracting', 'transcribing', 'paused'].includes(job.status);
  const statusText =
    job.status === 'queued' ? '排队中' :
    job.status === 'extracting' ? '提取音轨' :
    job.status === 'transcribing' ? '转写中' :
    job.status === 'paused' ? '已暂停' :
    job.status === 'done' ? '已完成' :
    job.status === 'cancelled' ? '已取消' : '失败';
  return (
    <div className="hdu-card" style={{ padding: 12, borderRadius: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7 }}>
        <span className={cx('hdu-dot', running ? 'warn' : job.status === 'failed' ? 'err' : 'ok')} />
        <span style={{ fontSize: 12, fontWeight: 500 }}>{statusText}</span>
        {job.auto ? <Chip>后台自动</Chip> : null}
        <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--muted)' }}>
          {job.doneChunks}/{job.totalChunks} 段
        </span>
      </div>
      <Progress value={job.progress} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 7, fontSize: 10.5, color: 'var(--muted)', flexWrap: 'wrap' }}>
        {job.rate ? <span>{job.rate.toFixed(1)}× 实时</span> : null}
        {job.etaSec ? <span>预计剩余 {formatDuration(job.etaSec)}</span> : null}
        {job.window ? <span>片段 {formatClock(job.window.start)}–{formatClock(job.window.end)}</span> : null}
        {running ? (
          <button type="button" className="hdu-btn ghost small" style={{ marginLeft: 'auto' }} onClick={() => void actions.cancelTranscribe()}>
            取消
          </button>
        ) : null}
      </div>
      {job.error ? <div className="hdu-error-text" style={{ marginTop: 6 }}>{job.error}</div> : null}
      {job.warning ? <div className="hdu-note-text" style={{ marginTop: 6 }}>{job.warning}</div> : null}
    </div>
  );
}
