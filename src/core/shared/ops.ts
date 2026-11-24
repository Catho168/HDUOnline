/**
 * 数据与编排操作注册表（内容脚本 / 扩展页面 → Service Worker）。
 *
 * 内容脚本无法直接访问扩展源的 IndexedDB，所有数据操作经统一 RPC 发往 SW。
 * 扩展页面与 SW 同源可只读直连仓储层，但写操作同样走本通道，保证软删除/
 * 回收站语义一致。
 */

import type { BiliFavFolder, BiliFavItem } from '../bili/favlist';
import type { WeeklyPlan } from '../plan/weekly';
import type { MediaKey } from './mediaRef';
import type { PeriodKind, PeriodReport } from '../stats/period';
import type { ActivityHeatmapData, DayDetailReport, MonthlyHeatmapData } from '../stats/heatmap';
import type { UnifiedSearchResult } from '../search/unified';
import type {
  AiResultEntity,
  AsrJobEntity,
  BiliOverviewResult,
  ChatGroupInfo,
  ChatMessageEntity,
  CourseBundle,
  CourseEntity,
  CourseStat,
  CurriculumItem,
  DashboardReport,
  ExternalNoteEntity,
  FavoriteEntity,
  FavoriteType,
  FolderEntity,
  NoteEntity,
  NoteInput,
  ReviewJobEntity,
  ReviewTemplate,
  ScreenshotEntity,
  SessionEntity,
  SessionMeta,
  TagEntity,
  TranscriptEntity,
  VideoProgressEntity,
  WatchRecordEntity,
} from './types';

export interface FavoriteFilter {
  teclId?: number;
  courId?: number;
  folderId?: string | null;
  type?: FavoriteType;
  tags?: string[];
  keyword?: string;
  dateFrom?: number;
  dateTo?: number;
  pinnedFirst?: boolean;
  includeDeleted?: boolean;
  limit?: number;
  offset?: number;
}

export interface TranscriptSearchHit {
  mediaKey: MediaKey;
  /** 站内课次 ID（记录体保留字段；B 站记录缺省） */
  courId?: number;
  start: number;
  end: number;
  text: string;
  score: number;
}

export interface MissedItem {
  courId: number;
  teclId: number;
  courseName: string;
  courLabel: string;
  beginTime: number;
  watchedSec: number;
  watchRatio: number;
  excluded: boolean;
}

export interface StorageUsage {
  indexedDbBytes: number;
  opfsBytes: number;
  quotaBytes: number;
  screenshotCount: number;
  transcriptCount: number;
  modelCached: boolean;
}

export interface ExportBuildArgs {
  kind: 'cards' | 'list' | 'outline' | 'backup';
  filter?: FavoriteFilter;
  /** 大纲导出对应的媒体主键（aiResults 主键） */
  mediaKey?: MediaKey;
  includeScreenshots?: boolean;
}

export interface ImportRunArgs {
  jobId: string;
  mode: 'merge' | 'replace';
}

// ───────────────────────── B 站收藏夹导入 ─────────────────────────

/** nav 接口登录态与 wbi key（imgKey/subKey 未登录时也可能返回，供 wbi 签名使用） */
export interface BiliNavInfo {
  isLogin: boolean;
  mid: number | null;
  imgKey: string | null;
  subKey: string | null;
}

export interface BiliFavFoldersResult {
  folders: BiliFavFolder[];
  total: number;
}

export interface BiliFavItemsResult {
  items: BiliFavItem[];
  hasMore: boolean;
  total: number;
}

type DataKind = 'ai' | 'transcript' | 'stats' | 'library' | 'screenshots' | 'models' | 'all';

/** 演示模式状态（第 319 轮）：counts 为演示库各 store 行数；未开启 / 未播种时为 null */
export interface DemoStatusResult {
  enabled: boolean;
  enteredAt: number;
  seededAt: number | null;
  counts: Record<string, number> | null;
}

export interface OpMap {
  // 课程 / 课次
  'course.upsert': { args: { course: CourseEntity }; result: void };
  'course.get': { args: { teclId: number }; result: CourseEntity | null };
  'course.list': { args: Record<string, never>; result: CourseEntity[] };
  'course.bundles': { args: Record<string, never>; result: CourseBundle[] };
  'course.rename': { args: { teclId: number; name: string }; result: void };

  'session.upsert': { args: { session: SessionEntity }; result: void };
  'session.get': { args: { courId: number }; result: SessionEntity | null };
  'session.listByCourse': { args: { teclId: number }; result: SessionEntity[] };
  'session.patch': { args: { courId: number; patch: Partial<SessionEntity> }; result: void };
  'session.saveMeta': { args: { meta: SessionMeta; weekNumber?: number }; result: void };

  // 转写
  'transcript.get': { args: { mediaKey: MediaKey }; result: TranscriptEntity | null };
  'transcript.put': { args: { transcript: TranscriptEntity }; result: void };
  'transcript.clear': { args: { mediaKey: MediaKey }; result: void };
  'transcript.applyGlossary': { args: { mediaKey: MediaKey }; result: TranscriptEntity | null };
  'transcript.search': { args: { query: string; mediaKeys?: MediaKey[]; limit?: number }; result: TranscriptSearchHit[] };
  /**
   * 全库 transcript 主键（仅键不载正文；第 16 轮知识库「字幕已就绪」徽标前缀匹配用）：
   * 多 P 后 `bili:<bvid>:p<N>` 与裸键 `bili:<bvid>` 并存，徽标需按前缀匹配。
   */
  'transcript.keys': { args: Record<string, never>; result: MediaKey[] };

  // 转写作业
  'asr.start': {
    args: {
      mediaKey: MediaKey;
      viewNum?: number;
      modelTier?: 'fast' | 'standard' | 'high';
      force?: boolean;
      durationSec?: number;
      audioUrl?: string;
      teclId?: number;
      aroundSec?: number;
      windowMode?: 'full' | 'around';
      auto?: boolean;
    };
    result: { job: AsrJobEntity };
  };
  'asr.follow': {
    args: {
      mediaKey: MediaKey;
      viewNum?: number;
      aroundSec: number;
      durationSec?: number;
      teclId?: number;
      paused: boolean;
      visible: boolean;
      sessionId?: string;
    };
    result: {
      start: boolean;
      reason:
        | 'start'
        | 'disabled'
        | 'away'
        | 'no-duration'
        | 'busy'
        | 'paused-job'
        | 'no-range'
        | 'covered'
        | 'throttled'
        | 'backoff'
        | 'suppressed';
      window?: { start: number; end: number };
      missingChunks?: number;
      plannedChunks?: number;
    };
  };
  'asr.control': { args: { mediaKey: MediaKey; action: 'pause' | 'resume' | 'cancel' }; result: { job: AsrJobEntity | null } };
  'asr.status': { args: { mediaKey: MediaKey }; result: AsrJobEntity | null };
  'asr.warmup': { args: { modelTier?: 'fast' | 'standard' | 'high' }; result: void };
  'asr.model.status': {
    args: { tier: 'fast' | 'standard' | 'high' };
    result: { cached: boolean; bytes?: number; files?: number; state: 'ready' | 'missing' | 'downloading' | 'error'; error?: string };
  };
  'asr.model.download': { args: { tier: 'fast' | 'standard' | 'high' }; result: { started: boolean } };
  'asr.model.clear': { args: { tier?: 'fast' | 'standard' | 'high' }; result: void };

  // 词表
  'glossary.getUser': { args: Record<string, never>; result: Record<string, string> };
  'glossary.setUser': { args: { dict: Record<string, string> }; result: void };
  'glossary.getCourse': { args: { mediaKey: MediaKey }; result: Record<string, string> };
  'glossary.setCourse': { args: { mediaKey: MediaKey; dict: Record<string, string> }; result: void };

  // AI 标注 / 大纲
  'ai.get': { args: { mediaKey: MediaKey }; result: { result: AiResultEntity | null; stale: boolean } };
  /**
   * 发起 AI 标注生成。windowPreset（第 28 轮，第 27 轮建议 4）：per-request 上下文
   * 窗口档位，声明形态照 qa.ask；缺省回落全局设置（settings.contextWindow）。
   * HDU 侧不传该参数（PlayPanel 无选档 UI）→ 旧行为不变；目前仅 B 站学习助手
   * 面板的「AI 标注」页签携带。消费口径见 background/ai.ts。
   */
  'ai.generate': {
    args: { mediaKey: MediaKey; force?: boolean; windowPreset?: 'small' | 'medium' | 'large' };
    result: { started: boolean; reason?: string };
  };
  'ai.abort': { args: { mediaKey: MediaKey }; result: void };
  'ai.hidden.get': { args: { mediaKey: MediaKey }; result: string[] };
  'ai.hidden.set': { args: { mediaKey: MediaKey; names: string[] }; result: void };
  'ai.clear': { args: { mediaKey: MediaKey }; result: void };
  'ai.testProvider': { args: { providerId?: string }; result: { ok: boolean; text?: string; error?: string } };

  // 时间点问答
  'qa.ask': {
    args: { mediaKey: MediaKey; question: string; anchorTime: number; groupId?: string; windowPreset?: 'small' | 'medium' | 'large' };
    result: { chatId: string; groupId: string; immediate?: boolean };
  };
  'qa.abort': { args: { chatId: string }; result: void };
  'qa.list': { args: { mediaKey: MediaKey; groupId?: string }; result: ChatMessageEntity[] };
  /** 跨 P 全部消息（第 105 轮巡检）：按 bvid 合并全部分 P 的问答消息（时间升序） */
  'qa.listAll': { args: { bvid: string }; result: ChatMessageEntity[] };
  'qa.groups': { args: { mediaKey: MediaKey }; result: ChatGroupInfo[] };
  /** 跨 P 聚合（第 104 轮巡检）：按 bvid 聚合全部分 P 的会话分组（行带 mediaKey/p） */
  'qa.groupsAll': { args: { bvid: string }; result: ChatGroupInfo[] };
  'qa.clear': { args: { mediaKey: MediaKey; groupId?: string }; result: void };

  // 收藏 / 文件夹 / 标签 / 笔记
  'fav.put': { args: { favorite: Omit<FavoriteEntity, 'updatedAt'> }; result: FavoriteEntity };
  'fav.get': { args: { id: string }; result: FavoriteEntity | null };
  'fav.list': { args: { filter?: FavoriteFilter }; result: FavoriteEntity[] };
  'fav.update': { args: { id: string; patch: Partial<FavoriteEntity> }; result: void };
  'fav.softDelete': { args: { ids: string[] }; result: void };
  'fav.restore': { args: { ids: string[] }; result: void };
  'fav.counts': { args: { teclId?: number }; result: Record<string, number> };

  'folder.list': { args: { includeArchived?: boolean }; result: FolderEntity[] };
  'folder.upsert': { args: { folder: FolderEntity }; result: void };
  'folder.ensureDefault': { args: { teclId: number; name: string }; result: FolderEntity };
  'folder.reorder': { args: { ids: string[] }; result: void };
  'folder.merge': { args: { fromId: string; toId: string }; result: void };
  'folder.rename': { args: { id: string; name: string }; result: void };
  'folder.archive': { args: { id: string; archived: boolean }; result: void };
  'folder.softDelete': { args: { id: string }; result: void };

  'tag.list': { args: Record<string, never>; result: TagEntity[] };
  'tag.create': { args: { name: string; color?: string }; result: TagEntity };
  'tag.rename': { args: { id: string; name: string }; result: void };
  'tag.merge': { args: { fromIds: string[]; toId: string }; result: void };
  'tag.softDelete': { args: { id: string }; result: void };

  // 笔记归属二选一：站内按 courId/teclId 过滤，外部媒体（B 站）按 mediaKey 过滤（第 26 轮）。
  // mediaKey 查询返回外部媒体笔记（记录体无 courId），消费方只应使用 id/anchorTime/text
  // 等共有字段；无过滤的列表只含站内笔记（HDU 聚合视图口径）。
  'note.list': { args: { courId?: number; teclId?: number; mediaKey?: MediaKey }; result: NoteEntity[] };
  /** 全库笔记（第 112 轮巡检）：站内 + B 站外部笔记一并返回（知识库笔记汇编导出用） */
  'note.listAll': { args: Record<string, never>; result: Array<NoteEntity | ExternalNoteEntity> };
  'note.put': { args: { note: NoteInput }; result: void };
  'note.update': { args: { id: string; text: string }; result: void };
  'note.softDelete': { args: { id: string }; result: void };
  'note.toFavorite': { args: { id: string; folderId?: string | null }; result: FavoriteEntity };

  // 统一搜索（学习中心顶栏）：字幕 / 收藏 / 笔记 三路一次聚合
  'search.all': { args: { keyword: string }; result: UnifiedSearchResult };

  // 站外视频学习进度（B 站）
  'video.progress.get': { args: { platform: 'bilibili'; videoId: string }; result: VideoProgressEntity | null };
  'video.progress.report': {
    args: { platform: 'bilibili'; videoId: string; positionSec: number; durationSec?: number | null; title?: string };
    result: VideoProgressEntity | null;
  };

  // B 站收藏夹导入（fetch 在 SW 内执行；分页循环由前端逐页调用，后台不做爬取）
  'bili.nav.get': { args: Record<string, never>; result: BiliNavInfo };
  'bili.favlist.folders': { args: { upMid?: number }; result: BiliFavFoldersResult };
  'bili.favlist.items': { args: { mediaId: number; pn: number; ps?: number }; result: BiliFavItemsResult };

  // B 站官方字幕获取（方向变更：无本地 ASR；无字幕作罢——none 不是错误、不落库）；
  // p 为多 P 视频的分 P 序号（从 1 计），落库 mediaKey 按 p 分 P 隔离（第 16 轮）
  'bili.subtitle.fetch': {
    args: { bvid: string; p?: number; force?: boolean };
    result:
      | { status: 'ok'; cached: boolean; segments: number; lan: string; lanDoc: string }
      | { status: 'none' };
  };

  // 统计
  'stats.tick': {
    args: {
      courId: number;
      teclId: number;
      state: { currentTime: number; duration: number; paused: boolean; rate: number };
      visible: boolean;
      focused: boolean;
      interacted: boolean;
    };
    result: void;
  };
  // 站外视频学习时长心跳（B 站等）：与站内 stats.tick 完全独立，绝不混入站内流水
  'stats.external.tick': { args: { bvid: string; title?: string; seconds: number }; result: void };
  'stats.flush': { args: { courId?: number }; result: void };
  'stats.report': { args: { days?: number }; result: DashboardReport };
  'stats.sessionSummary': { args: { courId: number }; result: { watchedSec: number; watchRatio: number; lastPositionSec: number | null } };
  'stats.courseSummary': { args: { teclId: number }; result: CourseStat | null };
  'stats.records': { args: { fromDay: string; toDay: string }; result: WatchRecordEntity[] };
  // 学习周报 / 月报（周期聚合：站内外时长 + 计划完成度 / 复习保持率；口径见 core/stats/period）
  'stats.period': { args: { kind: PeriodKind; count?: number }; result: PeriodReport };
  // 学习热力图（日级「周列 × 7 行」聚合，第 77 轮巡检；口径见 core/stats/heatmap）：
  // weeks 为含当前周的整数周数（缺省 26，钳制 [4, 52]）
  'stats.heatmap': { args: { weeks?: number }; result: ActivityHeatmapData };
  // 单日学习明细（热力图格子点击弹出，第 79 轮巡检）：站内外流水行 + 合计
  'stats.dayDetail': { args: { date: string }; result: DayDetailReport };
  // 月视图热力图（月列 × 当月天数，第 81 轮巡检；口径同周视图）：months 钳制 [1, 24] 缺省 12
  'stats.heatmapMonthly': { args: { months?: number }; result: MonthlyHeatmapData };
  // B 站视频学习统计总览（TopN / 最近观看 / 连续天数；聚合口径见 core/db/repo/bili）：
  // kind 决定 TopN 的周/月区间（边界与 stats.period 完全一致），recent / streak 为全历史口径
  'stats.bili.overview': { args: { kind: PeriodKind; limit?: number }; result: BiliOverviewResult };
  'stats.clear': { args: Record<string, never>; result: void };

  // 截图
  'shot.capture': {
    args: {
      courId: number;
      teclId: number;
      view: number;
      atSec: number;
      url: string;
      meta: ScreenshotEntity['meta'];
      watermark: boolean;
    };
    result: { id: string; width: number; height: number };
  };
  'shot.list': { args: { courId?: number }; result: Array<Omit<ScreenshotEntity, 'blob'>> };
  'shot.softDelete': { args: { ids: string[] }; result: void };
  'shot.restore': { args: { ids: string[] }; result: void };

  // 复习计划
  'review.plan': { args: { favoriteId: string; template?: ReviewTemplate; startDate?: string }; result: ReviewJobEntity[] };
  'review.cancel': { args: { favoriteId: string }; result: void };
  'review.due': { args: { date?: string }; result: Array<ReviewJobEntity & { favorite: FavoriteEntity | null }> };
  'review.complete': { args: { jobId: string; status: 'done' | 'skipped' }; result: void };
  /** 撤销完成/跳过（第 116 轮巡检）：done/skipped 作业回到 pending（到期日拉回今天起算） */
  'review.reopen': { args: { jobId: string }; result: void };
  /** 顺延复习作业（第 107 轮巡检）：pending 作业改期到指定日（YYYY-MM-DD） */
  'review.reschedule': { args: { jobId: string; dueDate: string }; result: void };
  'review.stats': { args: Record<string, never>; result: { pending: number; todayDone: number; planned: number } };
  // 全量复习作业（第 83 轮巡检，学习中心「复习计划」视图）：含 favorite 快照（可能 null）
  'review.list': { args: Record<string, never>; result: Array<ReviewJobEntity & { favorite: FavoriteEntity | null }> };

  // 课表 / 补看（D4）
  'schedule.put': { args: { items: CurriculumItem[]; termYear?: string }; result: void };
  'schedule.list': { args: Record<string, never>; result: CurriculumItem[] };
  'schedule.missed': { args: Record<string, never>; result: MissedItem[] };
  'schedule.exclude': { args: { courId: number; excluded: boolean }; result: void };

  // 今日待办（学习中心聚合视图的勾选状态；复用低层 KV，键规则见 core/plan/today）
  'todo.today.get': { args: { date: string }; result: string[] };
  'todo.today.set': { args: { date: string; keys: string[] }; result: void };

  // 每周回看学习计划（B 站批量导入后的按日切片；口径见 core/plan/weekly）
  'plan.weekly.get': { args: Record<string, never>; result: { plans: WeeklyPlan[] } };
  'plan.weekly.create': {
    args: { bvids: string[]; perDay: number; label?: string; startDate?: string };
    /** skippedCount = 因已在活跃计划中被跳过的 bvid 数（这些 bvid 不入新计划） */
    result: { plan: WeeklyPlan; skippedCount: number };
  };
  'plan.weekly.cancel': { args: { planId: string }; result: { ok: true } };

  // 导出 / 导入 / 数据管理
  'export.build': { args: ExportBuildArgs; result: { jobId: string } };
  'import.run': { args: ImportRunArgs; result: { imported: Record<string, number>; skipped: Record<string, number> } };
  /**
   * 全量数据导出（第 250 轮巡检，数据自主权域 / 备份视角）：白名单式用户资产快照
   * JSON——收藏 / 文件夹 / 标签 / 笔记 / 复习作业 / 周计划 / 课程与课次元数据 /
   * B 站续看断点 / 课表 / 偏好设置（不含 AI Key 等秘密；秘密在 chrome.storage.local
   * 的 SecretsStore 从不进入本导出）。**排除** trash、watchRecords / externalWatch
   * 流水明细、transcripts / aiResults / chats / screenshots 等大体积派生物（换机恢复
   * 请用「学习看板 → 数据管理」的全量备份 ZIP）。产物 app 标识与备份不同 → 导入
   * 通道按 app 不匹配直接拒绝（本导出不用于写回）。字段范围见 core/export/dataExport.ts。
   */
  'data.exportAll': {
    args: Record<string, never>;
    result: { filename: string; json: string; counts: Record<string, number>; size: number };
  };
  'storage.usage': { args: Record<string, never>; result: StorageUsage };
  /**
   * 浏览器配额即时查询（第 254 轮巡检，存储健康域 / 透明度视角）：
   * navigator.storage.estimate() 直通 → { usage, quota }；API 缺席 / 抛错返回 null
   * （与 storage.usage 的「缺省 0 值」不同，null 让 UI 能区分「浏览器不提供」并
   * 如实显示「无法获取（浏览器限制）」，而非误读为 0 字节）。SW 内调用不受
   * content script 环境限制（该 API 在 Window / WorkerGlobals 均可用，content 侧
   * 理论可用但配额按源共享，统一走 background 保证口径单点）。
   */
  'storage.estimate': { args: Record<string, never>; result: { usage: number; quota: number } | null };
  'data.clear': { args: { kinds: DataKind[] }; result: void };

  // 回收站
  'trash.list': { args: Record<string, never>; result: Array<{ key: string; kind: string; id: string; deletedAt: number; expiresAt: number; title: string }> };
  'trash.restore': { args: { keys: string[] }; result: void };
  /** 回收站续期（第 233 轮巡检）：把条目的自动清理时间重置为 now + days 天（默认 30） */
  'trash.extend': { args: { key: string; days?: number }; result: void };
  'trash.purge': { args: { keys?: string[] }; result: number };

  // 低层 KV
  'kv.get': { args: { key: string }; result: unknown };
  'kv.set': { args: { key: string; value: unknown }; result: void };
  'kv.del': { args: { key: string }; result: void };

  // 演示模式（第 319 轮）：并行库 hdu-assistant-demo，真实库零接触；实现见 core/demo/seed.ts
  'demo.enter': { args: Record<string, never>; result: DemoStatusResult };
  'demo.exit': { args: Record<string, never>; result: DemoStatusResult };
  'demo.reset': { args: Record<string, never>; result: DemoStatusResult };
  'demo.status': { args: Record<string, never>; result: DemoStatusResult };

  // 通知
  'notify.show': { args: { title: string; message: string; silent?: boolean }; result: void };
}

export type OpName = keyof OpMap;
export type OpArgs<N extends OpName> = OpMap[N]['args'];
export type OpResult<N extends OpName> = OpMap[N]['result'];
