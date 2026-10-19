/**
 * 全局领域类型。
 *
 * 与《技术实现文档》§4.2 对齐；为满足片段流式转写与学习中心，额外增加
 * `asrChunks` / `asrJobs` / 视图型数据结构。站点实体的主键统一为
 * `teclId`（教学班）+ `courId`（课次，URL 中的 courseId）。
 */

// ───────────────────────── 站点身份与路由 ─────────────────────────

export type SourceSite = 'campus' | 'webvpn';

export interface SiteRef {
  teclId: number;
  courId: number;
}

export type RouteKind =
  | 'play-center'
  | 'video-detail'
  | 'play-video'
  | 'list-video'
  | 'list-live'
  | 'home'
  | 'my-schedule'
  | 'my-record'
  | 'my-collection'
  | 'my-note'
  | 'other';

export interface RouteInfo {
  kind: RouteKind;
  site: SourceSite;
  teclId?: number;
  /** 课次 ID；`play-center` 的 URL 不携带，由多证据链事后解析 */
  courId?: number;
  teclCode?: string;
  /** `play-center` URL 中的课程 ID（不是课次 ID） */
  subjId?: number;
  target?: string;
  /** 原始 hash（只用于调试，落日志前打码） */
  raw: string;
}

/** 播放页课次识别结果（多证据链） */
export type CourEvidence =
  | 'url'
  | 'media-name'
  | 'media-query'
  | 'site-request'
  | 'site-last-play'
  | 'page-selection'
  | 'manual';

export interface ResolvedSession {
  courId: number;
  evidence: CourEvidence;
  /** 置信度：direct = URL/媒体直证；inferred = 需与播放地址核对 */
  confidence: 'direct' | 'inferred';
}

export interface SessionMeta {
  courId: number;
  teclId: number;
  courseName: string;
  subjCode?: string;
  teacherNames: string[];
  clroName?: string;
  letiNumber?: number;
  letyName?: string;
  /** 毫秒时间戳 */
  beginTime?: number;
  endTime?: number;
  durationSec: number;
  /** 站点原生断点（秒） */
  lastPlayTime?: number;
  views: VodView[];
  /** "第5周 / 2026-10-12 / 第12节课" */
  courLabel: string;
  openType?: string;
  message?: string;
}

export interface VodView {
  vodId: number;
  url: string;
  vodTime: number;
  viewNum?: number;
}

export interface SessionListItem {
  courId: number;
  beginTime: number;
  endTime: number;
  letiNumber?: number;
  letyName?: string;
  clroName?: string;
  /** 课次行里若带教师字段，用于补全课程教师 */
  teacherNames?: string[];
  vodStatus?: number | string | null;
  vodDisplayStatus?: number | string | null;
  noteFlag?: boolean;
}

export interface CourseListItem {
  teclId: number;
  subjName: string;
  subjCode?: string;
  teclCode?: string;
  clroName?: string;
  teacherNames: string[];
  courTimes?: number;
  coverUrl?: string;
}

export interface SiteUser {
  name: string;
  role?: string | number;
}

/** 站点原生笔记（只读） */
export interface SiteNote {
  id: string | number;
  anchorTime?: number;
  text: string;
  createdAt?: string | number;
}

/** 站点原生收藏条目（只读） */
export interface SiteCollectionItem {
  courId: number;
  teclId?: number;
  title: string;
  courseName?: string;
  createdAt?: number;
}

export interface CurriculumItem {
  courId: number;
  teclId: number;
  subjName: string;
  beginTime: number;
  endTime: number;
  clroName?: string;
  letiNumber?: number;
  status?: string;
}

// ───────────────────────── 本地实体 ─────────────────────────

export interface CourseEntity {
  teclId: number;
  subjName: string;
  subjCode?: string;
  teacherNames: string[];
  clroName?: string;
  semester?: string;
  teclCode?: string;
  coverUrl?: string;
  updatedAt: number;
}

export type WatchState = 'unwatched' | 'watching' | 'finished';

export interface SessionEntity {
  courId: number;
  teclId: number;
  beginTime: string;
  endTime: string;
  letiNumber?: number;
  letyName?: string;
  durationSec?: number;
  watchState: WatchState;
  firstWatchedAt?: number;
  lastPositionSec?: number;
  lastAiAnchor?: number;
  courseName?: string;
  courLabel?: string;
  /** 0–1 */
  watchRatio?: number;
  updatedAt?: number;
}

export interface TranscriptSegment {
  s: number;
  e: number;
  text: string;
  /**
   * 时间戳塌陷后按推理切片整体对齐的粗粒度段落。
   * 时间可信度低于常规段落，但比把整段文本挂到随机几秒上更诚实。
   */
  coarse?: boolean;
}

export interface TranscriptCoverageRange {
  start: number;
  end: number;
}

export interface TranscriptEntity {
  courId: number;
  segments: TranscriptSegment[];
  model: string;
  lang: string;
  glossaryVersion: number;
  createdAt: number;
  updatedAt?: number;
  source: 'local-asr' | 'cloud-asr';
  /** 已覆盖音频秒数（区间并集） */
  coveredSec?: number;
  /** 已实际处理过的音频区间（与“有文字的区间”不同：静音区间也算已处理） */
  coverage?: TranscriptCoverageRange[];
  durationSec?: number;
  partial?: boolean;
  /** 当前片段范围（片段流式模式） */
  window?: { start: number; end: number };
  /** 生成该转写的管线版本；缺失表示旧版本产物 */
  pipelineVersion?: number;
  threadId?: number;
}

export interface AsrChunkEntity {
  /** `${courId}:${viewNum}:${chunkIndex}` */
  key: string;
  courId: number;
  viewNum: number;
  chunkIndex: number;
  startSec: number;
  endSec: number;
  segments: TranscriptSegment[];
  createdAt: number;
  /** 生成该分片的管线版本；旧版本分片不再参与组装 */
  pipelineVersion?: number;
  /** 生成该分片的引擎；缺失视为 local，换引擎后旧分片不再复用 */
  engine?: 'local' | 'cloud';
}

/** 一轮转写的质量统计（用于判断“没识别到语音”还是“时间戳不可靠”） */
export interface AsrQualityStats {
  /** 实际送入推理的音频秒数（不含续跑跳过的分片） */
  audioSec: number;
  /** 其中检测到非静音的音频秒数 */
  speechSec: number;
  /** 被静音检测跳过的音频秒数 */
  silentSec: number;
  /** 被幻觉/纯标点过滤掉的段数 */
  droppedSegments: number;
  /** 保留段落的有效字符数 */
  textLength: number;
  /** 时间戳塌陷、按整片对齐的切片数 */
  coarseSlices: number;
  segmentCount: number;
}

export type AsrJobStatus =
  | 'queued'
  | 'extracting'
  | 'transcribing'
  | 'paused'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface AsrJobEntity {
  /** 主键：courId */
  courId: number;
  status: AsrJobStatus;
  viewNum: number;
  model: string;
  durationSec: number;
  /** 0–1 */
  progress: number;
  doneChunks: number;
  totalChunks: number;
  etaSec?: number;
  /** 音频秒 / 真实秒 */
  rate?: number;
  error?: string;
  errorKind?: 'network' | 'decode' | 'model' | 'memory' | 'unknown';
  window?: { start: number; end: number };
  /** 自动跟进作业（静默） */
  auto?: boolean;
  /** 作业使用的识别引擎（缺失视为 local，与分片缓存的引擎隔离口径一致） */
  engine?: 'local' | 'cloud';
  /** 完成后的质量提示（例如“几乎没有识别到有效语音”） */
  warning?: string;
  createdAt: number;
  updatedAt: number;
}

export type TopicConfidence = 'high' | 'medium' | 'low';

export interface Topic {
  name: string;
  summary: string;
  confidence: TopicConfidence;
  intervals: Array<[number, number]>;
}

export interface OutlineNode {
  level: 1 | 2;
  title: string;
  start: number;
  end: number;
  /** L2 指向 L1 下标 */
  parent?: number;
}

export interface AiResultEntity {
  courId: number;
  promptVersion: number;
  model: string;
  topics: Topic[];
  outline: OutlineNode[];
  createdAt: number;
  warnings?: string[];
}

export type ChatRole = 'user' | 'ai';
export type ChatStatus = 'done' | 'streaming' | 'failed' | 'aborted';

export interface ChatMessageEntity {
  id: string;
  courId: number;
  groupId: string;
  role: ChatRole;
  content: string;
  anchorTime?: number;
  contextActual?: [number, number];
  evidence?: { start: number; end: number };
  status: ChatStatus;
  error?: string;
  insufficient?: boolean;
  createdAt: number;
}

export type FavoriteType = 'time' | 'ai' | 'outline' | 'screenshot' | 'note';

export interface FavoriteEntity {
  id: string;
  type: FavoriteType;
  refId?: string;
  snapshot: { title: string; content: string };
  teclId?: number;
  courId?: number;
  anchorTime?: number;
  folderId?: string | null;
  tags: string[];
  note?: string;
  pinned: boolean;
  favoritedAt: number;
  updatedAt: number;
  deletedAt?: number | null;
}

export interface FolderEntity {
  id: string;
  teclId?: number;
  name: string;
  orderIndex: number;
  archived: boolean;
  createdAt: number;
  deletedAt?: number | null;
}

export interface TagEntity {
  id: string;
  name: string;
  color?: string;
  deletedAt?: number | null;
}

export interface NoteEntity {
  id: string;
  courId: number;
  teclId: number;
  anchorTime: number;
  text: string;
  createdAt: number;
  updatedAt: number;
  convertedFavoriteId?: string;
  deletedAt?: number | null;
}

export interface WatchRecordEntity {
  id?: number;
  courId: number;
  teclId: number;
  /** 'YYYY-MM-DD' 本地自然日 */
  date: string;
  startTs: number;
  endTs: number;
  durationSec: number;
  playMode: 'vod';
  speed: number;
  firstWatch: boolean;
  /** false = 挂机/异常，保留审计但不进报表 */
  valid: boolean;
}

export interface ScreenshotEntity {
  id: string;
  courId: number;
  view: number;
  blob: Blob;
  thumbDataUrl?: string;
  meta: {
    courseName: string;
    courLabel: string;
    anchorTime: number;
    watermark: boolean;
  };
  createdAt: number;
  deletedAt?: number | null;
}

export type ReviewTemplate = 'regular' | 'exam' | 'custom';

export interface ReviewJobEntity {
  id: string;
  favoriteId: string;
  /** 'YYYY-MM-DD' */
  dueDate: string;
  round: number;
  template: ReviewTemplate;
  status: 'pending' | 'done' | 'skipped';
  createdAt: number;
  updatedAt: number;
}

export type TrashKind = 'favorite' | 'folder' | 'note' | 'screenshot' | 'tag';

export interface TrashEntity {
  key: string;
  kind: TrashKind;
  id: string;
  title: string;
  deletedAt: number;
  expiresAt: number;
}

// ───────────────────────── 设置与秘密 ─────────────────────────

export type ContextWindowPreset = 'small' | 'medium' | 'large';

export interface CaptionStyle {
  enabled: boolean;
  fontSize: number;
  color: string;
  background: string;
  bottomOffset: number;
}

export interface ShortcutMap {
  ask: string;
  favorite: string;
  note: string;
  prevTopic: string;
  nextTopic: string;
}

export interface AppSettings {
  modules: Record<'a' | 'b' | 'c' | 'd' | 'incentive', boolean>;
  contextWindow: ContextWindowPreset;
  idleThresholdMin: number;
  finishThreshold: number;
  missDelayHours: number;
  weeklyGoalHours: number;
  review: { template: ReviewTemplate; intervals: Record<ReviewTemplate, number[]>; examDate?: string };
  shortcuts: ShortcutMap;
  theme: 'system' | 'light' | 'dark';
  screenshotWatermark: boolean;
  captionStyle: CaptionStyle;
  asr: {
    /** 识别引擎：本地 Whisper（默认，音频不出设备）或用户自配置的云端 ASR */
    engine: 'local' | 'cloud';
    modelTier: 'fast' | 'standard' | 'high';
    autoWarmup: boolean;
    autoTranscribeOnOpen: boolean;
    lang: 'zh' | 'en' | 'auto';
    windowMode: 'full' | 'around';
    windowMinutes: number;
    streamFollow: boolean;
  };
  llm: {
    temperature: number;
    timeoutConnectMs: number;
    timeoutFirstByteMs: number;
    timeoutTotalMs: number;
    maxRetries: number;
  };
  ui: {
    panelCollapsed: boolean;
    followPlayback: boolean;
    showTimelineMarkers: boolean;
    learningCenter: boolean;
    centerOnPlayPage: boolean;
  };
  debug: { logEnabled: boolean };
}

export type LlmKind = 'anthropic-messages' | 'openai-chat' | 'openai-responses';

export interface LlmProviderConfig {
  id: string;
  label: string;
  kind: LlmKind;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface SecretsStore {
  providers: LlmProviderConfig[];
  activeProviderId: string | null;
  allowLocalEndpoints: boolean;
  modelSource: { remoteHost: string };
  userGlossary: Record<string, string>;
  /** 云端 ASR（OpenAI 兼容 /v1/audio/transcriptions）；Key 只存本机，默认未配置 */
  cloudAsr: { baseUrl: string; apiKey: string; model: string } | null;
}

// ───────────────────────── 统计与报表 ─────────────────────────

export interface DailyStat {
  date: string;
  totalSec: number;
  validSec: number;
  sessionCount: number;
}

export interface CourseStat {
  teclId: number;
  courseName: string;
  totalSec: number;
  sessionCount: number;
  finishedCount: number;
}

export interface SessionStat {
  courId: number;
  teclId: number;
  courseName: string;
  courLabel: string;
  watchedSec: number;
  durationSec: number;
  watchRatio: number;
}

export interface DashboardReport {
  totalSec: number;
  weekSec: number;
  todaySec: number;
  streakDays: number;
  days: DailyStat[];
  weeks: Array<{ weekStart: string; totalSec: number }>;
  courses: CourseStat[];
  sessions: SessionStat[];
  goal: { weeklyTargetSec: number; weekSec: number; hitDaysThisWeek: number };
  generatedAt: number;
}

export interface PlayerState {
  currentTime: number;
  duration: number;
  paused: boolean;
  rate: number;
}

export interface PageContext {
  site: SourceSite;
  route: RouteInfo;
  url: string;
}

export interface PopupOverview {
  session: SessionMeta | null;
  transcript: { exists: boolean; partial: boolean; coveredSec: number } | null;
  ai: { exists: boolean; stale: boolean; topicCount: number } | null;
  job: AsrJobEntity | null;
  watchedSec: number;
  watchRatio: number;
  pageKind: RouteKind | null;
}

// ───────────────────────── 学习中心视图 ─────────────────────────

export interface CourseBundle {
  course: CourseEntity;
  sessions: SessionEntity[];
  sessionCount: number;
  watchedSec: number;
  finishedCount: number;
  transcriptCount: number;
  topicCount: number;
  lastActivityAt?: number;
}

export interface MissingSessionItem {
  session: SessionEntity;
  courseName: string;
  /** 课次结束后经过的小时数 */
  overdueHours: number;
}

export interface ScheduleDay {
  /** 'YYYY-MM-DD' */
  date: string;
  weekday: number;
  items: CurriculumItem[];
}

export interface KnowledgeEntry {
  favorite: FavoriteEntity;
  courseName?: string;
}

export interface AsrModelStatus {
  tier: 'fast' | 'standard' | 'high';
  ready: boolean;
  downloadedBytes?: number;
  totalBytes?: number;
  /** downloading / ready / missing / error */
  state: 'ready' | 'missing' | 'downloading' | 'error';
  error?: string;
}
