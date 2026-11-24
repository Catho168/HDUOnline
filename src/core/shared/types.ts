/**
 * 全局领域类型。
 *
 * 与《技术实现文档》§4.2 对齐；为满足片段流式转写与学习中心，额外增加
 * `asrChunks` / `asrJobs` / 视图型数据结构。站点实体的主键统一为
 * `teclId`（教学班）+ `courId`（课次，URL 中的 courseId）。
 */

import type { MediaKey } from './mediaRef';

// ───────────────────────── 站点身份与路由 ─────────────────────────

export type SourceSite = 'campus' | 'webvpn';

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
  /**
   * 媒体主键（DB v5 起为主键）：站内 `hdu:<courId>`，B 站 `bili:<bvid>`。
   * HDU 记录同时保留 `courId` 字段（备份双向兼容）。
   */
  mediaKey: MediaKey;
  /** 站内课次 ID；仅 HDU 记录非空（B 站记录缺省） */
  courId?: number;
  segments: TranscriptSegment[];
  model: string;
  lang: string;
  glossaryVersion: number;
  createdAt: number;
  updatedAt?: number;
  /**
   * 产物来源：local-asr = 本地 Whisper 转写；bili-official-subtitle = B 站官方字幕
   * （第 14 轮方向变更：B 站不做本地 ASR，直接拉官方字幕落库，无字幕作罢）。
   */
  source: 'local-asr' | 'bili-official-subtitle';
  /** 已覆盖音频秒数（区间并集） */
  coveredSec?: number;
  /** 已实际处理过的音频区间（与“有文字的区间”不同：静音区间也算已处理） */
  coverage?: TranscriptCoverageRange[];
  durationSec?: number;
  /**
   * 是否 AI 生成字幕（B 站官方字幕轨的 ai_type 口径，bili.subtitle.fetch 落库时写入；
   * 第 16 轮可选字段：旧数据/本地 ASR 记录缺省，对备份与既有数据零影响）。
   */
  aiSubtitle?: boolean;
  partial?: boolean;
  /** 当前片段范围（片段流式模式） */
  window?: { start: number; end: number };
  /** 生成该转写的管线版本；缺失表示旧版本产物 */
  pipelineVersion?: number;
  threadId?: number;
}

export interface AsrChunkEntity {
  /** `${mediaKey}:${viewNum}:${chunkIndex}`（DB v5 起为 mediaKey 前缀） */
  key: string;
  /** 分片所属媒体主键（与 key 前缀一致） */
  mediaKey: MediaKey;
  /** 站内课次 ID；仅 HDU 记录非空（B 站记录缺省） */
  courId?: number;
  viewNum: number;
  chunkIndex: number;
  startSec: number;
  endSec: number;
  segments: TranscriptSegment[];
  createdAt: number;
  /** 生成该分片的管线版本；旧版本分片不再参与组装 */
  pipelineVersion?: number;
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
  /** 主键：mediaKey（DB v5 起；HDU 记录同时保留 courId 字段） */
  mediaKey: MediaKey;
  /** 站内课次 ID；仅 HDU 记录非空（B 站记录缺省） */
  courId?: number;
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
  /** 媒体主键（DB v5 起为主键；HDU 记录同时保留 courId 字段） */
  mediaKey: MediaKey;
  /** 站内课次 ID；仅 HDU 记录非空（B 站记录缺省） */
  courId?: number;
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
  /** 所属媒体主键（DB v5 起建索引；HDU 记录同时保留 courId 字段） */
  mediaKey: MediaKey;
  /** 站内课次 ID；仅 HDU 记录非空（B 站记录缺省） */
  courId?: number;
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

export type FavoriteType = 'time' | 'ai' | 'outline' | 'screenshot' | 'note' | 'video';

/** 问答历史分组（qa.groups / qa.groupsAll 行；groupsAll 附带 mediaKey/p 供跨 P 预览与删除定位） */
export interface ChatGroupInfo {
  groupId: string;
  title: string;
  lastAt: number;
  count: number;
  /** 仅 qa.groupsAll 返回：该组所属媒体键（跨 P 聚合时可能是其他分 P 的键） */
  mediaKey?: MediaKey;
  /** 仅 qa.groupsAll 返回：分 P 序号（P1 缺省 1） */
  p?: number;
}

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
  metadata?: Record<string, unknown>;
}

/** 站外视频学习进度（如 B 站网课），主键 `${platform}:${videoId}` */
export interface VideoProgressEntity {
  id: string;
  platform: 'bilibili';
  videoId: string;
  title?: string;
  durationSec: number | null;
  lastPositionSec: number;
  updatedAt: number;
}

/**
 * 站外视频学习时长流水（externalWatch，独立于站内 watchRecords 的统计通道）。
 * 主键 `${date}:${bvid}`：同一天同一视频只保留一条累计记录，seconds 随上报累加。
 */
export interface ExternalWatchEntity {
  id: string;
  /** 'YYYY-MM-DD' 本地自然日 */
  date: string;
  /** 站外视频标识（如 B 站 bvid） */
  bvid: string;
  title?: string;
  /** 该日累计有效观看秒数 */
  seconds: number;
}

// ───────────────────────── B 站视频学习统计（stats.bili.overview） ─────────────────────────

/**
 * B 站视频统计：TopN 聚合行（externalWatch 按区间 × bvid 聚合）。
 * 标题降级口径（repo/bili）：videoProgress.title → 收藏 snapshot.title →
 * externalWatch 上报标题 → 「B 站视频 <bvid>」（与第 22 轮标题回查一致）。
 */
export interface BiliTopWatchedRow {
  bvid: string;
  /** 展示标题（降级口径见上） */
  title: string;
  /** 区间内累计有效观看秒数 */
  totalSec: number;
  /** 占区间总秒数比例（0..1；区间总量为 0 时为 0） */
  share: number;
}

/**
 * B 站视频统计：最近观看行（全历史口径，不随周/月区间变化）。
 * externalWatch 按日累计、无时刻精度，故「最后观看时间」只到自然日。
 */
export interface BiliRecentWatchedRow {
  bvid: string;
  /** 展示标题（降级口径见 BiliTopWatchedRow） */
  title: string;
  /** 全历史累计有效观看秒数 */
  totalSec: number;
  /** 最近观看日 'YYYY-MM-DD' */
  lastDay: string;
  /** 最近观看时间（该日本地 00:00 毫秒；排序/展示用） */
  lastWatchedAt: number;
  /** 最后观看位置秒（videoProgress，读不到为 0） */
  lastPositionSec: number;
  /** 视频总时长秒（videoProgress，未上报过时长为 null） */
  durationSec: number | null;
  /** 站外跳转链接（收藏 metadata.url 经白名单校验后优先，否则按 bvid 还原官方链接） */
  url: string;
}

/** stats.bili.overview 返回：TopN + 最近观看 + 连续天数 */
export interface BiliOverviewResult {
  /** TopN 聚合区间（当前周/月，边界口径与 stats.period 完全一致） */
  range: { kind: 'week' | 'month'; startDay: string; endDay: string };
  /** 区间内 TopN（按累计秒数降序；并列按 bvid 字典序稳定输出） */
  top: BiliTopWatchedRow[];
  /** 最近观看（按最后观看日降序，其次累计秒数） */
  recent: BiliRecentWatchedRow[];
  /** 连续学习天数（externalWatch 有记录的自然日；今日缺失不立即断链，从昨天回溯） */
  streakDays: number;
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

/**
 * 外部媒体（B 站）时间点笔记（第 26 轮）：不依赖站内课次，仅按 mediaKey 归属。
 * 与 NoteEntity 共用 notes store（零迁移：mediaKey 只是记录体上的可选字段，不建索引、
 * 不升 DB 版本）；HDU 侧聚合视图（note.list 无过滤）只消费站内笔记，互不可见。
 */
export interface ExternalNoteEntity {
  id: string;
  /** 外部媒体主键：`bili:<bvid>`（P1 裸键）或 `bili:<bvid>:p<N>`（分 P 键） */
  mediaKey: MediaKey;
  anchorTime: number;
  text: string;
  createdAt: number;
  updatedAt: number;
  convertedFavoriteId?: string;
  deletedAt?: number | null;
}

/** note.put 入参：站内笔记（courId+teclId）与外部媒体笔记（mediaKey）二选一 */
export type NoteInput = NoteEntity | ExternalNoteEntity;

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
  /** 改期留痕（第 111 轮巡检；零迁移可选字段，store 不建索引） */
  rescheduleLog?: Array<{ from: string; to: string; at: number }>;
  convertedFavoriteId?: string;
  deletedAt?: number | null;
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

/** 复习计划视图的筛选/排序偏好（第 104 轮巡检：随 settings 持久化，跨打开保留） */
export interface ReviewFilterPrefs {
  type: 'all' | FavoriteType;
  template: 'all' | ReviewTemplate;
  urgency: 'all' | 'today' | 'overdue' | 'future';
  sort: 'due' | 'type';
  /** 课程筛选（第 317 轮巡检）：按收藏所属课程（courId）过滤；缺省/undefined = 全部课程 */
  courseCourId?: number;
  /** 待完成区形态（第 106/111 轮巡检）：list = 行列表；week = 周视图；month = 月视图 */
  viewMode: 'list' | 'week' | 'month';
  /** 周视图窗口档（第 108/110 轮巡检）：7 天 / 14 天 / 30 天（月历式 7 列栅格） */
  viewRange: 7 | 14 | 30;
}

export interface AppSettings {
  modules: Record<'a' | 'b' | 'c' | 'd' | 'incentive', boolean>;
  contextWindow: ContextWindowPreset;
  idleThresholdMin: number;
  finishThreshold: number;
  missDelayHours: number;
  weeklyGoalHours: number;
  /** 每日目标分钟数（第 234 轮巡检：总览「今日目标」Ring 与 dashboard 指标卡的进度分母；
   *  仅展示与激励层，不改打卡判定线；合法域 5..600，非法回退 30，见 core/plan/dailyGoal） */
  dailyGoalMin: number;
  /** 成就目标倍率（第 133 轮巡检：1=标准，1.5=进取，2=挑战；徽章阈值 = 基准 × 倍率） */
  achievementGoalScale?: number;
  review: { template: ReviewTemplate; intervals: Record<ReviewTemplate, number[]>; examDate?: string };
  /** 每日待办提醒（每天固定时刻检查今日待办并发系统通知；时刻可配，见 dailyNotifyHour） */
  todo: {
    dailyNotify: boolean;
    weeklyRecap: boolean;
    notifyCoverage?: boolean;
    notifyStaleTags?: boolean;
    dailyNotifyHour?: number;
    /** 明日到期提醒（第 243 轮巡检）：默认关——主动提醒默认不打扰，用户显式开启才发 */
    dueTomorrowNotify?: boolean;
  };
  shortcuts: ShortcutMap;
  theme: 'system' | 'light' | 'dark';
  screenshotWatermark: boolean;
  captionStyle: CaptionStyle;
  asr: {
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
    /** 播放页顶栏 chip 注入（.play-header 末尾 append 受控节点；关闭或锚点缺失时回退浮窗胶囊） */
    nativeAnchor: boolean;
    /** 复习计划视图的筛选/排序（第 104 轮巡检：跨打开保留） */
    reviewFilters: ReviewFilterPrefs;
    /** B 站知识库排序（第 116 轮巡检：跨打开保留） */
    hubSortKey?: 'default' | 'title' | 'review';
    /** 复习计划月视图上次浏览的月份（第 117 轮巡检：'YYYY-MM'，跨打开保留） */
    reviewMonth?: string;
    /** 复习计划筛选快照（第 125 轮巡检：命名筛选组合，一键套用；最多保留 6 个） */
    reviewSnapshots?: Array<{ name: string; filters: ReviewFilterPrefs }>;
    /** 最近套用的筛选快照名（第 128 轮巡检：快照快捷回溯标注） */
    reviewSnapshotsLast?: string;
    /** 连续学习历史最佳纪录（第 128 轮巡检：破纪录祝贺用，跨会话累计） */
    streakBestSeen?: number;
    /** 成就首次解锁时间（第 135 轮巡检：徽章 id → 首次解锁时间戳，时间线用） */
    achievementUnlockedAt?: Record<string, number>;
    /** 标签统计趋势窗口（第 136 轮巡检：4/8/12 周，跨打开保留） */
    tagTrendWeeks?: number;
    /** 自定义成就徽章（第 139 轮巡检：名称 + 维度 + 阈值，随目标倍率缩放；第 142 轮起可选图标） */
    customAchievements?: Array<{ id: string; name: string; metric: string; threshold: number; icon?: string }>;
    /** 标签统计排序（第 139 轮巡检：favorites/reviewing/doneRate，跨打开保留） */
    tagStatsSort?: string;
    /** 标签覆盖率目标（第 152 轮巡检：0/缺省=不设目标，0.6/0.8/1 档位；未达标时面板强调 + 每日通知提示） */
    tagCoverageGoal?: number;
    /** 标签覆盖率首次达标时间戳（第 153 轮巡检：达标祝贺只弹一次的登记） */
    tagCoverageCelebratedAt?: number;
    /** 标签健康度统计窗口天数（第 159 轮巡检：7/14/28/56 档，默认 28；用于每日/每周通知的健康度口径） */
    staleWindowDays?: number;
    /** 统计窗口说明卡展开状态（第 166 轮巡检：默认展开；折叠后仅保留一行标题） */
    windowNoteOpen?: boolean;
    /** 总览「近 7 天学习节奏」柱图展开状态（第 244 轮巡检：默认收起，标题行保留摘要
     *  分钟数；统计页「近 30 天」已有同粒度日柱超集，跨打开保留） */
    overviewWeekOpen?: boolean;
    /** 最近搜索关键词（第 246 轮巡检：统一搜索非空提交记录，最新在前去重前移，
     *  最多 5 条；聚焦空输入时回放成 chips 行，跨打开保留） */
    recentQueries?: string[];
    /** 批量还原并复习连续部分失败计数（第 172 轮巡检：≥3 次提示改走单条排查，跨打开累计） */
    batchRetryCount?: number;
    /** 回收站排序（第 177 轮巡检：newest/oldest，跨打开保留） */
    trashSort?: 'newest' | 'oldest';
    /** 回收站类型筛选（第 177 轮巡检：all/favorite/note，跨打开保留） */
    trashKindFilter?: 'all' | 'favorite' | 'note';
    /** 成就区筛选（第 145 轮巡检：all/unlocked/progress，跨打开保留） */
    achievementFilter?: string;
    /** 成就区排序（第 145 轮巡检：default/progress/name，跨打开保留） */
    achievementSort?: string;
    /** 热力图周视图窗口（第 141 轮巡检：'13'/'26'/'52'，跨打开保留） */
    heatmapWeekOption?: string;
    /** 热力图月视图窗口（第 141 轮巡检：'6'/'12'/'24'，跨打开保留） */
    heatmapMonthOption?: string;
  };
  debug: { logEnabled: boolean };
  /** 演示模式（第 319 轮）：开启后全部读写切到并行演示库，真实库零接触；缺省 = 未开启 */
  demo?: { enabled: boolean; enteredAt?: number };
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
}

// ───────────────────────── 统计与报表 ─────────────────────────

export interface DailyStat {
  date: string;
  totalSec: number;
  validSec: number;
  sessionCount: number;
  /** 当日站外视频学习秒数（externalWatch，独立口径，不并入 validSec） */
  externalSeconds: number;
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
  /** 报表窗口内站外视频学习秒数合计（externalWatch，独立口径） */
  externalSeconds: number;
  /** 站外视频学习秒数累计（第 252 轮徽章口径核对新增：与 totalSec 同为流水取数
   *  窗口内累计，不受报表展示窗口限制）——供 external-10「双线学习」徽章与站内
   *  累计徽章（min-30 等）同一「累计」口径；缺省（旧快照）时消费方回退 externalSeconds */
  externalTotalSec?: number;
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
