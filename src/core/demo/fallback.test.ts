import test from 'node:test';
import assert from 'node:assert/strict';
import { biliMediaKey, hduMediaKey } from '../shared/mediaRef';
import type {
  AiResultEntity,
  ChatMessageEntity,
  ExternalNoteEntity,
  FavoriteEntity,
  NoteEntity,
  TranscriptEntity,
} from '../shared/types';
import {
  DEMO_BILI_CANONICAL_BVID,
  DEMO_HDU_CANONICAL_COUR_ID,
  buildDemoSubtitleFetchResult,
  canonicalDemoMediaKey,
  isCanonicalDemoMediaKey,
  isSeededDemoId,
  mergeChats,
  mergeFavorites,
  mergeNotes,
  rebaseAiResult,
  rebaseChats,
  rebaseExternalNotes,
  rebaseFavoritesForCour,
  rebaseNotesForCour,
  rebaseTranscript,
  searchTranscriptSegments,
  summarizeChatGroups,
  summarizeChatGroupsAll,
} from './fallback';

test('canonicalDemoMediaKey maps any valid HDU or Bili key to its canonical template', () => {
  assert.equal(canonicalDemoMediaKey(hduMediaKey(DEMO_HDU_CANONICAL_COUR_ID)), hduMediaKey(1227052));
  assert.equal(canonicalDemoMediaKey(hduMediaKey(1227041)), hduMediaKey(1227052));
  assert.equal(canonicalDemoMediaKey(hduMediaKey(999999)), hduMediaKey(1227052));

  assert.equal(canonicalDemoMediaKey(biliMediaKey(DEMO_BILI_CANONICAL_BVID)), biliMediaKey('BV1DEMO7X4Kq'));
  assert.equal(canonicalDemoMediaKey(biliMediaKey(DEMO_BILI_CANONICAL_BVID, 2)), biliMediaKey('BV1DEMO7X4Kq'));
  assert.equal(canonicalDemoMediaKey(biliMediaKey('BV1CUSTOM999', 3)), biliMediaKey('BV1DEMO7X4Kq'));
  assert.equal(canonicalDemoMediaKey('invalid-key'), null);

  assert.equal(isCanonicalDemoMediaKey(hduMediaKey(1227052)), true);
  assert.equal(isCanonicalDemoMediaKey(hduMediaKey(1227041)), false);
  assert.equal(isCanonicalDemoMediaKey(biliMediaKey('BV1DEMO7X4Kq')), true);
  assert.equal(isCanonicalDemoMediaKey(biliMediaKey('BV1DEMO7X4Kq', 2)), false);
});

test('rebaseTranscript updates mediaKey/courId properly for HDU and Bili without mutating source', () => {
  const hduSource: TranscriptEntity = {
    mediaKey: hduMediaKey(1227052),
    courId: 1227052,
    segments: [{ s: 0, e: 12, text: 'Dijkstra 算法用于非负权图单源最短路径。' }],
    model: 'demo-preset',
    source: 'local-asr',
    lang: 'zh',
    glossaryVersion: 1,
    createdAt: 1000,
    coveredSec: 12,
  };
  const hduTarget = rebaseTranscript(hduSource, hduMediaKey(1227041));
  assert.equal(hduTarget.mediaKey, 'hdu:1227041');
  assert.equal(hduTarget.courId, 1227041);
  hduTarget.segments[0]!.text = 'mutated';
  assert.notEqual(hduSource.segments[0]!.text, 'mutated');

  const biliTarget = rebaseTranscript(hduSource, biliMediaKey('BV1OTHER123', 2));
  assert.equal(biliTarget.mediaKey, 'bili:BV1OTHER123:p2');
  assert.equal('courId' in biliTarget, false);
});

test('searchTranscriptSegments scores matching segments across rebased transcripts', () => {
  const tx: TranscriptEntity = {
    mediaKey: hduMediaKey(1227041),
    courId: 1227041,
    segments: [
      { s: 0, e: 10, text: '今天介绍图论基础' },
      { s: 10, e: 25, text: 'Dijkstra 算法和优先队列时间复杂度分析，重点是 Dijkstra 松弛步骤' },
    ],
    model: 'demo-preset',
    source: 'local-asr',
    lang: 'zh',
    glossaryVersion: 1,
    createdAt: 1000,
  };
  const hits = searchTranscriptSegments([tx], 'Dijkstra', 10);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.mediaKey, 'hdu:1227041');
  assert.equal(hits[0]?.courId, 1227041);
  assert.equal(hits[0]?.start, 10);
  assert.equal(hits[0]?.end, 25);
});

test('rebaseAiResult clones topics and outline cleanly onto target mediaKey', () => {
  const aiSource: AiResultEntity = {
    mediaKey: hduMediaKey(1227052),
    courId: 1227052,
    promptVersion: 1,
    model: 'demo',
    topics: [{ name: '最短路径', summary: 'Dijkstra 核心思路', intervals: [[10, 80]], confidence: 'high' }],
    outline: [
      { title: '图论复习', start: 0, end: 120, level: 1 },
      { title: 'Dijkstra', start: 10, end: 80, level: 2, parent: 0 },
    ],
    createdAt: 1000,
  };
  const rebased = rebaseAiResult(aiSource, hduMediaKey(1227061));
  assert.equal(rebased.mediaKey, 'hdu:1227061');
  assert.equal(rebased.courId, 1227061);
  rebased.topics[0]!.intervals[0]![0] = 999;
  assert.equal(aiSource.topics[0]!.intervals[0]![0], 10);

  const biliRebased = rebaseAiResult(aiSource, biliMediaKey('BV1XYZ'));
  assert.equal('courId' in biliRebased, false);
});

test('mergeChats filters out seeded demo rows on target while preserving user messages', () => {
  const canonicalRebased: ChatMessageEntity[] = rebaseChats(
    [
      {
        id: 'demo-chat-1',
        mediaKey: hduMediaKey(1227052),
        courId: 1227052,
        groupId: 'demo-group-ds-1',
        role: 'user',
        content: '什么情况下用 Dijkstra？',
        anchorTime: 240,
        status: 'done',
        createdAt: 100,
      },
      {
        id: 'demo-chat-2',
        mediaKey: hduMediaKey(1227052),
        courId: 1227052,
        groupId: 'demo-group-ds-1',
        role: 'ai',
        content: '边权非负时使用。',
        anchorTime: 240,
        evidence: { start: 180, end: 260 },
        status: 'done',
        createdAt: 101,
      },
    ],
    hduMediaKey(1227042),
  );

  const targetExisting: ChatMessageEntity[] = [
    {
      id: 'demo-chat-5',
      mediaKey: hduMediaKey(1227042),
      courId: 1227042,
      groupId: 'demo-group-math-1',
      role: 'user',
      content: '另一门课的种子提问，应该被隔离',
      status: 'done',
      createdAt: 200,
    },
    {
      id: 'user-uuid-1',
      mediaKey: hduMediaKey(1227042),
      courId: 1227042,
      groupId: 'user-group-1',
      role: 'user',
      content: '用户现场提问',
      anchorTime: 300,
      status: 'done',
      createdAt: 300,
    },
  ];

  const merged = mergeChats(canonicalRebased, targetExisting, hduMediaKey(1227052), hduMediaKey(1227042));
  assert.equal(isSeededDemoId('demo-chat-5'), true);
  assert.equal(isSeededDemoId('user-uuid-1'), false);
  assert.deepEqual(
    merged.map((m) => m.id),
    ['demo-chat-1', 'demo-chat-2', 'user-uuid-1'],
  );
  assert.equal(merged[1]?.evidence?.start, 180);

  const groups = summarizeChatGroups(merged);
  assert.equal(groups.length, 2);
  assert.equal(groups[0]?.groupId, 'user-group-1');
  assert.equal(groups[1]?.groupId, 'demo-group-ds-1');

  const allBiliGroups = summarizeChatGroupsAll(
    rebaseChats(merged, biliMediaKey('BV1CUSTOM999', 2)),
  );
  assert.equal(allBiliGroups[0]?.mediaKey, 'bili:BV1CUSTOM999:p2');
  assert.equal(allBiliGroups[0]?.p, 2);
});

test('mergeNotes and mergeFavorites rebase canonical entities and keep user creations', () => {
  const canonicalNotes: NoteEntity[] = [
    { id: 'demo-note-1', courId: 1227052, teclId: 9102, anchorTime: 60, text: 'Canonical Note', createdAt: 100, updatedAt: 100 },
  ];
  const targetNotes: NoteEntity[] = [
    { id: 'demo-note-old', courId: 1227042, teclId: 9101, anchorTime: 20, text: 'Should drop', createdAt: 100, updatedAt: 100 },
    { id: 'user-note-1', courId: 1227042, teclId: 9101, anchorTime: 30, text: 'User Note', createdAt: 200, updatedAt: 200 },
  ];
  const rebasedNotes = rebaseNotesForCour(canonicalNotes, 1227042, 9101);
  const mergedNotes = mergeNotes(rebasedNotes, targetNotes, false);
  assert.deepEqual(
    mergedNotes.map((n) => ({ id: n.id, courId: n.courId, teclId: n.teclId })),
    [
      { id: 'user-note-1', courId: 1227042, teclId: 9101 },
      { id: 'demo-note-1', courId: 1227042, teclId: 9101 },
    ],
  );

  const xSource: ExternalNoteEntity[] = [
    { id: 'demo-xnote-1', mediaKey: biliMediaKey('BV1DEMO7X4Kq'), anchorTime: 58, text: '特征方程写法', createdAt: 100, updatedAt: 100 },
  ];
  const xRebased = rebaseExternalNotes(xSource, biliMediaKey('BV1OTHER', 2));
  assert.equal(xRebased[0]?.mediaKey, 'bili:BV1OTHER:p2');

  const favCanonical: FavoriteEntity[] = [
    {
      id: 'demo-fav-1',
      type: 'ai',
      snapshot: { title: 'Canonical Fav', content: 'Content' },
      courId: 1227052,
      teclId: 9102,
      tags: ['算法'],
      pinned: true,
      favoritedAt: 100,
      updatedAt: 100,
    },
  ];
  const favTarget: FavoriteEntity[] = [
    {
      id: 'user-fav-1',
      type: 'time',
      snapshot: { title: 'User Fav', content: 'Content 2' },
      courId: 1227042,
      teclId: 9101,
      tags: [],
      pinned: false,
      favoritedAt: 500,
      updatedAt: 500,
    },
  ];
  const mergedFavs = mergeFavorites(rebaseFavoritesForCour(favCanonical, 1227042, 9101), favTarget, false, true);
  assert.deepEqual(
    mergedFavs.map((f) => f.id),
    ['demo-fav-1', 'user-fav-1'],
  );
  assert.equal(mergedFavs[0]?.courId, 1227042);
  assert.equal(mergedFavs[0]?.teclId, 9101);
});

test('buildDemoSubtitleFetchResult returns offline ok payload', () => {
  const tx: TranscriptEntity = {
    mediaKey: biliMediaKey('BV1DEMO2LpVe', 2),
    segments: [
      { s: 0, e: 10, text: 'seg 1' },
      { s: 10, e: 20, text: 'seg 2' },
    ],
    model: 'bili-official-subtitle',
    source: 'bili-official-subtitle',
    lang: 'zh-CN',
    glossaryVersion: 0,
    createdAt: 1000,
  };
  assert.deepEqual(buildDemoSubtitleFetchResult(tx), {
    status: 'ok',
    cached: true,
    segments: 2,
    lan: 'zh-CN',
    lanDoc: '中文（演示字幕）',
  });
});
