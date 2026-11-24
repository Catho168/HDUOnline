/**
 * 播放页「本节助手」右侧面板（注入式 UI 第一阶段：PlayPanel 右栏停靠）。
 *
 * 第 48 轮按页签内聚纯搬移拆分（纪律同第 40/41 轮，逐行 diff 零差异）：本文件保留
 * 面板壳（头部/页签栏/页签分发/底部操作栏装配）与课次识别伴生组件（ResolutionChip/
 * ChooseCourModal）；各页签在 ui/panel/ 下（overview/topics/outline/qa/notes/
 * favorites/search 七页签 + PanelFooter + dock 停靠定位纯函数）。
 *
 * 设计原则：
 *  - 只读站点：不调用写接口、不修改站点 DOM、不劫持站点快捷键；
 *  - 站点播放器仍是主角，扩展 UI 全部在 Shadow DOM 内；
 *  - 任何单点失败静默降级，不阻塞播放。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ContextWindowPreset, CourEvidence } from '@/core/shared/types';
import { formatDuration, localDayKey } from '@/core/shared/utils';
import { Chip, EmptyState, IconButton, Modal, cx } from './components';
import { ShortcutsModal } from './ShortcutsModal';
import { Icon, type IconName } from './icons';
import { uiStore, useUiStore, type PanelTab } from './store';
import { panelDockStyle } from './panel/dock';
import { LessonStudyStrip } from './panel/LessonStudyStrip';
import { OverviewTab } from './panel/OverviewTab';
import { TopicsTab } from './panel/TopicsTab';
import { OutlineTab } from './panel/OutlineTab';
import { QaTab } from './panel/QaTab';
import { NotesTab } from './panel/NotesTab';
import { FavoritesTab } from './panel/FavoritesTab';
import { SearchTab } from './panel/SearchTab';
import { PanelFooter } from './panel/PanelFooter';

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

export function PlayPanel() {
  const state = useUiStore();
  const actions = uiStore.actions;
  const [noteText, setNoteText] = useState('');
  const [question, setQuestion] = useState('');
  const [searchText, setSearchText] = useState('');
  // 上下文窗口档位（第 29 轮 HDU 对齐 B 站面板）：初值同步取 uiStore 里的全局设置
  // （settings 已随 store 就绪，无 B 站侧 loadSettings 异步竞态）；点选仅影响本面板
  // 后续 qa.ask / ai.generate，不回写全局设置。
  const [windowPreset, setWindowPreset] = useState<ContextWindowPreset>(state.settings.contextWindow);
  // 「已交互」守卫：用户点选过档位后，全局设置的异步刷新（onSettingsChanged → store
  // patch）不再覆盖所选档；未交互时跟随全局设置（与 B 站面板 P3-1 同口径）
  const windowPresetTouchedRef = useRef(false);
  useEffect(() => {
    if (!windowPresetTouchedRef.current) setWindowPreset(state.settings.contextWindow);
  }, [state.settings.contextWindow]);
  const selectWindowPreset = useCallback((preset: ContextWindowPreset) => {
    windowPresetTouchedRef.current = true;
    setWindowPreset(preset);
  }, []);
  // 快捷键速查浮层（第 223 轮巡检）：面板头部「⌨」入口呼出，键位读当前设置（可配置值实时显示）
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

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
    void actions.ask(text, { windowPreset });
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
    // 第 17 轮实测修复（P1-2）：innerWidth 含滚动条宽度而 rect 是布局视口坐标，
    // 页面有纵向滚动条时右缘恒偏 15px——改用 clientWidth（布局视口）与 rect 同坐标系
    <aside className="hdu-panel" style={panelDockStyle(state.rightRailRect, document.documentElement.clientWidth)} aria-label="本节助手">
      <div className="hdu-panel-full">
        <header className="hdu-panel-head">
          <div className="hdu-panel-head-top">
            <div className="hdu-panel-session">
              <div className="hdu-panel-course" title={title}>{title}</div>
              <div className="hdu-panel-cour" title={courLabel}>{courLabel}</div>
            </div>
            <div className="hdu-panel-head-actions">
              <IconButton icon="scan" label="快捷键速查" onClick={() => setShortcutsOpen(true)} />
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
          {/* 本课学习小条（第 241 轮巡检）：本课今日已学/累计 + 本课待办提示；
              默认收起一行，courId 未识别时不渲染（组件内部自判） */}
          <LessonStudyStrip />
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
            <TopicsTab windowPreset={windowPreset} onSelectWindowPreset={selectWindowPreset} />
          ) : state.panelTab === 'outline' ? (
            <OutlineTab windowPreset={windowPreset} />
          ) : state.panelTab === 'qa' ? (
            <QaTab
              question={question}
              setQuestion={setQuestion}
              onSubmit={submitQuestion}
              windowPreset={windowPreset}
              onSelectWindowPreset={selectWindowPreset}
            />
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
            onGenerateAi={() => void actions.generateAi(undefined, { windowPreset })}
            onCapture={() => void actions.capture()}
            busy={busy}
          />
        </footer>
      </div>
      <ChooseCourModal />
      <ShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} shortcuts={state.settings.shortcuts} />
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
