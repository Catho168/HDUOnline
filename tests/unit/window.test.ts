/**
 * 局部转写时间窗（"只转写当前进度前后 x 分钟"，§5.2 B1，片段流式转写的口径来源）。
 *
 * 重点校验三处调用口径一致：SW 规划的分片范围、管线/Worker 的逐片判定必须与
 * `windowChunkRange` 对齐——不一致会导致"窗口内分片被跳过"或"窗口外分片仍被拉流"。
 */

import { describe, expect, it } from 'vitest';
import { ASR_PARAMS } from '@/core/shared/constants';
import {
  chunkInWindow,
  clampWindowMinutes,
  resolveWindow,
  windowAudioSec,
  windowChunkRange,
  windowHalfSecFromMinutes,
} from '@/core/asr/window';

const CHUNK = ASR_PARAMS.chunkSec; // 10 分钟分片
const HALF = 600; // ±10 分钟

describe('resolveWindow', () => {
  it('以当前位置为中心取前后各 10 分钟', () => {
    expect(resolveWindow(1500, HALF, 2820)).toEqual({ start: 900, end: 2100 });
  });

  it('靠近开头时下界裁剪到 0', () => {
    expect(resolveWindow(120, HALF, 2820)).toEqual({ start: 0, end: 720 });
  });

  it('靠近结尾时上界裁剪到总时长', () => {
    expect(resolveWindow(2800, HALF, 2820)).toEqual({ start: 2200, end: 2820 });
  });

  it('时长未知（0）时不做上界裁剪，只按中心取值', () => {
    expect(resolveWindow(300, HALF, 0)).toEqual({ start: 0, end: 900 });
  });

  it('位置缺失或非法时退化为从头开始的一段', () => {
    expect(resolveWindow(undefined, HALF, 2820)).toEqual({ start: 0, end: 600 });
    expect(resolveWindow(Number.NaN, HALF, 2820)).toEqual({ start: 0, end: 600 });
    expect(resolveWindow(-5, HALF, 2820)).toEqual({ start: 0, end: 600 });
  });

  it('半径为 0 时退化为单点窗口', () => {
    expect(resolveWindow(100, 0, 2820)).toEqual({ start: 100, end: 100 });
  });
});

describe('chunkInWindow', () => {
  it('无窗口时所有分片都参与（整段转写行为不变）', () => {
    expect(chunkInWindow(0, CHUNK, 2820)).toBe(true);
    expect(chunkInWindow(4, CHUNK, 2820)).toBe(true);
  });

  it('按半开区间相交判定：窗口起点所在分片算入，终点所在分片不算入', () => {
    const window = { start: 900, end: 2100 };
    expect(chunkInWindow(0, CHUNK, 2820, window)).toBe(false); // [0,600) 与窗口不相交
    expect(chunkInWindow(1, CHUNK, 2820, window)).toBe(true); // [600,1200) 含窗口起点
    expect(chunkInWindow(2, CHUNK, 2820, window)).toBe(true); // [1200,1800)
    expect(chunkInWindow(3, CHUNK, 2820, window)).toBe(true); // [1800,2400)
    expect(chunkInWindow(4, CHUNK, 2820, window)).toBe(false); // [2400,2820) 不相交
  });

  it('最后一个分片按总时长截断', () => {
    // [2400, 2820) 与 [2800, 2900) 相交
    expect(chunkInWindow(4, CHUNK, 2820, { start: 2800, end: 2900 })).toBe(true);
  });
});

describe('windowChunkRange', () => {
  it('给出与窗口相交的分片闭区间', () => {
    expect(windowChunkRange({ start: 900, end: 2100 }, 2820, CHUNK)).toEqual({ first: 1, last: 3 });
  });

  it('窗口落在尾部时上界不越过分片总数', () => {
    expect(windowChunkRange({ start: 2200, end: 2820 }, 2820, CHUNK)).toEqual({ first: 3, last: 4 });
  });

  it('时长未知（0）时退化为单个分片而非空区间', () => {
    expect(windowChunkRange({ start: 0, end: 600 }, 0, CHUNK)).toEqual({ first: 0, last: 0 });
  });
});

describe('windowAudioSec', () => {
  it('返回窗口内的音频秒数（进度分母）', () => {
    expect(windowAudioSec({ start: 900, end: 2100 }, 2820)).toBe(1200);
  });

  it('窗口上界超过总时长时按总时长裁剪', () => {
    expect(windowAudioSec({ start: 2200, end: 3000 }, 2820)).toBe(620);
  });
});

describe('clampWindowMinutes / windowHalfSecFromMinutes', () => {
  it('默认 10 分钟，越界收进允许范围（设置页可被手改/旧数据缺字段）', () => {
    expect(clampWindowMinutes(undefined)).toBe(ASR_PARAMS.windowMinutesDefault);
    expect(clampWindowMinutes(Number.NaN)).toBe(ASR_PARAMS.windowMinutesDefault);
    expect(clampWindowMinutes(1)).toBe(ASR_PARAMS.windowMinutesMin);
    expect(clampWindowMinutes(999)).toBe(ASR_PARAMS.windowMinutesMax);
    expect(clampWindowMinutes(7.4)).toBe(7);
  });

  it('分钟 → 秒换算，供 SW / 决策器 / 管线共用同一半径', () => {
    expect(windowHalfSecFromMinutes(10)).toBe(600);
    expect(windowHalfSecFromMinutes(undefined)).toBe(ASR_PARAMS.windowMinutesDefault * 60);
    expect(windowHalfSecFromMinutes(-3)).toBe(ASR_PARAMS.windowMinutesMin * 60);
  });
});

describe('口径一致性（SW 规划 ↔ 逐片判定）', () => {
  const durationSec = 2820;
  const window = resolveWindow(1500, HALF, durationSec);
  const range = windowChunkRange(window, durationSec, CHUNK);

  it('范围内每个分片都判定为窗口内', () => {
    expect(range).not.toBeNull();
    for (let index = range!.first; index <= range!.last; index += 1) {
      expect(chunkInWindow(index, CHUNK, durationSec, window)).toBe(true);
    }
  });

  it('范围外的分片都判定为窗口外（不会被拉流）', () => {
    const total = Math.ceil(durationSec / CHUNK);
    for (let index = 0; index < total; index += 1) {
      if (range && index >= range.first && index <= range.last) continue;
      expect(chunkInWindow(index, CHUNK, durationSec, window)).toBe(false);
    }
  });

  it('范围内分片的总时长足以覆盖整个窗口', () => {
    const plannedChunks = range!.last - range!.first + 1;
    expect(plannedChunks * CHUNK).toBeGreaterThanOrEqual(windowAudioSec(window, durationSec));
  });
});
