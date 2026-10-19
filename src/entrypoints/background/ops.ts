/**
 * 操作分发表（Op 注册表 → 具体实现）。
 *
 * 约定：
 *  - 数据类操作直接调用仓储层（SW 是唯一写入入口）；
 *  - 编排类操作（asr / ai / qa / export / import）委托给对应模块；
 *  - 返回值必须是可结构化克隆的「小对象」（大对象走 IndexedDB，只回传 key）。
 */

import { AppError, toAppError } from '@/core/shared/errors';
import { createLogger } from '@/core/shared/logger';
import type { MissedItem, OpArgs, OpName, OpResult, StorageUsage } from '@/core/shared/ops';
import { notifications, runtime } from '@/core/shared/runtime';
import { getActiveProvider, loadSecrets, loadSettings } from '@/core/shared/settings';
import { estimateStorage } from '@/core/shared/storage';
import { clamp, localDayKey, startOfLocalDay } from '@/core/shared/utils';
import { loadCourseGlossary, loadUserGlossary, saveCourseGlossary, saveUserGlossary } from '@/core/asr/glossary';
import { checkTierCached, clearTierCache, listModelFiles } from '@/core/asr/modelCache';
import { testCloudAsr } from '@/core/asr/cloud';
import { testProvider } from '@/core/llm/runner';
import {
  applyGlossary,
  clearAiResult,
  clearChats,
  clearTranscript,
  getCourse,
  getSession,
  getTranscript,
  listChatGroups,
  listChats,
  listCourses,
  listSessionsByCourse,
  patchSession,
  putTranscript,
  renameCourse,
  saveSessionMeta,
  searchTranscripts,
  upsertCourse,
  upsertSession,
} from '@/core/db/repo/content';
import {
  archiveFolder,
  cancelReview,
  completeReview,
  createTag,
  dueReviews,
  ensureDefaultFolder,
  favoriteCounts,
  getFavorite,
  listFavorites,
  listFolders,
  listNotes,
  listScreenshots,
  listTags,
  mergeFolders,
  mergeTags,
  noteToFavorite,
  planReview,
  putFavorite,
  putNote,
  renameFolder,
  renameTag,
  reorderFolders,
  restoreFavorites,
  restoreScreenshots,
  reviewStats,
  softDeleteFavorites,
  softDeleteFolder,
  softDeleteNote,
  softDeleteScreenshots,
  softDeleteTag,
  updateFavorite,
  updateNote,
  upsertFolder,
} from '@/core/db/repo/library';
import { getAsrJob } from '@/core/db/repo/asr';
import {
  KV_KEYS,
  kvDelete,
  kvGet,
  kvSet,
  listCurriculum,
  listMissedExcluded,
  putCurriculum,
  setMissedExcluded,
} from '@/core/db/repo/misc';
import { clearWatchRecords, listWatchRecords } from '@/core/db/repo/stats';
import { emptyTrash, listTrash, purgeExpiredTrash, purgeTrashEntries, removeFromTrash } from '@/core/db/repo/trash';
import { exportBackup, exportCardsMarkdown, exportListCsv, exportOutlineMarkdown } from '@/core/export/exporters';
import { runImport } from '@/core/export/importer';
import { buildCourseBundles, buildReport } from '@/core/stats/aggregate';
import { startTranscription, controlTranscription, planFollow, warmup, downloadModel, modelStatus, invalidateModelState } from './asr';
import { abortGeneration, generateTopics, loadAiResult } from './ai';
import { abortAsk, ask } from './qa';
import { captureFrame } from './screenshot';
import { statsService } from './stats';

const log = createLogger('sw-ops');

type Handler<N extends OpName> = (args: OpArgs<N>) => Promise<OpResult<N>>;

type HandlerTable = { [N in OpName]: Handler<N> };

export const handlers: HandlerTable = {
  // ── 课程 / 课次 ──
  'course.upsert': async ({ course }) => upsertCourse(course),
  'course.get': async ({ teclId }) => getCourse(teclId),
  'course.list': async () => listCourses(),
  'course.bundles': async () => buildCourseBundles(),
  'course.rename': async ({ teclId, name }) => renameCourse(teclId, name),

  'session.upsert': async ({ session }) => upsertSession(session),
  'session.get': async ({ courId }) => getSession(courId),
  'session.listByCourse': async ({ teclId }) => listSessionsByCourse(teclId),
  'session.patch': async ({ courId, patch }) => patchSession(courId, patch),
  'session.saveMeta': async ({ meta, weekNumber }) => saveSessionMeta(meta, weekNumber),

  // ── 转写 ──
  'transcript.get': async ({ courId }) => getTranscript(courId),
  'transcript.put': async ({ transcript }) => putTranscript(transcript),
  'transcript.clear': async ({ courId }) => clearTranscript(courId),
  'transcript.applyGlossary': async ({ courId }) => applyGlossary(courId),
  'transcript.search': async ({ query, courIds, limit }) => searchTranscripts(query, courIds, limit),

  // ── 转写作业 ──
  'asr.start': async (args) => ({ job: await startTranscription(args) }),
  'asr.follow': async (args) => planFollow(args),
  'asr.control': async ({ courId, action }) => ({ job: await controlTranscription(courId, action) }),
  'asr.status': async ({ courId }) => getAsrJob(courId),
  'asr.warmup': async ({ modelTier }) => warmup(modelTier),
  'asr.model.status': async ({ tier }) => modelStatus(tier),
  'asr.model.download': async ({ tier }) => downloadModel(tier),
  'asr.model.clear': async ({ tier }) => {
    await clearTierCache(tier);
    invalidateModelState(tier);
  },
  'asr.testCloudProvider': async () => {
    const secrets = await loadSecrets();
    if (!secrets.cloudAsr) {
      return { ok: false, error: '尚未配置云端 ASR：请先在设置「转写与模型」中填写服务地址、模型与 API Key' };
    }
    try {
      return await testCloudAsr(
        {
          baseUrl: secrets.cloudAsr.baseUrl,
          apiKey: secrets.cloudAsr.apiKey,
          model: secrets.cloudAsr.model,
        },
        { allowLocalEndpoints: secrets.allowLocalEndpoints },
      );
    } catch (err) {
      return { ok: false, error: toAppError(err).userMessage };
    }
  },

  // ── 词表 ──
  'glossary.getUser': async () => loadUserGlossary(),
  'glossary.setUser': async ({ dict }) => saveUserGlossary(dict),
  'glossary.getCourse': async ({ courId }) => loadCourseGlossary(courId),
  'glossary.setCourse': async ({ courId, dict }) => saveCourseGlossary(courId, dict),

  // ── AI 标注 / 大纲 ──
  'ai.get': async ({ courId }) => loadAiResult(courId),
  'ai.generate': async ({ courId, force }) => generateTopics(courId, force),
  'ai.abort': async ({ courId }) => abortGeneration(courId),
  'ai.hidden.get': async ({ courId }) => (await kvGet<string[]>(KV_KEYS.hiddenTopics(courId))) ?? [],
  'ai.hidden.set': async ({ courId, names }) => kvSet(KV_KEYS.hiddenTopics(courId), names),
  'ai.clear': async ({ courId }) => clearAiResult(courId),
  'ai.testProvider': async ({ providerId }) => {
    const secrets = await loadSecrets();
    const provider = providerId
      ? (secrets.providers.find((item) => item.id === providerId) ?? null)
      : await getActiveProvider();
    if (!provider) {
      return { ok: false, error: new AppError('LLM_NO_PROVIDER').userMessage };
    }
    const settings = await loadSettings();
    try {
      return await testProvider({
        provider: {
          kind: provider.kind,
          baseUrl: provider.baseUrl,
          model: provider.model,
          apiKey: provider.apiKey,
        },
        timeouts: {
          connectMs: settings.llm.timeoutConnectMs,
          firstByteMs: settings.llm.timeoutFirstByteMs,
          totalMs: settings.llm.timeoutTotalMs,
        },
        allowLocalEndpoints: secrets.allowLocalEndpoints,
      });
    } catch (err) {
      return { ok: false, error: toAppError(err).userMessage };
    }
  },

  // ── 问答 ──
  'qa.ask': async (args) => ask(args),
  'qa.abort': async ({ chatId }) => abortAsk(chatId),
  'qa.list': async ({ courId, groupId }) => listChats(courId, groupId),
  'qa.groups': async ({ courId }) => listChatGroups(courId),
  'qa.clear': async ({ courId, groupId }) => clearChats(courId, groupId),

  // ── 收藏 / 文件夹 / 标签 / 笔记 ──
  'fav.put': async ({ favorite }) => {
    let folderId = favorite.folderId;
    // 默认归入当前课程文件夹（§7 B1"先收后理"）
    if (folderId === undefined && favorite.teclId !== undefined) {
      const course = await getCourse(favorite.teclId);
      const name = course
        ? `${course.subjName}${course.semester ? `（${course.semester}）` : ''}`
        : `教学班 ${favorite.teclId}`;
      const folder = await ensureDefaultFolder(favorite.teclId, name);
      folderId = folder.id;
    }
    return putFavorite({ ...favorite, folderId: folderId ?? null });
  },
  'fav.get': async ({ id }) => getFavorite(id),
  'fav.list': async ({ filter }) => listFavorites(filter ?? {}),
  'fav.update': async ({ id, patch }) => updateFavorite(id, patch),
  'fav.softDelete': async ({ ids }) => softDeleteFavorites(ids),
  'fav.restore': async ({ ids }) => restoreFavorites(ids),
  'fav.counts': async ({ teclId }) => favoriteCounts(teclId),

  'folder.list': async ({ includeArchived }) => listFolders(includeArchived),
  'folder.upsert': async ({ folder }) => upsertFolder(folder),
  'folder.ensureDefault': async ({ teclId, name }) => ensureDefaultFolder(teclId, name),
  'folder.reorder': async ({ ids }) => reorderFolders(ids),
  'folder.merge': async ({ fromId, toId }) => mergeFolders(fromId, toId),
  'folder.rename': async ({ id, name }) => renameFolder(id, name),
  'folder.archive': async ({ id, archived }) => archiveFolder(id, archived),
  'folder.softDelete': async ({ id }) => softDeleteFolder(id),

  'tag.list': async () => listTags(),
  'tag.create': async ({ name, color }) => createTag(name, color),
  'tag.rename': async ({ id, name }) => renameTag(id, name),
  'tag.merge': async ({ fromIds, toId }) => mergeTags(fromIds, toId),
  'tag.softDelete': async ({ id }) => softDeleteTag(id),

  'note.list': async (filter) => listNotes(filter ?? {}),
  'note.put': async ({ note }) => putNote(note),
  'note.update': async ({ id, text }) => updateNote(id, text),
  'note.softDelete': async ({ id }) => softDeleteNote(id),
  'note.toFavorite': async ({ id, folderId }) => noteToFavorite(id, folderId),

  // ── 统计 ──
  'stats.tick': async (args) => {
    await statsService.tick(args);
  },
  'stats.flush': async ({ courId }) => {
    await statsService.flush(courId);
  },
  'stats.report': async ({ days }) => {
    const windowDays = days ?? 30;
    const from = localDayKey(startOfLocalDay(Date.now() - (windowDays + 120) * 24 * 3600 * 1000));
    const courses = await listCourses();
    const [records, sessionLists] = await Promise.all([
      listWatchRecords(from, localDayKey()),
      Promise.all(courses.map((course) => listSessionsByCourse(course.teclId))),
    ]);
    return buildReport({
      records,
      sessions: sessionLists.flat(),
      courses,
      windowDays,
      weeklyTargetSec: await weeklyTargetSec(),
      checkinMinSec: 10 * 60,
    });
  },
  'stats.sessionSummary': async ({ courId }) => statsService.sessionSummary(courId),
  'stats.courseSummary': async ({ teclId }) => {
    const courses = await listCourses();
    const course = courses.find((c) => c.teclId === teclId);
    const sessions = await listSessionsByCourse(teclId);
    const records = (await listWatchRecords('1970-01-01', localDayKey())).filter(
      (r) => r.teclId === teclId && r.valid,
    );
    return {
      teclId,
      courseName: course?.subjName ?? `教学班 ${teclId}`,
      totalSec: Math.round(records.reduce((acc, r) => acc + r.durationSec, 0)),
      sessionCount: new Set(records.map((r) => r.courId)).size,
      finishedCount: sessions.filter((s) => s.watchState === 'finished').length,
    };
  },
  'stats.records': async ({ fromDay, toDay }) => listWatchRecords(fromDay, toDay),
  'stats.clear': async () => clearWatchRecords(),

  // ── 截图 ──
  'shot.capture': async (args) =>
    captureFrame({
      courId: args.courId,
      teclId: args.teclId,
      view: args.view,
      atSec: args.atSec,
      url: args.url,
      watermark: args.watermark,
      meta: {
        courseName: args.meta.courseName,
        courLabel: args.meta.courLabel,
        anchorTime: args.meta.anchorTime,
      },
    }),
  'shot.list': async ({ courId }) => (await listScreenshots(courId)).map(({ blob: _blob, ...rest }) => rest),
  'shot.softDelete': async ({ ids }) => softDeleteScreenshots(ids),
  'shot.restore': async ({ ids }) => restoreScreenshots(ids),

  // ── 复习 ──
  'review.plan': async ({ favoriteId, template, startDate }) => {
    const settings = await loadSettings();
    return planReview(favoriteId, template ?? settings.review.template, settings.review.intervals, startDate);
  },
  'review.cancel': async ({ favoriteId }) => cancelReview(favoriteId),
  'review.due': async ({ date }) => dueReviews(date ?? localDayKey()),
  'review.complete': async ({ jobId, status }) => completeReview(jobId, status),
  'review.stats': async () => reviewStats(),

  // ── 课表联动 / 补看清单 ──
  'schedule.put': async ({ items, termYear }) => {
    await putCurriculum(items, termYear);
    if (termYear) await kvSet(KV_KEYS.termYear, termYear);
  },
  'schedule.list': async () => listCurriculum(),
  'schedule.missed': async () => buildMissedList(),
  'schedule.exclude': async ({ courId, excluded }) => setMissedExcluded(courId, excluded),

  // ── 导出 / 导入 / 数据管理 ──
  'export.build': async (args) => {
    switch (args.kind) {
      case 'cards':
        return exportCardsMarkdown(args.filter ?? {});
      case 'list':
        return exportListCsv(args.filter ?? {});
      case 'outline':
        if (args.courId === undefined) throw new AppError('INVALID_INPUT', { detail: '导出大纲需要 courId' });
        return exportOutlineMarkdown(args.courId);
      case 'backup':
        return exportBackup(args.includeScreenshots ?? false);
      default:
        throw new AppError('INVALID_INPUT', { detail: '未知的导出类型' });
    }
  },
  'import.run': async ({ jobId, mode }) => runImport(jobId, mode),
  'storage.usage': async () => storageUsage(),
  'data.clear': async ({ kinds }) => clearData(kinds),

  // ── 回收站 ──
  'trash.list': async () =>
    (await listTrash()).map((entry) => ({
      key: entry.key,
      kind: entry.kind,
      id: entry.id,
      deletedAt: entry.deletedAt,
      expiresAt: entry.expiresAt,
      title: entry.title,
    })),
  'trash.restore': async ({ keys }) => restoreTrashEntries(keys),
  'trash.purge': async ({ keys }) => (keys && keys.length > 0 ? purgeTrashEntries(keys) : emptyTrash()),

  // ── KV ──
  'kv.get': async ({ key }) => kvGet(key),
  'kv.set': async ({ key, value }) => kvSet(key, value),
  'kv.del': async ({ key }) => kvDelete(key),

  // ── 通知 ──
  'notify.show': async ({ title, message, silent }) => {
    await notifications.create(`hdu-assistant-${Date.now()}`, {
      type: 'basic',
      title,
      message,
      iconUrl: runtime.getURL('icon/128.png'),
      silent: silent ?? false,
    });
  },
};

// ───────────────────────── 辅助实现 ─────────────────────────

/** 从回收站还原：按 kind 分派到对应仓储的还原方法，并删除回收站索引 */
async function restoreTrashEntries(keys: string[]): Promise<void> {
  const all = await listTrash();
  const wanted = all.filter((entry) => keys.includes(entry.key));
  if (wanted.length === 0) return;
  const idsOf = (kind: string) => wanted.filter((e) => e.kind === kind).map((e) => e.id);
  const favIds = idsOf('favorite');
  const shotIds = idsOf('screenshot');
  if (favIds.length > 0) await restoreFavorites(favIds);
  if (shotIds.length > 0) await restoreScreenshots(shotIds);
  const { getDb } = await import('@/core/db');
  const db = await getDb();
  for (const entry of wanted) {
    if (entry.kind === 'note' || entry.kind === 'tag' || entry.kind === 'folder') {
      const store = entry.kind === 'note' ? 'notes' : entry.kind === 'tag' ? 'tags' : 'folders';
      const entity = (await db.get(store, entry.id)) as { deletedAt?: number | null } | undefined;
      if (entity) await db.put(store, { ...entity, deletedAt: null } as never);
    }
    await removeFromTrash(entry.kind, entry.id);
  }
}

async function weeklyTargetSec(): Promise<number> {
  const raw = await kvGet<number>(KV_KEYS.goalAdjust);
  if (typeof raw === 'number' && raw > 0) return raw;
  // 未单独调整时用设置里的周目标（默认 5 小时）
  const settings = await loadSettings();
  return Math.max(1, settings.weeklyGoalHours) * 3600;
}

/** 补看清单（§7 D4）：课次结束 N 小时后无有效观看 → 列入；支持人工排除 */
async function buildMissedList(): Promise<MissedItem[]> {
  const settings = await loadSettings();
  const curriculum = await listCurriculum();
  const excluded = await listMissedExcluded();
  const now = Date.now();
  const delayMs = settings.missDelayHours * 3600 * 1000;
  const courses = await listCourses();
  const courseMap = new Map(courses.map((c) => [c.teclId, c.subjName]));
  // 一次性取出全部流水，按课次归集（避免逐条查询）
  const records = await listWatchRecords('1970-01-01', localDayKey());
  const watchedByCour = new Map<number, number>();
  for (const record of records) {
    if (!record.valid) continue;
    watchedByCour.set(record.courId, (watchedByCour.get(record.courId) ?? 0) + record.durationSec);
  }

  const items: MissedItem[] = [];
  for (const entry of curriculum) {
    if (now - entry.endTime < delayMs) continue;
    const session = await getSession(entry.courId);
    const watchedSec = watchedByCour.get(entry.courId) ?? 0;
    const durationSec = session?.durationSec ?? Math.max(1, (entry.endTime - entry.beginTime) / 1000);
    const ratio = clamp(watchedSec / durationSec, 0, 1);
    if (ratio >= settings.finishThreshold) continue;
    items.push({
      courId: entry.courId,
      teclId: entry.teclId,
      courseName: courseMap.get(entry.teclId) ?? entry.subjName,
      courLabel: session?.courLabel ?? entry.subjName,
      beginTime: entry.beginTime,
      watchedSec: Math.round(watchedSec),
      watchRatio: ratio,
      excluded: excluded.includes(entry.courId),
    });
  }
  return items.sort((a, b) => b.beginTime - a.beginTime);
}

async function storageUsage(): Promise<StorageUsage> {
  const { getDb } = await import('@/core/db');
  const db = await getDb();
  const [screenshotCount, transcriptCount] = await Promise.all([
    db.count('screenshots'),
    db.count('transcripts'),
  ]);
  const est = await estimateStorage();
  let opfsBytes = 0;
  try {
    const files = await listModelFiles();
    opfsBytes = files.reduce((acc, file) => acc + file.size, 0);
  } catch {
    /* OPFS 不可用 */
  }
  const settings = await loadSettings();
  const cached = await checkTierCached(settings.asr.modelTier).catch(() => null);
  return {
    indexedDbBytes: est?.usage ?? 0,
    opfsBytes,
    quotaBytes: est?.quota ?? 0,
    screenshotCount,
    transcriptCount,
    modelCached: cached?.cached ?? false,
  };
}

async function clearData(
  kinds: Array<'ai' | 'transcript' | 'stats' | 'library' | 'screenshots' | 'models' | 'all'>,
): Promise<void> {
  const { getDb } = await import('@/core/db');
  const db = await getDb();
  const wanted = new Set(kinds.includes('all') ? ['ai', 'transcript', 'stats', 'library', 'screenshots', 'models'] : kinds);
  if (wanted.has('ai')) {
    await db.clear('aiResults');
    await db.clear('chats');
  }
  if (wanted.has('transcript')) {
    await db.clear('transcripts');
    await db.clear('asrChunks');
    await db.clear('asrJobs');
  }
  if (wanted.has('stats')) await clearWatchRecords();
  if (wanted.has('library')) {
    await db.clear('favorites');
    await db.clear('folders');
    await db.clear('tags');
    await db.clear('notes');
    await db.clear('reviewJobs');
    await db.clear('trash');
  }
  if (wanted.has('screenshots')) await db.clear('screenshots');
  if (wanted.has('models')) {
    const settings = await loadSettings();
    await clearTierCache(settings.asr.modelTier);
    invalidateModelState(settings.asr.modelTier);
  }
  log.info('数据清理完成', [...wanted]);
}

/** SW 启动时的例行清理 */
export async function housekeeping(): Promise<void> {
  try {
    await purgeExpiredTrash();
    const { purgeExpiredExportJobs, getDb } = await import('@/core/db');
    await purgeExpiredExportJobs();
    // 把"仍在补全但已无作业"的 partial 转写标记为完成态，避免一直显示 partial
    const db = await getDb();
    const jobs = await db.getAll('asrJobs');
    const activeIds = new Set(
      jobs
        .filter(
          (job) =>
            job.status === 'queued' ||
            job.status === 'transcribing' ||
            job.status === 'extracting' ||
            // paused 是可续跑的作业，转写仍不完整，不能把 partial 抹掉
            job.status === 'paused',
        )
        .map((job) => job.courId),
    );
    for (const transcript of await db.getAll('transcripts')) {
      if (transcript.partial && !activeIds.has(transcript.courId)) {
        await db.put('transcripts', { ...transcript, partial: false });
      }
    }
  } catch (err) {
    log.warn('housekeeping 失败', err);
  }
}

export async function dispatchOp<N extends OpName>(op: N, args: OpArgs<N>): Promise<OpResult<N>> {
  const handler = handlers[op] as ((a: OpArgs<N>) => Promise<OpResult<N>>) | undefined;
  if (!handler) throw new AppError('NOT_IMPLEMENTED', { detail: `未注册的操作：${op}` });
  return handler(args);
}
