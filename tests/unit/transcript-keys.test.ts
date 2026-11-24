/**
 * transcript.keys op 集成测试（fake-indexeddb，照 bili-subtitle-op.test.ts 模式）。
 *
 * 第 16 轮知识库「字幕已就绪」徽标改为按 transcripts 主键集合前缀匹配：
 * 多 P 后 `bili:<bvid>:p<N>` 分 P 键与 P1 裸键并存，逐个 transcript.get 精确查
 * 会漏掉分 P 记录。本 op 一次取全库主键（getAllKeys，仅键不载正文），前缀匹配
 * 逻辑在 UI 侧（LearningCenter hasBiliTranscriptKey）。
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '@/core/db';
import { listTranscriptMediaKeys } from '@/core/db/repo/content';
import { dispatchOp } from '@/entrypoints/background/ops';
import { biliMediaKey, hduMediaKey } from '@/core/shared/mediaRef';
import type { TranscriptEntity } from '@/core/shared/types';

const NOW = 1700000000000;

function makeTranscript(mediaKey: string, text: string): TranscriptEntity {
  return {
    mediaKey,
    segments: [{ s: 1, e: 2, text }],
    model: 'bili-official-subtitle',
    lang: 'zh-CN',
    glossaryVersion: 0,
    createdAt: NOW,
    source: 'bili-official-subtitle',
  };
}

beforeAll(async () => {
  const db = await getDb();
  await db.put('transcripts', makeTranscript(biliMediaKey('BVkeysP000001'), '第一分P'));
  await db.put('transcripts', makeTranscript(biliMediaKey('BVkeysP000001', 2), '第二分P'));
  await db.put('transcripts', {
    ...makeTranscript(hduMediaKey(41001), '站内课次'),
    courId: 41001,
    source: 'local-asr',
    model: 'fast',
  });
});

describe('transcript.keys（全库字幕主键，仅键不载正文）', () => {
  it('返回全部 mediaKey：P1 裸键与 p≥2 分 P 键并存，站内键不缺', async () => {
    const keys = await dispatchOp('transcript.keys', {});
    expect(new Set(keys)).toEqual(
      new Set(['bili:BVkeysP000001', 'bili:BVkeysP000001:p2', 'hdu:41001']),
    );
    const repoKeys = await listTranscriptMediaKeys();
    expect(repoKeys).toEqual(keys);
  });

  it('主键集合能支撑徽标前缀匹配（裸键前缀 + :p 边界不误伤相邻 bvid）', async () => {
    const keys = await listTranscriptMediaKeys();
    const readyOf = (bvid: string): boolean =>
      keys.some((key) => key === `bili:${bvid}` || key.startsWith(`bili:${bvid}:p`));
    // P1 裸键命中；仅分 P 键也命中（多 P 徽标点亮）
    expect(readyOf('BVkeysP000001')).toBe(true);
    // 相邻 bvid（BVkeysP000001 是其字符串前缀）不得误判
    expect(keys.some((key) => key.startsWith('bili:BVkeysP000002'))).toBe(false);
    expect(readyOf('BVkeysP000002')).toBe(false);
  });
});
