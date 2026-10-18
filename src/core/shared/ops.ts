/**
 * 数据与编排操作注册表（内容脚本 / 扩展页面 → Service Worker）。
 *
 * 内容脚本无法直接访问扩展源的 IndexedDB，所有数据操作经统一 RPC 发往 SW。
 * 扩展页面与 SW 同源可只读直连仓储层，但写操作同样走本通道，保证软删除/
 * 回收站语义一致。
 */

import type {
  AiResultEntity,
  AsrJobEntity,
  ChatMessageEntity,
  CourseBundle,
  CourseEntity,
  CourseStat,
  CurriculumItem,
  DashboardReport,
  FavoriteEntity,
  FavoriteType,
  FolderEntity,
  NoteEntity,
  ReviewJobEntity,
  ReviewTemplate,
  ScreenshotEntity,
  SessionEntity,
  SessionMeta,
  TagEntity,
  TranscriptEntity,
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
  courId: number;
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
  courId?: number;
  includeScreenshots?: boolean;
}

export interface ImportRunArgs {
  jobId: string;
  mode: 'merge' | 'replace';
}

type DataKind = 'ai' | 'transcript' | 'stats' | 'library' | 'screenshots' | 'models' | 'all';

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
  'transcript.get': { args: { courId: number }; result: TranscriptEntity | null };
  'transcript.put': { args: { transcript: TranscriptEntity }; result: void };
  'transcript.clear': { args: { courId: number }; result: void };
  'transcript.applyGlossary': { args: { courId: number }; result: TranscriptEntity | null };
  'transcript.search': { args: { query: string; courIds?: number[]; limit?: number }; result: TranscriptSearchHit[] };

  // 转写作业
  'asr.start': {
    args: {
      courId: number;
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
      courId: number;
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
  'asr.control': { args: { courId: number; action: 'pause' | 'resume' | 'cancel' }; result: { job: AsrJobEntity | null } };
  'asr.status': { args: { courId: number }; result: AsrJobEntity | null };
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
  'glossary.getCourse': { args: { courId: number }; result: Record<string, string> };
  'glossary.setCourse': { args: { courId: number; dict: Record<string, string> }; result: void };

  // AI 标注 / 大纲
  'ai.get': { args: { courId: number }; result: { result: AiResultEntity | null; stale: boolean } };
  'ai.generate': { args: { courId: number; force?: boolean }; result: { started: boolean; reason?: string } };
  'ai.abort': { args: { courId: number }; result: void };
  'ai.hidden.get': { args: { courId: number }; result: string[] };
  'ai.hidden.set': { args: { courId: number; names: string[] }; result: void };
  'ai.clear': { args: { courId: number }; result: void };
  'ai.testProvider': { args: { providerId?: string }; result: { ok: boolean; text?: string; error?: string } };

  // 时间点问答
  'qa.ask': {
    args: { courId: number; question: string; anchorTime: number; groupId?: string; windowPreset?: 'small' | 'medium' | 'large' };
    result: { chatId: string; groupId: string; immediate?: boolean };
  };
  'qa.abort': { args: { chatId: string }; result: void };
  'qa.list': { args: { courId: number; groupId?: string }; result: ChatMessageEntity[] };
  'qa.groups': { args: { courId: number }; result: Array<{ groupId: string; title: string; lastAt: number; count: number }> };
  'qa.clear': { args: { courId: number; groupId?: string }; result: void };

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

  'note.list': { args: { courId?: number; teclId?: number }; result: NoteEntity[] };
  'note.put': { args: { note: NoteEntity }; result: void };
  'note.update': { args: { id: string; text: string }; result: void };
  'note.softDelete': { args: { id: string }; result: void };
  'note.toFavorite': { args: { id: string; folderId?: string | null }; result: FavoriteEntity };

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
  'stats.flush': { args: { courId?: number }; result: void };
  'stats.report': { args: { days?: number }; result: DashboardReport };
  'stats.sessionSummary': { args: { courId: number }; result: { watchedSec: number; watchRatio: number; lastPositionSec: number | null } };
  'stats.courseSummary': { args: { teclId: number }; result: CourseStat | null };
  'stats.records': { args: { fromDay: string; toDay: string }; result: WatchRecordEntity[] };
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
  'review.stats': { args: Record<string, never>; result: { pending: number; todayDone: number; planned: number } };

  // 课表 / 补看（D4）
  'schedule.put': { args: { items: CurriculumItem[]; termYear?: string }; result: void };
  'schedule.list': { args: Record<string, never>; result: CurriculumItem[] };
  'schedule.missed': { args: Record<string, never>; result: MissedItem[] };
  'schedule.exclude': { args: { courId: number; excluded: boolean }; result: void };

  // 导出 / 导入 / 数据管理
  'export.build': { args: ExportBuildArgs; result: { jobId: string } };
  'import.run': { args: ImportRunArgs; result: { imported: Record<string, number> } };
  'storage.usage': { args: Record<string, never>; result: StorageUsage };
  'data.clear': { args: { kinds: DataKind[] }; result: void };

  // 回收站
  'trash.list': { args: Record<string, never>; result: Array<{ key: string; kind: string; id: string; deletedAt: number; expiresAt: number; title: string }> };
  'trash.restore': { args: { keys: string[] }; result: void };
  'trash.purge': { args: { keys?: string[] }; result: number };

  // 低层 KV
  'kv.get': { args: { key: string }; result: unknown };
  'kv.set': { args: { key: string; value: unknown }; result: void };
  'kv.del': { args: { key: string }; result: void };

  // 通知
  'notify.show': { args: { title: string; message: string; silent?: boolean }; result: void };
}

export type OpName = keyof OpMap;
export type OpArgs<N extends OpName> = OpMap[N]['args'];
export type OpResult<N extends OpName> = OpMap[N]['result'];
