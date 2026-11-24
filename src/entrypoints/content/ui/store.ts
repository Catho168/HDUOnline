/**
 * 内容脚本 UI 状态（外部 store）。
 * 单一实例：每个站点页面只有一个内容脚本实例。
 */

import { useSyncExternalStore } from 'react';
import { DEFAULT_SETTINGS } from '@/core/shared/constants';
import type {
  AiResultEntity,
  AppSettings,
  AsrJobEntity,
  ChatMessageEntity,
  ContextWindowPreset,
  CourEvidence,
  FavoriteEntity,
  NoteEntity,
  ReviewFilterPrefs,
  RouteInfo,
  SessionListItem,
  SessionMeta,
  SiteNote,
  SourceSite,
  TranscriptEntity,
} from '@/core/shared/types';

export type CenterView = 'overview' | 'courses' | 'schedule' | 'library' | 'review' | 'stats';

/** 复习计划视图的筛选/排序（第 84/88/97/103 轮巡检；第 104 轮起随 settings 持久化） */
export type ReviewFilters = ReviewFilterPrefs;
/** 缺省筛选/排序（与 DEFAULT_SETTINGS.ui.reviewFilters 同值；读取旧数据时兜底合并用） */
export const DEFAULT_REVIEW_FILTERS: ReviewFilters = {
  type: 'all',
  template: 'all',
  urgency: 'all',
  sort: 'due',
  viewMode: 'list',
  viewRange: 7,
};
export type PanelTab = 'overview' | 'topics' | 'outline' | 'qa' | 'notes' | 'favorites' | 'search';
export type ResolutionPhase = 'idle' | 'resolving' | 'resolved' | 'unresolved';

export interface ResolutionState {
  phase: ResolutionPhase;
  courId?: number;
  evidence?: CourEvidence;
  confidence?: 'direct' | 'inferred';
  candidates?: SessionListItem[];
}

export interface UiState {
  ready: boolean;
  route: RouteInfo;
  site: SourceSite;
  settings: AppSettings;
  session: SessionMeta | null;
  resolution: ResolutionState;
  currentTime: number;
  duration: number;
  paused: boolean;
  watchedSec: number;
  watchRatio: number;
  videoRect: { left: number; top: number; width: number; height: number; bottom: number } | null;
  timelineRect: { left: number; top: number; width: number; height: number } | null;
  /** 站点右栏矩形（PlayPanel 停靠用；非播放页或选择器缺失时为 null） */
  rightRailRect: { left: number; top: number; width: number; height: number } | null;
  /** 顶栏 chip 注入是否已挂载成功（挂载成功时隐藏浮窗胶囊，保持单入口） */
  anchorChipActive: boolean;
  /** 注入式入口（锚点探针）是否已挂载成功（挂载成功时隐藏浮层 Dock，保持单入口） */
  injectedEntryActive: boolean;
  transcript: TranscriptEntity | null;
  job: AsrJobEntity | null;
  ai: AiResultEntity | null;
  aiStale: boolean;
  chats: ChatMessageEntity[];
  notes: NoteEntity[];
  favorites: FavoriteEntity[];
  siteNotes: SiteNote[];
  siteCollected: boolean;
  panelOpen: boolean;
  panelTab: PanelTab;
  courPickerOpen: boolean;
  centerOpen: boolean;
  centerView: CenterView;
  centerSuppressed: boolean;
  centerDataVersion: number;
  activeGroupId?: string;
  streamingChatId?: string;
  backendReady: boolean;
  busy: { session: boolean; transcript: boolean; ai: boolean; ask: boolean; capture: boolean };
  transcriptSearch: { query: string; results: Array<{ start: number; end: number; text: string }>; loading: boolean };
  toastVersion: number;
  /** 今日待办卡刷新计数（第 159 轮巡检）：回收站还原等跨视图操作 bump，TodayTodoCard 随之重取数据 */
  todoRefreshTick: number;
}

const PLAY_ROUTES = new Set(['play-center', 'video-detail', 'play-video']);

export function isPlayRoute(kind: RouteInfo['kind']): boolean {
  return PLAY_ROUTES.has(kind);
}

export function emptyRoute(): RouteInfo {
  return { kind: 'other', site: 'campus', raw: '' };
}

export function initialState(): UiState {
  return {
    ready: false,
    route: emptyRoute(),
    site: 'campus',
    settings: DEFAULT_SETTINGS,
    todoRefreshTick: 0,
    session: null,
    resolution: { phase: 'idle' },
    currentTime: 0,
    duration: 0,
    paused: true,
    watchedSec: 0,
    watchRatio: 0,
    videoRect: null,
    timelineRect: null,
    rightRailRect: null,
    anchorChipActive: false,
    injectedEntryActive: false,
    transcript: null,
    job: null,
    ai: null,
    aiStale: false,
    chats: [],
    notes: [],
    favorites: [],
    siteNotes: [],
    siteCollected: false,
    panelOpen: false,
    panelTab: 'overview',
    courPickerOpen: false,
    centerOpen: false,
    centerView: 'overview',
    centerSuppressed: false,
    centerDataVersion: 0,
    backendReady: true,
    busy: { session: false, transcript: false, ai: false, ask: false, capture: false },
    transcriptSearch: { query: '', results: [], loading: false },
    toastVersion: 0,
  };
}

/**
 * ask / generateAi 的可选 per-request 上下文窗口档位（第 29 轮 HDU 对齐）：
 * 面板选档时携带（WindowPresetChips 点选值），缺省回落全局设置——与 SW 侧
 * resolveContextWindowPreset 的 `args.windowPreset ?? settings.contextWindow` 口径一致。
 */
export interface WindowPresetOptions {
  windowPreset?: ContextWindowPreset;
}

export interface UiActions {
  seek(seconds: number): void;
  togglePlay(): void;
  setPanelOpen(open: boolean): void;
  togglePanel(): void;
  setPanelTab(tab: PanelTab): void;
  openCourPicker(): void;
  closeCourPicker(): void;
  openCenter(view?: CenterView): void;
  closeCenter(): void;
  setCenterView(view: CenterView): void;
  suppressCenter(): void;
  restoreCenter(): void;
  refresh(): Promise<void>;
  /** 从站点只读同步课程/课次；force=true 时跳过 15 分钟节流 */
  syncCourses(opts?: { force?: boolean; quiet?: boolean }): Promise<void>;
  /** 从站点只读同步本周课表；force=true 时跳过节流 */
  syncSchedule(opts?: { force?: boolean; quiet?: boolean }): Promise<void>;
  reloadSession(): Promise<void>;
  selectCour(courId: number): Promise<void>;
  startTranscribe(opts?: { force?: boolean; windowMode?: 'full' | 'around' }): Promise<void>;
  cancelTranscribe(): Promise<void>;
  generateAi(force?: boolean, opts?: WindowPresetOptions): Promise<void>;
  ask(question: string, opts?: WindowPresetOptions): Promise<void>;
  abortAsk(chatId: string): Promise<void>;
  newChatGroup(): void;
  /** 会话历史管理（第 88 轮巡检）：切换到指定历史问答会话 */
  loadChatGroup(groupId: string): Promise<void>;
  /** 会话历史管理（第 88 轮巡检）：删除指定历史问答会话（当前会话被删则清空展示） */
  deleteChatGroup(groupId: string): Promise<void>;
  addNote(text: string, atSec: number): Promise<void>;
  deleteNote(id: string): Promise<void>;
  convertNote(id: string): Promise<void>;
  addTimeFavorite(): Promise<void>;
  favoriteChat(chatId: string): Promise<void>;
  favoriteOutline(index: number): Promise<void>;
  capture(): Promise<void>;
  searchTranscript(query: string): Promise<void>;
  saveSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): Promise<void>;
  openSessionInSite(
    courId: number,
    teclId?: number,
    extra?: { teclCode?: string; subjId?: number; anchorSec?: number },
  ): void;
  copyText(text: string): Promise<void>;
  showToast(message: string, level?: 'info' | 'success' | 'warn' | 'error'): void;
}

const noopAsync = async () => undefined;
const noop = () => undefined;

function defaultActions(): UiActions {
  return {
    seek: noop,
    togglePlay: noop,
    setPanelOpen: noop,
    togglePanel: noop,
    setPanelTab: noop,
    openCourPicker: noop,
    closeCourPicker: noop,
    openCenter: noop,
    closeCenter: noop,
    setCenterView: noop,
    suppressCenter: noop,
    restoreCenter: noop,
    refresh: noopAsync,
    syncCourses: noopAsync,
    syncSchedule: noopAsync,
    reloadSession: noopAsync,
    selectCour: noopAsync,
    startTranscribe: noopAsync,
    cancelTranscribe: noopAsync,
    generateAi: noopAsync,
    ask: noopAsync,
    abortAsk: noopAsync,
    newChatGroup: noop,
    loadChatGroup: noopAsync,
    deleteChatGroup: noopAsync,
    addNote: noopAsync,
    deleteNote: noopAsync,
    convertNote: noopAsync,
    addTimeFavorite: noopAsync,
    favoriteChat: noopAsync,
    favoriteOutline: noopAsync,
    capture: noopAsync,
    searchTranscript: noopAsync,
    saveSetting: noopAsync,
    openSessionInSite: noop,
    copyText: noopAsync,
    showToast: noop,
  };
}

export class UiStore {
  private state: UiState = initialState();
  private listeners = new Set<() => void>();
  actions: UiActions = defaultActions();
  /** 最近一次用户与页面交互时间戳（第 203 轮巡检）：mousedown/keydown 时更新；
   *  非响应式（不入 state，不触发订阅重渲染），供 Esc 等交互前提判断读取 */
  lastInteractionAt = 0;

  markInteraction = (): void => {
    this.lastInteractionAt = Date.now();
  };

  getState = (): UiState => this.state;

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  patch = (patch: Partial<UiState>): void => {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  };

  update = (fn: (state: UiState) => Partial<UiState>): void => {
    this.patch(fn(this.state));
  };

  bindActions = (actions: Partial<UiActions>): void => {
    this.actions = { ...this.actions, ...actions };
  };

  showToast = (message: string, level: 'info' | 'success' | 'warn' | 'error' = 'info'): void => {
    this.actions.showToast(message, level);
  };
}

export const uiStore = new UiStore();

export function useUiStore(): UiState {
  return useSyncExternalStore(uiStore.subscribe, uiStore.getState, uiStore.getState);
}
