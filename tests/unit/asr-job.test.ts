/**
 * ASR 作业状态机测试（SW 侧编排，entrypoints/background/asr.ts）：
 *  - 作业创建 → 进行中（extracting/transcribing）→ 完成/失败 的状态迁移与落库；
 *  - 重复消息（重复 start / 重复进度 / 重复完成）的幂等边界；
 *  - SW 重启后的续跑对账（PING_REPLY / reconcileJobsOnStartup）；
 *  - 异常路径不卡死（组装失败也要收尾）。
 *
 * 仓储层走真实 fake-indexeddb；Offscreen 下发与标签页事件推送用桩替换。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ASR_MODELS, ASR_PARAMS, ASR_PIPELINE_VERSION } from '@/core/shared/constants';
import type { OffscreenOutbound, OffscreenRequestEnvelope } from '@/core/shared/messages';
import { hduCourIdOf, hduMediaKey, type MediaKey } from '@/core/shared/mediaRef';
import type { AsrChunkEntity, AsrJobEntity, SessionMeta } from '@/core/shared/types';
import { getDb } from '@/core/db';
import { chunkKey, getAsrJob, listAsrChunks, putAsrChunk, putAsrJob } from '@/core/db/repo/asr';
import { getTranscript, putTranscript } from '@/core/db/repo/content';
import {
  buildStartArgsFromMeta,
  controlTranscription,
  handleOffscreenEvent,
  reconcileJobsOnStartup,
  resetJob,
  startTranscription,
  type StartArgs,
} from '@/entrypoints/background/asr';

// ───────────────────────── 桩：Offscreen 下发 / 事件推送 ─────────────────────────

const mocks = vi.hoisted(() => ({
  sendToOffscreen: vi.fn(),
  emitToCour: vi.fn(),
  emitToAll: vi.fn(),
}));

vi.mock('@/core/shared/runtime', () => ({
  sendToOffscreen: mocks.sendToOffscreen,
}));

vi.mock('@/entrypoints/background/tabs', () => ({
  emitToCour: mocks.emitToCour,
  emitToAll: mocks.emitToAll,
}));

// ───────────────────────── 测试基建 ─────────────────────────

const usedKeys: MediaKey[] = [];
function keyFor(courId: number): MediaKey {
  const key = hduMediaKey(courId);
  if (!usedKeys.includes(key)) usedKeys.push(key);
  return key;
}

beforeEach(async () => {
  const db = await getDb();
  for (const store of ['asrJobs', 'asrChunks', 'transcripts', 'sessions', 'courses', 'kv'] as const) {
    await db.clear(store);
  }
  mocks.sendToOffscreen.mockReset();
  mocks.sendToOffscreen.mockImplementation(async () => undefined);
  mocks.emitToCour.mockReset();
  mocks.emitToCour.mockImplementation(async () => undefined);
  mocks.emitToAll.mockReset();
  mocks.emitToAll.mockImplementation(async () => undefined);
});

afterEach(async () => {
  for (const key of usedKeys.splice(0)) await resetJob(key);
});

function startArgs(mediaKey: MediaKey, overrides: Partial<StartArgs> = {}): StartArgs {
  return {
    mediaKey,
    audioUrl: 'https://media.example.com/audio.m3u8',
    durationSec: 1200,
    windowMode: 'full',
    ...overrides,
  };
}

function makeJob(mediaKey: MediaKey, overrides: Partial<AsrJobEntity> = {}): AsrJobEntity {
  return {
    mediaKey,
    courId: hduCourIdOf(mediaKey),
    status: 'transcribing',
    viewNum: 1,
    model: ASR_MODELS.standard.modelId,
    durationSec: 1200,
    progress: 0.5,
    doneChunks: 1,
    totalChunks: 2,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function makeChunk(mediaKey: MediaKey, chunkIndex: number, overrides: Partial<AsrChunkEntity> = {}): AsrChunkEntity {
  const viewNum = overrides.viewNum ?? 1;
  return {
    key: chunkKey(mediaKey, viewNum, chunkIndex),
    mediaKey,
    courId: hduCourIdOf(mediaKey),
    viewNum,
    chunkIndex,
    startSec: chunkIndex * ASR_PARAMS.chunkSec,
    endSec: (chunkIndex + 1) * ASR_PARAMS.chunkSec,
    segments: [{ s: chunkIndex * ASR_PARAMS.chunkSec, e: chunkIndex * ASR_PARAMS.chunkSec + 10, text: `片段${chunkIndex}` }],
    createdAt: 1000,
    pipelineVersion: ASR_PIPELINE_VERSION,
    ...overrides,
  };
}

type AsrProgressEvent = Extract<OffscreenOutbound, { type: 'OFFSCREEN_ASR_PROGRESS' }>;
type AsrChunkDoneEvent = Extract<OffscreenOutbound, { type: 'OFFSCREEN_ASR_CHUNK_DONE' }>;
type AsrDoneEvent = Extract<OffscreenOutbound, { type: 'OFFSCREEN_ASR_DONE' }>;

function progressEvent(mediaKey: MediaKey, overrides: Partial<Omit<AsrProgressEvent, 'type'>> = {}): OffscreenOutbound {
  return { type: 'OFFSCREEN_ASR_PROGRESS', mediaKey, phase: 'transcribing', progress: 0.5, doneChunks: 1, totalChunks: 2, ...overrides };
}

function chunkDoneEvent(mediaKey: MediaKey, chunkIndex: number, overrides: Partial<Omit<AsrChunkDoneEvent, 'type'>> = {}): OffscreenOutbound {
  return {
    type: 'OFFSCREEN_ASR_CHUNK_DONE',
    mediaKey,
    viewNum: 1,
    chunkIndex,
    startSec: chunkIndex * ASR_PARAMS.chunkSec,
    endSec: (chunkIndex + 1) * ASR_PARAMS.chunkSec,
    segments: [{ s: chunkIndex * ASR_PARAMS.chunkSec, e: chunkIndex * ASR_PARAMS.chunkSec + 10, text: `片段${chunkIndex}` }],
    ...overrides,
  };
}

function doneEvent(mediaKey: MediaKey, overrides: Partial<Omit<AsrDoneEvent, 'type'>> = {}): OffscreenOutbound {
  return {
    type: 'OFFSCREEN_ASR_DONE',
    mediaKey,
    segmentCount: 2,
    coveredSec: 1200,
    model: ASR_MODELS.standard.modelId,
    durationSec: 1200,
    stats: { audioSec: 1200, speechSec: 1000, silentSec: 200, droppedSegments: 0, textLength: 100, coarseSlices: 0, segmentCount: 2 },
    ...overrides,
  };
}

interface EmittedCall {
  mediaKey: MediaKey;
  data: Record<string, any>;
}

function callsNamed(name: string): EmittedCall[] {
  return mocks.emitToCour.mock.calls
    .filter((call) => (call[1] as { name: string }).name === name)
    .map((call) => ({ mediaKey: call[0] as MediaKey, data: (call[1] as { data: Record<string, any> }).data }));
}

function lastOffscreenMessage(): OffscreenRequestEnvelope {
  const call = mocks.sendToOffscreen.mock.calls.at(-1)?.[0] as OffscreenRequestEnvelope;
  expect(call?.type).toBe('OFFSCREEN_REQUEST');
  return call;
}

// ───────────────────────── 作业创建 ─────────────────────────

describe('startTranscription（作业创建）', () => {
  it('整段作业：创建 extracting 作业并按 ASR_START 协议下发 Offscreen', async () => {
    const mediaKey = keyFor(101);
    const job = await startTranscription(startArgs(mediaKey, { viewNum: 2 }));

    expect(job.status).toBe('extracting');
    expect(job.mediaKey).toBe(mediaKey);
    expect(job.courId).toBe(101);
    expect(job.viewNum).toBe(2);
    expect(job.model).toBe(ASR_MODELS.standard.modelId);
    expect(job.durationSec).toBe(1200);
    expect(job.totalChunks).toBe(2); // ceil(1200 / 600)
    expect(job.doneChunks).toBe(0);
    expect(job.progress).toBe(0);
    expect(job.window).toBeUndefined();
    expect(job.auto).toBeUndefined();

    const stored = await getAsrJob(mediaKey);
    expect(stored).not.toBeNull();
    expect(stored?.status).toBe('extracting');

    expect(mocks.sendToOffscreen).toHaveBeenCalledTimes(1);
    const message = lastOffscreenMessage();
    expect(message.op).toBe('ASR_START');
    const payload = message.payload as unknown as Record<string, unknown>;
    expect(payload).toMatchObject({
      type: 'OFFSCREEN_ASR_START',
      mediaKey,
      viewNum: 2,
      audioUrl: 'https://media.example.com/audio.m3u8',
      totalChunks: 2,
      chunkSec: ASR_PARAMS.chunkSec,
      durationSec: 1200,
      modelTier: 'standard',
      lang: 'zh',
    });
    expect(payload.window).toBeUndefined();
    expect(typeof payload.glossaryPrompt).toBe('string');

    // 创建后立即广播一次进度
    const progressEvents = callsNamed('ASR_PROGRESS');
    expect(progressEvents).toHaveLength(1);
    expect(progressEvents[0]?.mediaKey).toBe(mediaKey);
    expect(progressEvents[0]?.data.job).toMatchObject({ status: 'extracting', progress: 0 });
  });

  it.each(['queued', 'extracting', 'transcribing'] as const)('已有进行中作业（%s）时重复发起 → 幂等返回原作业', async (status) => {
    const mediaKey = keyFor(102);
    const existing = makeJob(mediaKey, { status, progress: 0.5 });
    await putAsrJob(existing);

    const before = mocks.sendToOffscreen.mock.calls.length;
    const job = await startTranscription(startArgs(mediaKey));

    expect(job.mediaKey).toBe(mediaKey);
    expect(job.status).toBe(status);
    expect(job.progress).toBe(0.5);
    expect(mocks.sendToOffscreen.mock.calls.length).toBe(before);
    expect(mocks.emitToCour).not.toHaveBeenCalled();
  });

  it('当前管线的完整整段转写命中缓存 → 直接返回 done，不重新转写', async () => {
    const mediaKey = keyFor(103);
    await putTranscript({
      mediaKey,
      courId: 103,
      segments: [{ s: 0, e: 10, text: '缓存字幕' }],
      model: 'm',
      lang: 'zh',
      glossaryVersion: 1,
      createdAt: 1000,
      source: 'local-asr',
      pipelineVersion: ASR_PIPELINE_VERSION,
      durationSec: 1200,
    });

    const job = await startTranscription(startArgs(mediaKey));

    expect(job.status).toBe('done');
    expect(job.progress).toBe(1);
    expect(job.totalChunks).toBe(0);
    expect(mocks.sendToOffscreen).not.toHaveBeenCalled();
  });

  it('旧管线版本的转写不命中缓存 → 重新发起作业', async () => {
    const mediaKey = keyFor(104);
    await putTranscript({
      mediaKey,
      courId: 104,
      segments: [{ s: 0, e: 10, text: '旧字幕' }],
      model: 'm',
      lang: 'zh',
      glossaryVersion: 1,
      createdAt: 1000,
      source: 'local-asr',
      pipelineVersion: ASR_PIPELINE_VERSION - 1,
      durationSec: 1200,
    });

    const job = await startTranscription(startArgs(mediaKey));
    expect(job.status).toBe('extracting');
    expect(mocks.sendToOffscreen).toHaveBeenCalledTimes(1);
  });

  it('片段模式：窗口内已完成分片计入进度，Offscreen 载荷带窗口与分片清单', async () => {
    const mediaKey = keyFor(105);
    for (let index = 0; index < 6; index += 1) await putAsrChunk(makeChunk(mediaKey, index));

    const job = await startTranscription(
      startArgs(mediaKey, { durationSec: 3600, windowMode: 'around', aroundSec: 1800, auto: true }),
    );

    // 窗口 [1200, 2400] → 分片 2、3
    expect(job.window).toEqual({ start: 1200, end: 2400 });
    expect(job.totalChunks).toBe(2); // 计划内（窗口）分片数
    expect(job.doneChunks).toBe(2);
    expect(job.progress).toBe(1);
    expect(job.auto).toBe(true);

    const payload = lastOffscreenMessage().payload as unknown as Record<string, unknown>;
    expect(payload.doneChunks).toEqual([2, 3]);
    expect(payload.totalChunks).toBe(6); // 整段分片总数（口径与 job.totalChunks 不同）
    expect(payload.window).toEqual({ start: 1200, end: 2400 });
  });

  it('片段模式：其他机位与旧管线版本的分片不接管', async () => {
    const mediaKey = keyFor(106);
    // 窗口内的“坏”分片：旧管线版本（index 2）、其他机位（index 3）
    await putAsrChunk(makeChunk(mediaKey, 2, { pipelineVersion: ASR_PIPELINE_VERSION - 1 }));
    await putAsrChunk(makeChunk(mediaKey, 3, { viewNum: 2, key: chunkKey(mediaKey, 2, 3) }));

    const job = await startTranscription(startArgs(mediaKey, { durationSec: 3600, windowMode: 'around', aroundSec: 1800 }));

    expect(job.doneChunks).toBe(0);
    expect(job.progress).toBe(0);
    const payload = lastOffscreenMessage().payload as unknown as Record<string, unknown>;
    expect(payload.doneChunks).toEqual([]);
  });

  it('force 重转（片段模式）只清理本次窗口范围的分片', async () => {
    const mediaKey = keyFor(107);
    for (let index = 0; index < 6; index += 1) await putAsrChunk(makeChunk(mediaKey, index));

    const job = await startTranscription(
      startArgs(mediaKey, { force: true, durationSec: 3600, windowMode: 'around', aroundSec: 1800 }),
    );

    const remaining = await listAsrChunks(mediaKey);
    expect(remaining.map((chunk) => chunk.chunkIndex)).toEqual([0, 1, 4, 5]); // 窗口内 2、3 被清除
    expect(job.doneChunks).toBe(0);
    expect(job.progress).toBe(0);
  });

  it('force 重转（整段）清空该媒体全部分片', async () => {
    const mediaKey = keyFor(108);
    for (let index = 0; index < 3; index += 1) await putAsrChunk(makeChunk(mediaKey, index));

    await startTranscription(startArgs(mediaKey, { force: true }));

    expect(await listAsrChunks(mediaKey)).toHaveLength(0);
  });

  it('缺少直链 → ASR_NETWORK_FAILED，且不落库', async () => {
    const mediaKey = keyFor(109);
    await expect(startTranscription({ mediaKey, durationSec: 1200, windowMode: 'full' })).rejects.toMatchObject({
      code: 'ASR_NETWORK_FAILED',
      retryable: true,
    });
    expect(await getAsrJob(mediaKey)).toBeNull();
  });

  it('缺少时长 → INVALID_INPUT', async () => {
    const mediaKey = keyFor(110);
    await expect(startTranscription(startArgs(mediaKey, { durationSec: 0 }))).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(await getAsrJob(mediaKey)).toBeNull();
  });

  it('Offscreen 下发失败 → 作业标记 failed 并广播 ASR_FAILED', async () => {
    const mediaKey = keyFor(111);
    mocks.sendToOffscreen.mockRejectedValueOnce(new Error('offscreen gone'));

    await expect(startTranscription(startArgs(mediaKey))).rejects.toMatchObject({ code: 'ASR_NETWORK_FAILED' });

    const stored = await getAsrJob(mediaKey);
    expect(stored?.status).toBe('failed');
    expect(stored?.errorKind).toBe('unknown');
    expect(stored?.error).toBe('音频拉取中断，请检查网络后继续');

    const failedEvents = callsNamed('ASR_FAILED');
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]?.mediaKey).toBe(mediaKey);
    expect(failedEvents[0]?.data.auto).toBe(false);
  });

  it('failed 作业可重新发起（保留原始 createdAt）', async () => {
    const mediaKey = keyFor(112);
    await putAsrJob(makeJob(mediaKey, { status: 'failed', createdAt: 12345 }));

    const job = await startTranscription(startArgs(mediaKey));

    expect(job.status).toBe('extracting');
    expect(job.createdAt).toBe(12345);
  });
});

// ───────────────────────── 进度事件 ─────────────────────────

describe('handleOffscreenEvent：OFFSCREEN_ASR_PROGRESS', () => {
  it('extracting/transcribing 迁移、进度落库、节流与 progress>=1 立即推送', async () => {
    let now = 1_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const mediaKey = keyFor(201);
      await startTranscription(startArgs(mediaKey));
      expect(callsNamed('ASR_PROGRESS')).toHaveLength(1); // start 时广播过一次

      // 1) transcribing 阶段：状态与速率落库并推送
      now += 5_000;
      await handleOffscreenEvent(progressEvent(mediaKey, { phase: 'transcribing', progress: 0.5, rate: 2.5, etaSec: 30 }));
      expect(await getAsrJob(mediaKey)).toMatchObject({
        status: 'transcribing',
        progress: 0.5,
        doneChunks: 1,
        totalChunks: 2,
        rate: 2.5,
        etaSec: 30,
      });
      expect(callsNamed('ASR_PROGRESS')).toHaveLength(2);

      // 2) 800ms 内的重复进度：状态仍落库，但不重复推送（幂等节流）
      now += 100;
      await handleOffscreenEvent(progressEvent(mediaKey, { progress: 0.6 }));
      expect((await getAsrJob(mediaKey))?.progress).toBe(0.6);
      expect(callsNamed('ASR_PROGRESS')).toHaveLength(2);

      // 3) progress 越界夹取到 [0,1]；progress>=1 时绕过节流立即推送
      now += 100;
      await handleOffscreenEvent(progressEvent(mediaKey, { progress: 5, doneChunks: 2 }));
      expect((await getAsrJob(mediaKey))?.progress).toBe(1);
      expect(callsNamed('ASR_PROGRESS')).toHaveLength(3);

      // 4) phase → status 映射是二元的：仅 'extracting' 归为 extracting，其余阶段均为 transcribing
      now += 100;
      await handleOffscreenEvent(progressEvent(mediaKey, { phase: 'extracting', progress: 0.1, doneChunks: 0 }));
      const stored = await getAsrJob(mediaKey);
      expect(stored?.status).toBe('extracting');
      expect(stored?.progress).toBe(0.1);
      expect(callsNamed('ASR_PROGRESS')).toHaveLength(3); // 仍在节流窗口内
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('未知媒体的进度事件安全忽略（不落库、不推送、返回 true）', async () => {
    const unknown = hduMediaKey(99999);
    const handled = await handleOffscreenEvent(progressEvent(unknown));
    expect(handled).toBe(true);
    expect(await getAsrJob(unknown)).toBeNull();
    expect(callsNamed('ASR_PROGRESS')).toHaveLength(0);
  });
});

// ───────────────────────── 分片完成 / 整体完成 ─────────────────────────

describe('handleOffscreenEvent：分片与完成事件', () => {
  it('OFFSCREEN_ASR_CHUNK_DONE：分片落库 + partial 转写增量更新 + ASR_SEGMENTS 推送', async () => {
    const mediaKey = keyFor(202);
    await startTranscription(startArgs(mediaKey));

    await handleOffscreenEvent(chunkDoneEvent(mediaKey, 0, { segments: [{ s: 0, e: 8, text: '你好世界' }] }));

    const chunks = await listAsrChunks(mediaKey);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      mediaKey,
      courId: 202,
      viewNum: 1,
      chunkIndex: 0,
      startSec: 0,
      endSec: 600,
      pipelineVersion: ASR_PIPELINE_VERSION,
    });
    expect(chunks[0]?.key).toBe(chunkKey(mediaKey, 1, 0));

    const transcript = await getTranscript(mediaKey);
    expect(transcript?.partial).toBe(true);
    expect(transcript?.pipelineVersion).toBe(ASR_PIPELINE_VERSION);
    expect(transcript?.segments).toEqual([{ s: 0, e: 8, text: '你好世界' }]);
    expect(transcript?.coveredSec).toBe(600);
    expect(transcript?.durationSec).toBe(1200);

    const segmentEvents = callsNamed('ASR_SEGMENTS');
    expect(segmentEvents).toHaveLength(1);
    expect(segmentEvents[0]?.mediaKey).toBe(mediaKey);
    expect(segmentEvents[0]?.data.segments).toEqual([{ s: 0, e: 8, text: '你好世界' }]);
    expect(segmentEvents[0]?.data.window).toBeUndefined();
  });

  it('OFFSCREEN_ASR_DONE：done 状态 + 合并转写落库 + 整段分片清理 + ASR_DONE 推送', async () => {
    const mediaKey = keyFor(203);
    await startTranscription(startArgs(mediaKey));
    await handleOffscreenEvent(chunkDoneEvent(mediaKey, 0));
    await handleOffscreenEvent(chunkDoneEvent(mediaKey, 1));

    await handleOffscreenEvent(doneEvent(mediaKey));

    const stored = await getAsrJob(mediaKey);
    expect(stored?.status).toBe('done');
    expect(stored?.progress).toBe(1);
    expect(stored?.doneChunks).toBe(stored?.totalChunks);
    expect(stored?.etaSec).toBe(0);
    expect(stored?.warning).toBeUndefined();

    const transcript = await getTranscript(mediaKey);
    expect(transcript?.partial).toBe(false);
    expect(transcript?.window).toBeUndefined();
    expect(transcript?.segments.map((segment) => segment.text)).toEqual(['片段0', '片段1']);
    expect(transcript?.coveredSec).toBe(1200);
    expect(transcript?.lang).toBe('zh');

    // 整段作业完成后分片冗余，照旧清理
    expect(await listAsrChunks(mediaKey)).toHaveLength(0);

    const doneEvents = callsNamed('ASR_DONE');
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0]?.mediaKey).toBe(mediaKey);
    expect(doneEvents[0]?.data.segmentCount).toBe(2);
    expect(doneEvents[0]?.data.coveredSec).toBe(1200);
    expect(doneEvents[0]?.data.auto).toBe(false);
  });

  it('完成事件质量提示：几乎无有效语音时给出 warning', async () => {
    const mediaKey = keyFor(204);
    await startTranscription(startArgs(mediaKey));
    await handleOffscreenEvent(chunkDoneEvent(mediaKey, 0, { segments: [{ s: 0, e: 5, text: '嗯' }] }));

    await handleOffscreenEvent(
      doneEvent(mediaKey, {
        stats: { audioSec: 1200, speechSec: 10, silentSec: 1190, droppedSegments: 0, textLength: 1, coarseSlices: 0, segmentCount: 1 },
      }),
    );

    const stored = await getAsrJob(mediaKey);
    expect(stored?.status).toBe('done');
    expect(stored?.warning).toContain('没有识别到有效语音');
  });

  it('完成事件质量提示：时间戳塌陷时给出 coarse 提示', async () => {
    const mediaKey = keyFor(205);
    await startTranscription(startArgs(mediaKey));
    await handleOffscreenEvent(chunkDoneEvent(mediaKey, 0));
    await handleOffscreenEvent(chunkDoneEvent(mediaKey, 1));

    await handleOffscreenEvent(
      doneEvent(mediaKey, {
        stats: { audioSec: 1200, speechSec: 1000, silentSec: 200, droppedSegments: 0, textLength: 100, coarseSlices: 3, segmentCount: 2 },
      }),
    );

    const stored = await getAsrJob(mediaKey);
    expect(stored?.status).toBe('done');
    expect(stored?.warning).toContain('时间戳不稳定');
  });

  it('完成事件组装失败（无分片）→ 作业收尾为 failed，不卡死', async () => {
    const mediaKey = keyFor(206);
    await startTranscription(startArgs(mediaKey));
    // 不产生任何分片直接 DONE：assembleTranscript 必然失败
    await handleOffscreenEvent(doneEvent(mediaKey));

    const stored = await getAsrJob(mediaKey);
    expect(stored?.status).toBe('failed');
    expect(stored?.errorKind).toBe('unknown');
    expect(stored?.error).toContain('解析失败');

    const failedEvents = callsNamed('ASR_FAILED');
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]?.mediaKey).toBe(mediaKey);
  });

  it('重复完成事件（整段分片已清理）幂等：保持 done、不广播失败、转写不被破坏', async () => {
    const mediaKey = keyFor(207);
    await startTranscription(startArgs(mediaKey));
    await handleOffscreenEvent(chunkDoneEvent(mediaKey, 0));
    await handleOffscreenEvent(doneEvent(mediaKey));
    expect((await getAsrJob(mediaKey))?.status).toBe('done');
    const transcriptBefore = await getTranscript(mediaKey);
    const doneCount = callsNamed('ASR_DONE').length;
    const failedCount = callsNamed('ASR_FAILED').length;

    // 同一 DONE 重复投递：作业已 done → 幂等忽略（不重新组装、不翻转 failed、不重复广播）
    const handled = await handleOffscreenEvent(doneEvent(mediaKey));

    expect(handled).toBe(true);
    const stored = await getAsrJob(mediaKey);
    expect(stored?.status).toBe('done');
    expect(stored?.progress).toBe(1);
    expect(callsNamed('ASR_DONE')).toHaveLength(doneCount);
    expect(callsNamed('ASR_FAILED')).toHaveLength(failedCount);
    expect(await getTranscript(mediaKey)).toEqual(transcriptBefore);
    expect(await listAsrChunks(mediaKey)).toHaveLength(0);
  });

  it('片段作业完成后保留分片，重复完成事件幂等', async () => {
    const mediaKey = keyFor(208);
    await startTranscription(startArgs(mediaKey, { durationSec: 3600, windowMode: 'around', aroundSec: 1800 }));
    await handleOffscreenEvent(chunkDoneEvent(mediaKey, 2));
    await handleOffscreenEvent(doneEvent(mediaKey, { durationSec: 3600, coveredSec: 600 }));

    expect((await getAsrJob(mediaKey))?.status).toBe('done');
    expect(await listAsrChunks(mediaKey)).toHaveLength(1); // 片段作业保留分片（累积转写）
    expect(callsNamed('ASR_SEGMENTS')[0]?.data.window).toEqual({ start: 1200, end: 2400 });
    const transcriptBefore = await getTranscript(mediaKey);
    const doneCount = callsNamed('ASR_DONE').length;

    // 作业已 done：即使分片还在（理论上可重新组装），重复 DONE 也直接幂等忽略
    const handled = await handleOffscreenEvent(doneEvent(mediaKey, { durationSec: 3600, coveredSec: 600 }));

    expect(handled).toBe(true);
    expect((await getAsrJob(mediaKey))?.status).toBe('done');
    expect(await listAsrChunks(mediaKey)).toHaveLength(1);
    expect(callsNamed('ASR_DONE')).toHaveLength(doneCount);
    expect(await getTranscript(mediaKey)).toEqual(transcriptBefore);
  });

  it('OFFSCREEN_ASR_FAILED：failed 状态 + 错误分类落库 + auto 标记透传', async () => {
    const mediaKey = keyFor(209);
    await putAsrJob(makeJob(mediaKey, { status: 'transcribing', auto: true }));

    const handled = await handleOffscreenEvent({
      type: 'OFFSCREEN_ASR_FAILED',
      mediaKey,
      error: { code: 'ASR_DECODE_FAILED', userMessage: '音频解码失败，该节次可能使用了不支持的编码', retryable: false },
      errorKind: 'decode',
    });

    expect(handled).toBe(true);
    const stored = await getAsrJob(mediaKey);
    expect(stored?.status).toBe('failed');
    expect(stored?.error).toContain('解码失败');
    expect(stored?.errorKind).toBe('decode');

    const failedEvents = callsNamed('ASR_FAILED');
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]?.data.auto).toBe(true);
  });

  it('未知媒体的失败事件：不落库、不崩溃，仍广播 ASR_FAILED', async () => {
    const unknown = hduMediaKey(99998);
    const handled = await handleOffscreenEvent({
      type: 'OFFSCREEN_ASR_FAILED',
      mediaKey: unknown,
      error: { code: 'ASR_INFER_FAILED', userMessage: '推理失败', retryable: true },
      errorKind: 'model',
    });

    expect(handled).toBe(true);
    expect(await getAsrJob(unknown)).toBeNull();
    const failedEvents = callsNamed('ASR_FAILED');
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]?.mediaKey).toBe(unknown);
    expect(failedEvents[0]?.data.auto).toBe(false);
  });
});

// ───────────────────────── 终态覆盖防护（cancelled 幂等） ─────────────────────────

describe('handleOffscreenEvent：cancelled 终态不被迟到事件改写', () => {
  it('cancelled 作业收到迟到的失败事件：保持 cancelled、不广播', async () => {
    const mediaKey = keyFor(224);
    await putAsrJob(makeJob(mediaKey, { status: 'cancelled' }));

    const handled = await handleOffscreenEvent({
      type: 'OFFSCREEN_ASR_FAILED',
      mediaKey,
      error: { code: 'ASR_INFER_FAILED', userMessage: '推理失败', retryable: true },
      errorKind: 'model',
    });

    expect(handled).toBe(true);
    const stored = await getAsrJob(mediaKey);
    expect(stored?.status).toBe('cancelled');
    expect(stored?.error).toBeUndefined();
    expect(stored?.errorKind).toBeUndefined();
    expect(callsNamed('ASR_FAILED')).toHaveLength(0);
  });

  it('cancelled 整段作业收到迟到的完成事件：保持 cancelled、不重组装、不广播', async () => {
    const mediaKey = keyFor(225);
    // 整段作业取消时已清空分片
    await putAsrJob(makeJob(mediaKey, { status: 'cancelled' }));

    const handled = await handleOffscreenEvent(doneEvent(mediaKey));

    expect(handled).toBe(true);
    const stored = await getAsrJob(mediaKey);
    expect(stored?.status).toBe('cancelled');
    expect(stored?.progress).toBe(0.5); // 未被改写成 done
    expect(await getTranscript(mediaKey)).toBeNull(); // 不重新组装
    expect(await listAsrChunks(mediaKey)).toHaveLength(0);
    expect(callsNamed('ASR_DONE')).toHaveLength(0);
    expect(callsNamed('ASR_FAILED')).toHaveLength(0); // 不误判为组装失败
  });

  it('cancelled 片段作业收到迟到的完成事件：同样保持 cancelled（不翻成 done）', async () => {
    const mediaKey = keyFor(226);
    // 片段作业取消时保留分片
    await putAsrJob(makeJob(mediaKey, { status: 'cancelled', durationSec: 3600, window: { start: 1200, end: 2400 } }));
    await putAsrChunk(makeChunk(mediaKey, 2));

    const handled = await handleOffscreenEvent(doneEvent(mediaKey, { durationSec: 3600, coveredSec: 600 }));

    expect(handled).toBe(true);
    const stored = await getAsrJob(mediaKey);
    expect(stored?.status).toBe('cancelled');
    expect(stored?.progress).toBe(0.5);
    expect(await getTranscript(mediaKey)).toBeNull(); // 不重组装
    expect(await listAsrChunks(mediaKey)).toHaveLength(1); // 取消片段作业保留的分片不受影响
    expect(callsNamed('ASR_DONE')).toHaveLength(0);
    expect(callsNamed('ASR_FAILED')).toHaveLength(0);
  });
});

// ───────────────────────── 终态覆盖防护（done / failed 幂等） ─────────────────────────

describe('handleOffscreenEvent：done/failed 终态不被迟到事件改写', () => {
  it('done 作业收到迟到的失败事件：保持 done、不广播、不覆盖错误字段', async () => {
    const mediaKey = keyFor(227);
    await putAsrJob(makeJob(mediaKey, { status: 'done', progress: 1, doneChunks: 2 }));

    const handled = await handleOffscreenEvent({
      type: 'OFFSCREEN_ASR_FAILED',
      mediaKey,
      error: { code: 'ASR_INFER_FAILED', userMessage: '推理失败', retryable: true },
      errorKind: 'model',
    });

    expect(handled).toBe(true);
    const stored = await getAsrJob(mediaKey);
    expect(stored?.status).toBe('done');
    expect(stored?.progress).toBe(1);
    expect(stored?.error).toBeUndefined();
    expect(stored?.errorKind).toBeUndefined();
    expect(callsNamed('ASR_FAILED')).toHaveLength(0);
    expect(callsNamed('ASR_DONE')).toHaveLength(0);
  });

  it('failed 片段作业收到迟到的完成事件：保持 failed、不翻成 done、不广播、分片保留', async () => {
    const mediaKey = keyFor(228);
    await putAsrJob(
      makeJob(mediaKey, {
        status: 'failed',
        durationSec: 3600,
        window: { start: 1200, end: 2400 },
        error: '推理失败',
        errorKind: 'model',
      }),
    );
    await putAsrChunk(makeChunk(mediaKey, 2));

    const handled = await handleOffscreenEvent(doneEvent(mediaKey, { durationSec: 3600, coveredSec: 600 }));

    expect(handled).toBe(true);
    const stored = await getAsrJob(mediaKey);
    expect(stored?.status).toBe('failed');
    expect(stored?.error).toBe('推理失败');
    expect(await listAsrChunks(mediaKey)).toHaveLength(1); // 分片保留，不被迟到 DONE 清掉
    expect(await getTranscript(mediaKey)).toBeNull(); // 不重新组装
    expect(callsNamed('ASR_DONE')).toHaveLength(0);
    expect(callsNamed('ASR_FAILED')).toHaveLength(0);
  });

  it('failed 整段作业收到迟到的完成事件：保持 failed、不误判组装失败、不重复广播', async () => {
    const mediaKey = keyFor(229);
    // 整段失败作业分片已清：不短路时迟到 DONE 会组装失败，重复标记 failed 并再广播 ASR_FAILED
    await putAsrJob(makeJob(mediaKey, { status: 'failed', error: '推理失败', errorKind: 'model' }));

    const handled = await handleOffscreenEvent(doneEvent(mediaKey));

    expect(handled).toBe(true);
    const stored = await getAsrJob(mediaKey);
    expect(stored?.status).toBe('failed');
    expect(stored?.progress).toBe(0.5); // 未被改写
    expect(await getTranscript(mediaKey)).toBeNull();
    expect(await listAsrChunks(mediaKey)).toHaveLength(0);
    expect(callsNamed('ASR_DONE')).toHaveLength(0);
    expect(callsNamed('ASR_FAILED')).toHaveLength(0); // 不重复广播
  });

  it('failed 作业收到重复失败事件：幂等忽略（重试走新建作业，不依赖 FAILED 事件）', async () => {
    const mediaKey = keyFor(231);
    await putAsrJob(makeJob(mediaKey, { status: 'failed', error: '首次失败', errorKind: 'model' }));

    const handled = await handleOffscreenEvent({
      type: 'OFFSCREEN_ASR_FAILED',
      mediaKey,
      error: { code: 'ASR_DECODE_FAILED', userMessage: '音频解码失败，该节次可能使用了不支持的编码', retryable: false },
      errorKind: 'decode',
    });

    expect(handled).toBe(true);
    const stored = await getAsrJob(mediaKey);
    expect(stored?.status).toBe('failed');
    expect(stored?.error).toBe('首次失败'); // 不被重复失败事件覆盖
    expect(stored?.errorKind).toBe('model');
    expect(callsNamed('ASR_FAILED')).toHaveLength(0); // 不重复广播

    // 重试入口不受影响：failed 作业可重新发起（新建 extracting 作业覆盖）
    const retry = await startTranscription(startArgs(mediaKey));
    expect(retry.status).toBe('extracting');
  });
});

// ───────────────────────── 续跑对账 ─────────────────────────

describe('续跑对账', () => {
  it('OFFSCREEN_PING_REPLY：存活作业保持原状，失联的进行中作业标记 paused 可续跑', async () => {
    const alive = keyFor(210);
    const lost = keyFor(211);
    const doneKey = keyFor(212);
    const pausedKey = keyFor(213);
    await putAsrJob(makeJob(alive, { status: 'transcribing' }));
    await putAsrJob(makeJob(lost, { status: 'extracting' }));
    await putAsrJob(makeJob(doneKey, { status: 'done' }));
    await putAsrJob(makeJob(pausedKey, { status: 'paused' }));

    const handled = await handleOffscreenEvent({ type: 'OFFSCREEN_PING_REPLY', activeMediaKeys: [alive] });

    expect(handled).toBe(true);
    expect((await getAsrJob(alive))?.status).toBe('transcribing');

    const lostJob = await getAsrJob(lost);
    expect(lostJob?.status).toBe('paused');
    expect(lostJob?.error).toBe('任务因后台或浏览器重启而中断，可点击继续');

    // 非“进行中”状态不受对账影响
    expect((await getAsrJob(doneKey))?.status).toBe('done');
    expect((await getAsrJob(pausedKey))?.status).toBe('paused');
  });

  it('reconcileJobsOnStartup：Offscreen 正常应答 → 不动任何作业', async () => {
    const mediaKey = keyFor(214);
    await putAsrJob(makeJob(mediaKey, { status: 'transcribing' }));

    await reconcileJobsOnStartup();

    expect(mocks.sendToOffscreen).toHaveBeenCalledTimes(1);
    expect(lastOffscreenMessage().op).toBe('PING');
    expect((await getAsrJob(mediaKey))?.status).toBe('transcribing');
  });

  it('reconcileJobsOnStartup：首次 PING 失败、重试成功 → 不标记中断', async () => {
    const mediaKey = keyFor(215);
    await putAsrJob(makeJob(mediaKey, { status: 'transcribing' }));
    mocks.sendToOffscreen.mockRejectedValueOnce(new Error('offscreen not ready')).mockResolvedValueOnce(undefined);

    await reconcileJobsOnStartup();

    expect(mocks.sendToOffscreen).toHaveBeenCalledTimes(2);
    expect((await getAsrJob(mediaKey))?.status).toBe('transcribing');
  });

  it('reconcileJobsOnStartup：Offscreen 不可用 → 进行中作业全部标记 paused（可续跑）', async () => {
    const transcribing = keyFor(216);
    const extracting = keyFor(217);
    const doneKey = keyFor(218);
    await putAsrJob(makeJob(transcribing, { status: 'transcribing' }));
    await putAsrJob(makeJob(extracting, { status: 'extracting' }));
    await putAsrJob(makeJob(doneKey, { status: 'done' }));
    mocks.sendToOffscreen.mockRejectedValue(new Error('no offscreen'));

    await reconcileJobsOnStartup();

    const first = await getAsrJob(transcribing);
    expect(first?.status).toBe('paused');
    expect(first?.error).toBe('任务已中断，可点击继续');
    const second = await getAsrJob(extracting);
    expect(second?.status).toBe('paused');
    expect(second?.error).toBe('任务已中断，可点击继续');
    expect((await getAsrJob(doneKey))?.status).toBe('done');
  });
});

// ───────────────────────── 控制指令与重置 ─────────────────────────

describe('controlTranscription', () => {
  it('pause / resume 状态迁移并下发 ASR_CONTROL', async () => {
    const mediaKey = keyFor(220);
    await startTranscription(startArgs(mediaKey));

    const paused = await controlTranscription(mediaKey, 'pause');
    expect(paused?.status).toBe('paused');
    let message = lastOffscreenMessage();
    expect(message.op).toBe('ASR_CONTROL');
    expect((message.payload as unknown as Record<string, unknown>).action).toBe('pause');
    expect(callsNamed('ASR_PROGRESS').at(-1)?.data.job).toMatchObject({ status: 'paused' });

    const resumed = await controlTranscription(mediaKey, 'resume');
    expect(resumed?.status).toBe('transcribing');
    message = lastOffscreenMessage();
    expect((message.payload as unknown as Record<string, unknown>).action).toBe('resume');
    expect(callsNamed('ASR_PROGRESS').at(-1)?.data.job).toMatchObject({ status: 'transcribing' });
  });

  it('取消整段作业：清空分片与 partial 转写', async () => {
    const mediaKey = keyFor(221);
    await startTranscription(startArgs(mediaKey));
    await handleOffscreenEvent(chunkDoneEvent(mediaKey, 0));
    expect(await getTranscript(mediaKey)).not.toBeNull();

    const cancelled = await controlTranscription(mediaKey, 'cancel');

    expect(cancelled?.status).toBe('cancelled');
    expect(await listAsrChunks(mediaKey)).toHaveLength(0);
    expect(await getTranscript(mediaKey)).toBeNull();
  });

  it('取消片段作业：只停这一轮，已累积分片保留', async () => {
    const mediaKey = keyFor(222);
    await startTranscription(startArgs(mediaKey, { durationSec: 3600, windowMode: 'around', aroundSec: 1800 }));
    await handleOffscreenEvent(chunkDoneEvent(mediaKey, 2));

    const cancelled = await controlTranscription(mediaKey, 'cancel');

    expect(cancelled?.status).toBe('cancelled');
    expect(await listAsrChunks(mediaKey)).toHaveLength(1);
  });

  it('控制指令下发失败不阻塞本地状态更新', async () => {
    const mediaKey = keyFor(223);
    await startTranscription(startArgs(mediaKey));
    mocks.sendToOffscreen.mockRejectedValueOnce(new Error('send fail'));

    const paused = await controlTranscription(mediaKey, 'pause');

    expect(paused?.status).toBe('paused');
    expect((await getAsrJob(mediaKey))?.status).toBe('paused');
  });

  it('无作业时返回 null', async () => {
    expect(await controlTranscription(hduMediaKey(99997), 'pause')).toBeNull();
  });
});

describe('resetJob', () => {
  it('清空作业与分片，之后可重新发起', async () => {
    const mediaKey = keyFor(230);
    await startTranscription(startArgs(mediaKey));
    await handleOffscreenEvent(chunkDoneEvent(mediaKey, 0));

    await resetJob(mediaKey);

    expect(await getAsrJob(mediaKey)).toBeNull();
    expect(await listAsrChunks(mediaKey)).toHaveLength(0);

    const again = await startTranscription(startArgs(mediaKey));
    expect(again.status).toBe('extracting');
  });
});

describe('buildStartArgsFromMeta', () => {
  it('按机位号推导转写输入；缺省取第一个机位', () => {
    const meta: SessionMeta = {
      courId: 301,
      teclId: 30,
      courseName: '线性代数',
      teacherNames: ['张三'],
      durationSec: 1500,
      courLabel: '第1周',
      views: [
        { vodId: 1, url: 'https://media.example.com/v1.m3u8', vodTime: 1500, viewNum: 1 },
        { vodId: 2, url: 'https://media.example.com/v2.m3u8', vodTime: 1500, viewNum: 2 },
      ],
    };

    expect(buildStartArgsFromMeta(meta, 2)).toEqual({
      mediaKey: 'hdu:301',
      teclId: 30,
      viewNum: 2,
      durationSec: 1500,
      audioUrl: 'https://media.example.com/v2.m3u8',
    });

    const fallback = buildStartArgsFromMeta(meta);
    expect(fallback.viewNum).toBe(1);
    expect(fallback.audioUrl).toBe('https://media.example.com/v1.m3u8');
    expect(fallback.mediaKey).toBe('hdu:301');
  });
});
