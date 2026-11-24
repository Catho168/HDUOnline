/**
 * bili.subtitle.fetch op 集成测试（fake-indexeddb 全链路：op handler → transcripts 落库/读取）。
 *
 * fetchBiliSubtitle（网络层）整体 mock，聚焦 handler 的行为约定：
 *  1. none：无字幕作罢——不落库、结果不是错误；
 *  2. ok：落库可读——mediaKey=`bili:<bvid>`（P1 裸键）、courId 缺省、source/coverage/durationSec
 *     口径正确；
 *  3. cached 幂等：已有字幕且未 force 时不再拉网络接口；force 才重拉；
 *  4. 分 P（第 16 轮）：p 透传适配器，p≥2 落分 P 键 `bili:<bvid>:p<N>`，与 P1 互相隔离；
 *  5. none 记忆（第 16 轮 P3-3）：SW 内存级，命中不发请求，force 穿透，TTL 过期后重试。
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/core/bili/subtitle', () => ({ fetchBiliSubtitle: vi.fn() }));

import { getDb } from '@/core/db';
import { getTranscript } from '@/core/db/repo/content';
import {
  BILI_SUBTITLE_NONE_TTL_MS,
  biliSubtitleNoneMemory,
  dispatchOp,
  resetBiliSubtitleNoneMemory,
} from '@/entrypoints/background/ops';
import { fetchBiliSubtitle } from '@/core/bili/subtitle';
import { biliMediaKey } from '@/core/shared/mediaRef';
import { AppError } from '@/core/shared/errors';
import type { BiliSubtitleFetchResult } from '@/core/bili/subtitle';

const fetchSubtitleMock = vi.mocked(fetchBiliSubtitle);

beforeAll(async () => {
  await getDb();
});

beforeEach(() => {
  resetBiliSubtitleNoneMemory();
});

const OK_RESULT: BiliSubtitleFetchResult = {
  status: 'ok',
  lan: 'zh-CN',
  lanDoc: '中文字幕',
  ai: false,
  cid: 42,
  durationSec: 600,
  segments: [
    { s: 1.5, e: 4, text: '第一句' },
    { s: 4, e: 8.2, text: '第二句' },
    { s: 10, e: 12.5, text: '第三句' },
  ],
  coverage: [
    { start: 1.5, end: 8.2 },
    { start: 10, end: 12.5 },
  ],
  coveredSec: 9.2,
};

describe('bili.subtitle.fetch op', () => {
  it('none：无字幕作罢——直接返回不落库，不是错误', async () => {
    fetchSubtitleMock.mockResolvedValue({ status: 'none' });
    const result = await dispatchOp('bili.subtitle.fetch', { bvid: 'BVnone000001' });
    expect(result).toEqual({ status: 'none' });
    expect(await getTranscript(biliMediaKey('BVnone000001'))).toBeNull();
    expect(fetchSubtitleMock).toHaveBeenCalledWith('BVnone000001', { p: 1 });
  });

  it('ok：落库可读——mediaKey 口径、courId 缺省、coverage/durationSec 按 adapter 结果', async () => {
    fetchSubtitleMock.mockResolvedValue(OK_RESULT);
    const result = await dispatchOp('bili.subtitle.fetch', { bvid: 'BVok000000001' });
    expect(result).toEqual({ status: 'ok', cached: false, segments: 3, lan: 'zh-CN', lanDoc: '中文字幕' });

    const entity = await getTranscript(biliMediaKey('BVok000000001'));
    expect(entity).not.toBeNull();
    expect(entity?.mediaKey).toBe('bili:BVok000000001');
    // B 站记录：courId 缺省（无课次）；来源标记为官方字幕，非 ASR 产物
    expect(entity?.courId).toBeUndefined();
    expect(entity?.source).toBe('bili-official-subtitle');
    expect(entity?.model).toBe('bili-official-subtitle');
    expect(entity?.lang).toBe('zh-CN');
    expect(entity?.glossaryVersion).toBe(0);
    expect(entity?.partial).toBe(false);
    expect(entity?.segments).toHaveLength(3);
    expect(entity?.coveredSec).toBeCloseTo(9.2, 10);
    expect(entity?.coverage).toEqual([
      { start: 1.5, end: 8.2 },
      { start: 10, end: 12.5 },
    ]);
    expect(entity?.durationSec).toBe(600);
  });

  it('cached 幂等：已有字幕且未 force 时不拉接口直接返回；force 才重拉', async () => {
    fetchSubtitleMock.mockResolvedValue(OK_RESULT);
    const first = await dispatchOp('bili.subtitle.fetch', { bvid: 'BVcached000001' });
    expect(first).toEqual({ status: 'ok', cached: false, segments: 3, lan: 'zh-CN', lanDoc: '中文字幕' });
    expect(fetchSubtitleMock).toHaveBeenCalledTimes(1);

    const second = await dispatchOp('bili.subtitle.fetch', { bvid: 'BVcached000001' });
    expect(second).toEqual({ status: 'ok', cached: true, segments: 3, lan: 'zh-CN', lanDoc: '' });
    // 未 force：网络适配器只被调过一次
    expect(fetchSubtitleMock).toHaveBeenCalledTimes(1);

    const forced = await dispatchOp('bili.subtitle.fetch', { bvid: 'BVcached000001', force: true });
    expect(forced).toEqual({ status: 'ok', cached: false, segments: 3, lan: 'zh-CN', lanDoc: '中文字幕' });
    expect(fetchSubtitleMock).toHaveBeenCalledTimes(2);
  });

  it('force 重拉得到 none 时保留旧字幕（不删库），返回 none', async () => {
    fetchSubtitleMock.mockResolvedValueOnce(OK_RESULT);
    await dispatchOp('bili.subtitle.fetch', { bvid: 'BVstale0000001' });
    fetchSubtitleMock.mockResolvedValueOnce({ status: 'none' });
    const result = await dispatchOp('bili.subtitle.fetch', { bvid: 'BVstale0000001', force: true });
    expect(result).toEqual({ status: 'none' });
    expect(await getTranscript(biliMediaKey('BVstale0000001'))).not.toBeNull();
  });

  it('无字幕的 ok 结果缺 durationSec 时实体不写 durationSec', async () => {
    fetchSubtitleMock.mockResolvedValue({ ...OK_RESULT, durationSec: null });
    await dispatchOp('bili.subtitle.fetch', { bvid: 'BVnodur0000001' });
    const entity = await getTranscript(biliMediaKey('BVnodur0000001'));
    expect(entity?.durationSec).toBeUndefined();
  });

  it('bvid 不合法抛 INVALID_INPUT', async () => {
    fetchSubtitleMock.mockClear();
    const err = (await dispatchOp('bili.subtitle.fetch', { bvid: 'abc' }).catch((e: unknown) => e)) as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('INVALID_INPUT');
    expect(fetchSubtitleMock).not.toHaveBeenCalled();
  });
});

describe('bili.subtitle.fetch op：分 P 透传与隔离（第 16 轮）', () => {
  it('p=2 透传适配器，落分 P 键 bili:<bvid>:p2；ai 口径写入 aiSubtitle', async () => {
    fetchSubtitleMock.mockClear();
    fetchSubtitleMock.mockResolvedValue(OK_RESULT);
    const result = await dispatchOp('bili.subtitle.fetch', { bvid: 'BVmulti000001', p: 2 });
    expect(result).toEqual({ status: 'ok', cached: false, segments: 3, lan: 'zh-CN', lanDoc: '中文字幕' });
    expect(fetchSubtitleMock).toHaveBeenCalledWith('BVmulti000001', { p: 2 });

    const entity = await getTranscript(biliMediaKey('BVmulti000001', 2));
    expect(entity?.mediaKey).toBe('bili:BVmulti000001:p2');
    // 第 16 轮包 B：选轨的 AI 标记随落库写入（OK_RESULT.ai = false）
    expect(entity?.aiSubtitle).toBe(false);
    // P1 裸键不受 p=2 落库影响（分 P 隔离）
    expect(await getTranscript(biliMediaKey('BVmulti000001'))).toBeNull();
  });

  it('p1/p2 各自 cached、互不冒充（cached 幂等按 mediaKey 天然分 P 隔离）', async () => {
    fetchSubtitleMock.mockClear();
    fetchSubtitleMock.mockResolvedValue(OK_RESULT);
    await dispatchOp('bili.subtitle.fetch', { bvid: 'BVisolate00001' });
    await dispatchOp('bili.subtitle.fetch', { bvid: 'BVisolate00001', p: 2 });
    expect(fetchSubtitleMock).toHaveBeenCalledTimes(2);

    fetchSubtitleMock.mockClear();
    const cachedP1 = await dispatchOp('bili.subtitle.fetch', { bvid: 'BVisolate00001' });
    expect(cachedP1).toEqual({ status: 'ok', cached: true, segments: 3, lan: 'zh-CN', lanDoc: '' });
    const cachedP2 = await dispatchOp('bili.subtitle.fetch', { bvid: 'BVisolate00001', p: 2 });
    expect(cachedP2).toEqual({ status: 'ok', cached: true, segments: 3, lan: 'zh-CN', lanDoc: '' });
    // 两个分 P 各自命中各自的落库记录，没有重复拉接口
    expect(fetchSubtitleMock).not.toHaveBeenCalled();
  });

  it('AI 字幕轨落库 aiSubtitle=true', async () => {
    fetchSubtitleMock.mockClear();
    fetchSubtitleMock.mockResolvedValue({ ...OK_RESULT, ai: true, lan: 'ai-zh' });
    await dispatchOp('bili.subtitle.fetch', { bvid: 'BVaisub0000001' });
    const entity = await getTranscript(biliMediaKey('BVaisub0000001'));
    expect(entity?.aiSubtitle).toBe(true);
    expect(entity?.lang).toBe('ai-zh');
  });

  it('非法 p（0/小数/NaN）按 1 兜底：落裸键 P1', async () => {
    fetchSubtitleMock.mockClear();
    fetchSubtitleMock.mockResolvedValue(OK_RESULT);
    expect(await dispatchOp('bili.subtitle.fetch', { bvid: 'BVfallback0001', p: 0 })).toMatchObject({ status: 'ok' });
    // 首次请求以 p=1 透传适配器
    expect(fetchSubtitleMock).toHaveBeenCalledTimes(1);
    expect(fetchSubtitleMock).toHaveBeenCalledWith('BVfallback0001', { p: 1 });
    const entity = await getTranscript(biliMediaKey('BVfallback0001'));
    expect(entity?.mediaKey).toBe('bili:BVfallback0001');
    // 兜底口径的缓存一致性：p=2.5 / NaN 同样归一到 P1 裸键，直接 cached 不重拉
    expect(await dispatchOp('bili.subtitle.fetch', { bvid: 'BVfallback0001', p: 2.5 })).toMatchObject({ cached: true });
    expect(await dispatchOp('bili.subtitle.fetch', { bvid: 'BVfallback0001', p: Number.NaN })).toMatchObject({ cached: true });
    expect(fetchSubtitleMock).toHaveBeenCalledTimes(1);
  });
});

describe('bili.subtitle.fetch op：none 记忆（第 16 轮 P3-3，SW 内存级）', () => {
  it('得到 none 后写记忆（TTL 10 分钟）；命中记忆直接返回 none 不打接口', async () => {
    fetchSubtitleMock.mockClear();
    fetchSubtitleMock.mockResolvedValue({ status: 'none' });
    const mediaKey = biliMediaKey('BVnoneMem00001');
    const first = await dispatchOp('bili.subtitle.fetch', { bvid: 'BVnoneMem00001' });
    expect(first).toEqual({ status: 'none' });
    const expiry = biliSubtitleNoneMemory.get(mediaKey);
    expect(expiry).toBeDefined();
    expect(expiry! - Date.now()).toBeGreaterThan(BILI_SUBTITLE_NONE_TTL_MS - 5000);

    fetchSubtitleMock.mockClear();
    const second = await dispatchOp('bili.subtitle.fetch', { bvid: 'BVnoneMem00001' });
    expect(second).toEqual({ status: 'none' });
    // 记忆命中：网络适配器不再被调（降风控暴露）
    expect(fetchSubtitleMock).not.toHaveBeenCalled();
    expect(await getTranscript(mediaKey)).toBeNull();
  });

  it('none 记忆按 mediaKey 分 P 隔离：P1 的 none 不压制 P2 的请求', async () => {
    fetchSubtitleMock.mockClear();
    fetchSubtitleMock.mockResolvedValueOnce({ status: 'none' }).mockResolvedValueOnce(OK_RESULT);
    expect(await dispatchOp('bili.subtitle.fetch', { bvid: 'BVnoneIso00001' })).toEqual({ status: 'none' });
    expect(await dispatchOp('bili.subtitle.fetch', { bvid: 'BVnoneIso00001', p: 2 })).toEqual({
      status: 'ok',
      cached: false,
      segments: 3,
      lan: 'zh-CN',
      lanDoc: '中文字幕',
    });
    // P1 记忆命中 + P2 正常拉取：适配器恰好被调两次
    expect(fetchSubtitleMock).toHaveBeenCalledTimes(2);
    const p1Again = await dispatchOp('bili.subtitle.fetch', { bvid: 'BVnoneIso00001' });
    expect(p1Again).toEqual({ status: 'none' });
    expect(fetchSubtitleMock).toHaveBeenCalledTimes(2);
  });

  it('force 穿透记忆照常拉取；重拉 none 刷新记忆、重拉 ok 清除记忆', async () => {
    fetchSubtitleMock.mockClear();
    const mediaKey = biliMediaKey('BVforceMem0001');
    fetchSubtitleMock.mockResolvedValueOnce({ status: 'none' });
    await dispatchOp('bili.subtitle.fetch', { bvid: 'BVforceMem0001' });
    expect(biliSubtitleNoneMemory.get(mediaKey)).toBeDefined();

    // force：跳过记忆照常拉取（即使记忆未过期）
    fetchSubtitleMock.mockResolvedValueOnce({ status: 'none' });
    expect(await dispatchOp('bili.subtitle.fetch', { bvid: 'BVforceMem0001', force: true })).toEqual({ status: 'none' });
    expect(fetchSubtitleMock).toHaveBeenCalledTimes(2);
    const refreshed = biliSubtitleNoneMemory.get(mediaKey)!;
    expect(refreshed - Date.now()).toBeGreaterThan(BILI_SUBTITLE_NONE_TTL_MS - 5000);

    // force 重拉得到 ok：清除 none 记忆
    fetchSubtitleMock.mockResolvedValueOnce(OK_RESULT);
    expect(await dispatchOp('bili.subtitle.fetch', { bvid: 'BVforceMem0001', force: true })).toMatchObject({ status: 'ok' });
    expect(biliSubtitleNoneMemory.get(mediaKey)).toBeUndefined();
    // 记忆已清 + 字幕已落库：后续普通请求直接 cached（不进 none 记忆分支、不打接口）
    fetchSubtitleMock.mockClear();
    expect(await dispatchOp('bili.subtitle.fetch', { bvid: 'BVforceMem0001' })).toMatchObject({
      status: 'ok',
      cached: true,
    });
    expect(fetchSubtitleMock).not.toHaveBeenCalled();
  });

  it('TTL 过期后记忆不再命中（允许再次探测）', async () => {
    fetchSubtitleMock.mockClear();
    const mediaKey = biliMediaKey('BVttlMem000001');
    // 直接过期的记忆条目（模拟 SW 存活跨过 10 分钟窗口）
    biliSubtitleNoneMemory.set(mediaKey, Date.now() - 1);
    fetchSubtitleMock.mockResolvedValueOnce(OK_RESULT);
    expect(await dispatchOp('bili.subtitle.fetch', { bvid: 'BVttlMem000001' })).toMatchObject({ status: 'ok' });
    // 过期记忆不拦截：适配器被正常调用
    expect(fetchSubtitleMock).toHaveBeenCalledTimes(1);
    expect(biliSubtitleNoneMemory.get(mediaKey)).toBeUndefined();
  });
});
