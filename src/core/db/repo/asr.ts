/** 转写作业仓储：asrJobs / asrChunks（支撑 §5.3 断点续跑与增量落库）。 */

import { getDb, mapDbError } from '../index';
import { AppError } from '../../shared/errors';
import { ASR_PIPELINE_VERSION } from '../../shared/constants';
import type { AsrChunkEntity, AsrJobEntity, TranscriptCoverageRange, TranscriptEntity } from '../../shared/types';
import { applyGlossaryToSegments, loadMergedGlossary, glossaryVersion } from '../../asr/glossary';
import { sanitizeSegments } from '../../asr/postprocess';
import { getTranscript } from './content';

function wrap<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((err) => {
    throw mapDbError(err);
  });
}

export function chunkKey(courId: number, viewNum: number, chunkIndex: number): string {
  return `${courId}:${viewNum}:${chunkIndex}`;
}

/**
 * 覆盖到的音频区间（并集）。
 * 片段流式转写会在多个窗口累积分片，用"最大 endSec"会把窗口之间的空档也算进来；
 * 直接求和又会把跨机位/重叠窗口的同名分片重复计数——并集才是诚实的覆盖口径。
 */
export function coveredRanges(
  chunks: Array<{ startSec: number; endSec: number }>,
  durationSec = 0,
): TranscriptCoverageRange[] {
  const spans = chunks
    .map((chunk) => {
      const a = Math.min(chunk.startSec, chunk.endSec);
      const b = Math.max(chunk.startSec, chunk.endSec);
      const start = durationSec > 0 ? Math.min(a, durationSec) : a;
      const end = durationSec > 0 ? Math.min(b, durationSec) : b;
      return [start, end] as const;
    })
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .sort((a, b) => a[0] - b[0]);

  const ranges: TranscriptCoverageRange[] = [];
  for (const [start, end] of spans) {
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end) {
      last.end = Math.max(last.end, end);
    } else {
      ranges.push({ start, end });
    }
  }
  return ranges.map((range) => ({
    start: Math.round(range.start * 100) / 100,
    end: Math.round(range.end * 100) / 100,
  }));
}

/** 覆盖到的音频秒数（区间并集长度） */
export function coveredAudioSec(chunks: Array<{ startSec: number; endSec: number }>, durationSec = 0): number {
  return Math.round(
    coveredRanges(chunks, durationSec).reduce((total, range) => total + (range.end - range.start), 0),
  );
}

export async function putAsrJob(job: AsrJobEntity): Promise<void> {
  return wrap(async () => {
    const db = await getDb();
    await db.put('asrJobs', { ...job, updatedAt: Date.now() });
  });
}

export async function getAsrJob(courId: number): Promise<AsrJobEntity | null> {
  return wrap(async () => {
    const db = await getDb();
    return (await db.get('asrJobs', courId)) ?? null;
  });
}

export async function listActiveAsrJobs(): Promise<AsrJobEntity[]> {
  return wrap(async () => {
    const db = await getDb();
    const all = await db.getAll('asrJobs');
    return all.filter((j) => j.status === 'queued' || j.status === 'extracting' || j.status === 'transcribing');
  });
}

export async function deleteAsrJob(courId: number): Promise<void> {
  const db = await getDb();
  await db.delete('asrJobs', courId);
}

export async function putAsrChunk(chunk: AsrChunkEntity): Promise<void> {
  return wrap(async () => {
    const db = await getDb();
    // 兼容旧调用/测试：未显式标注版本时视为当前管线；历史库里没有该字段的记录仍会被忽略
    await db.put('asrChunks', { ...chunk, pipelineVersion: chunk.pipelineVersion ?? ASR_PIPELINE_VERSION });
  });
}

export async function listAsrChunks(courId: number): Promise<AsrChunkEntity[]> {
  return wrap(async () => {
    const db = await getDb();
    const list = await db.getAllFromIndex('asrChunks', 'courId', courId);
    return list.sort((a, b) => a.chunkIndex - b.chunkIndex);
  });
}

/**
 * 清空转写分片。
 *  - 不带筛选：清空该课次全部分片（整段作业取消、数据清理用）；
 *  - 带筛选：只清某一机位、某段分片索引（片段流式转写的"重转当前片段"用，
 *    不会误伤其他片段已累积的分片缓存）。
 */
export async function clearAsrChunks(
  courId: number,
  filter?: { viewNum?: number; fromChunk?: number; toChunk?: number },
): Promise<void> {
  return wrap(async () => {
    const db = await getDb();
    const tx = db.transaction('asrChunks', 'readwrite');
    const entities = await tx.store.index('courId').getAll(courId);
    for (const chunk of entities) {
      if (filter) {
        if (filter.viewNum !== undefined && chunk.viewNum !== filter.viewNum) continue;
        if (filter.fromChunk !== undefined && chunk.chunkIndex < filter.fromChunk) continue;
        if (filter.toChunk !== undefined && chunk.chunkIndex > filter.toChunk) continue;
      }
      await tx.store.delete(chunk.key);
    }
    await tx.done;
  });
}

/**
 * 由已完成分片组装最终转写（§5.3：分片增量落库 → 完成后合并 + 术语纠错）。
 * 同时写入 `transcripts`，并清理临时分片。
 */
export async function assembleTranscript(
  courId: number,
  meta: {
    model: string;
    lang: string;
    durationSec: number;
    window?: { start: number; end: number };
    /** 识别引擎（缺失视为 local）：只组装当前引擎的分片，source 同步标记 */
    engine?: 'local' | 'cloud';
    source?: 'local-asr' | 'cloud-asr';
  },
  opts: { keepChunks?: boolean } = {},
): Promise<TranscriptEntity> {
  const engine = meta.engine ?? 'local';
  const chunks = (await listAsrChunks(courId)).filter(
    (chunk) => chunk.pipelineVersion === ASR_PIPELINE_VERSION && (chunk.engine ?? 'local') === engine,
  );
  if (chunks.length === 0) {
    throw new AppError('ASR_PARSE_FAILED', { detail: '没有可用的转写分片' });
  }
  const segments = chunks
    .flatMap((c) => c.segments)
    .sort((a, b) => a.s - b.s)
    .map((s) => ({
      s: Math.max(0, Math.round(s.s * 100) / 100),
      e: Math.max(0, Math.round(Math.max(s.e, s.s) * 100) / 100),
      text: s.text.trim(),
      ...(s.coarse ? { coarse: true } : {}),
    }))
    .filter((s) => s.text.length > 0);

  const glossary = await loadMergedGlossary(courId);
  const corrected = sanitizeSegments(applyGlossaryToSegments(segments, glossary)).segments;
  const db = await getDb();

  // 静音/解码异常可能让整轮作业产不出文字：同版本已有字幕时保留原样，
  // 避免"转写跑完了，字幕反而没了"；旧版本字幕（可能有时间戳塌陷/幻觉）不再保留。
  if (corrected.length === 0) {
    const existing = await getTranscript(courId);
    if (existing?.segments.length && existing.pipelineVersion === ASR_PIPELINE_VERSION) {
      const refreshed: TranscriptEntity = {
        ...existing,
        coveredSec: coveredAudioSec(chunks, meta.durationSec),
        coverage: coveredRanges(chunks, meta.durationSec),
        durationSec: meta.durationSec,
        pipelineVersion: ASR_PIPELINE_VERSION,
      };
      await db.put('transcripts', refreshed);
      if (!opts.keepChunks) await clearAsrChunks(courId);
      return refreshed;
    }
  }

  const transcript: TranscriptEntity = {
    courId,
    segments: corrected,
    model: meta.model,
    lang: meta.lang,
    glossaryVersion: glossaryVersion(glossary),
    createdAt: Date.now(),
    source: meta.source ?? (engine === 'cloud' ? 'cloud-asr' : 'local-asr'),
    coveredSec: coveredAudioSec(chunks, meta.durationSec),
    coverage: coveredRanges(chunks, meta.durationSec),
    durationSec: meta.durationSec,
    partial: false,
    // 局部转写的转写是"有意不完整"（非补全中），由窗口字段标明范围
    window: meta.window,
    pipelineVersion: ASR_PIPELINE_VERSION,
  };

  await db.put('transcripts', transcript);
  if (!opts.keepChunks) await clearAsrChunks(courId);
  return transcript;
}

/** 统计各存储分类占用（Options 的"存储占用显示"） */
export async function countStore(store: 'transcripts' | 'screenshots' | 'favorites' | 'watchRecords'): Promise<number> {
  const db = await getDb();
  return db.count(store);
}
