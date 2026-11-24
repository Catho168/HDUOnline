/**
 * IndexedDB 表结构（v5 schema；v1 定义见 MIGRATIONS[0]）。
 *
 * 与《技术实现文档》§4.2 的两处差异（见《实现差异说明》）：
 *  1) 新增 `asrJobs` / `asrChunks`：支撑 §5.3 的"作业级进度 + 断点续跑 + 增量落库"；
 *  2) 新增 `kv` / `exportJobs` / `curriculum`：分别承载轻量 UI 状态（隐藏的知识点、
 *     面板状态）、导出作业（大对象不进消息通道，§2.2）、课表快照（D4）。
 *
 * v5（B 站转写专项 §3）：transcripts / aiResults / asrJobs 主键 courId → mediaKey，
 * chats 增 mediaKey 索引；sessions / stats / library 等站内 store 全部不变。
 */

import type { DBSchema } from 'idb';
import type { WeeklyPlan } from '../plan/weekly';
import type { MediaKey } from '../shared/mediaRef';
import type {
  AiResultEntity,
  AsrChunkEntity,
  AsrJobEntity,
  ChatMessageEntity,
  CourseEntity,
  CurriculumItem,
  ExternalWatchEntity,
  FavoriteEntity,
  FolderEntity,
  NoteEntity,
  ReviewJobEntity,
  ScreenshotEntity,
  SessionEntity,
  TagEntity,
  TranscriptEntity,
  TrashEntity,
  VideoProgressEntity,
  WatchRecordEntity,
} from '../shared/types';

export interface KvRecord {
  key: string;
  value: unknown;
  updatedAt: number;
}

export interface ExportJobRecord {
  id: string;
  kind: 'cards' | 'list' | 'outline' | 'backup' | 'import';
  filename: string;
  mime: string;
  /** 文件内容（JSON 文本或 ZIP 的 Uint8Array） */
  data: string | Uint8Array;
  size: number;
  createdAt: number;
  /** 过期自动清理（毫秒时间戳） */
  expiresAt: number;
}

export interface CurriculumRecord extends CurriculumItem {
  termYear?: string;
  updatedAt: number;
}

export interface HduAssistantDB extends DBSchema {
  courses: {
    key: number;
    value: CourseEntity;
    indexes: { updatedAt: number };
  };
  sessions: {
    key: number;
    value: SessionEntity;
    indexes: { teclId: number; beginTime: string; watchState: string };
  };
  transcripts: {
    key: MediaKey;
    value: TranscriptEntity;
    indexes: { createdAt: number };
  };
  aiResults: {
    key: MediaKey;
    value: AiResultEntity;
    indexes: { createdAt: number };
  };
  chats: {
    key: string;
    value: ChatMessageEntity;
    indexes: { courId: number; mediaKey: MediaKey; groupId: string; createdAt: number };
  };
  favorites: {
    key: string;
    value: FavoriteEntity;
    indexes: {
      courId: number;
      teclId: number;
      folderId: string;
      tags: string;
      favoritedAt: number;
      type: string;
    };
  };
  folders: {
    key: string;
    value: FolderEntity;
    indexes: { teclId: number; orderIndex: number };
  };
  tags: {
    key: string;
    value: TagEntity;
    indexes: { name: string };
  };
  notes: {
    key: string;
    value: NoteEntity;
    indexes: { courId: number; teclId: number; anchorTime: number };
  };
  watchRecords: {
    key: number;
    value: WatchRecordEntity;
    indexes: { date: string; courId: number; daySession: [string, number] };
  };
  screenshots: {
    key: string;
    value: ScreenshotEntity;
    indexes: { courId: number; createdAt: number };
  };
  reviewJobs: {
    key: string;
    value: ReviewJobEntity;
    indexes: { favoriteId: string; dueDate: string; status: string };
  };
  asrJobs: {
    key: MediaKey;
    value: AsrJobEntity;
    indexes: { status: string; updatedAt: number };
  };
  asrChunks: {
    key: string;
    value: AsrChunkEntity;
    indexes: { courId: number };
  };
  kv: {
    key: string;
    value: KvRecord;
  };
  trash: {
    key: string;
    value: TrashEntity;
    indexes: { deletedAt: number; kind: string };
  };
  exportJobs: {
    key: string;
    value: ExportJobRecord;
    indexes: { createdAt: number };
  };
  curriculum: {
    key: number;
    value: CurriculumRecord;
    indexes: { beginTime: number; teclId: number };
  };
  videoProgress: {
    key: string;
    value: VideoProgressEntity;
    indexes: { updatedAt: number };
  };
  externalWatch: {
    key: string;
    value: ExternalWatchEntity;
    indexes: { date: string };
  };
  /** 每周回看学习计划（DB v4 新增；用户资产，进全量备份） */
  weeklyPlans: {
    key: string;
    value: WeeklyPlan;
  };
}
