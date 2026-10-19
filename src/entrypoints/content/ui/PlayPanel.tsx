import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessageEntity, CourEvidence, Topic } from '@/core/shared/types';
import { formatClock, formatDuration, localDayKey } from '@/core/shared/utils';
import { Button, Chip, EmptyState, IconButton, Modal, Progress, cx } from './components';
import { Icon, type IconName } from './icons';
import { uiStore, useUiStore, type PanelTab } from './store';

const TAB_META: Array<{ key: PanelTab; label: string; icon: IconName }> = [
  { key: 'overview', label: '速览', icon: 'layers' },
  { key: 'topics', label: '标注', icon: 'spark' },
  { key: 'outline', label: '大纲', icon: 'list' },
  { key: 'qa', label: '问答', icon: 'message' },
  { key: 'notes', label: '笔记', icon: 'note' },
  { key: 'favorites', label: '收藏', icon: 'star' },
  { key: 'search', label: '搜索', icon: 'search' },
];

const EVIDENCE_LABEL: Record<CourEvidence, string> = {
  url: 'URL 参数',
  'media-name': '播放地址',
  'media-query': '播放地址参数',
  'site-request': '站点接口',
  'site-last-play': '上次播放记录',
  'page-selection': '页面课次选中项',
  manual: '手动选择',
};

const SUGGESTIONS = ['这一段的重点是什么？', '老师刚才举了什么例子？', '用更直白的话解释这个概念'];

export function PlayPanel() {
  const state = useUiStore();
  const actions = uiStore.actions;
  const [noteText, setNoteText] = useState('');
  const [question, setQuestion] = useState('');
  const [searchText, setSearchText] = useState('');

  const resolution = state.resolution;
  const busy = state.busy;
  const session = state.session;
  const jobRunning = state.job && ['queued', 'extracting', 'transcribing', 'paused'].includes(state.job.status);

  const title = session?.courseName ?? '本节助手';
  const courLabel = session?.courLabel ?? (resolution.phase === 'resolving' ? '正在识别当前课次…' : '等待识别课次');

  const submitQuestion = () => {
    const text = question.trim();
    if (!text) return;
    setQuestion('');
    void actions.ask(text);
  };

  const submitNote = () => {
    const text = noteText.trim();
    if (!text) return;
    setNoteText('');
    void actions.addNote(text, Math.floor(state.currentTime));
  };

  const submitSearch = () => {
    const text = searchText.trim();
    if (text) void actions.searchTranscript(text);
  };

  if (!state.panelOpen) return null;

  return (
    <aside className="hdu-panel" aria-label="本节助手">
      <div className="hdu-panel-full">
        <header className="hdu-panel-head">
          <div className="hdu-panel-head-top">
            <div className="hdu-panel-session">
              <div className="hdu-panel-course" title={title}>{title}</div>
              <div className="hdu-panel-cour" title={courLabel}>{courLabel}</div>
            </div>
            <div className="hdu-panel-head-actions">
              <IconButton icon="star" label="收藏当前时间点" onClick={() => void actions.addTimeFavorite()} />
              <IconButton icon="library" label="打开学习中心" onClick={() => actions.openCenter()} />
              <IconButton icon="chevronRight" label="收起面板" onClick={() => actions.setPanelOpen(false)} />
            </div>
          </div>
          <div className="hdu-panel-status">
            <ResolutionChip />
            {state.duration > 0 ? <Chip icon="clock">{formatDuration(state.duration)}</Chip> : null}
            {state.transcript ? (
              <Chip tone={state.transcript.segments.length > 0 ? 'jade' : 'info'} icon="check">
                {state.transcript.segments.length > 0
                  ? `已转写 ${Math.round((state.transcript.coveredSec ?? 0) / 60)} 分钟`
                  : '尚未识别到文字'}
              </Chip>
            ) : null}
          </div>
        </header>

        <div className="hdu-panel-tabs" role="tablist">
          {TAB_META.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={state.panelTab === tab.key}
              className={cx('hdu-panel-tab', state.panelTab === tab.key ? 'is-active' : '')}
              onClick={() => actions.setPanelTab(tab.key)}
            >
              {tab.label}
              {tab.key === 'qa' && state.streamingChatId ? <span className="hdu-tab-dot" /> : null}
            </button>
          ))}
        </div>

        <div className="hdu-panel-body hdu-scroll">
          {state.panelTab === 'overview' ? (
            <OverviewTab />
          ) : state.panelTab === 'topics' ? (
            <TopicsTab />
          ) : state.panelTab === 'outline' ? (
            <OutlineTab />
          ) : state.panelTab === 'qa' ? (
            <QaTab question={question} setQuestion={setQuestion} onSubmit={submitQuestion} />
          ) : state.panelTab === 'notes' ? (
            <NotesTab noteText={noteText} setNoteText={setNoteText} onSubmit={submitNote} />
          ) : state.panelTab === 'favorites' ? (
            <FavoritesTab />
          ) : (
            <SearchTab searchText={searchText} setSearchText={setSearchText} onSubmit={submitSearch} />
          )}
        </div>

        <footer className="hdu-panel-foot">
          <PanelFooter
            jobRunning={Boolean(jobRunning)}
            onTranscribe={() => void actions.startTranscribe()}
            onCancel={() => void actions.cancelTranscribe()}
            onGenerateAi={() => void actions.generateAi()}
            onCapture={() => void actions.capture()}
            busy={busy}
          />
        </footer>
      </div>
      <ChooseCourModal />
    </aside>
  );
}

function ResolutionChip() {
  const state = useUiStore();
  const resolution = state.resolution;
  const actions = uiStore.actions;
  if (resolution.phase === 'resolving') {
    return <Chip tone="info" icon="refresh">识别课次中…</Chip>;
  }
  if (resolution.phase === 'unresolved') {
    return (
      <button type="button" className="hdu-chip danger" onClick={() => actions.openCourPicker()}>
        <Icon name="alert" /> 待识别课次
        <Icon name="chevronDown" />
      </button>
    );
  }
  if (resolution.phase === 'resolved' && resolution.evidence) {
    const inferred = resolution.confidence === 'inferred';
    return (
      <button
        type="button"
        className={cx('hdu-chip', inferred ? 'accent' : 'jade')}
        onClick={() => actions.openCourPicker()}
        title={inferred ? '推断结果，点击可手动切换课次' : '点击可手动切换课次'}
      >
        <Icon name={inferred ? 'target' : 'check'} /> {EVIDENCE_LABEL[resolution.evidence]}
        {inferred ? ' · 推断' : ''}
      </button>
    );
  }
  return (
    <button type="button" className="hdu-chip" onClick={() => actions.openCourPicker()}>
      <Icon name="target" /> 选择课次
    </button>
  );
}

function ChooseCourModal() {
  const state = useUiStore();
  const actions = uiStore.actions;
  const candidates = state.resolution.candidates ?? [];
  return (
    <Modal open={state.courPickerOpen} title="选择当前课次" onClose={() => actions.closeCourPicker()}>
      <div className="hdu-hint">
        {state.session?.teclId ? `教学班 ${state.session.teclId}` : '站点新播放页的 URL 不含课次 ID，请选择右栏中对应当前播放的课次。'}
      </div>
      {candidates.length === 0 ? (
        <EmptyState icon="calendar" title="还没有课次列表" text="等待站点课次列表加载，或在右栏切换一次课次后再试。" />
      ) : (
        <div className="hdu-list">
          {candidates.map((item) => {
            const active = state.resolution.courId === item.courId;
            return (
              <button
                type="button"
                key={item.courId}
                className="hdu-list-row"
                style={{ width: '100%', textAlign: 'left', padding: '10px 6px', borderRadius: 10 }}
                onClick={async () => {
                  await actions.selectCour(item.courId);
                  actions.closeCourPicker();
                }}
              >
                <div className="hdu-list-main">
                  <div className="hdu-list-title">{item.courId} · 第{item.letiNumber ?? '?'}节课</div>
                  <div className="hdu-list-sub">
                    <span>{localDayKey(item.beginTime)}</span>
                    <span>{item.clroName || '教室未知'}</span>
                  </div>
                </div>
                <div className="hdu-list-side">
                  {active ? <Chip tone="jade" icon="check">当前</Chip> : <Icon name="chevronRight" />}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

// ───────────────────────── 速览 ─────────────────────────

function OverviewTab() {
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
          <Button size="small" icon="target" onClick={() => actions.openCourPicker()}>
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
          {state.settings.asr.engine === 'cloud'
            ? '转写由云端服务完成，60 秒音频片段将上传至你在设置中配置的 ASR 服务。默认按当前进度前后 10 分钟滚动补齐，边看边生成。'
            : '转写只在本机进行，音频不会上传。默认按当前进度前后 10 分钟滚动补齐，边看边生成；可在设置中调整范围或改为整段。'}
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

// ───────────────────────── 标注 ─────────────────────────

function TopicsTab() {
  const state = useUiStore();
  const actions = uiStore.actions;
  const [hideLow, setHideLow] = useState(false);
  const processedNoSpeech =
    Boolean(state.transcript?.coverage?.length) && state.transcript?.segments.length === 0;
  if (!state.transcript || state.transcript.segments.length === 0) {
    return (
      <EmptyState
        icon={processedNoSpeech ? 'message' : 'wand'}
        title={processedNoSpeech ? '没有识别到有效语音' : '需要先生成字幕'}
        text={
          processedNoSpeech
            ? state.job?.warning ??
              '本节音频已处理，但没有识别到有效文字。请确认当前播放机位是否包含声音（部分机位只有画面），或换一个区段重新生成。'
            : '知识标注以字幕文本为依据。先生成字幕，再让 AI 提取知识点。'
        }
        action={
          <Button size="small" onClick={() => void actions.startTranscribe()}>
            {processedNoSpeech ? '重新生成' : '生成字幕'}
          </Button>
        }
      />
    );
  }
  if (!state.ai) {
    return (
      <EmptyState
        icon="spark"
        title="还没有知识标注"
        text={state.busy.ai ? '正在生成，通常需要几十秒到几分钟…' : '根据本节字幕提取知识点与时间区间，点击条目可直接跳转。'}
        action={<Button size="small" variant="primary" loading={state.busy.ai} onClick={() => void actions.generateAi()}>生成知识标注</Button>}
      />
    );
  }
  const topics = hideLow ? state.ai.topics.filter((t) => t.confidence !== 'low') : state.ai.topics;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
        <Chip tone="accent" icon="spark">AI 生成</Chip>
        <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>{state.ai.topics.length} 个知识点</span>
        <button type="button" className="hdu-filter-pill" style={{ marginLeft: 'auto' }} onClick={() => setHideLow((v) => !v)}>
          {hideLow ? '显示低置信' : '隐藏低置信'}
        </button>
      </div>
      {topics.map((topic, i) => (
        <TopicRow key={`${topic.name}-${i}`} topic={topic} />
      ))}
      {topics.length === 0 ? <EmptyState icon="spark" title="没有高置信度知识点" text="关闭「隐藏低置信」可查看全部结果。" /> : null}
    </div>
  );
}

function TopicRow({ topic }: { topic: Topic }) {
  const actions = uiStore.actions;
  const [open, setOpen] = useState(false);
  return (
    <div className={cx('hdu-topic', topic.confidence === 'low' ? 'low' : '')}>
      <div className="hdu-topic-head">
        <span className="hdu-topic-name">{topic.name}</span>
        {topic.confidence === 'low' ? <Chip>低置信</Chip> : topic.confidence === 'medium' ? <Chip tone="info">中置信</Chip> : null}
        <button type="button" className="hdu-btn ghost small" style={{ marginLeft: 'auto' }} onClick={() => actions.seek(topic.intervals[0]?.[0] ?? 0)}>
          跳到开头
        </button>
      </div>
      <button type="button" className="hdu-topic-sum" style={{ textAlign: 'left' }} onClick={() => setOpen((v) => !v)}>
        {open ? topic.summary : topic.summary.slice(0, 76) + (topic.summary.length > 76 ? '…' : '')}
      </button>
      <div className="hdu-topic-times">
        {topic.intervals.map(([start, end], i) => (
          <button type="button" className="hdu-topic-time" key={i} onClick={() => actions.seek(start)}>
            {formatClock(start)}–{formatClock(end)}
          </button>
        ))}
      </div>
    </div>
  );
}

// ───────────────────────── 大纲 ─────────────────────────

function OutlineTab() {
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
        action={<Button size="small" variant="primary" disabled={!state.transcript} loading={state.busy.ai} onClick={() => void actions.generateAi()}>生成大纲</Button>}
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

// ───────────────────────── 问答 ─────────────────────────

function QaTab({
  question,
  setQuestion,
  onSubmit,
}: {
  question: string;
  setQuestion: (value: string) => void;
  onSubmit: () => void;
}) {
  const state = useUiStore();
  const actions = uiStore.actions;
  const bottomRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [state.chats.length, state.streamingChatId]);

  const segments = state.transcript?.segments ?? [];
  if (segments.length === 0) {
    // transcript 记录可能已存在但还没有文字（首个分片未完成/静音片段）：
    // 这时不能只显示"需要先生成字幕"，否则用户会以为转写没生效。
    const status = state.job?.status;
    const running = status === 'queued' || status === 'extracting' || status === 'transcribing';
    const paused = status === 'paused';
    const percent = Math.round((state.job?.progress ?? 0) * 100);
    // 已处理过音频但没有有效文字：与“还没开始转写”区分开，避免反复点生成
    const processedNoSpeech = !running && !paused && Boolean(state.transcript?.coverage?.length);
    return (
      <EmptyState
        icon="message"
        title={
          running
            ? status === 'extracting'
              ? '正在提取音轨'
              : '字幕正在生成'
            : paused
              ? '转写已暂停'
              : processedNoSpeech
                ? '没有识别到有效语音'
                : '需要先生成字幕'
        }
        text={
          running
            ? `正在转写本节字幕（${percent}%），首个片段完成后即可提问。`
            : paused
              ? '转写已暂停，继续转写后才能基于字幕提问。'
              : processedNoSpeech
                ? state.job?.warning ??
                  '本节音频已处理，但没有识别到有效文字。请确认当前播放机位是否包含声音（部分机位只有画面），或换一个区段重新生成。'
                : '问答只依据本节字幕内容回答，并在回答中标注依据时间。'
        }
        action={
          running ? undefined : (
            <Button size="small" onClick={() => void actions.startTranscribe()}>
              {paused ? '继续转写' : '生成字幕'}
            </Button>
          )
        }
      />
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
        <Chip tone="info" icon="brain">基于本节字幕</Chip>
        <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>锚点 {formatClock(state.currentTime)}</span>
        <Button size="small" variant="ghost" icon="plus" style={{ marginLeft: 'auto' }} onClick={() => actions.newChatGroup()}>
          新对话
        </Button>
      </div>
      {state.chats.length === 0 ? (
        <div>
          <EmptyState icon="message" title="就这一刻提问" text="问题会带上当前播放位置作为锚点。回答只依据附近字幕，不足时会明确告诉你。" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {SUGGESTIONS.map((text) => (
              <button type="button" key={text} className="hdu-topic" style={{ textAlign: 'left' }} onClick={() => setQuestion(text)}>
                <span className="hdu-topic-sum">{text}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="hdu-qa">
          {state.chats.map((chat) => (
            <ChatBubble key={chat.id} chat={chat} />
          ))}
          <div ref={bottomRef} />
        </div>
      )}
      <div style={{ marginTop: 12 }}>
        <div className="hdu-composer">
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={`就 ${formatClock(state.currentTime)} 这一刻提问…`}
            rows={2}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                onSubmit();
              }
            }}
          />
          {state.streamingChatId ? (
            <Button size="small" variant="ghost" icon="stop" onClick={() => void actions.abortAsk(state.streamingChatId!)}>
              停止
            </Button>
          ) : (
            <Button size="small" variant="primary" icon="send" onClick={onSubmit} loading={state.busy.ask} />
          )}
        </div>
        <div className="hdu-composer-hint">
          <span>Enter 发送 · Shift+Enter 换行</span>
          <span>·</span>
          <span>仅发送字幕文本与问题，视频数据不出本机</span>
        </div>
      </div>
    </div>
  );
}

function ChatBubble({ chat }: { chat: ChatMessageEntity }) {
  const actions = uiStore.actions;
  if (chat.role === 'user') {
    return (
      <div className="hdu-qa-msg user">
        <div className="hdu-qa-bubble">{chat.content}</div>
        <div className="hdu-qa-meta">
          {chat.anchorTime != null ? <span className="hdu-qa-anchor">@{formatClock(chat.anchorTime)}</span> : null}
          {chat.status === 'failed' ? <span style={{ color: 'var(--danger)' }}>发送失败</span> : null}
        </div>
      </div>
    );
  }
  return (
    <div className="hdu-qa-msg ai">
      <div className="hdu-qa-bubble">
        {chat.content ||
          (chat.status === 'streaming' ? (
            <span className="hdu-spinner" />
          ) : chat.insufficient ? (
            '附近字幕不足以回答这个问题。可以换一种问法，或把进度拖到讲解该内容的区段再提问。'
          ) : (
            ''
          ))}
        {chat.status === 'streaming' ? <span className="hdu-dot warn" style={{ display: 'inline-block', marginLeft: 4 }} /> : null}
      </div>
      <div className="hdu-qa-meta">
        <Chip tone="accent" icon="spark">AI 生成</Chip>
        {chat.evidence ? (
          <button type="button" className="hdu-qa-evidence" onClick={() => actions.seek(chat.evidence!.start)}>
            <Icon name="target" size={10} /> 依据 {formatClock(chat.evidence.start)}–{formatClock(chat.evidence.end)}
          </button>
        ) : null}
        {chat.contextActual ? <span>上下文 {formatClock(chat.contextActual[0])}–{formatClock(chat.contextActual[1])}</span> : null}
        {chat.status === 'done' ? (
          <button type="button" className="hdu-icon-btn" style={{ width: 20, height: 20 }} onClick={() => void actions.favoriteChat(chat.id)} title="收藏这条回答">
            <Icon name="star" />
          </button>
        ) : null}
        {chat.insufficient ? <Chip tone="danger">字幕不足</Chip> : null}
      </div>
    </div>
  );
}

// ───────────────────────── 笔记 ─────────────────────────

function NotesTab({
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
        <Chip tone="accent" icon="note">{state.notes.length} 条本节笔记</Chip>
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
                <IconButton icon="trash" label="删除笔记" onClick={() => void actions.deleteNote(note.id)} />
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

// ───────────────────────── 收藏 ─────────────────────────

function FavoritesTab() {
  const state = useUiStore();
  const actions = uiStore.actions;
  if (state.favorites.length === 0) {
    return (
      <EmptyState
        icon="star"
        title="本节还没有收藏"
        text="收藏时间点、AI 回答、大纲节点或截图，统一进入知识库，可加标签、写备注、导出复习卡片。"
        action={<Button size="small" icon="star" onClick={() => void actions.addTimeFavorite()}>收藏当前时间点</Button>}
      />
    );
  }
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <Chip tone="accent" icon="star">{state.favorites.length} 条</Chip>
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

// ───────────────────────── 搜索 ─────────────────────────

function SearchTab({
  searchText,
  setSearchText,
  onSubmit,
}: {
  searchText: string;
  setSearchText: (value: string) => void;
  onSubmit: () => void;
}) {
  const state = useUiStore();
  const actions = uiStore.actions;
  const search = state.transcriptSearch;
  return (
    <div>
      <div className="hdu-search" style={{ maxWidth: 'none', width: '100%' }}>
        <Icon name="search" />
        <input
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          placeholder="搜索本节字幕内容…"
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSubmit();
          }}
        />
        <Button size="small" variant="ghost" onClick={onSubmit} loading={search.loading}>搜索</Button>
      </div>
      <div style={{ marginTop: 10 }}>
        {search.query ? (
          <div className="hdu-hint" style={{ marginBottom: 8 }}>“{search.query}” · {search.results.length} 条结果</div>
        ) : null}
        {search.results.length === 0 ? (
          <EmptyState icon="search" title={search.query ? '没有命中' : '在字幕中定位'} text="输入关键词，命中结果会带上时间点，点击即可跳转。" />
        ) : (
          <div className="hdu-transcript">
            {search.results.map((hit, i) => (
              <button type="button" key={`${hit.start}-${i}`} className="hdu-seg" onClick={() => actions.seek(hit.start)}>
                <span className="hdu-seg-time">{formatClock(hit.start)}</span>
                <span className="hdu-seg-text">{hit.text}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ───────────────────────── 底部操作栏 ─────────────────────────

function PanelFooter({
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
