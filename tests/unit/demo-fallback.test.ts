import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb } from '@/core/db';
import { enterDemo, exitDemo } from '@/core/demo/seed';
import { biliMediaKey, hduMediaKey } from '@/core/shared/mediaRef';
import { extStorage } from '@/core/shared/storage';
import { DB_NAME, DB_NAME_DEMO } from '@/core/shared/constants';
import { handlers } from '@/entrypoints/background/ops';

async function deleteDbByName(name: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

beforeEach(async () => {
  await closeDb();
  extStorage.__resetMemory();
  await deleteDbByName(DB_NAME);
  await deleteDbByName(DB_NAME_DEMO);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeDb();
  extStorage.__resetMemory();
  await deleteDbByName(DB_NAME);
  await deleteDbByName(DB_NAME_DEMO);
});

describe('演示模式全课次 / 全 B 站视频统一规范侧栏回落', () => {
  it('未开启演示模式时，任意不存在的课次/视频不回落规范数据', async () => {
    expect(await handlers['transcript.get']({ mediaKey: hduMediaKey(999999) })).toBeNull();
    expect(await handlers['ai.get']({ mediaKey: hduMediaKey(999999) })).toEqual({ result: null, stale: false });
    expect(await handlers['qa.list']({ mediaKey: hduMediaKey(999999) })).toEqual([]);
    expect(await handlers['qa.groups']({ mediaKey: hduMediaKey(999999) })).toEqual([]);
    expect(await handlers['note.list']({ courId: 999999 })).toEqual([]);
    expect(await handlers['fav.list']({ filter: { courId: 999999 } })).toEqual([]);
    expect(await handlers['transcript.get']({ mediaKey: biliMediaKey('BV1UNKNOWN99', 2) })).toBeNull();
  });

  it('演示模式下进入任意 HDU 课次（未看 1227041 / 有原种子的 1227042 / 未知 999999）侧栏均为规范数据集', async () => {
    await enterDemo();

    const canonicalTx = await handlers['transcript.get']({ mediaKey: hduMediaKey(1227052) });
    const canonicalAi = await handlers['ai.get']({ mediaKey: hduMediaKey(1227052) });
    const canonicalGroups = await handlers['qa.groups']({ mediaKey: hduMediaKey(1227052) });
    const canonicalNotes = await handlers['note.list']({ courId: 1227052 });
    const canonicalFavs = await handlers['fav.list']({ filter: { courId: 1227052 } });

    expect(canonicalTx?.segments.length).toBeGreaterThanOrEqual(10);
    expect(canonicalAi.result?.topics.length).toBeGreaterThanOrEqual(3);
    expect(canonicalAi.result?.outline.length).toBeGreaterThanOrEqual(6);
    expect(canonicalGroups.length).toBe(3);
    expect(canonicalNotes.length).toBeGreaterThanOrEqual(2);
    expect(canonicalFavs.length).toBeGreaterThanOrEqual(2);

    for (const courId of [1227041, 1227042, 999999]) {
      const key = hduMediaKey(courId);
      const tx = await handlers['transcript.get']({ mediaKey: key });
      const ai = await handlers['ai.get']({ mediaKey: key });
      const groups = await handlers['qa.groups']({ mediaKey: key });
      const chats = await handlers['qa.list']({ mediaKey: key });
      const notes = await handlers['note.list']({ courId });
      const favs = await handlers['fav.list']({ filter: { courId } });

      expect(tx?.mediaKey).toBe(key);
      expect(tx?.courId).toBe(courId);
      expect(tx?.segments).toEqual(canonicalTx?.segments);

      expect(ai.result?.mediaKey).toBe(key);
      expect(ai.result?.courId).toBe(courId);
      expect(ai.result?.topics).toEqual(canonicalAi.result?.topics);
      expect(ai.result?.outline).toEqual(canonicalAi.result?.outline);

      expect(groups.map((g) => g.groupId)).toEqual(canonicalGroups.map((g) => g.groupId));
      // 隔离原有其它课次的 demo-* 聊天（例如 1227042 MATH_W1 的 demo-chat-5）
      expect(chats.some((c) => c.id === 'demo-chat-5')).toBe(false);
      const aiReplies = chats.filter((c) => c.role === 'ai');
      expect(aiReplies.length).toBeGreaterThanOrEqual(3);
      for (const reply of aiReplies) {
        expect(reply.evidence).toBeDefined();
      }

      expect(notes.length).toBe(canonicalNotes.length);
      expect(notes.every((n) => n.courId === courId)).toBe(true);
      expect(favs.length).toBe(canonicalFavs.length);
      expect(favs.every((f) => f.courId === courId)).toBe(true);
    }

    // 在非规范课次下检索字幕可命中规范字幕内容并标出当前课次 mediaKey
    const hits = await handlers['transcript.search']({
      query: '二叉树',
      mediaKeys: [hduMediaKey(1227041)],
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.mediaKey).toBe(hduMediaKey(1227041));
    expect(hits[0]?.courId).toBe(1227041);

    // 用户现场新增笔记后，与规范假数据合并展示
    await handlers['note.put']({
      note: {
        id: 'user-added-note-1227041',
        courId: 1227041,
        teclId: 9101,
        anchorTime: 185,
        text: '现场手记笔记',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    });
    const mergedNotes = await handlers['note.list']({ courId: 1227041 });
    expect(mergedNotes.some((n) => n.id === 'user-added-note-1227041')).toBe(true);
    expect(mergedNotes.length).toBe(canonicalNotes.length + 1);
  });

  it('演示模式下任意 B 站视频及分 P 返回规范 B 站完整数据且字幕获取不触发网络请求', async () => {
    await enterDemo();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('should not fetch in demo mode'));

    const canonicalKey = biliMediaKey('BV1DEMO7X4Kq');
    const canonicalTx = await handlers['transcript.get']({ mediaKey: canonicalKey });
    const canonicalAi = await handlers['ai.get']({ mediaKey: canonicalKey });
    const canonicalGroups = await handlers['qa.groups']({ mediaKey: canonicalKey });
    const canonicalNotes = await handlers['note.list']({ mediaKey: canonicalKey });

    expect(canonicalTx?.segments.length).toBeGreaterThanOrEqual(12);
    expect(canonicalAi.result?.topics.length).toBe(4);
    expect(canonicalAi.result?.outline.length).toBe(7);
    expect(canonicalGroups.length).toBe(2);
    expect(canonicalNotes.length).toBe(3);

    for (const [bvid, p] of [
      ['BV1DEMO7X4Kq', 2],
      ['BV1DEMO2LpVe', 1],
      ['BV1DEMO9PhYs', 1],
      ['BV1CUSTOM999', 3],
    ] as const) {
      const targetKey = biliMediaKey(bvid, p);
      const subFetch = await handlers['bili.subtitle.fetch']({ bvid, p });
      expect(subFetch.status).toBe('ok');
      if (subFetch.status === 'ok') {
        expect(subFetch.segments).toBe(canonicalTx?.segments.length);
      }

      const tx = await handlers['transcript.get']({ mediaKey: targetKey });
      const ai = await handlers['ai.get']({ mediaKey: targetKey });
      const groups = await handlers['qa.groups']({ mediaKey: targetKey });
      const groupsAll = await handlers['qa.groupsAll']({ bvid });
      const chatsAll = await handlers['qa.listAll']({ bvid });
      const notes = await handlers['note.list']({ mediaKey: targetKey });

      expect(tx?.mediaKey).toBe(targetKey);
      expect(tx?.segments).toEqual(canonicalTx?.segments);
      expect(ai.result?.mediaKey).toBe(targetKey);
      expect(ai.result?.topics).toEqual(canonicalAi.result?.topics);
      expect(groups.length).toBe(2);
      expect(groupsAll.length).toBe(2);
      expect(chatsAll.length).toBe(6);
      expect(notes.length).toBe(3);
    }

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('学习中心无过滤全量聚合（course.bundles / fav.list / note.list）仍保留多课程原貌', async () => {
    await enterDemo();

    const bundles = await handlers['course.bundles']({});
    expect(bundles).toHaveLength(5);

    const allFavs = await handlers['fav.list']({ filter: { limit: 500 } });
    const favCourses = new Set(allFavs.map((f) => f.courId).filter((id) => id !== undefined));
    expect(favCourses.size).toBeGreaterThanOrEqual(3);

    const allNotes = await handlers['note.list']({});
    const noteCourses = new Set(allNotes.map((n) => n.courId));
    expect(noteCourses.size).toBeGreaterThanOrEqual(3);

    await exitDemo();
  });
});
