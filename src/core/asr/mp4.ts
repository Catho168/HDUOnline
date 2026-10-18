/**
 * MP4 音轨定位与字节区间计算（§5.2 步骤 ① ② ③）。
 *
 * 主路径（省流量）：按 mp4box 返回的“下一段需要解析的偏移”迭代读取文件头/尾的
 * 盒头与 moov。不能只固定探测头部 256KB + 尾部 2MB：47 分钟录播的 moov 实测可达
 * 2.4MB（样本表随帧数增长），会同时超出两个固定窗口，导致“moov 未找到”。
 * 解析出音轨的样本表后，只拉**音频样本**的字节区间（通常仅占整文件 1–3%）。
 *
 * 兜底：moov 解析失败 / 无音轨 / 无样本表 → 由调用方走整文件下载路径（B1）。
 */

import { createFile, type ISOFile, type Sample } from 'mp4box';
import { ASR_PARAMS } from '../shared/constants';
import { AppError } from '../shared/errors';
import { createLogger } from '../shared/logger';

const log = createLogger('asr-mp4');

export interface AudioTrackInfo {
  trackId: number;
  codec: string;
  sampleRate: number;
  channels: number;
  timescale: number;
  /** 音轨总时长（秒） */
  durationSec: number;
  /** 音频样本总数 */
  sampleCount: number;
  /** AudioSpecificConfig（WebCodecs 的 description） */
  asc?: Uint8Array;
}

export interface ByteRange {
  start: number;
  /** 含端点的结束偏移 */
  end: number;
}

export interface ProbeResult {
  info: AudioTrackInfo;
  samples: Sample[];
  /** 合并后的音频字节区间（用于批量 Range 拉取） */
  ranges: ByteRange[];
  /** 文件总大小（来自 Content-Range；未知为 undefined） */
  fileSize?: number;
  /** 是否为分片 MP4（存在 moof） */
  fragmented: boolean;
  /** 音频字节总量 */
  audioBytes: number;
}

/** 解析 Range 响应头中的总大小：`bytes 0-262143/12345678` */
function parseTotalSize(contentRange: string | null): number | undefined {
  if (!contentRange) return undefined;
  const match = contentRange.match(/\/(\d+)\s*$/);
  if (!match?.[1]) return undefined;
  const total = Number(match[1]);
  return Number.isFinite(total) && total > 0 ? total : undefined;
}

async function fetchRange(
  url: string,
  start: number | 'tail',
  length: number,
  signal?: AbortSignal,
): Promise<{ buffer: ArrayBuffer; fileStart: number; fileSize?: number }> {
  const header = start === 'tail' ? `bytes=-${length}` : `bytes=${start}-${start + length - 1}`;
  const res = await fetch(url, { headers: { Range: header }, signal, credentials: 'omit', mode: 'cors' });
  const contentRange = res.headers.get('content-range');
  const fileSize = parseTotalSize(contentRange);
  // 越过文件末尾（部分服务器对越界 Range 返回 416）：视为“没有更多可读”
  if (res.status === 416) {
    return { buffer: new ArrayBuffer(0), fileStart: start === 'tail' ? 0 : start, fileSize };
  }
  if (!res.ok && res.status !== 206) {
    throw new AppError('ASR_NETWORK_FAILED', {
      userMessage: `音频拉取失败（HTTP ${res.status}）`,
      detail: `Range ${header} → ${res.status}`,
      retryable: true,
    });
  }

  // 服务端忽略 Range 时返回整文件（200）。对 47 分钟、800MB 级的录播这会直接
  // 把整个文件读进内存，必须提前拒绝，而不是悄悄下载。
  const contentLength = Number(res.headers.get('content-length') ?? 0);
  // 服务端忽略 Range 时返回整文件（200）。对 47 分钟、800MB 级的录播这会直接
  // 把整个文件读进内存，必须提前拒绝，而不是悄悄下载。
  if (res.status === 200 && contentLength > length * 2 + 1024) {
    try {
      await res.body?.cancel();
    } catch {
      /* 忽略 */
    }
    throw new AppError('ASR_NETWORK_FAILED', {
      userMessage:
        '视频服务器没有按 Range 返回片段（可能不支持分段读取），无法只拉取音频片段。请确认直链有效，或改用整段模式重试。',
      detail: `Range ${header} 返回 200，content-length=${contentLength}`,
      retryable: true,
    });
  }

  const buffer = await res.arrayBuffer();
  const rangeStart = contentRange?.match(/^bytes\s+(\d+)-/i)?.[1];
  let fileStart: number;
  if (start === 'tail') {
    fileStart = Math.max(0, (fileSize ?? 0) - buffer.byteLength);
  } else if (res.status === 206) {
    fileStart = rangeStart ? Number(rangeStart) : start;
  } else {
    // 200 且文件不大：服务端返回的是完整文件，真实起点是 0
    fileStart = 0;
  }
  return { buffer, fileStart, fileSize };
}

/** 带文件偏移的 ArrayBuffer（mp4box 要求 fileStart 属性） */
function toMp4Buffer(buffer: ArrayBuffer, fileStart: number): ArrayBuffer & { fileStart: number } {
  const tagged = buffer as ArrayBuffer & { fileStart: number };
  tagged.fileStart = fileStart;
  return tagged;
}

export interface ProbeOptions {
  /** 单次探测拉取的字节数（测试可调小；默认 headProbeBytes） */
  chunkBytes?: number;
  /** 探测阶段最多读取的字节数，防止异常文件无限拉取（默认 64MB） */
  maxBytes?: number;
}

/**
 * 解析音轨信息与音频字节区间。
 * 注意：整个过程只读取盒头/moov 与少量探测片段（不含 mdat 数据）。
 *
 * 迭代策略：`ISOFile.appendBuffer()` 会返回“下一段需要解析的绝对偏移”。
 * 对 moov 在头部的文件，它指向 moov 的后续字节；对 moov 在尾部的文件，
 * 解析完 mdat 头后会直接指向 mdat 末尾（即 moov 起点）。因此不能用固定的
 * 头/尾探测窗口，必须按返回值继续拉取。
 */
export async function probeAudioTrack(
  url: string,
  signal?: AbortSignal,
  opts: ProbeOptions = {},
): Promise<ProbeResult> {
  const isoFile = createFile() as unknown as ISOFile;
  let ready = false;
  let info: unknown = null;

  isoFile.onReady = (movieInfo: unknown) => {
    ready = true;
    info = movieInfo as never;
  };
  isoFile.onError = (err: unknown) => {
    log.warn('mp4box 解析错误', err);
  };

  const chunkBytes = Math.max(1024, Math.floor(opts.chunkBytes ?? ASR_PARAMS.headProbeBytes));
  const maxBytes = Math.max(chunkBytes, opts.maxBytes ?? 64 * 1024 * 1024);

  let nextStart: number | undefined = 0;
  let fetched = 0;
  let fileSize: number | undefined;
  let rounds = 0;

  while (!ready && fetched < maxBytes && rounds < 512) {
    rounds += 1;
    const start = nextStart ?? 0;
    if (fileSize !== undefined && start >= fileSize) break;

    const part = await fetchRange(url, start, chunkBytes, signal);
    fileSize ??= part.fileSize;
    if (part.buffer.byteLength === 0) break;

    const next = isoFile.appendBuffer(toMp4Buffer(part.buffer, part.fileStart) as never);
    isoFile.flush();
    fetched += part.buffer.byteLength;

    log.debug('MP4 探测片段', {
      round: rounds,
      fileStart: part.fileStart,
      bytes: part.buffer.byteLength,
      fileSize,
      next,
      ready,
    });

    if (ready) break;
    if (typeof next !== 'number' || !Number.isFinite(next)) {
      // 没有明确的下一段偏移：按顺序继续读（至少保证不会卡在原地）
      nextStart = part.fileStart + part.buffer.byteLength;
    } else if (next <= part.fileStart) {
      // appendBuffer 没有前进（例如服务端返回了 200 整文件）：停止，避免死循环
      break;
    } else {
      nextStart = next;
    }
    if (fileSize !== undefined && nextStart >= fileSize) break;
  }

  if (!ready || !info) {
    throw new AppError('ASR_PARSE_FAILED', {
      userMessage: '视频文件结构解析失败，无法定位音轨',
      detail: `moov 在 ${rounds} 次分段探测（共 ${fetched} 字节）内未解析完成`,
    });
  }

  const movie = info as unknown as {
    audioTracks?: Array<{
      id: number;
      codec: string;
      audio?: { sample_rate: number; channel_count: number };
      timescale: number;
      duration: number;
      nb_samples: number;
    }>;
    tracks?: Array<{ id: number; type?: string }>;
  };
  const audioTrack = movie.audioTracks?.[0];
  if (!audioTrack) {
    throw new AppError('ASR_NO_AUDIO_TRACK', { userMessage: '该视频中没有音轨' });
  }

  const samples = safeTrackSamples(isoFile, audioTrack.id);
  if (samples.length === 0) {
    throw new AppError('ASR_PARSE_FAILED', {
      userMessage: '未能读取音轨样本表，无法定位音频数据',
      detail: 'stbl 样本表为空或不可用',
    });
  }

  const trak = safeTrackById(isoFile, audioTrack.id);
  const asc = trak ? findAudioSpecificConfig(trak) : undefined;
  const durationSec = audioTrack.timescale > 0 ? audioTrack.duration / audioTrack.timescale : 0;

  const ranges = mergeRanges(samples, ASR_PARAMS.audioBatchBytes);
  const audioBytes = ranges.reduce((acc, r) => acc + (r.end - r.start + 1), 0);
  const fragmented = Boolean((isoFile.moovs?.length ?? 0) > 1 || hasMoof(isoFile));

  log.info('音轨探测完成', {
    trackId: audioTrack.id,
    codec: audioTrack.codec,
    sampleRate: audioTrack.audio?.sample_rate,
    channels: audioTrack.audio?.channel_count,
    durationSec: Math.round(durationSec),
    sampleCount: samples.length,
    rangeCount: ranges.length,
    audioBytes,
    fragmented,
  });

  return {
    info: {
      trackId: audioTrack.id,
      codec: audioTrack.codec || 'mp4a.40.2',
      sampleRate: Math.round(audioTrack.audio?.sample_rate ?? 44100),
      channels: audioTrack.audio?.channel_count ?? 1,
      timescale: audioTrack.timescale,
      durationSec,
      sampleCount: samples.length,
      asc,
    },
    samples,
    ranges,
    fileSize,
    fragmented,
    audioBytes,
  };
}

function safeTrackSamples(isoFile: ISOFile, trackId: number): Sample[] {
  try {
    return isoFile.getTrackSamplesInfo(trackId) ?? [];
  } catch (err) {
    log.warn('getTrackSamplesInfo 失败', err);
    return [];
  }
}

function safeTrackById(isoFile: ISOFile, trackId: number): unknown {
  try {
    return isoFile.getTrackById(trackId);
  } catch {
    return undefined;
  }
}

function hasMoof(isoFile: ISOFile): boolean {
  try {
    const moofs = (isoFile as unknown as { moofs?: unknown[] }).moofs;
    return Array.isArray(moofs) && moofs.length > 0;
  } catch {
    return false;
  }
}

/**
 * 从 mp4a 样本条目中提取 AudioSpecificConfig（§5.2：esds 的
 * `entry.esds.esd.descs[0].descs[0].data`）。
 * 由于不同文件/不同 mp4box 版本的层级可能略有差异，这里做**多路径 + 递归兜底**，
 * 只取 tag=0x05（DecoderSpecificInfo）的 data。
 */
export function findAudioSpecificConfig(trak: unknown): Uint8Array | undefined {
  const entry = getSampleEntry(trak);
  if (!entry) return undefined;

  // 路径 1：文档给出的标准层级
  const esds = (
    entry as { esds?: { esd?: { descs?: Array<{ descs?: Array<{ data?: Uint8Array }> }> } } }
  ).esds;
  const standard = esds?.esd?.descs?.[0]?.descs?.[0]?.data;
  if (isByteArray(standard) && standard.byteLength > 0) return new Uint8Array(standard);

  // 路径 2：在样本条目内递归查找 tag=0x05 的描述符
  const found = searchDescriptor(entry, 0);
  if (found) return found;
  return undefined;
}

function getSampleEntry(trak: unknown): unknown {
  const t = trak as { mdia?: { minf?: { stbl?: { stsd?: { entries?: unknown[] } } } } } | undefined;
  return t?.mdia?.minf?.stbl?.stsd?.entries?.[0];
}

function isByteArray(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array || (Array.isArray(value) && value.every((v) => typeof v === 'number'));
}

/** 有界递归查找 DecoderSpecificInfo（tag=5） */
function searchDescriptor(node: unknown, depth: number): Uint8Array | undefined {
  if (depth > 6 || node === null || typeof node !== 'object') return undefined;
  const obj = node as { tag?: number; data?: unknown; descs?: unknown[]; esd?: unknown };
  if (obj.tag === 0x05 && isByteArray(obj.data) && obj.data.byteLength > 0) {
    return new Uint8Array(obj.data as Uint8Array);
  }
  if (Array.isArray(obj.descs)) {
    for (const child of obj.descs) {
      const hit = searchDescriptor(child, depth + 1);
      if (hit) return hit;
    }
  }
  if (obj.esd) {
    const hit = searchDescriptor(obj.esd, depth + 1);
    if (hit) return hit;
  }
  if ((obj as { esds?: unknown }).esds) {
    const hit = searchDescriptor((obj as { esds?: unknown }).esds, depth + 1);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * 把样本列表合并为连续的字节区间：
 * 相邻（或间隙 < 64KB）的样本合并成一段，单段上限 `maxBytes`，
 * 以近似"整段音频"的请求数换取更低的总请求数（§5.2 步骤 3）。
 */
export function mergeRanges(samples: Sample[], maxBytes: number = ASR_PARAMS.audioBatchBytes): ByteRange[] {
  const sorted = [...samples]
    .map((sample) => ({ start: sample.offset, end: sample.offset + sample.size - 1 }))
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end >= r.start)
    .sort((a, b) => a.start - b.start);
  if (sorted.length === 0) return [];

  const gapTolerance = 64 * 1024;
  const ranges: ByteRange[] = [];
  let current = { ...(sorted[0] as ByteRange) };

  for (let i = 1; i < sorted.length; i += 1) {
    const next = sorted[i] as ByteRange;
    const gap = next.start - current.end - 1;
    const mergedSize = next.end - current.start + 1;
    if (gap <= gapTolerance && mergedSize <= maxBytes) {
      current.end = Math.max(current.end, next.end);
      continue;
    }
    ranges.push(current);
    current = { ...next };
  }
  ranges.push(current);
  return ranges;
}

/** 依据样本的 dts/duration 计算每个样本的起点（秒）与时长（秒） */
export function buildSampleTimeline(
  samples: Sample[],
  timescale: number,
): Array<{ startSec: number; durationSec: number }> {
  const scale = timescale > 0 ? timescale : 1000;
  return samples.map((sample) => ({
    startSec: sample.dts / scale,
    durationSec: sample.duration > 0 ? sample.duration / scale : 0,
  }));
}

/** 把拉取的区间字节拼装为样本数据（区间必须覆盖样本范围） */
export function extractSampleBytes(
  samples: Sample[],
  buffers: Array<{ start: number; bytes: Uint8Array }>,
): Array<{ index: number; data: Uint8Array }> {
  const out: Array<{ index: number; data: Uint8Array }> = [];
  for (const [index, sample] of samples.entries()) {
    const target = { start: sample.offset, end: sample.offset + sample.size };
    const piece = findCovering(buffers, target.start, target.end);
    if (!piece) {
      out.push({ index, data: new Uint8Array(0) });
      continue;
    }
    const offsetInBuffer = target.start - piece.start;
    out.push({ index, data: piece.bytes.subarray(offsetInBuffer, offsetInBuffer + sample.size) });
  }
  return out;
}

function findCovering(
  buffers: Array<{ start: number; bytes: Uint8Array }>,
  start: number,
  end: number,
): { start: number; bytes: Uint8Array } | undefined {
  for (const buffer of buffers) {
    if (start >= buffer.start && end <= buffer.start + buffer.bytes.byteLength) return buffer;
  }
  return undefined;
}
