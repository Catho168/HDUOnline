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
import type { BiliOverviewResult, FavoriteEntity, SessionEntity, TranscriptEntity } from '@/core/shared/types';
import { biliMediaKey, hduCourIdOf, parseMediaKey } from '@/core/shared/mediaRef';
import { notifications, runtime } from '@/core/shared/runtime';
import { getActiveProvider, loadSecrets, loadSettings } from '@/core/shared/settings';
import { estimateStorage } from '@/core/shared/storage';
import { clamp, localDayKey, startOfLocalDay } from '@/core/shared/utils';
import { loadCourseGlossary, loadUserGlossary, saveCourseGlossary, saveUserGlossary } from '@/core/asr/glossary';
import { checkTierCached, clearTierCache, listModelFiles } from '@/core/asr/modelCache';
import { testProvider } from '@/core/llm/runner';
import {
  applyGlossary,
  clearAiResult,
  clearChats,
  clearTranscript,
  getCourse,
  getSession,
  getTranscript,
  listCourses,
  listSessionsByCourse,
  listTranscriptMediaKeys,
  patchSession,
  putTranscript,
  renameCourse,
  saveSessionMeta,
  searchTranscriptsByCourse,
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
  listAllNotes,
  listFavorites,
  listFolders,
  listReviewJobs,
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
  reopenReview,
  reorderFolders,
  rescheduleReview,
  restoreFavorites,
  restoreScreenshots,
  reviewStats,
  searchNotes,
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
  getTodayDoneKeys,
  isAllowedKvKey,
  kvDelete,
  kvGet,
  kvSet,
  listCurriculum,
  listMissedExcluded,
  putCurriculum,
  setMissedExcluded,
  setTodayDoneKeys,
} from '@/core/db/repo/misc';
import { clearWatchRecords, listWatchRecords } from '@/core/db/repo/stats';
import { addExternalWatch, clearExternalWatch, getExternalByDateRange, getExternalWatchByDate } from '@/core/db/repo/external';
// 演示域（第 319 轮）：isDemoActive 走 demo/index（不牵 db，内容脚本亦可引用）；
// 播种实现在 demo/seed（仅 SW 使用）
import { isDemoActive } from '@/core/demo';
import { buildDemoSubtitleFetchResult } from '@/core/demo/fallback';
import { demoStatus, enterDemo, exitDemo, resetDemo } from '@/core/demo/seed';
import { emptyTrash, extendedExpiresAt, listTrash, purgeExpiredTrash, purgeTrashEntries, removeFromTrash } from '@/core/db/repo/trash';
import { getVideoProgress, reportVideoProgress } from '@/core/db/repo/video';
import { buildBiliOverview } from '@/core/db/repo/bili';
import { deleteWeeklyPlan, getWeeklyPlans, upsertWeeklyPlan } from '@/core/db/repo/weekly';
import { buildWeeklyPlan, isActiveWeeklyPlan, type WeeklyPlan } from '@/core/plan/weekly';
import { mergeSearchResults, normalizeKeyword, SEARCH_FAVORITES_LIMIT, type UnifiedSearchResult } from '@/core/search/unified';
import { exportBackup, exportCardsMarkdown, exportListCsv, exportOutlineMarkdown } from '@/core/export/exporters';
import { assembleExportPayload, buildExportFilename } from '@/core/export/dataExport';
import { runImport } from '@/core/export/importer';
import { CHECKIN_MIN_SEC, buildCourseBundles, buildReport } from '@/core/stats/aggregate';
import { buildPeriodReport, periodBuckets, type PeriodKind, type PeriodReport } from '@/core/stats/period';
import {
  buildActivityHeatmap,
  buildMonthlyHeatmap,
  clampHeatmapMonths,
  clampHeatmapWeeks,
  heatmapWindowStartDay,
  type ActivityHeatmapData,
  type DayDetailReport,
  type MonthlyHeatmapData,
} from '@/core/stats/heatmap';
import { startTranscription, controlTranscription, planFollow, warmup, downloadModel, modelStatus, invalidateModelState } from './asr';
import { abortGeneration, generateTopics, loadAiResult } from './ai';
import { fetchBiliFavFolders, fetchBiliFavItems, fetchBiliNav } from './bili';
import {
  getTranscriptWithDemo,
  listChatGroupsByBvidWithDemo,
  listChatGroupsWithDemo,
  listChatsByBvidWithDemo,
  listChatsWithDemo,
  listFavoritesWithDemo,
  listNotesWithDemo,
  searchTranscriptsWithDemo,
} from './demoFallback';
import { fetchBiliSubtitle } from '@/core/bili/subtitle';
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
  'transcript.get': async ({ mediaKey }) => getTranscriptWithDemo(mediaKey),
  'transcript.put': async ({ transcript }) => putTranscript(transcript),
  'transcript.clear': async ({ mediaKey }) => clearTranscript(mediaKey),
  'transcript.applyGlossary': async ({ mediaKey }) => applyGlossary(mediaKey),
  'transcript.search': async ({ query, mediaKeys, limit }) => searchTranscriptsWithDemo(query, mediaKeys, limit),
  // 全库主键（仅键不载正文；知识库徽标前缀匹配用，第 16 轮）
  'transcript.keys': async () => listTranscriptMediaKeys(),

  // ── 转写作业 ──
  'asr.start': async (args) => ({ job: await startTranscription(args) }),
  'asr.follow': async (args) => planFollow(args),
  'asr.control': async ({ mediaKey, action }) => ({ job: await controlTranscription(mediaKey, action) }),
  'asr.status': async ({ mediaKey }) => getAsrJob(mediaKey),
  'asr.warmup': async ({ modelTier }) => warmup(modelTier),
  'asr.model.status': async ({ tier }) => modelStatus(tier),
  'asr.model.download': async ({ tier }) => downloadModel(tier),
  'asr.model.clear': async ({ tier }) => {
    await clearTierCache(tier);
    invalidateModelState(tier);
  },

  // ── 词表 ──
  'glossary.getUser': async () => loadUserGlossary(),
  'glossary.setUser': async ({ dict }) => saveUserGlossary(dict),
  // 课程级词表仍按 courId 存 kv（保留旧数据），mediaKey 在入口反解
  'glossary.getCourse': async ({ mediaKey }) => loadCourseGlossary(hduCourIdOf(mediaKey) ?? -1),
  'glossary.setCourse': async ({ mediaKey, dict }) => saveCourseGlossary(hduCourIdOf(mediaKey) ?? -1, dict),

  // ── AI 标注 / 大纲 ──
  'ai.get': async ({ mediaKey }) => loadAiResult(mediaKey),
  'ai.generate': async ({ mediaKey, force, windowPreset }) => generateTopics(mediaKey, force, windowPreset),
  'ai.abort': async ({ mediaKey }) => abortGeneration(mediaKey),
  // 隐藏知识点仍按 courId 存 kv（保留旧数据），mediaKey 在入口反解
  'ai.hidden.get': async ({ mediaKey }) => (await kvGet<string[]>(KV_KEYS.hiddenTopics(hduCourIdOf(mediaKey) ?? -1))) ?? [],
  'ai.hidden.set': async ({ mediaKey, names }) => kvSet(KV_KEYS.hiddenTopics(hduCourIdOf(mediaKey) ?? -1), names),
  'ai.clear': async ({ mediaKey }) => clearAiResult(mediaKey),
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
  'qa.list': async ({ mediaKey, groupId }) => listChatsWithDemo(mediaKey, groupId),
  'qa.listAll': async ({ bvid }) => listChatsByBvidWithDemo(bvid),
  'qa.groups': async ({ mediaKey }) => listChatGroupsWithDemo(mediaKey),
  'qa.groupsAll': async ({ bvid }) => listChatGroupsByBvidWithDemo(bvid),
  'qa.clear': async ({ mediaKey, groupId }) => clearChats(mediaKey, groupId),

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
  'fav.list': async ({ filter }) => listFavoritesWithDemo(filter ?? {}),
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

  'note.list': async (filter) => listNotesWithDemo(filter ?? {}),
  'note.listAll': async () => listAllNotes(),
  'note.put': async ({ note }) => putNote(note),
  'note.update': async ({ id, text }) => updateNote(id, text),
  'note.softDelete': async ({ id }) => softDeleteNote(id),
  'note.toFavorite': async ({ id, folderId }) => noteToFavorite(id, folderId),

  // ── 统一搜索（字幕 / 收藏 / 笔记 一次聚合） ──
  'search.all': async ({ keyword }) => runUnifiedSearch(keyword),

  // ── 站外视频学习进度（B 站）；演示模式下不上报（真实观看不写进演示库） ──
  'video.progress.get': async ({ platform, videoId }) => getVideoProgress(platform, videoId),
  'video.progress.report': async (args) => {
    if (await isDemoActive()) return null;
    return reportVideoProgress(args);
  },

  // ── B 站收藏夹导入（SW 内单页请求，分页循环由前端编排） ──
  'bili.nav.get': async () => fetchBiliNav(),
  'bili.favlist.folders': async ({ upMid }) => fetchBiliFavFolders(upMid),
  'bili.favlist.items': async ({ mediaId, pn, ps }) => fetchBiliFavItems({ mediaId, pn, ps }),

  // ── B 站官方字幕获取（无字幕作罢，none 不是错误） ──
  'bili.subtitle.fetch': async (args) => fetchBiliSubtitleOp(args),

  // ── 统计；演示模式下心跳不上报（真实观看时长不写进演示库，退出即删也不丢真实记录） ──
  'stats.tick': async (args) => {
    if (await isDemoActive()) return;
    await statsService.tick(args);
  },
  // 站外视频学习时长：落 externalWatch store（date 用 SW 端本地日期；title 缺省不覆盖旧值）
  'stats.external.tick': async ({ bvid, title, seconds }) => {
    if (await isDemoActive()) return;
    await addExternalWatch({ date: localDayKey(), bvid, title, seconds });
  },
  'stats.flush': async ({ courId }) => {
    await statsService.flush(courId);
  },
  'stats.report': async ({ days }) => {
    const windowDays = days ?? 30;
    const from = localDayKey(startOfLocalDay(Date.now() - (windowDays + 120) * 24 * 3600 * 1000));
    const courses = await listCourses();
    const [records, externalRecords, sessionLists] = await Promise.all([
      listWatchRecords(from, localDayKey()),
      getExternalByDateRange(from, localDayKey()),
      Promise.all(courses.map((course) => listSessionsByCourse(course.teclId))),
    ]);
    return buildReport({
      records,
      sessions: sessionLists.flat(),
      courses,
      externalRecords,
      windowDays,
      weeklyTargetSec: await weeklyTargetSec(),
      checkinMinSec: CHECKIN_MIN_SEC,
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
  // 学习周报 / 月报：周期聚合交给纯函数（口径见 core/stats/period），此处只做范围查询
  'stats.period': async ({ kind, count }) => buildPeriodOpReport(kind, count),
  // 学习热力图（第 77 轮巡检）：窗口边界由纯函数给出（周一为界），聚合委托 core/stats/heatmap
  'stats.heatmap': async ({ weeks }) => buildHeatmapOp(weeks),
  // 单日学习明细（第 79 轮巡检）：热力图格子点击后的当日流水（站内外分行，课程名就地富化）
  'stats.dayDetail': async ({ date }) => buildDayDetailOp(date),
  // 月视图热力图（第 81 轮巡检）：自然月列 × 当月天数，聚合委托 core/stats/heatmap
  'stats.heatmapMonthly': async ({ months }) => buildHeatmapMonthlyOp(months),
  // B 站视频学习统计总览：区间边界复用 periodBuckets（与 stats.period 同口径），聚合委托 repo
  'stats.bili.overview': async ({ kind, limit }) => buildBiliOverviewOp(kind, limit),
  'stats.clear': async () => clearWatchRecords(),

  // 全量复习作业（第 83 轮巡检，学习中心「复习计划」视图）：含 favorite 快照（可能 null）
  'review.list': async () => {
    const jobs = await listReviewJobs();
    const favorites = await Promise.all(
      jobs.map((job) => getFavorite(job.favoriteId).catch(() => null)),
    );
    return jobs.map((job, index) => ({ ...job, favorite: favorites[index] ?? null }));
  },

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
  'review.reopen': async ({ jobId }) => reopenReview(jobId),
  'review.reschedule': async ({ jobId, dueDate }) => rescheduleReview(jobId, dueDate),
  'review.stats': async () => reviewStats(),

  // ── 课表联动 / 补看清单 ──
  'schedule.put': async ({ items, termYear }) => {
    await putCurriculum(items, termYear);
    if (termYear) await kvSet(KV_KEYS.termYear, termYear);
  },
  'schedule.list': async () => listCurriculum(),
  'schedule.missed': async () => buildMissedList(),
  'schedule.exclude': async ({ courId, excluded }) => setMissedExcluded(courId, excluded),

  // ── 今日待办（勾选状态走 KV 薄封装） ──
  'todo.today.get': async ({ date }) => getTodayDoneKeys(date),
  'todo.today.set': async ({ date, keys }) => setTodayDoneKeys(date, keys),

  // ── 每周回看学习计划（切片/活跃判定口径在 core/plan/weekly 纯函数） ──
  'plan.weekly.get': async () => ({ plans: await getWeeklyPlans() }),
  'plan.weekly.create': async (args) => createWeeklyPlan(args),
  'plan.weekly.cancel': async ({ planId }) => {
    await deleteWeeklyPlan(planId);
    return { ok: true as const };
  },

  // ── 导出 / 导入 / 数据管理 ──
  'export.build': async (args) => {
    switch (args.kind) {
      case 'cards':
        return exportCardsMarkdown(args.filter ?? {});
      case 'list':
        return exportListCsv(args.filter ?? {});
      case 'outline':
        if (args.mediaKey === undefined) throw new AppError('INVALID_INPUT', { detail: '导出大纲需要 mediaKey' });
        return exportOutlineMarkdown(args.mediaKey);
      case 'backup':
        return exportBackup(args.includeScreenshots ?? false);
      default:
        throw new AppError('INVALID_INPUT', { detail: '未知的导出类型' });
    }
  },
  'import.run': async ({ jobId, mode }) => runImport(jobId, mode),
  'storage.usage': async () => storageUsage(),
  // 配额即时查询（第 254 轮巡检，存储健康域）：estimateStorage 已封装 try/catch 与
  // API 缺席探测（core/shared/storage.ts），不可用 → null（UI 显示「无法获取」）
  'storage.estimate': async () => estimateStorage(),
  'data.clear': async ({ kinds }) => clearData(kinds),

  // ── 演示模式（第 319 轮）：并行库播种 / 清库；实现见 core/demo/seed.ts ──
  'demo.enter': async () => enterDemo(),
  'demo.exit': async () => exitDemo(),
  'demo.reset': async () => resetDemo(),
  'demo.status': async () => demoStatus(),
  /**
   * 全量数据导出（第 250 轮巡检，数据自主权域）：background 直调各 repo 收集白名单
   * 数据段（清理由 assembleExportPayload 统一做——非数组段置空、非对象行丢弃、
   * settings 顶层键白名单挑选），组装 { version, app, kind, exportedAt, counts, data }
   * 后整包 JSON 回传（轻量资产段不含转写 / 流水明细，消息通道体积可控）。
   * sessions 沿用 collectBackup 同款「按课程逐个拉取」路径；videoProgress 无 repo
   * 列表函数，走 db.getAll（exporters.collectBackup 同款）。
   */
  'data.exportAll': async () => {
    const [favorites, folders, tags, notes, reviewJobs, weeklyPlans, courses, curriculum, settings] = await Promise.all([
      listFavorites({}),
      listFolders(true),
      listTags(),
      listAllNotes(),
      listReviewJobs(),
      getWeeklyPlans(),
      listCourses(),
      listCurriculum(),
      loadSettings(),
    ]);
    const sessionRows: SessionEntity[] = [];
    for (const course of courses) {
      sessionRows.push(...(await listSessionsByCourse(course.teclId)));
    }
    const { getDb } = await import('@/core/db');
    const db = await getDb();
    const videoProgress = await db.getAll('videoProgress');
    const payload = assembleExportPayload({
      favorites,
      folders,
      tags,
      notes,
      reviewJobs,
      weeklyPlans,
      courses,
      sessions: sessionRows,
      videoProgress,
      curriculum,
      settings,
      now: Date.now(),
    });
    const json = JSON.stringify(payload, null, 2);
    return {
      filename: buildExportFilename(Date.now()),
      json,
      counts: payload.counts,
      size: new TextEncoder().encode(json).length,
    };
  },

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
  /** 回收站续期（第 233 轮巡检）：重置 expiresAt = now + days 天（默认 30，钳制 1..365） */
  'trash.extend': async ({ key, days }) => {
    const { getDb } = await import('@/core/db');
    const db = await getDb();
    const entry = await db.get('trash', key);
    if (!entry) return;
    await db.put('trash', { ...entry, expiresAt: extendedExpiresAt(Date.now(), Number(days)) });
  },
  'trash.purge': async ({ keys }) => (keys && keys.length > 0 ? purgeTrashEntries(keys) : emptyTrash()),

  // ── KV（键白名单见 assertKvKeyAllowed，第 24 轮审计 P3） ──
  'kv.get': async ({ key }) => {
    assertKvKeyAllowed(key);
    return kvGet(key);
  },
  'kv.set': async ({ key, value }) => {
    assertKvKeyAllowed(key);
    return kvSet(key, value);
  },
  'kv.del': async ({ key }) => {
    assertKvKeyAllowed(key);
    return kvDelete(key);
  },

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

/**
 * kv.* op 键白名单校验（第 24 轮审计 P3 纵深防御）：只放行 KV_KEYS 注册的静态键
 * 与动态前缀键（aiHidden:<courId> / missedExcluded:<courId> / hdu.todo.done.<date>），
 * 未注册键一律 INVALID_INPUT，防止低层 KV 通道被用于覆盖内部键。
 */
function assertKvKeyAllowed(key: unknown): asserts key is string {
  if (!isAllowedKvKey(key)) {
    throw new AppError('INVALID_INPUT', {
      detail: `kv 键不在白名单：${typeof key === 'string' ? key : `<${typeof key}>`}`,
    });
  }
}

// ───────────────────────── 辅助实现 ─────────────────────────

/**
 * none 记忆（第 16 轮审计 P3-3）：`bili.subtitle.fetch` 得到 none（无字幕作罢、不落库）时，
 * 在 SW 内存里记 `Map<mediaKey, expiry>`，命中记忆直接返回 none 不再打 B 站接口——
 * 逐次重试只会重复暴露给风控。仅内存级（SW 存活期内有效，SW 被回收即失效重来），
 * 不写 IndexedDB：作罢语义是「本次没有」，不是持久事实，落库会让未来的 force/再试
 * 语义变复杂。TTL 10 分钟：跨过这个窗口后允许再次探测（UP 主可能中途补字幕）。
 * force 请求跳过记忆照常拉取，重拉结果 none 时刷新、ok 时清除（有字幕了就别再记 none）。
 */
export const BILI_SUBTITLE_NONE_TTL_MS = 10 * 60 * 1000;
/** 导出仅为单测可构造命中/过期场景（生产路径只有 fetchBiliSubtitleOp 读写） */
export const biliSubtitleNoneMemory = new Map<string, number>();

/** 清空 none 记忆（单测隔离用；SW 生命周期管理无需清） */
export function resetBiliSubtitleNoneMemory(): void {
  biliSubtitleNoneMemory.clear();
}

/**
 * bvid 分 P 参数口径（第 16 轮）：正整数 ≥1 才认，其余（0 / 负数 / 小数 / 非数值）
 * 一律按 1 兜底——P1 是绝大多数场景，非法 p 不值得整体拒绝（沿用 args 校验的
 * 「防御式兜底」风格，与 resolvePageCid 的越界回退 P1 同口径）。
 */
function normalizeBiliPageP(raw: unknown): number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 ? raw : 1;
}

/**
 * B 站官方字幕获取（bili.subtitle.fetch，第 14 轮方向变更：B 站不做本地 ASR 转写）：
 *  - 已有字幕且未 force → 幂等返回 cached（不重复拉接口）；mediaKey 按分 P 隔离，
 *    P1 裸键 `bili:<bvid>`、p≥2 分 P 键 `bili:<bvid>:p<N>`，互不冒充（第 16 轮）；
 *  - none 记忆命中（未过期）→ 不打接口直接返回 none（P3-3 降风控暴露）；
 *  - 无字幕（fetchBiliSubtitle 返回 none）→ 直接返回、不落库（无字幕作罢，不是错误）；
 *  - 有字幕 → 落 transcripts 后返回计数与语言。
 *
 * TranscriptEntity 字段口径（B 站官方字幕，无转写作业）：
 *  - mediaKey = `bili:<bvid>`（P1）或 `bili:<bvid>:p<N>`（p≥2）；courId 不写（B 站无课次）；
 *    asrJobs 不写（无转写作业）；
 *  - source = 'bili-official-subtitle'（非 ASR 产物的来源标记）；
 *  - model = 'bili-official-subtitle'（占位：无推理模型，仅标明产物来源）；
 *  - lang = 轨的 lan（缺省 'und'）；glossaryVersion = 0（未应用词表纠错）；
 *  - aiSubtitle = 选中的轨是否 AI 生成（第 16 轮可选字段，浮层头部标记用）；
 *  - coverage / coveredSec = 字幕实际覆盖区间（有文字的区间并集，非音频全程）；
 *  - durationSec = pagelist 的分 P 时长（QA 兜底链可用）；partial=false；
 *    window / pipelineVersion / threadId 属转写管线概念，B 站字幕不适用，缺省。
 *  - force 重拉返回 none 时保留旧字幕（不删库，避免误伤已有数据）。
 */
async function fetchBiliSubtitleOp(args: OpArgs<'bili.subtitle.fetch'>): Promise<OpResult<'bili.subtitle.fetch'>> {
  const bvid = typeof args?.bvid === 'string' ? args.bvid.trim() : '';
  if (!bvid.startsWith('BV') || bvid.length < 3) {
    throw new AppError('INVALID_INPUT', { detail: `bili.subtitle.fetch bvid 不合法：${args?.bvid ?? ''}` });
  }
  const p = normalizeBiliPageP(args?.p);
  const mediaKey = biliMediaKey(bvid, p);
  if (await isDemoActive()) {
    const demoTranscript = await getTranscriptWithDemo(mediaKey);
    if (!demoTranscript) return { status: 'none' };
    return buildDemoSubtitleFetchResult(demoTranscript);
  }
  if (!args.force) {
    const existing = await getTranscript(mediaKey);
    if (existing) {
      return { status: 'ok', cached: true, segments: existing.segments.length, lan: existing.lang, lanDoc: '' };
    }
    // none 记忆命中（P3-3）：SW 存活期内作罢过且未过期 → 直接返回，不再打接口
    const expiry = biliSubtitleNoneMemory.get(mediaKey);
    if (expiry !== undefined) {
      if (expiry > Date.now()) {
        log.info(`B 站视频无可用字幕（none 记忆命中，作罢）：${mediaKey}`);
        return { status: 'none' };
      }
      // 惰性清除过期条目（第 17 轮复核 P3-1）：避免长存活 SW 下 Map 滞留无界缓增
      biliSubtitleNoneMemory.delete(mediaKey);
    }
  }
  const result = await fetchBiliSubtitle(bvid, { p });
  if (result.status === 'none') {
    // 作罢不落库：SW 内存级 none 记忆仅为降风控暴露（见 BILI_SUBTITLE_NONE_TTL_MS 注释）
    biliSubtitleNoneMemory.set(mediaKey, Date.now() + BILI_SUBTITLE_NONE_TTL_MS);
    log.info(`B 站视频无可用字幕（作罢）：${mediaKey}`);
    return { status: 'none' };
  }
  // 拿到 ok 说明该 mediaKey 并非无字幕：清掉可能存在的旧 none 记忆
  biliSubtitleNoneMemory.delete(mediaKey);
  const transcript: TranscriptEntity = {
    mediaKey,
    segments: result.segments,
    model: 'bili-official-subtitle',
    lang: result.lan || 'und',
    glossaryVersion: 0,
    createdAt: Date.now(),
    source: 'bili-official-subtitle',
    coveredSec: result.coveredSec,
    coverage: result.coverage,
    ...(result.durationSec !== null ? { durationSec: result.durationSec } : {}),
    aiSubtitle: result.ai,
    partial: false,
  };
  await putTranscript(transcript);
  log.info(`B 站官方字幕已落库：${mediaKey} ${result.segments.length} 段（${result.lanDoc || result.lan}）`);
  return {
    status: 'ok',
    cached: false,
    segments: result.segments.length,
    lan: transcript.lang,
    lanDoc: result.lanDoc,
  };
}

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

/**
 * 学习周报 / 月报（stats.period）：
 *  - 周期边界由纯函数 periodBuckets 给出（周界/月界口径见 core/stats/period）；
 *  - 查询全程无 N+1：watchRecords / externalWatch 走 date 索引范围查询，
 *    weeklyPlans / favorites / reviewJobs 为小表一次读取（favorites 仅周报的
 *    计划完看口径需要，reviewJobs 仅月报保持率需要，按 kind 按需取）。
 */
async function buildPeriodOpReport(kind: PeriodKind, count?: number): Promise<PeriodReport> {
  const now = Date.now();
  const buckets = periodBuckets(kind, count, now);
  const fromDay = buckets[0]?.startDay ?? localDayKey(now);
  const todayKey = localDayKey(now);
  const [records, externalRecords, plans, favorites, reviewJobs] = await Promise.all([
    listWatchRecords(fromDay, todayKey),
    getExternalByDateRange(fromDay, todayKey),
    kind === 'week' ? getWeeklyPlans() : Promise.resolve([]),
    kind === 'week' ? listFavorites({}) : Promise.resolve([]),
    kind === 'month' ? listReviewJobs() : Promise.resolve([]),
  ]);
  return buildPeriodReport({
    kind,
    count,
    now,
    records,
    externalRecords,
    plans,
    favorites,
    reviewJobs,
  });
}

/**
 * 学习热力图（stats.heatmap，第 77 轮巡检）：
 *  - 窗口边界由纯函数 heatmapWindowStartDay 给出（本地周一为界，与 stats.period 周界同口径）；
 *  - 查询全程无 N+1：watchRecords / externalWatch 走 date 索引范围查询（截至今天，
 *    未来日本就无流水）；
 *  - 聚合为只读操作，日级分档与周列排布委托 core/stats/heatmap 纯函数。
 */
async function buildHeatmapOp(weeks?: number): Promise<ActivityHeatmapData> {
  const now = Date.now();
  const count = clampHeatmapWeeks(weeks);
  const fromDay = heatmapWindowStartDay(now, count);
  const todayKey = localDayKey(now);
  const [records, externalRecords] = await Promise.all([
    listWatchRecords(fromDay, todayKey),
    getExternalByDateRange(fromDay, todayKey),
  ]);
  return buildActivityHeatmap({ now, weeks: count, records, externalRecords });
}

/**
 * 月视图热力图（stats.heatmapMonthly，第 81 轮巡检）：
 *  - 窗口 = 当前月回退 (months-1) 个自然月（首日 00:00 起），截至今天；
 *  - 查询与周视图同款（watchRecords / externalWatch date 索引范围查询），聚合委托纯函数。
 */
async function buildHeatmapMonthlyOp(months?: number): Promise<MonthlyHeatmapData> {
  const now = Date.now();
  const count = clampHeatmapMonths(months);
  const anchor = new Date(now);
  const from = new Date(anchor.getFullYear(), anchor.getMonth() - (count - 1), 1, 0, 0, 0, 0);
  const fromDay = localDayKey(from);
  const todayKey = localDayKey(now);
  const [records, externalRecords] = await Promise.all([
    listWatchRecords(fromDay, todayKey),
    getExternalByDateRange(fromDay, todayKey),
  ]);
  return buildMonthlyHeatmap({ now, months: count, records, externalRecords });
}

/**
 * 单日学习明细（stats.dayDetail，第 79 轮巡检）：热力图格子点击后的当日流水。
 *  - 站内流水按 teclId 就地富化课程名（courses 表 subjName · teclCode；查不到回退
 *    「课程 <courId>」），invalid 流水保留展示并标「不计入」（与报表口径注释一致）；
 *  - 站外流水取当日 externalWatch（同日同视频一条累计），标题缺失回退 bvid；
 *  - 一次日期点查 + 一次课程全表（小表），无 N+1。
 */
async function buildDayDetailOp(date: string): Promise<DayDetailReport> {
  const day = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : localDayKey();
  const [records, external, courses] = await Promise.all([
    listWatchRecords(day, day),
    getExternalWatchByDate(day),
    listCourses().catch(() => []),
  ]);
  const courseByTecl = new Map(courses.map((course) => [course.teclId, course]));
  const internalRows = records
    .map((record) => {
      const course = courseByTecl.get(record.teclId);
      const label = course
        ? [course.subjName, course.teclCode].filter(Boolean).join(' · ')
        : `课程 ${record.courId}`;
      return {
        label,
        sub: `课次 ${record.teclId}${record.valid ? '' : ' · 不计入'}`,
        seconds: record.durationSec,
        valid: record.valid === true,
        courId: record.courId,
        teclId: record.teclId,
      };
    })
    .sort((a, b) => b.seconds - a.seconds);
  const externalRows = external
    .map((row) => ({
      label: row.title || row.bvid,
      sub: '站外视频',
      seconds: row.seconds,
      valid: true,
      url: `https://www.bilibili.com/video/${row.bvid}`,
    }))
    .sort((a, b) => b.seconds - a.seconds);
  return {
    date: day,
    internal: internalRows,
    external: externalRows,
    internalSec: Math.round(internalRows.filter((row) => row.valid).reduce((sum, row) => sum + row.seconds, 0)),
    externalSec: Math.round(externalRows.reduce((sum, row) => sum + row.seconds, 0)),
  };
}

/**
 * B 站视频学习统计总览（stats.bili.overview）：
 *  - TopN 区间边界复用 periodBuckets（当前周/月，与 stats.period 周月报口径完全一致）；
 *  - recent / streak 为全历史口径，不受区间影响；limit 钳制在 repo 层完成；
 *  - 聚合为只读操作（externalWatch / videoProgress / favorites），不写库。
 */
async function buildBiliOverviewOp(kind: PeriodKind, limit?: number): Promise<BiliOverviewResult> {
  const now = Date.now();
  const bucket = periodBuckets(kind, 1, now)[0];
  const fromDay = bucket?.startDay ?? localDayKey(now);
  const toDay = bucket?.endDay ?? localDayKey(now);
  return buildBiliOverview({ kind, fromDay, toDay }, limit);
}

/**
 * 统一搜索复习路的输入归并（第 245 轮巡检补第四组）：
 * 全量 pending 作业 × 全量在册收藏一次取齐后按 favoriteId 拼接（store 小，
 * 两次 getAll 比逐条 db.get 便宜）；匹配 / 去重 / 排序在 buildReviewEntries 纯函数内。
 * favorite 已删除（不在 listFavorites 缺省结果里）的作业 favorite=null，聚合器不成条。
 */
async function collectReviewSearchParts(): Promise<unknown[]> {
  const [jobs, favorites] = await Promise.all([listReviewJobs(), listFavorites({})]);
  const byId = new Map(favorites.map((fav) => [fav.id, fav]));
  return jobs.map((job) => ({ ...job, favorite: byId.get(job.favoriteId) ?? null }));
}

/**
 * 统一搜索（学习中心顶栏）：字幕 / 收藏 / 笔记 / 复习 四路并行查询，
 * 任一路失败降级为空列表并记日志，不拖垮其余三路；结果经纯函数聚合器归并。
 * 空关键词直接返回空结果，不查库。
 *
 * 收藏路截断（第 18 轮审计留观项）：listFavorites 按 keyword 只取最近
 * SEARCH_FAVORITES_LIMIT 条匹配，更旧的匹配不进入搜索。这里多取 1 条探测是否
 * 触顶，触顶时把 favoritesTruncated=true 传给聚合器（前端在收藏组末尾显示
 * 中性降级提示）；返回给聚合器的前 SEARCH_FAVORITES_LIMIT 条及其顺序不变。
 */
async function runUnifiedSearch(keyword: string): Promise<UnifiedSearchResult> {
  const kw = normalizeKeyword(keyword);
  if (kw.length < 1) return { groups: [], totalCount: 0, favoritesTruncated: false };
  const [transcriptsRes, favoritesRes, notesRes, reviewsRes] = await Promise.allSettled([
    searchTranscriptsByCourse(kw, { totalLimit: 12 }),
    // pinnedFirst（第 287 轮，检索域）：置顶收藏在统一搜索结果中优先排序
    listFavorites({ keyword: kw, limit: SEARCH_FAVORITES_LIMIT + 1, pinnedFirst: true }),
    searchNotes(kw, { limit: 30 }),
    collectReviewSearchParts(),
  ]);
  if (transcriptsRes.status === 'rejected') log.warn('search.all 字幕检索失败', toAppError(transcriptsRes.reason).detail);
  if (favoritesRes.status === 'rejected') log.warn('search.all 收藏检索失败', toAppError(favoritesRes.reason).detail);
  if (notesRes.status === 'rejected') log.warn('search.all 笔记检索失败', toAppError(notesRes.reason).detail);
  if (reviewsRes.status === 'rejected') log.warn('search.all 复习检索失败', toAppError(reviewsRes.reason).detail);
  const transcriptHits = transcriptsRes.status === 'fulfilled' ? transcriptsRes.value : [];
  const favoritesAll = favoritesRes.status === 'fulfilled' ? favoritesRes.value : [];
  // 多取的 1 条存在 ⇒ 还有更旧匹配未进入搜索（触顶）；截掉探测位，行为与原 limit:30 一致
  const favoritesTruncated = favoritesAll.length > SEARCH_FAVORITES_LIMIT;
  const favorites = favoritesTruncated ? favoritesAll.slice(0, SEARCH_FAVORITES_LIMIT) : favoritesAll;
  const notes = notesRes.status === 'fulfilled' ? notesRes.value : [];

  // 补齐媒体标题与站外跳转 URL（第 15 轮收口）：
  //  - 站内课次（有 courId）：逐个回查 session 拼标题（命中媒体 ≤12）；
  //  - B 站字幕（courId 缺省，mediaKey=`bili:<bvid>` 或多 P 键 `bili:<bvid>:p<N>`，
  //    两者反解出同一 bvid）：回查视频收藏（refId=bvid）取
  //    snapshot.title 与 metadata.url（可能带 ?p= 分 P；一次 type 索引查询 + 内存按 refId
  //    匹配，避免逐条扫库），无收藏兜底「B 站视频 <bvid>」；url 交给聚合器生成
  //    `?t=<命中秒>` 的站外跳转（分 P 键的跳转带 ?p=N，见 unified.ts externalTranscriptJumpOf）。
  const biliBvids = new Set<string>();
  for (const hit of transcriptHits) {
    if (hit.courId !== undefined) continue;
    const parsed = parseMediaKey(hit.mediaKey);
    if (parsed?.kind === 'bili') biliBvids.add(parsed.bvid);
  }
  const biliFavs = new Map<string, FavoriteEntity>();
  if (biliBvids.size > 0) {
    const videoFavs = await listFavorites({ type: 'video', limit: 500 }).catch(() => [] as FavoriteEntity[]);
    for (const fav of videoFavs) {
      if (typeof fav.refId === 'string' && biliBvids.has(fav.refId) && !biliFavs.has(fav.refId)) {
        biliFavs.set(fav.refId, fav);
      }
    }
  }
  const transcripts = await Promise.all(
    transcriptHits.map(async (hit) => {
      if (hit.courId !== undefined) {
        const session = await getSession(hit.courId).catch(() => null);
        const title = session ? [session.courseName, session.courLabel].filter(Boolean).join(' · ') : '';
        return { ...hit, title: title || `课次 ${hit.courId}` };
      }
      const parsed = parseMediaKey(hit.mediaKey);
      if (parsed?.kind !== 'bili') return hit; // 非法键：交给聚合器兜底（标题占位、不生成 jump）
      const bvid = parsed.bvid;
      const fav = biliFavs.get(bvid);
      const meta = (fav?.metadata ?? {}) as Record<string, unknown>;
      const favUrl = typeof meta.url === 'string' && meta.url ? meta.url : null;
      const favTitle = typeof fav?.snapshot?.title === 'string' ? fav.snapshot.title.trim() : '';
      return {
        ...hit,
        title: favTitle || `B 站视频 ${bvid}`,
        url: favUrl ?? `https://www.bilibili.com/video/${bvid}`,
      };
    }),
  );
  const reviews = reviewsRes.status === 'fulfilled' ? reviewsRes.value : [];
  return mergeSearchResults({ transcripts, favorites, notes, reviews, favoritesTruncated }, kw, { capPerSource: 5 });
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

/**
 * 生成每周回看学习计划（plan.weekly.create）：
 *  - SW 侧再做一次 clamp / 保序去重（buildWeeklyPlan 内置）；
 *  - 同 bvid 已在任一活跃计划中 → 跳过（不计入新计划），计入 skippedCount；
 *  - 全部被跳过 / 输入为空时不建空计划，抛 INVALID_INPUT（UI 已有错误文案通道）。
 */
async function createWeeklyPlan(args: OpArgs<'plan.weekly.create'>): Promise<OpResult<'plan.weekly.create'>> {
  const now = Date.now();
  const today = localDayKey(now);
  const existing = await getWeeklyPlans();
  const activeBvids = new Set<string>();
  for (const plan of existing) {
    if (!isActiveWeeklyPlan(plan, today)) continue;
    for (const bvid of plan.bvids) activeBvids.add(bvid);
  }
  const accepted: string[] = [];
  const skipped = new Set<string>();
  const seen = new Set<string>();
  for (const bvid of Array.isArray(args?.bvids) ? args.bvids : []) {
    if (typeof bvid !== 'string' || bvid.length === 0 || seen.has(bvid)) continue;
    seen.add(bvid);
    if (activeBvids.has(bvid)) skipped.add(bvid);
    else accepted.push(bvid);
  }
  const plan: WeeklyPlan | null = buildWeeklyPlan({
    bvids: accepted,
    perDay: args?.perDay,
    label: args?.label,
    startDate: args?.startDate,
    now,
  });
  if (!plan) {
    throw new AppError('INVALID_INPUT', {
      userMessage: skipped.size > 0 ? '所选视频都已在进行中的每周计划里，无需重复创建' : '没有可加入计划的视频',
    });
  }
  await upsertWeeklyPlan(plan);
  log.info(`已创建每周学习计划：共 ${plan.bvids.length} 个视频，每天 ${plan.perDay} 个`, { id: plan.id });
  return { plan, skippedCount: skipped.size };
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
  if (wanted.has('stats')) {
    await clearWatchRecords();
    await clearExternalWatch();
  }
  if (wanted.has('library')) {
    await db.clear('favorites');
    await db.clear('folders');
    await db.clear('tags');
    await db.clear('notes');
    await db.clear('reviewJobs');
    await db.clear('trash');
    // 每周学习计划引用的收藏被清空，计划随之失去意义：一并清除保持数据一致
    await db.clear('weeklyPlans');
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
    const activeKeys = new Set(
      jobs
        .filter(
          (job) =>
            job.status === 'queued' ||
            job.status === 'transcribing' ||
            job.status === 'extracting' ||
            // paused 是可续跑的作业，转写仍不完整，不能把 partial 抹掉
            job.status === 'paused',
        )
        .map((job) => job.mediaKey),
    );
    for (const transcript of await db.getAll('transcripts')) {
      if (transcript.partial && !activeKeys.has(transcript.mediaKey)) {
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
