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
  CourEvidence,
  FavoriteEntity,
  NoteEntity,
  RouteInfo,
  SessionListItem,
  SessionMeta,
  SiteNote,
  SourceSite,
  TranscriptEntity,
} from '@/core/shared/types';

export type CenterView = 'overview' | 'courses' | 'schedule' | 'library' | 'stats';
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
    session: null,
    resolution: { phase: 'idle' },
    currentTime: 0,
    duration: 0,
    paused: true,
    watchedSec: 0,
    watchRatio: 0,
    videoRect: null,
    timelineRect: null,
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
  generateAi(force?: boolean): Promise<void>;
  ask(question: string): Promise<void>;
  abortAsk(chatId: string): Promise<void>;
  newChatGroup(): void;
  addNote(text: string, atSec: number): Promise<void>;
  deleteNote(id: string): Promise<void>;
  convertNote(id: string): Promise<void>;
  addTimeFavorite(): Promise<void>;
  favoriteChat(chatId: string): Promise<void>;
  favoriteOutline(index: number): Promise<void>;
  capture(): Promise<void>;
  searchTranscript(query: string): Promise<void>;
  saveSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): Promise<void>;
  openSessionInSite(courId: number, teclId?: number, extra?: { teclCode?: string; subjId?: number }): void;
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

export function useUiActions(): UiActions {
  return uiStore.actions;
}
