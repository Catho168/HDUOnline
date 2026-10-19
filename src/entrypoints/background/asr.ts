/**
 * 转写编排（SW 侧）。
 *
 * 分工（§2.1）：
 *  - SW：作业状态机、进度事件广播、分片结果落库、续跑判定、片段流式"浏览时跟进"决策；
 *  - Offscreen + ASR Worker：音轨提取、解码、重采样、Whisper 推理（纯计算）。
 *
 * 断点续跑：进度以"分片（10 分钟）"为单位，已完成分片写入 `asrChunks`。
 * 片段模式（默认）下分片跨作业保留，是累积转写与"同名分片自动复用"的依据；
 * 整段模式完成后仍清理分片（转写已完整，分片冗余）。
 */

import { ASR_MODELS, ASR_PARAMS, ASR_PIPELINE_VERSION } from '@/core/shared/constants';
import { AppError, toAppError } from '@/core/shared/errors';
import { createLogger } from '@/core/shared/logger';
import type { OffscreenOutbound } from '@/core/shared/messages';
import { sendToOffscreen } from '@/core/shared/runtime';
import { loadSecrets, loadSettings } from '@/core/shared/settings';
import type { AsrChunkEntity, AsrJobEntity, SessionMeta, TranscriptSegment } from '@/core/shared/types';
import { applyGlossaryToSegments, buildGlossaryPrompt, glossaryVersion, loadMergedGlossary } from '@/core/asr/glossary';
import { sanitizeSegments } from '@/core/asr/postprocess';
import {
  emptyFollowMemory,
  followRangeKey,
  noteFollowCancelled,
  noteFollowDone,
  noteFollowFailed,
  noteFollowStarted,
  noteManualStart,
  tickFollow,
  type FollowMemory,
  type FollowReason,
} from '@/core/asr/follow';
import { checkTierCached } from '@/core/asr/modelCache';
import { chunkInWindow, resolveWindow, windowChunkRange, windowHalfSecFromMinutes } from '@/core/asr/window';
import {
  assembleTranscript,
  clearAsrChunks,
  coveredAudioSec,
  coveredRanges,
  deleteAsrJob,
  getAsrJob,
  listActiveAsrJobs,
  listAsrChunks,
  putAsrChunk,
  putAsrJob,
} from '@/core/db/repo/asr';
import { clearTranscript, getSession, getTranscript, putTranscript } from '@/core/db/repo/content';
import { emitToAll, emitToCour } from './tabs';

const log = createLogger('sw-asr');

type ModelTier = 'fast' | 'standard' | 'high';

interface RunContext {
  job: AsrJobEntity;
  modelTier: ModelTier;
  lastEmit: number;
}

const runs = new Map<number, RunContext>();

/** 片段流式跟进的逐课次记忆（仅内存；SW 回收后自然重置） */
const followMemories = new Map<number, FollowMemory>();
/** 上次决策原因（只在变化时打日志，避免每几秒一条） */
const lastFollowReason = new Map<number, FollowReason>();

// ───────────────────────── 模型下载 / 状态 ─────────────────────────

interface ModelRuntimeState {
  state: 'downloading' | 'ready' | 'error';
  error?: string;
  loaded?: number;
  total?: number;
  file?: string;
  updatedAt: number;
}

/** 模型运行态（下载/加载进度、最近一次失败）；缓存命中以 OPFS 实查为准 */
const modelStates = new Map<ModelTier, ModelRuntimeState>();
/** 已下发 WARMUP、尚未收到 WARMUP_DONE 的档位（事件不带 tier，用 FIFO 对应） */
const pendingWarmups: ModelTier[] = [];

export interface ModelStatusResult {
  cached: boolean;
  bytes?: number;
  files?: number;
  state: 'ready' | 'missing' | 'downloading' | 'error';
  error?: string;
}

/**
 * 触发档位模型的下载 / 加载。
 *
 * Offscreen 协议没有独立的下载 op：WARMUP 会按需下载缺失文件并加载模型，
 * 期间 Offscreen 持续上报 `OFFSCREEN_MODEL_PROGRESS`（→ MODEL_PROGRESS 广播），
 * 完成后 `OFFSCREEN_WARMUP_DONE`（→ MODEL_DONE / MODEL_FAILED 广播）。
 */
export async function downloadModel(tier: ModelTier): Promise<{ started: boolean }> {
  // 同一档位已在下发/下载中：不重复入队（事件仍在持续上报）
  if (modelStates.get(tier)?.state === 'downloading') return { started: true };
  const prev = modelStates.get(tier);
  modelStates.set(tier, {
    state: 'downloading',
    loaded: prev?.loaded ?? 0,
    total: prev?.total ?? 0,
    updatedAt: Date.now(),
  });
  // 不阻塞调用方：下载进度通过事件推送
  void warmup(tier);
  return { started: true };
}

/** 模型缓存实查 + 当前运行态（供设置页/面板展示） */
export async function modelStatus(tier: ModelTier): Promise<ModelStatusResult> {
  const live = modelStates.get(tier);
  let cache: { cached: boolean; bytes?: number; files?: number } | null = null;
  try {
    cache = await checkTierCached(tier);
  } catch (err) {
    log.warn('模型缓存检查失败', err);
  }
  const cached = cache?.cached === true;
  let state: ModelStatusResult['state'];
  if (live?.state === 'downloading') state = 'downloading';
  else if (live?.state === 'error') state = 'error';
  else if (cached) state = 'ready';
  else state = 'missing';
  return {
    cached,
    bytes: cache?.bytes,
    files: cache?.files,
    state,
    error: state === 'error' ? live?.error : undefined,
  };
}

/** 清理某档位的运行态（模型缓存被清空后调用，避免展示过期状态） */
export function invalidateModelState(tier?: ModelTier): void {
  if (tier) modelStates.delete(tier);
  else modelStates.clear();
}

export async function warmup(modelTier?: ModelTier): Promise<void> {
  const tier = modelTier ?? (await loadSettings()).asr.modelTier;
  const prev = modelStates.get(tier);
  modelStates.set(tier, { ...prev, state: 'downloading', error: undefined, updatedAt: Date.now() });
  pendingWarmups.push(tier);
  try {
    await sendToOffscreen({
      type: 'OFFSCREEN_REQUEST',
      op: 'WARMUP',
      payload: { type: 'OFFSCREEN_WARMUP', modelTier: tier },
    });
  } catch (err) {
    // 下发失败：撤销排队并广播失败事件（不阻断主流程）
    const index = pendingWarmups.lastIndexOf(tier);
    if (index >= 0) pendingWarmups.splice(index, 1);
    const appErr = toAppError(err, 'ASR_MODEL_DOWNLOAD_FAILED');
    modelStates.set(tier, { state: 'error', error: appErr.userMessage, updatedAt: Date.now() });
    await emitToAll({ name: 'MODEL_FAILED', data: { tier, error: appErr.toJSON() } });
    log.warn('模型预热失败（不影响主流程）', err);
  }
}

// ───────────────────────── 启动与作业 ─────────────────────────

export interface StartArgs {
  courId: number;
  viewNum?: number;
  modelTier?: ModelTier;
  force?: boolean;
  /** 内容脚本提供的当前播放器时长（兜底，避免为此再打站点接口） */
  durationSec?: number;
  /** 新鲜直链（限时签名，由页面上下文获取后立即使用） */
  audioUrl?: string;
  teclId?: number;
  lang?: 'zh' | 'en' | 'auto';
  /** 当前播放位置（秒）：windowMode='around' 时以它为中心取 ±windowMinutes 分钟窗口 */
  aroundSec?: number;
  /** 覆盖设置中的转写范围（面板按钮 / 学习中心用） */
  windowMode?: 'full' | 'around';
  /** 由"浏览时后台静默跟进"发起：UI 不弹提示，作业标记为自动 */
  auto?: boolean;
}

export async function startTranscription(args: StartArgs): Promise<AsrJobEntity> {
  const { courId } = args;
  const existing = await getAsrJob(courId);
  if (
    existing &&
    (existing.status === 'queued' || existing.status === 'extracting' || existing.status === 'transcribing')
  ) {
    log.info('转写作业已在运行', { courId });
    return existing;
  }

  const settings = await loadSettings();
  const engine = settings.asr.engine ?? 'local';
  const secrets = await loadSecrets();
  if (engine === 'cloud' && !secrets.cloudAsr) {
    throw new AppError('INVALID_INPUT', {
      userMessage: '云端转写尚未配置：请在设置「转写与模型」中选择云端引擎并填写服务地址与 API Key',
      retryable: false,
    });
  }

  if (!args.force) {
    const transcript = await getTranscript(courId);
    // 只有"当前管线版本的完整整段转写"才算缓存命中：片段转写是有意不完整的，
    // 后续窗口要继续累积；旧版本产物可能带时间戳塌陷/幻觉，必须重转（§5.2 B1）。
    // 换引擎后旧引擎的转写不再复用（source 与当前引擎不一致 → 视为未转写）。
    if (
      transcript &&
      transcript.pipelineVersion === ASR_PIPELINE_VERSION &&
      !transcript.partial &&
      transcript.window === undefined &&
      transcript.segments.length > 0 &&
      ((transcript.source === 'cloud-asr' ? 'cloud' : 'local') === engine)
    ) {
      log.info('转写缓存命中', { courId });
      return {
        courId,
        status: 'done',
        viewNum: args.viewNum ?? 1,
        model: transcript.model,
        durationSec: transcript.durationSec ?? 0,
        progress: 1,
        doneChunks: 0,
        totalChunks: 0,
        createdAt: transcript.createdAt,
        updatedAt: Date.now(),
      };
    }
  }

  const session = await getSession(courId).catch(() => null);
  const durationSec = args.durationSec ?? session?.durationSec ?? 0;
  if (!args.audioUrl) {
    throw new AppError('ASR_NETWORK_FAILED', {
      userMessage: '未能获取视频直链，请稍候重试（直链为限时签名，不做缓存）',
      detail: 'audioUrl missing',
      retryable: true,
    });
  }
  if (durationSec <= 0) {
    throw new AppError('INVALID_INPUT', { userMessage: '尚未获取到课次时长，请等待页面加载完成后重试', retryable: true });
  }

  const modelTier = args.modelTier ?? settings.asr.modelTier;
  const lang = args.lang ?? settings.asr.lang;
  const viewNum = args.viewNum ?? 1;
  const totalChunks = Math.max(1, Math.ceil(durationSec / ASR_PARAMS.chunkSec));

  // 片段转写（§5.2 B1，默认）：只转写当前进度前后各 windowMinutes 分钟，
  // 走音轨流式主路径，内存与流量可控；半径来自设置（2–30 分钟），SW/管线/Worker 同口径
  const mode = args.windowMode ?? settings.asr.windowMode;
  const window =
    mode === 'around'
      ? resolveWindow(args.aroundSec, windowHalfSecFromMinutes(settings.asr.windowMinutes), durationSec)
      : undefined;
  const range = window ? windowChunkRange(window, durationSec, ASR_PARAMS.chunkSec) : null;
  const plannedChunks = range ? range.last - range.first + 1 : totalChunks;

  // 强制重转只清"本次计划范围"：整段 = 全部；片段 = 该机位该区间，不误伤其他片段的累积分片
  if (args.force) {
    await clearAsrChunks(
      courId,
      window && range ? { viewNum, fromChunk: range.first, toChunk: range.last } : undefined,
    );
  }

  const doneChunks = (await listAsrChunks(courId))
    // 旧管线产物不复用：时间戳/幻觉问题可能来自旧后处理，必须重新转写
    .filter((c) => c.pipelineVersion === ASR_PIPELINE_VERSION)
    .filter((c) => c.viewNum === viewNum)
    // 分片缓存按引擎隔离：换引擎后旧引擎的分片不再复用（旧记录缺 engine 视为 local）
    .filter((c) => (c.engine ?? 'local') === engine)
    // 窗口作业只接管窗口内的分片，避免与窗口外的旧分片混算进度
    .filter((c) => chunkInWindow(c.chunkIndex, ASR_PARAMS.chunkSec, durationSec, window))
    .map((c) => c.chunkIndex)
    .sort((a, b) => a - b);

  const job: AsrJobEntity = {
    courId,
    status: 'extracting',
    viewNum,
    // 云端引擎记录云端模型名（cloud:{model}），本地引擎记录本地档位模型 ID
    model: engine === 'cloud' ? `cloud:${secrets.cloudAsr?.model ?? 'unknown'}` : ASR_MODELS[modelTier].modelId,
    durationSec,
    progress: Math.min(1, doneChunks.length / plannedChunks),
    doneChunks: doneChunks.length,
    totalChunks: plannedChunks,
    window,
    engine,
    auto: args.auto === true ? true : undefined,
    createdAt: existing?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  };
  await putAsrJob(job);

  const glossary = await loadMergedGlossary(courId);
  const glossaryPrompt = buildGlossaryPrompt(glossary);

  runs.set(courId, { job, modelTier, lastEmit: 0 });

  try {
    await sendToOffscreen({
      type: 'OFFSCREEN_REQUEST',
      op: 'ASR_START',
      payload: {
        type: 'OFFSCREEN_ASR_START',
        courId,
        viewNum,
        audioUrl: args.audioUrl,
        doneChunks,
        totalChunks,
        chunkSec: ASR_PARAMS.chunkSec,
        durationSec,
        modelTier,
        lang,
        glossaryPrompt,
        engine,
        window,
      },
    });
  } catch (err) {
    runs.delete(courId);
    const appErr = toAppError(err, 'ASR_NETWORK_FAILED');
    await putAsrJob({ ...job, status: 'failed', error: appErr.userMessage, errorKind: 'unknown' });
    await emitToCour(courId, { name: 'ASR_FAILED', data: { courId, error: appErr.toJSON(), auto: args.auto === true } });
    throw appErr;
  }

  await emitToCour(courId, { name: 'ASR_PROGRESS', data: { courId, job } });
  // 跟随记忆：自动作业记限流与范围键；手动作业解除"取消抑制"并清退避（用户意图优先）
  const memory = followMemories.get(courId) ?? emptyFollowMemory();
  followMemories.set(
    courId,
    args.auto && range
      ? noteFollowStarted(memory, Date.now(), followRangeKey(range, viewNum))
      : noteManualStart(memory),
  );
  return job;
}

// ───────────────────────── 片段流式跟进 ─────────────────────────

function memoryFor(courId: number): FollowMemory {
  const existing = followMemories.get(courId);
  if (existing) return existing;
  const fresh = emptyFollowMemory();
  followMemories.set(courId, fresh);
  return fresh;
}

export interface FollowArgs {
  courId: number;
  viewNum?: number;
  /** 当前播放位置（秒） */
  aroundSec: number;
  durationSec?: number;
  teclId?: number;
  paused: boolean;
  visible: boolean;
  /** 播放页会话标识（换页/换课次会变化，用于重置跟随时序记忆） */
  sessionId?: string;
}

export interface FollowReply {
  /** true = 可以发起 auto 作业（由调用方补新鲜直链后调 asr.start） */
  start: boolean;
  reason: FollowReason;
  window?: { start: number; end: number };
  /** 窗口内待转分片数 / 窗口内分片总数（UI 与日志可读） */
  missingChunks?: number;
  plannedChunks?: number;
}

/**
 * 片段流式"浏览时跟进"的规划：
 * 读设置与分片覆盖 → 交给决策器 → 更新记忆。内容脚本按节拍调用，仅在 start=true
 * 时去取一条新鲜直链并调用 asr.start（auto=true）。
 */
export async function planFollow(args: FollowArgs): Promise<FollowReply> {
  const settings = await loadSettings();
  const engine = settings.asr.engine ?? 'local';
  const enabled =
    settings.modules.a === true && settings.asr.windowMode === 'around' && settings.asr.streamFollow === true;

  // 整段转写已完成时不需要再跟进：整段作业完成会清掉分片，若此时再跑窗口作业，
  // 增量落库会把完整字幕重建成只剩当前窗口的局部字幕。旧版本整段转写不算完成。
  // 换引擎后旧引擎的完整转写不再视为覆盖（与 startTranscription 的缓存命中同口径）。
  if (enabled) {
    const transcript = await getTranscript(args.courId).catch(() => null);
    if (
      transcript &&
      transcript.pipelineVersion === ASR_PIPELINE_VERSION &&
      !transcript.partial &&
      transcript.window === undefined &&
      transcript.segments.length > 0 &&
      (transcript.source === 'cloud-asr' ? 'cloud' : 'local') === engine
    ) {
      log.debug('整段转写已完成，跳过自动跟进', { courId: args.courId });
      return { start: false, reason: 'covered' };
    }
  }

  const job = await getAsrJob(args.courId);
  const viewNum = args.viewNum ?? job?.viewNum ?? 1;

  let durationSec = args.durationSec ?? job?.durationSec ?? 0;
  if (enabled && !(durationSec > 0)) {
    durationSec = (await getSession(args.courId).catch(() => null))?.durationSec ?? 0;
  }
  let doneChunks: number[] = [];
  if (enabled && durationSec > 0) {
    doneChunks = (await listAsrChunks(args.courId))
      .filter((c) => c.pipelineVersion === ASR_PIPELINE_VERSION)
      .filter((c) => c.viewNum === viewNum)
      // 分片缓存按引擎隔离（与 startTranscription 同口径）
      .filter((c) => (c.engine ?? 'local') === engine)
      .map((c) => c.chunkIndex);
  }

  const decision = tickFollow(
    {
      now: Date.now(),
      settings,
      aroundSec: args.aroundSec,
      paused: args.paused,
      visible: args.visible,
      durationSec,
      jobStatus: job?.status ?? null,
      viewNum,
      doneChunks,
      chunkSec: ASR_PARAMS.chunkSec,
      sessionId: args.sessionId,
    },
    memoryFor(args.courId),
  );
  followMemories.set(args.courId, decision.memory);

  if (decision.start || lastFollowReason.get(args.courId) !== decision.reason) {
    lastFollowReason.set(args.courId, decision.reason);
    log.info('片段跟随时机', { courId: args.courId, reason: decision.reason, missing: decision.missingChunks });
  }

  return {
    start: decision.start,
    reason: decision.reason,
    window: decision.window ?? undefined,
    missingChunks: decision.missingChunks,
    plannedChunks: decision.range ? decision.plannedChunks : undefined,
  };
}

export async function controlTranscription(
  courId: number,
  action: 'pause' | 'resume' | 'cancel',
): Promise<AsrJobEntity | null> {
  const job = await getAsrJob(courId);
  if (!job) return null;
  try {
    await sendToOffscreen({
      type: 'OFFSCREEN_REQUEST',
      op: 'ASR_CONTROL',
      payload: { type: 'OFFSCREEN_ASR_CONTROL', courId, action },
    });
  } catch (err) {
    log.warn('转写控制指令下发失败', err);
  }
  const nextStatus: AsrJobEntity['status'] = action === 'pause' ? 'paused' : action === 'cancel' ? 'cancelled' : 'transcribing';
  const next: AsrJobEntity = { ...job, status: nextStatus, updatedAt: Date.now() };
  await putAsrJob(next);
  if (action === 'cancel') {
    runs.delete(courId);
    // 整段作业取消 = 放弃并清空；片段作业取消 = 只停这一轮，已转分片保留
    // （它们是累积转写的成果，也是"同名分片自动复用"的缓存）
    if (!job.window) {
      await clearAsrChunks(courId);
      await clearPartialTranscript(courId);
    }
    // 抑制一段时间内的自动跟进，避免用户刚点取消又被后台拉起来；
    // 移动播放位置、手动转写或重新打开播放页即恢复
    followMemories.set(courId, noteFollowCancelled(memoryFor(courId), Date.now()));
  }
  await emitToCour(courId, { name: 'ASR_PROGRESS', data: { courId, job: next } });
  return next;
}

// ───────────────────────── Offscreen 事件 ─────────────────────────

/** Offscreen → SW 事件入口；返回 true 表示已处理 */
export async function handleOffscreenEvent(payload: OffscreenOutbound): Promise<boolean> {
  switch (payload.type) {
    case 'OFFSCREEN_READY':
      log.info('Offscreen 文档就绪');
      return true;

    case 'OFFSCREEN_PING_REPLY': {
      await reconcileJobs(payload.activeCourIds);
      return true;
    }

    case 'OFFSCREEN_ASR_PROGRESS': {
      const ctx = runs.get(payload.courId);
      const job = ctx?.job ?? (await getAsrJob(payload.courId));
      if (!job) return true;
      const next: AsrJobEntity = {
        ...job,
        status: payload.phase === 'extracting' ? 'extracting' : 'transcribing',
        progress: Math.max(0, Math.min(1, payload.progress)),
        doneChunks: payload.doneChunks,
        totalChunks: payload.totalChunks,
        rate: payload.rate,
        etaSec: payload.etaSec,
        updatedAt: Date.now(),
      };
      if (ctx) ctx.job = next;
      await putAsrJob(next);
      const now = Date.now();
      if (!ctx || now - ctx.lastEmit > 800 || payload.progress >= 1) {
        if (ctx) ctx.lastEmit = now;
        await emitToCour(payload.courId, { name: 'ASR_PROGRESS', data: { courId: payload.courId, job: next } });
      }
      return true;
    }

    case 'OFFSCREEN_ASR_CHUNK_DONE': {
      // 分片落库带上引擎标记：换引擎后旧分片不再参与组装/续跑（缓存按引擎隔离）
      const jobForChunk = runs.get(payload.courId)?.job ?? (await getAsrJob(payload.courId));
      const chunk: AsrChunkEntity = {
        key: `${payload.courId}:${payload.viewNum}:${payload.chunkIndex}`,
        courId: payload.courId,
        viewNum: payload.viewNum,
        chunkIndex: payload.chunkIndex,
        startSec: payload.startSec,
        endSec: payload.endSec,
        segments: payload.segments,
        createdAt: Date.now(),
        pipelineVersion: ASR_PIPELINE_VERSION,
        engine: jobForChunk?.engine ?? 'local',
      };
      await putAsrChunk(chunk);
      await writePartialTranscript(payload.courId);
      // 片段完成即推送，便于面板/字幕层边转写边显示（window 取当前作业口径）
      const job = runs.get(payload.courId)?.job ?? (await getAsrJob(payload.courId));
      await emitToCour(payload.courId, {
        name: 'ASR_SEGMENTS',
        data: { courId: payload.courId, segments: payload.segments, window: job?.window },
      });
      return true;
    }

    case 'OFFSCREEN_ASR_DONE': {
      let autoJob = false;
      let job: Awaited<ReturnType<typeof getAsrJob>> = null;
      try {
        job = await getAsrJob(payload.courId);
        autoJob = job?.auto === true;
        // 片段作业保留分片（累积转写 + 后续窗口复用）；整段作业完成后分片冗余，照旧清理
        const transcript = await assembleTranscript(
          payload.courId,
          {
            model: payload.model,
            lang: (await loadSettings()).asr.lang,
            durationSec: payload.durationSec,
            window: job?.window,
            engine: job?.engine ?? 'local',
            source: job?.engine === 'cloud' ? 'cloud-asr' : 'local-asr',
          },
          { keepChunks: Boolean(job?.window || job?.auto) },
        );
        if (job) {
          const stats = payload.stats;
          let warning: string | undefined;
          if (stats && stats.audioSec >= 60) {
            if (stats.textLength < 20) {
              warning = `已处理约 ${Math.round(
                stats.audioSec / 60,
              )} 分钟音频，但几乎没有识别到有效语音。请确认当前播放机位是否包含声音（部分机位可能只有画面），或稍后重试。`;
            } else if (stats.coarseSlices > 0) {
              warning = `部分片段的时间戳不稳定，已按 ${ASR_PARAMS.inferSliceSec} 秒粒度对齐；字幕可读，但时间定位可能有偏差。`;
            }
          }
          await putAsrJob({
            ...job,
            status: 'done',
            progress: 1,
            doneChunks: job.totalChunks,
            etaSec: 0,
            warning,
            updatedAt: Date.now(),
          });
        }
        runs.delete(payload.courId);
        if (autoJob) followMemories.set(payload.courId, noteFollowDone(memoryFor(payload.courId)));
        await emitToCour(payload.courId, {
          name: 'ASR_DONE',
          data: {
            courId: payload.courId,
            segmentCount: transcript.segments.length,
            coveredSec: transcript.coveredSec ?? payload.coveredSec,
            auto: autoJob,
          },
        });
      } catch (err) {
        const appErr = toAppError(err, 'ASR_PARSE_FAILED');
        // 组装失败也必须收尾：否则作业永远停在 transcribing，面板显示"停止转写"、
        // 自动跟进也会一直判定 busy。
        runs.delete(payload.courId);
        if (job) {
          await putAsrJob({
            ...job,
            status: 'failed',
            error: appErr.userMessage,
            errorKind: 'unknown',
            updatedAt: Date.now(),
          }).catch(() => undefined);
        }
        if (autoJob) followMemories.set(payload.courId, noteFollowFailed(memoryFor(payload.courId), Date.now()));
        await emitToCour(payload.courId, {
          name: 'ASR_FAILED',
          data: { courId: payload.courId, error: appErr.toJSON(), auto: autoJob },
        });
      }
      return true;
    }

    case 'OFFSCREEN_ASR_FAILED': {
      const job = await getAsrJob(payload.courId);
      if (job) {
        await putAsrJob({
          ...job,
          status: 'failed',
          error: payload.error.userMessage,
          errorKind: payload.errorKind,
          updatedAt: Date.now(),
        });
      }
      runs.delete(payload.courId);
      // 自动作业失败：指数退避后再试（连续多次失败静默停手，移动进度/手动转写可重置）
      if (job?.auto) followMemories.set(payload.courId, noteFollowFailed(memoryFor(payload.courId), Date.now()));
      await emitToCour(payload.courId, {
        name: 'ASR_FAILED',
        data: { courId: payload.courId, error: payload.error, auto: job?.auto === true },
      });
      return true;
    }

    case 'OFFSCREEN_WARMUP_DONE': {
      const tier = pendingWarmups.shift() ?? (await loadSettings()).asr.modelTier;
      log.info('模型预热结果', { ok: payload.ok, device: payload.device, tier });
      if (payload.ok) {
        modelStates.set(tier, { state: 'ready', updatedAt: Date.now() });
        // 面板需要知道"模型是否就绪/设备类型"，统一通过事件广播
        await emitToAll({ name: 'MODEL_DONE', data: { tier } });
      } else {
        const error =
          payload.error ??
          new AppError('ASR_MODEL_DOWNLOAD_FAILED', { detail: '模型下载或加载失败' }).toJSON();
        modelStates.set(tier, { state: 'error', error: error.userMessage, updatedAt: Date.now() });
        await emitToAll({ name: 'MODEL_FAILED', data: { tier, error } });
      }
      return true;
    }

    case 'OFFSCREEN_MODEL_PROGRESS': {
      const prev = modelStates.get(payload.tier);
      modelStates.set(payload.tier, {
        state: 'downloading',
        loaded: payload.loaded,
        total: payload.total,
        file: payload.file,
        error: prev?.error,
        updatedAt: Date.now(),
      });
      // 模型下载/加载进度：广播给所有播放页（面板在设置区展示进度条）
      await emitToAll({
        name: 'MODEL_PROGRESS',
        data: { tier: payload.tier, loaded: payload.loaded, total: payload.total, file: payload.file },
      });
      return true;
    }

    default:
      return false;
  }
}

/** 分片完成后写入 partial 转写，便于面板边转写边显示字幕 */
async function writePartialTranscript(courId: number): Promise<void> {
  try {
    const ctxJob = runs.get(courId)?.job ?? (await getAsrJob(courId));
    const engine = ctxJob?.engine ?? 'local';
    const chunks = (await listAsrChunks(courId)).filter(
      (chunk) => chunk.pipelineVersion === ASR_PIPELINE_VERSION && (chunk.engine ?? 'local') === engine,
    );
    if (chunks.length === 0) return;
    const ctx = runs.get(courId);
    const job = ctx?.job ?? (await getAsrJob(courId));
    const durationSec = job?.durationSec ?? 0;
    const raw: TranscriptSegment[] = chunks
      .flatMap((c) => c.segments)
      .sort((a, b) => a.s - b.s)
      .map((s) => ({
        s: s.s,
        e: Math.max(s.e, s.s),
        text: s.text.trim(),
        ...(s.coarse ? { coarse: true } : {}),
      }))
      .filter((s) => s.text.length > 0);
    const glossary = await loadMergedGlossary(courId);
    const corrected = applyGlossaryToSegments(raw, glossary);
    // 双保险：即使上游漏过滤，也不把重复标点/“谢谢观看”一类幻觉写进字幕
    const { segments } = sanitizeSegments(corrected);
    // 空片段（静音/解码结果为空）不落库：否则会把已有字幕覆盖成空记录，
    // 表现为"转写正常但提问说没有字幕文本"。
    if (segments.length === 0) {
      const existing = await getTranscript(courId);
      // 同版本且已有文字：本次只是静音窗口，保留原字幕；
      // 无记录或旧管线记录：写入空转写 + 覆盖区间，让问答能区分"没转写"和"没有语音"，
      // 同时清掉旧管线留下的错误字幕。
      if (existing?.segments.length && existing.pipelineVersion === ASR_PIPELINE_VERSION) {
        // 保留已有字幕，但覆盖区间必须更新：静音区段也算“已处理”，
        // 否则问答会把刚看过的静音区误判为“还没转写”。
        await putTranscript({
          ...existing,
          coveredSec: coveredAudioSec(chunks, durationSec),
          coverage: coveredRanges(chunks, durationSec),
          durationSec,
          pipelineVersion: ASR_PIPELINE_VERSION,
        });
        log.info('分片尚无有效文字，保留已有字幕并更新覆盖区间', { courId, chunks: chunks.length });
        return;
      }
      await putTranscript({
        courId,
        segments: [],
        model: job?.model ?? 'unknown',
        lang: (await loadSettings()).asr.lang,
        glossaryVersion: glossaryVersion(glossary),
        createdAt: existing?.createdAt ?? Date.now(),
        source: engine === 'cloud' ? 'cloud-asr' : 'local-asr',
        coveredSec: coveredAudioSec(chunks, durationSec),
        coverage: coveredRanges(chunks, durationSec),
        durationSec,
        partial: true,
        window: job?.window,
        pipelineVersion: ASR_PIPELINE_VERSION,
      });
      return;
    }
    const existing = await getTranscript(courId);
    await putTranscript({
      courId,
      segments,
      model: job?.model ?? 'unknown',
      lang: (await loadSettings()).asr.lang,
      glossaryVersion: glossaryVersion(glossary),
      createdAt: existing?.createdAt ?? Date.now(),
      source: engine === 'cloud' ? 'cloud-asr' : 'local-asr',
      coveredSec: coveredAudioSec(chunks, durationSec),
      coverage: coveredRanges(chunks, durationSec),
      durationSec,
      partial: true,
      window: job?.window,
      pipelineVersion: ASR_PIPELINE_VERSION,
    });
  } catch (err) {
    log.warn('分片增量落库失败', err);
  }
}

async function clearPartialTranscript(courId: number): Promise<void> {
  try {
    const existing = await getTranscript(courId);
    if (existing?.partial) await clearTranscript(courId);
  } catch {
    /* 忽略 */
  }
}

/**
 * SW 重启后的作业状态对账：Offscreen 仍在跑的作业保持原状，
 * 其余"进行中"的作业标记为中断可续跑（§5.3）。
 */
async function reconcileJobs(activeCourIds: number[]): Promise<void> {
  try {
    const active = await listActiveAsrJobs();
    const activeSet = new Set(activeCourIds);
    for (const job of active) {
      if (activeSet.has(job.courId)) continue;
      await putAsrJob({
        ...job,
        status: 'paused',
        error: '任务因后台或浏览器重启而中断，可点击继续',
        updatedAt: Date.now(),
      });
    }
    if (active.length > 0) log.info(`作业状态对账完成（进行中 ${active.length} 个，存活 ${activeSet.size} 个）`);
  } catch (err) {
    log.warn('作业状态对账失败', err);
  }
}

/** 启动时对账：向 Offscreen 询问存活作业 */
export async function reconcileJobsOnStartup(): Promise<void> {
  try {
    try {
      await sendToOffscreen({ type: 'OFFSCREEN_REQUEST', op: 'PING', payload: { type: 'OFFSCREEN_PING' } });
    } catch {
      // Offscreen 刚创建时监听器可能尚未注册完成：短暂等待后重试一次
      await new Promise((resolve) => setTimeout(resolve, 250));
      await sendToOffscreen({ type: 'OFFSCREEN_REQUEST', op: 'PING', payload: { type: 'OFFSCREEN_PING' } });
    }
  } catch (err) {
    // Offscreen 起不来（例如刚安装）：把所有进行中的作业标记为中断
    const active = await listActiveAsrJobs().catch(() => []);
    for (const job of active) {
      await putAsrJob({ ...job, status: 'paused', error: '任务已中断，可点击继续', updatedAt: Date.now() });
    }
    log.warn('Offscreen 不可用，作业已标记为中断', err);
  }
}

/** 由会话元数据推导转写输入（内容脚本只传 courId 时的兜底路径） */
export function buildStartArgsFromMeta(meta: SessionMeta, viewNum?: number): StartArgs {
  const view = meta.views.find((v) => v.viewNum === viewNum) ?? meta.views[0];
  return {
    courId: meta.courId,
    teclId: meta.teclId,
    viewNum: view?.viewNum ?? viewNum ?? 1,
    durationSec: meta.durationSec,
    audioUrl: view?.url,
  };
}

export async function resetJob(courId: number): Promise<void> {
  runs.delete(courId);
  followMemories.delete(courId);
  lastFollowReason.delete(courId);
  await deleteAsrJob(courId);
  await clearAsrChunks(courId);
}
