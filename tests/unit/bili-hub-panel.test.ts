/**
 * B 站学习中心面板（BiliHubPanel.tsx，第 32 轮巡检）单测。
 *
 * 覆盖：
 *  1. 纯函数 isBiliHubFavorite：video（BV refId）/ time（metadata.bvid）/
 *     ai（metadata.bvid，第 34 轮）/ note（metadata.mediaKey=bili 键，第 34 轮）收录，
 *     非 BV refId、HDU 站内同型收藏（无 B 站归属 metadata）排除；
 *  2. 纯函数 sortHubFavorites：置顶优先，其余按收藏时间倒序；
 *  3. 纯函数 filterHubFavoritesByType（第 34 轮）：全部/视频/此时刻/问答/笔记类型过滤，
 *     与 filterHubFavorites 关键词过滤 AND 叠加；
 *  4. 组件（jsdom + react-dom 客户端渲染，无 JSX、直接 createElement，照
 *     fav-edit-modal-shared.test.ts 模式；callOp 整体 mock）：
 *     - 知识库页签：fav.list 结果过滤出 B 站收藏（video + time），HDU 收藏不混入，
 *       独立 shadow host（hdu-bili-hub-host）内渲染 VideoFavCard 列表；
 *     - 空态：「还没有收藏的视频」；
 *     - 统计页签：切换后 BiliWatchCard 挂载并发起 stats.bili.overview；
 *     - 加入复习：点击卡片复习按钮 → review.plan 携带 favoriteId → 面板内 toast；
 *     - 类型筛选 chips（第 34 轮）：点「视频」/「此时刻」各自只剩对应卡片，「全部」恢复；
 *     - ai/note 收藏收录与卡片渲染（第 34 轮 P2-1）：类型标签/锚点时间/收藏时间；
 *     - 面板重开重置搜索词与类型筛选（第 34 轮 P3-4）；
 *     - 统计页签学习周报（第 34 轮）：PeriodReportCard 挂载并发起 stats.period，
 *       渲染周报关键文案（B 站侧与 HDU 统计页共用同一组件）；
 *  5. 字幕能力（第 36 轮巡检）：hasBiliTranscriptKey 前缀匹配判定（P1 裸键 / p≥2
 *     分 P 键 / 相邻 bvid 不误匹配 / 无字幕）；知识库视频卡「字幕已就绪」徽标与
 *     「查看字幕」入口（time/ai/note 卡无此槽位）；点击在独立 shadow host 内打开
 *     共享 BiliSubtitlePanel（seekMode='external'，transcript.get 按 bvid+分 P
 *     媒体主键取数，关闭只关浮层不关面板）；收藏夹导入进行中防重复点击。
 *
 * 样式桥接（独立 shadow host + UI_CSS）不在 jsdom 断言范围（computed style 无意义），
 * 只断言 portal 容器与内容挂载。
 */
// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({ callOp: vi.fn() }));

import { callOp } from '@/core/shared/client';
import { hasBiliTranscriptKey } from '@/core/shared/mediaRef';
import {
  BiliHubPanel,
  BILI_HUB_HOST_ID,
  filterHubFavorites,
  filterHubFavoritesByType,
  isBiliHubFavorite,
  sortHubFavorites,
} from '@/entrypoints/content/ui/BiliHubPanel';
import type { FavoriteEntity } from '@/core/shared/types';
import { dayKeyToTs, localDayKey } from '@/core/shared/utils';
import type { PeriodReport } from '@/core/stats/period';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;

const BVID = 'BV1HubTest01';

function makeVideoFav(overrides: Partial<FavoriteEntity> = {}): FavoriteEntity {
  return {
    id: 'fav-video-1',
    type: 'video',
    refId: BVID,
    snapshot: { title: '线性代数公开课：矩阵乘法', content: 'B 站收藏的网课视频' },
    folderId: null,
    tags: ['高数'],
    pinned: false,
    favoritedAt: 1000,
    updatedAt: 1000,
    metadata: { platform: 'bilibili', bvid: BVID, url: `https://www.bilibili.com/video/${BVID}` },
    ...overrides,
  };
}

function makeTimeFav(overrides: Partial<FavoriteEntity> = {}): FavoriteEntity {
  return {
    id: 'fav-time-1',
    type: 'time',
    snapshot: { title: '线性代数公开课 · 03:00', content: 'B站视频的时间点 03:00' },
    anchorTime: 180,
    folderId: null,
    tags: [],
    pinned: false,
    favoritedAt: 2000,
    updatedAt: 2000,
    metadata: { platform: 'bilibili', bvid: BVID, url: 'https://www.bilibili.com/video/x?t=180' },
    ...overrides,
  } as FavoriteEntity;
}

/** HDU 站内收藏（时间点笔记，无 bvid）：不应进 B 站学习中心 */
function makeHduFav(): FavoriteEntity {
  return {
    id: 'fav-hdu-1',
    type: 'time',
    snapshot: { title: '站内时间点', content: 'HDU 课堂笔记' },
    courId: 12,
    teclId: 34,
    anchorTime: 60,
    folderId: null,
    tags: [],
    pinned: false,
    favoritedAt: 3000,
    updatedAt: 3000,
  } as FavoriteEntity;
}

/** B 站 AI 回答收藏（buildAiFavorite 口径：refId=chatId，metadata 带 bvid，第 34 轮收录） */
function makeAiFav(overrides: Partial<FavoriteEntity> = {}): FavoriteEntity {
  return {
    id: 'fav-ai-1',
    type: 'ai',
    refId: 'chat-1',
    snapshot: { title: '特征值有什么直观含义', content: '特征值描述了线性变换的不变方向' },
    anchorTime: 300,
    folderId: null,
    tags: [],
    pinned: false,
    favoritedAt: 1500,
    updatedAt: 1500,
    metadata: { platform: 'bilibili', bvid: BVID, url: `https://www.bilibili.com/video/${BVID}` },
    ...overrides,
  } as FavoriteEntity;
}

/** B 站笔记转藏（noteToFavorite 站外口径：metadata.mediaKey=bili:<bvid>，无 courId/teclId，第 34 轮收录） */
function makeNoteFav(overrides: Partial<FavoriteEntity> = {}): FavoriteEntity {
  return {
    id: 'fav-note-1',
    type: 'note',
    refId: 'note-1',
    snapshot: { title: '笔记 @120s', content: '矩阵乘法不满足交换律' },
    anchorTime: 120,
    folderId: null,
    tags: [],
    pinned: false,
    favoritedAt: 2500,
    updatedAt: 2500,
    metadata: { mediaKey: `bili:${BVID}` },
    ...overrides,
  } as FavoriteEntity;
}

/** HDU 站内 AI 收藏（favoriteChat 口径：courId/teclId、无 metadata）：不应进 B 站学习中心 */
function makeHduAiFav(): FavoriteEntity {
  return {
    id: 'fav-hdu-ai',
    type: 'ai',
    refId: 'chat-hdu-1',
    snapshot: { title: '站内 AI 回答', content: 'HDU 课堂问答' },
    courId: 12,
    teclId: 34,
    anchorTime: 60,
    folderId: null,
    tags: [],
    pinned: false,
    favoritedAt: 4000,
    updatedAt: 4000,
  } as FavoriteEntity;
}

/** HDU 站内笔记转藏（noteToFavorite 站内口径：courId/teclId、无 metadata）：不应进 B 站学习中心 */
function makeHduNoteFav(): FavoriteEntity {
  return {
    id: 'fav-hdu-note',
    type: 'note',
    refId: 'note-hdu-1',
    snapshot: { title: '笔记 @60s', content: 'HDU 站内笔记转藏' },
    courId: 12,
    teclId: 34,
    anchorTime: 60,
    folderId: null,
    tags: [],
    pinned: false,
    favoritedAt: 5000,
    updatedAt: 5000,
  } as FavoriteEntity;
}

/** transcript.get 回包（BiliSubtitlePanel 渲染行列表所需的最小 TranscriptEntity） */
function makeTranscript(mediaKey: string) {
  return {
    mediaKey,
    segments: [
      { s: 0, e: 5, text: '大家好，欢迎来到线性代数课堂' },
      { s: 5, e: 12, text: '今天讲矩阵乘法' },
    ],
    model: 'bili-official',
    lang: 'zh-CN',
    glossaryVersion: 0,
    createdAt: 1,
    source: 'bili-official-subtitle' as const,
    aiSubtitle: false,
  };
}

/** bili.favlist.items 的单条目（BiliImportModal 步骤③写入载荷来源） */
function makeBiliFavItem(bvid: string, title: string) {
  return {
    bvid,
    title,
    coverUrl: `https://i0.hdslb.com/bfs/archive/${bvid}.jpg`,
    uploader: '网课 UP 主',
    durationSec: 600,
    intro: '',
  };
}

describe('isBiliHubFavorite', () => {
  it('video 收藏按 BV refId 收录，非法 refId 排除', () => {
    expect(isBiliHubFavorite(makeVideoFav())).toBe(true);
    expect(isBiliHubFavorite(makeVideoFav({ refId: 'BV1A' }))).toBe(false);
    expect(isBiliHubFavorite(makeVideoFav({ refId: undefined }))).toBe(false);
  });
  it('time 收藏按 metadata.bvid 收录，缺 bvid 排除', () => {
    expect(isBiliHubFavorite(makeTimeFav())).toBe(true);
    expect(isBiliHubFavorite(makeTimeFav({ metadata: { platform: 'bilibili' } }))).toBe(false);
    expect(isBiliHubFavorite(makeTimeFav({ metadata: undefined }))).toBe(false);
  });
  it('ai 收藏按 metadata.bvid 收录（第 34 轮），HDU 站内 AI 收藏（无 metadata）排除', () => {
    expect(isBiliHubFavorite(makeAiFav())).toBe(true);
    // bvid 缺失/非法/整体无 metadata 均排除
    expect(isBiliHubFavorite(makeAiFav({ metadata: { platform: 'bilibili' } }))).toBe(false);
    expect(isBiliHubFavorite(makeAiFav({ metadata: { bvid: 'BV1A' } }))).toBe(false);
    expect(isBiliHubFavorite(makeAiFav({ metadata: undefined }))).toBe(false);
    // HDU 站内 favoriteChat 产出：courId/teclId、无 metadata
    expect(isBiliHubFavorite(makeHduAiFav())).toBe(false);
  });
  it('note 收藏按 metadata.mediaKey（bili 键）收录（第 34 轮），HDU 站内笔记转藏排除', () => {
    expect(isBiliHubFavorite(makeNoteFav())).toBe(true);
    // 分 P 键 bili:<bvid>:pN 同样收录
    expect(isBiliHubFavorite(makeNoteFav({ metadata: { mediaKey: `bili:${BVID}:p2` } }))).toBe(true);
    // 非法/缺失 mediaKey 排除
    expect(isBiliHubFavorite(makeNoteFav({ metadata: { mediaKey: 'hdu:12' } }))).toBe(false);
    expect(isBiliHubFavorite(makeNoteFav({ metadata: { mediaKey: 'bili:' } }))).toBe(false);
    expect(isBiliHubFavorite(makeNoteFav({ metadata: undefined }))).toBe(false);
    // HDU 站内 noteToFavorite 产出：courId/teclId、无 metadata
    expect(isBiliHubFavorite(makeHduNoteFav())).toBe(false);
  });
  it('HDU 站内收藏（courId，无 bvid）与其他类型排除', () => {
    expect(isBiliHubFavorite(makeHduFav())).toBe(false);
    expect(isBiliHubFavorite(makeVideoFav({ type: 'outline', refId: undefined }))).toBe(false);
    expect(isBiliHubFavorite(makeVideoFav({ type: 'screenshot', refId: undefined }))).toBe(false);
  });
});

describe('sortHubFavorites', () => {
  it('置顶优先，其余按收藏时间倒序，不改原数组', () => {
    const a = makeVideoFav({ id: 'a', favoritedAt: 100 });
    const b = makeTimeFav({ id: 'b', favoritedAt: 300 });
    const c = makeVideoFav({ id: 'c', favoritedAt: 200, pinned: true });
    const list = [a, b, c];
    const sorted = sortHubFavorites(list);
    expect(sorted.map((f) => f.id)).toEqual(['c', 'b', 'a']);
    expect(list.map((f) => f.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('filterHubFavorites 知识库搜索过滤（第 33 轮）', () => {
  it('标题/备注/标签大小写不敏感 contains；空白查询返回全部副本', () => {
    const video = makeVideoFav({ id: 'v', note: '期末复习重点', tags: ['高数', 'E2E'] });
    const time = makeTimeFav({ id: 't' });
    const list = [video, time];

    // 空白查询：返回原序副本
    expect(filterHubFavorites(list, '')).toEqual(list);
    expect(filterHubFavorites(list, '   ')).toEqual(list);
    expect(filterHubFavorites(list, '')).not.toBe(list);

    // 标题命中（大小写不敏感）
    expect(filterHubFavorites(list, '矩阵乘法').map((f) => f.id)).toEqual(['v']);
    expect(filterHubFavorites(list, '线性代数').map((f) => f.id)).toEqual(['v', 't']);

    // 备注命中
    expect(filterHubFavorites(list, '期末复习').map((f) => f.id)).toEqual(['v']);

    // 标签命中（大小写不敏感）
    expect(filterHubFavorites(list, '高数').map((f) => f.id)).toEqual(['v']);
    expect(filterHubFavorites(list, 'e2e').map((f) => f.id)).toEqual(['v']);

    // 时间点收藏的标题（· 03:00）亦可命中
    expect(filterHubFavorites(list, '03:00').map((f) => f.id)).toEqual(['t']);
  });

  it('无命中返回空数组', () => {
    const list = [makeVideoFav()];
    expect(filterHubFavorites(list, '不存在的关键词')).toEqual([]);
  });
});

describe('filterHubFavoritesByType 知识库类型筛选（第 34 轮）', () => {
  const video = makeVideoFav({ id: 'v' });
  const time = makeTimeFav({ id: 't' });

  it('all 返回原序副本；video/time 各自只保留对应类型', () => {
    const list = [video, time];
    expect(filterHubFavoritesByType(list, 'all')).toEqual(list);
    expect(filterHubFavoritesByType(list, 'all')).not.toBe(list);
    expect(filterHubFavoritesByType(list, 'video').map((f) => f.id)).toEqual(['v']);
    expect(filterHubFavoritesByType(list, 'time').map((f) => f.id)).toEqual(['t']);
  });

  it('不改原数组，空列表安全', () => {
    const list = [video, time];
    filterHubFavoritesByType(list, 'video');
    expect(list.map((f) => f.id)).toEqual(['v', 't']);
    expect(filterHubFavoritesByType([], 'time')).toEqual([]);
  });

  it('与 filterHubFavorites AND 叠加：先类型后关键词 / 先关键词后类型结果一致', () => {
    const v1 = makeVideoFav({ id: 'v1', snapshot: { title: '线性代数：矩阵乘法', content: '' } });
    const v2 = makeVideoFav({ id: 'v2', snapshot: { title: '概率论：大数定律', content: '' } });
    const list = [v1, v2, time];
    const keyword = '矩阵乘法';
    expect(filterHubFavorites(filterHubFavoritesByType(list, 'video'), keyword).map((f) => f.id)).toEqual(['v1']);
    expect(filterHubFavoritesByType(filterHubFavorites(list, keyword), 'video').map((f) => f.id)).toEqual(['v1']);
    // 类型筛选后关键词无命中 → 空态路径
    expect(filterHubFavorites(filterHubFavoritesByType(list, 'time'), keyword)).toEqual([]);
  });

  it('ai / note 类型各自只保留对应收藏（第 34 轮 chips 扩展）', () => {
    const ai = makeAiFav({ id: 'a' });
    const note = makeNoteFav({ id: 'n' });
    const list = [video, time, ai, note];
    expect(filterHubFavoritesByType(list, 'ai').map((f) => f.id)).toEqual(['a']);
    expect(filterHubFavoritesByType(list, 'note').map((f) => f.id)).toEqual(['n']);
    expect(filterHubFavoritesByType(list, 'video').map((f) => f.id)).toEqual(['v']);
    expect(filterHubFavoritesByType(list, 'time').map((f) => f.id)).toEqual(['t']);
    expect(filterHubFavoritesByType(list, 'all').map((f) => f.id)).toEqual(['v', 't', 'a', 'n']);
  });
});

// ───────────────────────── 组件（独立 shadow host portal） ─────────────────────────

/** stats.period 固定周报（第 34 轮：统计页签 PeriodReportCard 挂载断言用，结构与 stats-period-ui.test.ts 同源） */
const HUB_WEEK_REPORT: PeriodReport = {
  kind: 'week',
  count: 8,
  todayKey: '2026-05-06',
  buckets: [
    {
      key: '2026-04-27',
      label: '04-27–05-03',
      chartLabel: '04-27',
      kind: 'week',
      startDay: '2026-04-27',
      endDay: '2026-05-03',
      startTs: dayKeyToTs('2026-04-27'),
      endTs: dayKeyToTs('2026-05-04'),
      internalSec: 600,
      externalSec: 180,
      activeDays: 2,
      flowCount: 3,
      plan: null,
    },
  ],
  totalInternalSec: 600,
  totalExternalSec: 180,
  generatedAt: dayKeyToTs('2026-05-06') + 20 * 3600_000,
};

let calls: Array<{ op: string; args: unknown }> = [];

function stubOps(table: Record<string, unknown> = {}): void {
  calls = [];
  const defaults: Record<string, unknown> = {
    'fav.list': [],
    'folder.list': [],
    'review.plan': [],
    // 今日页签（第 35 轮）与导入弹窗（第 35 轮）的缺省回包
    'review.due': [],
    'bili.nav.get': { isLogin: false },
    // 字幕能力（第 36 轮）：知识库列表加载后拉全库字幕主键；浮层打开时按媒体主键取正文
    'transcript.keys': [],
    'transcript.get': null,
    'stats.bili.overview': {
      range: { kind: 'week', startDay: '2026-01-05', endDay: '2026-01-11' },
      top: [],
      recent: [],
      streakDays: 0,
    },
    'stats.period': HUB_WEEK_REPORT,
    ...table,
  };
  callOpMock.mockImplementation(async (op: string, args?: unknown) => {
    calls.push({ op, args });
    if (!(op in defaults)) throw new Error(`unexpected op: ${op}`);
    return defaults[op];
  });
}

let host: HTMLElement;
let root: Root;

async function renderElement(el: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => {
    root.render(el);
  });
  await act(async () => {});
}

async function clickAsync(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await act(async () => {});
}

function hubShadow(): ShadowRoot | null {
  return document.getElementById(BILI_HUB_HOST_ID)?.shadowRoot ?? null;
}

function hubText(selector: string): string {
  return hubShadow()?.querySelector(selector)?.textContent ?? '';
}

function hubQueryAll(selector: string): Element[] {
  return Array.from(hubShadow()?.querySelectorAll(selector) ?? []);
}

function hubButtonWithText(text: string): HTMLButtonElement {
  const el = hubQueryAll('button').find((b) => b.textContent === text);
  if (!el) throw new Error(`hub button not found: ${text}`);
  return el as HTMLButtonElement;
}

/** 知识库搜索框输入（React 受控输入：原生 setter 赋值 + input 事件触发 onChange） */
async function typeHubSearch(text: string): Promise<void> {
  const input = hubShadow()?.querySelector<HTMLInputElement>('.hdu-hub-search');
  if (!input) throw new Error('hub search input not found');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {});
}

/** 按文案取类型筛选 chip */
function hubTypeChip(label: string): HTMLButtonElement {
  const el = hubQueryAll('.hdu-hub-type-chip').find((b) => b.textContent === label);
  if (!el) throw new Error(`type chip not found: ${label}`);
  return el as HTMLButtonElement;
}

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  stubOps();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  document.body.innerHTML = '';
});

describe('BiliHubPanel 组件', () => {
  it('关闭时不渲染任何内容', async () => {
    await renderElement(createElement(BiliHubPanel, { open: false, onClose: () => {}, dark: false }));
    expect(hubShadow()?.querySelector('.hdu-modal') ?? null).toBeNull();
  });

  it('知识库页签：过滤出 B 站收藏（video + time），HDU 收藏不混入', async () => {
    stubOps({
      'fav.list': [makeVideoFav(), makeTimeFav(), makeHduFav()],
      'folder.list': [{ id: 'f1', name: '网课', orderIndex: 0, archived: false, createdAt: 1 }],
    });
    await renderElement(createElement(BiliHubPanel, { open: true, onClose: () => {}, dark: false }));
    // 进入面板即拉取收藏与文件夹
    expect(calls.some((c) => c.op === 'fav.list')).toBe(true);
    expect(calls.some((c) => c.op === 'folder.list')).toBe(true);
    // portal 落在独立 shadow host 的 .hdu-root 容器内
    expect(hubShadow()?.querySelector('#bili-hub-root .hdu-root')).not.toBeNull();
    // 2 张 B 站卡片（time 收藏更新时间较新排在前），HDU 收藏被过滤
    const titles = hubQueryAll('.hdu-knowledge-title').map((el) => el.textContent);
    expect(titles).toEqual(['线性代数公开课 · 03:00', '线性代数公开课：矩阵乘法']);
    expect(hubText('.hdu-knowledge-grid')).not.toContain('站内时间点');
    // 卡片带编辑入口（头部角标）与复习入口（底部动作组）
    expect(hubQueryAll('.hdu-icon-btn').some((b) => b.getAttribute('aria-label') === '编辑')).toBe(true);
    expect(hubQueryAll('.hdu-icon-btn').some((b) => b.getAttribute('aria-label') === '加入复习')).toBe(true);
  });

  it('空收藏列表显示空态文案', async () => {
    await renderElement(createElement(BiliHubPanel, { open: true, onClose: () => {}, dark: false }));
    expect(hubText('.hdu-empty-title')).toBe('还没有收藏的视频');
  });

  it('切换统计页签后 BiliWatchCard 挂载并发起 stats.bili.overview', async () => {
    await renderElement(createElement(BiliHubPanel, { open: true, onClose: () => {}, dark: false }));
    await clickAsync(hubButtonWithText('统计'));
    expect(calls.some((c) => c.op === 'stats.bili.overview')).toBe(true);
    expect(hubText('.hdu-section-title')).toBe('B 站视频');
    // 未预置站外观看流水 → 空态
    expect(hubText('.hdu-empty-title')).toBe('还没有站外观看记录');
  });

  it('加入复习：review.plan 携带 favoriteId，成功后面板内 toast', async () => {
    stubOps({ 'fav.list': [makeVideoFav()] });
    await renderElement(createElement(BiliHubPanel, { open: true, onClose: () => {}, dark: false }));
    const reviewBtn = hubQueryAll('.hdu-icon-btn').find((b) => b.getAttribute('aria-label') === '加入复习');
    expect(reviewBtn).toBeDefined();
    await clickAsync(reviewBtn!);
    const planCall = calls.find((c) => c.op === 'review.plan');
    expect(planCall).toBeDefined();
    expect((planCall!.args as { favoriteId: string }).favoriteId).toBe('fav-video-1');
    expect(hubText('.hdu-toast')).toContain('已加入复习计划');
  });

  it('dark=true 时 portal 容器带 data-theme="dark"', async () => {
    await renderElement(createElement(BiliHubPanel, { open: true, onClose: () => {}, dark: true }));
    expect(hubShadow()?.querySelector('.hdu-root')?.getAttribute('data-theme')).toBe('dark');
  });

  it('知识库搜索框（第 33 轮）：输入关键词过滤卡片，清空恢复；无命中给空态', async () => {
    stubOps({ 'fav.list': [makeVideoFav(), makeTimeFav()] });
    await renderElement(createElement(BiliHubPanel, { open: true, onClose: () => {}, dark: false }));
    expect(hubQueryAll('.hdu-knowledge-card')).toHaveLength(2);
    const input = hubShadow()?.querySelector<HTMLInputElement>('.hdu-hub-search');
    expect(input).not.toBeNull();
    const typeSearch = async (text: string) => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, text);
        input!.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => {});
    };
    // 命中 video 收藏标题 → 只剩 1 卡
    await typeSearch('矩阵乘法');
    expect(hubQueryAll('.hdu-knowledge-card')).toHaveLength(1);
    // 清空恢复全部
    await typeSearch('');
    expect(hubQueryAll('.hdu-knowledge-card')).toHaveLength(2);
    // 无命中 → 搜索空态（与列表空态文案区分）
    await typeSearch('不存在的关键词');
    expect(hubQueryAll('.hdu-knowledge-card')).toHaveLength(0);
    expect(hubText('.hdu-empty-title')).toBe('没有匹配的收藏');
  });

  it('类型筛选 chips（第 34 轮）：点「视频」/「此时刻」各自只剩对应卡，「全部」恢复', async () => {
    stubOps({ 'fav.list': [makeVideoFav(), makeTimeFav()] });
    await renderElement(createElement(BiliHubPanel, { open: true, onClose: () => {}, dark: false }));
    expect(hubQueryAll('.hdu-knowledge-card')).toHaveLength(2);
    const chip = (label: string): HTMLButtonElement => {
      const el = hubQueryAll('.hdu-hub-type-chip').find((b) => b.textContent === label);
      if (!el) throw new Error(`type chip not found: ${label}`);
      return el as HTMLButtonElement;
    };
    // 缺省「全部」选中
    expect(chip('全部').getAttribute('aria-pressed')).toBe('true');
    // 点「视频」→ 只剩 video 卡
    await clickAsync(chip('视频'));
    expect(hubQueryAll('.hdu-knowledge-card')).toHaveLength(1);
    expect(hubText('.hdu-knowledge-grid')).toContain('矩阵乘法');
    // 点「此时刻」→ 只剩 time 卡
    await clickAsync(chip('此时刻'));
    expect(hubQueryAll('.hdu-knowledge-card')).toHaveLength(1);
    expect(hubText('.hdu-knowledge-grid')).toContain('03:00');
    // 点「全部」→ 恢复 2 卡
    await clickAsync(chip('全部'));
    expect(hubQueryAll('.hdu-knowledge-card')).toHaveLength(2);
  });

  it('类型筛选无命中时空态提示切回「全部」（第 34 轮）', async () => {
    stubOps({ 'fav.list': [makeVideoFav()] });
    await renderElement(createElement(BiliHubPanel, { open: true, onClose: () => {}, dark: false }));
    const timeChip = hubQueryAll('.hdu-hub-type-chip').find((b) => b.textContent === '此时刻');
    expect(timeChip).toBeDefined();
    await clickAsync(timeChip!);
    expect(hubQueryAll('.hdu-knowledge-card')).toHaveLength(0);
    expect(hubText('.hdu-empty-title')).toBe('没有匹配的收藏');
    expect(hubText('.hdu-empty-text')).toContain('该类型下暂无收藏');
  });

  it('知识库收录 B 站 ai/note 收藏（类型标签/锚点时间/收藏时间），HDU 站内 ai/note 排除（第 34 轮 P2-1）', async () => {
    stubOps({
      'fav.list': [makeVideoFav(), makeTimeFav(), makeAiFav(), makeNoteFav(), makeHduAiFav(), makeHduNoteFav()],
    });
    await renderElement(createElement(BiliHubPanel, { open: true, onClose: () => {}, dark: false }));
    // 4 张 B 站卡片按收藏时间倒序（note 2500 / time 2000 / ai 1500 / video 1000），
    // HDU 站内 ai/note（courId/teclId、无 B 站归属 metadata）不混入
    const titles = hubQueryAll('.hdu-knowledge-title').map((el) => el.textContent);
    expect(titles).toEqual(['笔记 @120s', '线性代数公开课 · 03:00', '特征值有什么直观含义', '线性代数公开课：矩阵乘法']);
    const grid = hubText('.hdu-knowledge-grid');
    expect(grid).not.toContain('站内 AI 回答');
    expect(grid).not.toContain('HDU 站内笔记转藏');
    // note 卡正文 = 笔记原文（noteToFavorite 落 snapshot.content，VideoFavCard 渲染，
    // 第 37 轮巡检核实并锁定；.hdu-knowledge-text 的 3 行截断为全部卡型统一的视觉样式）
    expect(grid).toContain('矩阵乘法不满足交换律');
    // 卡片头类型标签（共享 FAVORITE_META：ai=AI 回答 / note=笔记）与锚点时间徽标
    const heads = hubQueryAll('.hdu-knowledge-head').map((el) => el.textContent ?? '');
    expect(heads.some((t) => t.includes('AI 回答'))).toBe(true);
    expect(heads.some((t) => t.includes('笔记'))).toBe(true);
    expect(grid).toContain('05:00');
    expect(grid).toContain('02:00');
    // 收藏时间（showFavoritedAt，仅 B 站学习中心开启）
    expect(grid).toContain('收藏于');
  });

  it('类型筛选 chips 扩展「问答」「笔记」（第 34 轮 P2-1）', async () => {
    stubOps({ 'fav.list': [makeVideoFav(), makeTimeFav(), makeAiFav(), makeNoteFav()] });
    await renderElement(createElement(BiliHubPanel, { open: true, onClose: () => {}, dark: false }));
    expect(hubQueryAll('.hdu-hub-type-chip').map((b) => b.textContent)).toEqual(['全部', '视频', '此时刻', '问答', '笔记']);
    expect(hubQueryAll('.hdu-knowledge-card')).toHaveLength(4);
    await clickAsync(hubTypeChip('问答'));
    expect(hubQueryAll('.hdu-knowledge-card')).toHaveLength(1);
    expect(hubText('.hdu-knowledge-grid')).toContain('特征值');
    await clickAsync(hubTypeChip('笔记'));
    expect(hubQueryAll('.hdu-knowledge-card')).toHaveLength(1);
    expect(hubText('.hdu-knowledge-grid')).toContain('笔记 @120s');
    await clickAsync(hubTypeChip('全部'));
    expect(hubQueryAll('.hdu-knowledge-card')).toHaveLength(4);
  });

  it('面板关闭再打开后搜索词与类型筛选重置（第 34 轮 P3-4）', async () => {
    stubOps({ 'fav.list': [makeVideoFav(), makeTimeFav()] });
    const base = { onClose: () => {}, dark: false };
    await renderElement(createElement(BiliHubPanel, { ...base, open: true }));
    await typeHubSearch('矩阵乘法');
    expect(hubQueryAll('.hdu-knowledge-card')).toHaveLength(1);
    await clickAsync(hubTypeChip('视频'));
    expect(hubQueryAll('.hdu-knowledge-card')).toHaveLength(1);
    // 关闭再打开：搜索词/类型筛选不残留，列表恢复全量、chips 回「全部」
    await renderElement(createElement(BiliHubPanel, { ...base, open: false }));
    await renderElement(createElement(BiliHubPanel, { ...base, open: true }));
    const input = hubShadow()?.querySelector<HTMLInputElement>('.hdu-hub-search');
    expect(input?.value ?? '').toBe('');
    expect(hubQueryAll('.hdu-knowledge-card')).toHaveLength(2);
    expect(hubTypeChip('全部').getAttribute('aria-pressed')).toBe('true');
  });

  it('统计页签学习周报（第 34 轮）：PeriodReportCard 挂载并发起 stats.period，渲染周报关键文案', async () => {
    await renderElement(createElement(BiliHubPanel, { open: true, onClose: () => {}, dark: false }));
    await clickAsync(hubButtonWithText('统计'));
    // B 站统计卡（stats.bili.overview）与学习周报（stats.period）同页签先后渲染
    expect(calls.some((c) => c.op === 'stats.bili.overview')).toBe(true);
    const periodCall = calls.find((c) => c.op === 'stats.period');
    expect(periodCall).toBeDefined();
    expect(periodCall!.args).toEqual({ kind: 'week', count: 8 });
    const body = hubText('.hdu-modal-body');
    expect(body).toContain('B 站视频');
    expect(body).toContain('学习周报');
    expect(body).toContain('站内学习');
    expect(body).toContain('站外视频');
  });

  it('编辑弹层打开时按 Escape 只关编辑弹层，学习中心面板保持打开（第 33 轮 P2 收口）', async () => {
    stubOps({ 'fav.list': [makeVideoFav()], 'folder.list': [] });
    const onClose = vi.fn();
    await renderElement(createElement(BiliHubPanel, { open: true, onClose, dark: false }));
    // 打开编辑弹层：面板 Modal 与编辑弹层同时打开（标题共 2 个）
    const editBtn = hubQueryAll('.hdu-icon-btn').find((b) => b.getAttribute('aria-label') === '编辑');
    expect(editBtn).toBeDefined();
    await clickAsync(editBtn!);
    const titles = () => hubQueryAll('.hdu-modal-title').map((el) => el.textContent);
    expect(titles()).toEqual(['学习中心', '编辑收藏']);
    // Escape → 编辑弹层关闭，面板仍在、onClose 未被触发
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await act(async () => {});
    expect(titles()).toEqual(['学习中心']);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('今日页签（第 35 轮）：切到「今日」渲染到期复习精简卡，review.due 惰性拉取', async () => {
    const hubJob = {
      id: 'job-hub-1',
      favoriteId: 'fav-video-1',
      dueDate: localDayKey(),
      round: 1,
      template: 'regular',
      status: 'pending',
      createdAt: 1,
      updatedAt: 1,
      favorite: makeVideoFav(),
    };
    stubOps({
      'fav.list': [makeVideoFav()],
      // 第 244 轮：知识库卡片「复习状态徽标」数据收编进 review.list 单路
      //（原第 102 轮 review.due 独立往返删除，徽标口径升级为全量 pending + 到期日分色）
      'review.list': [hubJob],
      'review.due': [hubJob],
    });
    await renderElement(createElement(BiliHubPanel, { open: true, onClose: () => {}, dark: false }));
    // 知识库页签即拉 review.list（第 102 轮起拉徽标数据；第 244 轮 review.due 收编进此路）；
    // 切到「今日」再拉待办精简卡（BiliHubTodayCard 自挂载独立取 review.due）
    expect(calls.some((c) => c.op === 'review.list')).toBe(true);
    await clickAsync(hubButtonWithText('今日'));
    expect(calls.some((c) => c.op === 'review.due')).toBe(true);
    expect(hubText('.hdu-section-title')).toBe('今日待办');
    expect(hubText('.hdu-hub-today')).toContain('线性代数公开课：矩阵乘法');
    expect(hubText('.hdu-hub-today')).toContain('今日到期');
    expect(hubText('.hdu-hub-today')).toContain('去复习');
  });

  it('从收藏夹导入入口（第 35 轮）：知识库工具行按钮打开 BiliImportModal', async () => {
    await renderElement(createElement(BiliHubPanel, { open: true, onClose: () => {}, dark: false }));
    const importBtn = hubQueryAll('button').find((b) => b.textContent === '从收藏夹导入');
    expect(importBtn).toBeDefined();
    await clickAsync(importBtn!);
    // 面板 Modal 与导入弹窗并存（平级渲染），标题共 2 个
    const titles = () => hubQueryAll('.hdu-modal-title').map((el) => el.textContent);
    expect(titles()).toEqual(['学习中心', '从 B 站导入']);
    // 登录态检测已发起；stub 返回未登录 → 导入弹窗内空态（在导入弹窗作用域内断言，
    // 避免与知识库页签自身的空态混淆）
    expect(calls.some((c) => c.op === 'bili.nav.get')).toBe(true);
    const importModal = hubQueryAll('.hdu-modal').find(
      (modal) => modal.querySelector('.hdu-modal-title')?.textContent === '从 B 站导入',
    );
    expect(importModal?.querySelector('.hdu-empty-title')?.textContent).toBe('尚未登录 B 站');
  });
});

// ───────────────────────── 字幕就绪判定（第 36 轮抽共享） ─────────────────────────

describe('hasBiliTranscriptKey 字幕就绪判定（第 36 轮抽到 shared/mediaRef）', () => {
  it('P1 裸键与 p≥2 分 P 键均判定就绪', () => {
    expect(hasBiliTranscriptKey([`bili:${BVID}`], BVID)).toBe(true);
    expect(hasBiliTranscriptKey([`bili:${BVID}:p2`], BVID)).toBe(true);
    expect(hasBiliTranscriptKey([`bili:${BVID}:p10`], BVID)).toBe(true);
    // 多 P 落库口径（裸键 + 分 P 键并存）任一命中即可
    expect(hasBiliTranscriptKey([`bili:${BVID}`, `bili:${BVID}:p2`], BVID)).toBe(true);
  });

  it('无字幕（空集合 / 仅 HDU 键 / 其他 bvid 的键）判定未就绪', () => {
    expect(hasBiliTranscriptKey([], BVID)).toBe(false);
    expect(hasBiliTranscriptKey(['hdu:12'], BVID)).toBe(false);
    expect(hasBiliTranscriptKey(['bili:BV1Other000'], BVID)).toBe(false);
  });

  it('前缀必须带 :p 后缀边界：相邻 bvid 的键不误匹配', () => {
    // 相邻 bvid 的裸键 / 分 P 键均不应命中（否则 BV1abc 误配 BV1abcd 的字幕）
    expect(hasBiliTranscriptKey(['bili:BV1abc1234'], 'BV1abc123')).toBe(false);
    expect(hasBiliTranscriptKey(['bili:BV1abc1234:p2'], 'BV1abc123')).toBe(false);
    expect(hasBiliTranscriptKey(['bili:BV1abc123:p2'], 'BV1abc1234')).toBe(false);
  });
});

// ───────────────────────── 字幕能力接线（第 36 轮巡检） ─────────────────────────

describe('BiliHubPanel 字幕能力（第 36 轮巡检）', () => {
  it('列表加载后经 transcript.keys 判定：视频卡出「字幕已就绪」徽标与「查看字幕」入口，time 卡没有', async () => {
    stubOps({
      'fav.list': [makeVideoFav(), makeTimeFav()],
      'transcript.keys': [`bili:${BVID}:p2`],
    });
    await renderElement(createElement(BiliHubPanel, { open: true, onClose: () => {}, dark: false }));
    expect(calls.some((c) => c.op === 'transcript.keys')).toBe(true);
    const grid = hubText('.hdu-knowledge-grid');
    expect(grid).toContain('字幕已就绪');
    // 字幕槽位按 videoBvidOf 门控：仅 1 张视频卡有「查看字幕」入口
    const entries = hubQueryAll('button').filter((b) => (b.textContent ?? '').includes('查看字幕'));
    expect(entries).toHaveLength(1);
  });

  it('transcript.keys 为空（无字幕）不出现徽标与入口', async () => {
    stubOps({ 'fav.list': [makeVideoFav()], 'transcript.keys': [] });
    await renderElement(createElement(BiliHubPanel, { open: true, onClose: () => {}, dark: false }));
    const grid = hubText('.hdu-knowledge-grid');
    expect(grid).not.toContain('字幕已就绪');
    expect(grid).not.toContain('查看字幕');
  });

  it('点击「查看字幕」在独立 shadow host 内打开共享字幕浮层，transcript.get 按 P1 裸键取数', async () => {
    stubOps({
      'fav.list': [makeVideoFav()],
      'transcript.keys': [`bili:${BVID}`],
      'transcript.get': makeTranscript(`bili:${BVID}`),
    });
    await renderElement(createElement(BiliHubPanel, { open: true, onClose: () => {}, dark: false }));
    const entry = hubQueryAll('button').find((b) => (b.textContent ?? '').includes('查看字幕'));
    expect(entry).toBeDefined();
    await clickAsync(entry!);
    // 收藏 metadata.url 无 ?p= → P1 裸键 bili:<bvid>
    const getCall = calls.find((c) => c.op === 'transcript.get');
    expect(getCall?.args).toEqual({ mediaKey: `bili:${BVID}` });
    // 浮层挂在本面板的独立 shadow host 内（.bili-sub-scope 作用域），标题与行列表渲染
    expect(hubShadow()?.querySelector('.bili-sub-scope')).not.toBeNull();
    expect(hubText('.bili-modal-head h3')).toBe('字幕');
    expect(hubQueryAll('.bili-sub-row')).toHaveLength(2);
    expect(hubText('.bili-sub-list')).toContain('矩阵乘法');
    // 学习中心面板 Modal 保持打开（字幕浮层叠加其上，非替换）
    expect(hubText('.hdu-modal-title')).toBe('学习中心');
  });

  it('字幕浮层 seekMode=external：点行新标签打开 B 站 ?t= 外链；关闭只关浮层不关面板', async () => {
    stubOps({
      'fav.list': [makeVideoFav()],
      'transcript.keys': [`bili:${BVID}`],
      'transcript.get': makeTranscript(`bili:${BVID}`),
    });
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    try {
      await renderElement(createElement(BiliHubPanel, { open: true, onClose: () => {}, dark: false }));
      const entry = hubQueryAll('button').find((b) => (b.textContent ?? '').includes('查看字幕'));
      await clickAsync(entry!);
      const row = hubShadow()?.querySelector<HTMLButtonElement>('.bili-sub-row');
      expect(row).not.toBeNull();
      await clickAsync(row!);
      // external 模式：页内无（相关）<video>，一律新标签打开 B 站 ?t= 外链（首行 s=0）
      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(openSpy.mock.calls[0]?.[0]).toBe(`https://www.bilibili.com/video/${BVID}?t=0`);
      // 关闭字幕浮层：浮层卸载，学习中心面板仍在
      const closeBtn = hubShadow()?.querySelector<HTMLButtonElement>('.bili-modal-close');
      expect(closeBtn).not.toBeNull();
      await clickAsync(closeBtn!);
      expect(hubShadow()?.querySelector('.bili-sub-scope')).toBeNull();
      expect(hubText('.hdu-modal-title')).toBe('学习中心');
    } finally {
      openSpy.mockRestore();
    }
  });

  it('多 P 收藏：分 P 从 metadata.url 提取，transcript.get 读分 P 键', async () => {
    stubOps({
      'fav.list': [
        makeVideoFav({
          metadata: { platform: 'bilibili', bvid: BVID, url: `https://www.bilibili.com/video/${BVID}?p=2` },
        }),
      ],
      'transcript.keys': [`bili:${BVID}:p2`],
      'transcript.get': makeTranscript(`bili:${BVID}:p2`),
    });
    await renderElement(createElement(BiliHubPanel, { open: true, onClose: () => {}, dark: false }));
    const entry = hubQueryAll('button').find((b) => (b.textContent ?? '').includes('查看字幕'));
    expect(entry).toBeDefined();
    await clickAsync(entry!);
    // p≥2 → 分 P 键 bili:<bvid>:p<N>（与 transcript.keys 判定口径一致）
    expect(calls.find((c) => c.op === 'transcript.get')?.args).toEqual({ mediaKey: `bili:${BVID}:p2` });
    expect(hubShadow()?.querySelector('.bili-sub-scope')).not.toBeNull();
  });
});

// ───────────────────────── 收藏夹导入防重复点击（第 36 轮巡检） ─────────────────────────

describe('BiliImportModal 导入进行中防重复点击（第 36 轮巡检）', () => {
  it('收藏夹行连点两次只发起一轮分页与写入', async () => {
    stubOps({
      'fav.list': [],
      'bili.nav.get': { isLogin: true },
      'bili.favlist.folders': { folders: [{ id: 101, title: '网课夹', mediaCount: 2 }] },
      'bili.favlist.items': {
        items: [makeBiliFavItem('BV1ImpItem01', '导入视频一'), makeBiliFavItem('BV1ImpItem02', '导入视频二')],
        total: 2,
        hasMore: false,
      },
      // 回包 id 与写入不同 → 记为跳过；本测试只关心写入次数，不关心导入/跳过比例
      'fav.put': { id: 'existing' },
    });
    await renderElement(createElement(BiliHubPanel, { open: true, onClose: () => {}, dark: false }));
    await clickAsync(hubQueryAll('button').find((b) => b.textContent === '从收藏夹导入')!);
    await act(async () => {});
    const row = hubQueryAll('.hdu-session-row').find((b) => (b.textContent ?? '').includes('网课夹'));
    expect(row).toBeDefined();
    // 同一事件循环内连点两次：第二次必须被 runningRef 守卫忽略（否则会再跑一轮分页+写入）
    await act(async () => {
      row!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      row!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await act(async () => {});
    expect(calls.filter((c) => c.op === 'bili.favlist.items')).toHaveLength(1);
    expect(calls.filter((c) => c.op === 'fav.put')).toHaveLength(2);
  });
});

// ───────────────────────── 字幕浮层 Escape 归属（第 37 轮巡检） ─────────────────────────

describe('BiliHubPanel 字幕浮层 Escape 归属（第 37 轮巡检）', () => {
  it('字幕浮层打开时按 Esc 只关浮层，学习中心面板保持；浮层关闭后 Esc 关面板', async () => {
    stubOps({
      'fav.list': [makeVideoFav()],
      'transcript.keys': [`bili:${BVID}`],
      'transcript.get': makeTranscript(`bili:${BVID}`),
    });
    const onClose = vi.fn();
    await renderElement(createElement(BiliHubPanel, { open: true, onClose, dark: false }));
    const entry = hubQueryAll('button').find((b) => (b.textContent ?? '').includes('查看字幕'));
    expect(entry).toBeDefined();
    await clickAsync(entry!);
    expect(hubShadow()?.querySelector('.bili-sub-scope')).not.toBeNull();
    // Esc → 字幕浮层是归属栈顶（后于面板打开）：只关浮层，面板 Modal 保持、onClose 不触发
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await act(async () => {});
    expect(hubShadow()?.querySelector('.bili-sub-scope')).toBeNull();
    expect(hubText('.hdu-modal-title')).toBe('学习中心');
    expect(onClose).not.toHaveBeenCalled();
    // 浮层已注销：Esc 回到面板 Modal 自身的既有行为 → 关闭面板
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await act(async () => {});
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────── 字幕浮层 Tab 圈闭（第 39 轮巡检，hub 宿主） ─────────────────────────

describe('BiliHubPanel 字幕浮层 Tab 圈闭（第 39 轮巡检）', () => {
  it('浮层打开（栈顶）时 Tab 焦点圈闭在浮层内，不落到遮罩之下的面板 Modal；浮层关闭后面板圈闭恢复', async () => {
    stubOps({
      'fav.list': [makeVideoFav()],
      'transcript.keys': [`bili:${BVID}`],
      'transcript.get': makeTranscript(`bili:${BVID}`),
    });
    await renderElement(createElement(BiliHubPanel, { open: true, onClose: () => {}, dark: false }));
    const entry = hubQueryAll('button').find((b) => (b.textContent ?? '').includes('查看字幕'));
    expect(entry).toBeDefined();
    await clickAsync(entry!);
    const overlay = hubShadow()?.querySelector('.bili-sub-scope');
    expect(overlay).not.toBeNull();

    // focus 不冒泡：在 hub shadow root 上挂捕获监听收集 Tab 后的真实焦点落点
    const shadow = hubShadow()!;
    const focused: Element[] = [];
    const onFocus = (event: Event): void => {
      focused.push(event.target as Element);
    };
    shadow.addEventListener('focus', onFocus, true);
    try {
      // 字幕浮层是归属栈顶：Tab 被浮层圈闭，焦点拉回浮层内首元素（浮层关闭按钮），
      // 而不是 Tab 到遮罩之下面板 Modal 的按钮（修复前浮层不 trap、面板让位后的缺口）
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
      });
      expect(focused).toHaveLength(1);
      expect(focused[0]!.classList.contains('bili-modal-close')).toBe(true);
      expect(overlay!.contains(focused[0]!)).toBe(true);
    } finally {
      shadow.removeEventListener('focus', onFocus, true);
    }

    // 浮层关闭（注销归属）后：Tab 圈闭回到面板 Modal——焦点被拉回面板弹窗内首元素
    // （Modal 头部关闭按钮，aria-label=关闭，与浮层的「关闭字幕」按钮区分）
    const overlayClose = hubShadow()?.querySelector<HTMLButtonElement>('.bili-modal-close');
    await clickAsync(overlayClose!);
    expect(hubShadow()?.querySelector('.bili-sub-scope')).toBeNull();
    const focusedAfter: Element[] = [];
    const onFocusAfter = (event: Event): void => {
      focusedAfter.push(event.target as Element);
    };
    shadow.addEventListener('focus', onFocusAfter, true);
    try {
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
      });
      expect(focusedAfter).toHaveLength(1);
      expect(focusedAfter[0]!.getAttribute('aria-label')).toBe('关闭');
      expect(focusedAfter[0]!.closest('.hdu-modal')).not.toBeNull();
    } finally {
      shadow.removeEventListener('focus', onFocusAfter, true);
    }
  });
});

// ───────────────────────── 导出复习卡入口（第 37 轮巡检） ─────────────────────────

describe('BiliHubPanel 导出复习卡（第 37 轮巡检）', () => {
  /** jsdom 无 Blob URL：为下载链路赋桩（直接赋值，restoreMocks 不触及） */
  function stubBlobUrl(): ReturnType<typeof vi.fn> {
    const createObjectURL = vi.fn(() => 'blob:hub-export-test');
    (URL as unknown as Record<string, unknown>).createObjectURL = createObjectURL;
    (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();
    return createObjectURL;
  }

  it('知识库工具行有「导出复习卡」按钮：点击对当前筛选列表触发下载并提示', async () => {
    stubOps({ 'fav.list': [makeVideoFav(), makeTimeFav()] });
    const createObjectURL = stubBlobUrl();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      await renderElement(createElement(BiliHubPanel, { open: true, onClose: () => {}, dark: false }));
      const exportBtn = hubQueryAll('button').find((b) => b.textContent === '导出复习卡') as HTMLButtonElement | undefined;
      expect(exportBtn).toBeDefined();
      expect(exportBtn!.disabled).toBe(false);
      await clickAsync(exportBtn!);
      // 下载已触发（md 内容口径由 review-cards-export.test.ts 锁定），面板内成功提示。
      // toast 栈为模块级状态（前序用例的提示可能未过期），这里用 some 而非首个元素断言
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(hubQueryAll('.hdu-toast').some((t) => (t.textContent ?? '').includes('复习卡片已导出'))).toBe(true);
    } finally {
      clickSpy.mockRestore();
    }
  });

  it('筛选后无收藏时「导出复习卡」禁用', async () => {
    stubOps({ 'fav.list': [] });
    stubBlobUrl();
    await renderElement(createElement(BiliHubPanel, { open: true, onClose: () => {}, dark: false }));
    const exportBtn = hubQueryAll('button').find((b) => b.textContent === '导出复习卡') as HTMLButtonElement | undefined;
    expect(exportBtn).toBeDefined();
    expect(exportBtn!.disabled).toBe(true);
  });
});

// ───────────────────────── load 迟到响应守卫（第 38 轮巡检） ─────────────────────────

describe('BiliHubPanel load 迟到响应守卫（第 38 轮巡检）', () => {
  it('慢的旧 fav.list 响应后到，不覆盖新 load 的数据（seq 守卫丢弃）', async () => {
    let resolveSlow!: (value: unknown) => void;
    const slowFavList = new Promise((resolve) => {
      resolveSlow = resolve;
    });
    const favOld = makeVideoFav({ id: 'fav-old', snapshot: { title: '旧数据收藏', content: '' } });
    const favNew = makeVideoFav({ id: 'fav-new', snapshot: { title: '新数据收藏', content: '' } });
    let favListCalls = 0;
    callOpMock.mockImplementation(async (op: string) => {
      calls.push({ op, args: undefined });
      if (op === 'fav.list') {
        favListCalls += 1;
        return favListCalls === 1 ? slowFavList : [favNew]; // 请求 A 慢、请求 B 快
      }
      if (op === 'folder.list') return [];
      if (op === 'transcript.keys') return [];
      throw new Error(`unexpected op: ${op}`);
    });
    const base = { onClose: () => {}, dark: false };
    await renderElement(createElement(BiliHubPanel, { ...base, open: true })); // load#1（A，挂起）
    expect(favListCalls).toBe(1);
    // 面板关闭再快速重开（SPA 常驻、组件不卸载）：触发 load#2（B，立即返回）
    await renderElement(createElement(BiliHubPanel, { ...base, open: false }));
    await renderElement(createElement(BiliHubPanel, { ...base, open: true }));
    expect(favListCalls).toBe(2);
    await act(async () => {});
    expect(hubText('.hdu-knowledge-grid')).toContain('新数据收藏');
    // 旧响应 A 迟到返回：序号不匹配 → 丢弃，最终状态仍是 B 的数据
    await act(async () => {
      resolveSlow([favOld]);
    });
    await act(async () => {});
    expect(hubText('.hdu-knowledge-grid')).toContain('新数据收藏');
    expect(hubText('.hdu-knowledge-grid')).not.toContain('旧数据收藏');
  });
});

// ───────────────────────── 加入复习 busy 守卫（第 38 轮巡检） ─────────────────────────

describe('BiliHubPanel 加入复习 busy 守卫（第 38 轮巡检）', () => {
  it('同一收藏并发双击只产生一次 review.plan 调用', async () => {
    callOpMock.mockImplementation(async (op: string) => {
      calls.push({ op, args: undefined });
      if (op === 'fav.list') return [makeVideoFav()];
      if (op === 'folder.list') return [];
      if (op === 'transcript.keys') return [];
      if (op === 'review.plan') return new Promise(() => {}); // 请求挂起，模拟进行中
      throw new Error(`unexpected op: ${op}`);
    });
    await renderElement(createElement(BiliHubPanel, { open: true, onClose: () => {}, dark: false }));
    const reviewBtn = hubQueryAll('.hdu-icon-btn').find((b) => b.getAttribute('aria-label') === '加入复习');
    expect(reviewBtn).toBeDefined();
    // 同一事件循环内连点两次：第二次被 busy 守卫忽略
    await act(async () => {
      reviewBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      reviewBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await act(async () => {});
    expect(calls.filter((c) => c.op === 'review.plan')).toHaveLength(1);
  });
});

// ───────────────────────── 导入弹窗会话代际 token（第 38 轮巡检） ─────────────────────────

describe('BiliImportModal 会话代际 token（第 38 轮巡检）', () => {
  it('关闭又立即重开后，旧会话的 in-flight 分页不再写入（fav.put 归属新会话）', async () => {
    let resolvePage!: (value: unknown) => void;
    const pendingPage = new Promise((resolve) => {
      resolvePage = resolve;
    });
    const oldItem = makeBiliFavItem('BV1ImpOld01', '旧会话视频');
    calls = [];
    callOpMock.mockImplementation(async (op: string, args?: unknown) => {
      calls.push({ op, args });
      switch (op) {
        case 'bili.nav.get':
          return { isLogin: true };
        case 'bili.favlist.folders':
          return { folders: [{ id: 101, title: '网课夹', mediaCount: 1 }] };
        case 'bili.favlist.items':
          // 旧会话的分页请求挂起；重开后同一 promise 已 resolve，新会话立即拿到回包
          return pendingPage;
        case 'fav.put':
          return { id: (args as { favorite: { id: string } }).favorite.id };
        default:
          throw new Error(`unexpected op: ${op}`);
      }
    });
    const base = { onClose: () => {}, dark: false };
    await renderElement(createElement(BiliHubPanel, { ...base, open: true }));
    // 打开导入弹窗（会话 1）
    await clickAsync(hubQueryAll('button').find((b) => b.textContent === '从收藏夹导入')!);
    await act(async () => {});
    const row = () => hubQueryAll('.hdu-session-row').find((b) => (b.textContent ?? '').includes('网课夹'));
    expect(row()).toBeDefined();
    // 会话 1：点收藏夹行开始导入 → 分页请求挂起
    await clickAsync(row()!);
    expect(calls.filter((c) => c.op === 'bili.favlist.items')).toHaveLength(1);
    // Esc 关闭导入弹窗（栈顶）→ 立即重开（会话 2：代际递增、取消标记复位）
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await act(async () => {});
    expect(hubQueryAll('.hdu-modal-title').map((el) => el.textContent)).toEqual(['学习中心']);
    await clickAsync(hubQueryAll('button').find((b) => b.textContent === '从收藏夹导入')!);
    await act(async () => {});
    expect(row()).toBeDefined();
    // 旧会话的分页响应此刻才回来：代际不匹配 → 中止，不产生任何 fav.put
    await act(async () => {
      resolvePage({ items: [oldItem], total: 1, hasMore: false });
    });
    await act(async () => {});
    expect(calls.filter((c) => c.op === 'fav.put')).toHaveLength(0);
    // 新会话正常走完：点行 → 分页（已 resolve，立即返回）→ fav.put 归属新会话
    await clickAsync(row()!);
    await act(async () => {});
    const puts = calls.filter((c) => c.op === 'fav.put');
    expect(puts).toHaveLength(1);
    expect((puts[0]!.args as { favorite: { refId: string } }).favorite.refId).toBe('BV1ImpOld01');
  });
});

// ───────────────────────── 卡片级删除 + 相对收藏时间（第 241 轮巡检） ─────────────────────────

describe('BiliHubPanel 卡片级删除入口（第 241 轮巡检，对齐 HDU 第 228 轮）', () => {
  it('知识库卡片有「删除」两步确认入口：第一次点击进入确认态，第二次发起 fav.softDelete', async () => {
    stubOps({ 'fav.list': [makeVideoFav()], 'fav.softDelete': undefined });
    await renderElement(createElement(BiliHubPanel, { open: true, onClose: () => {}, dark: false }));
    const delBtn = hubQueryAll('.hdu-icon-btn').find((b) => b.getAttribute('aria-label') === '删除');
    expect(delBtn).toBeDefined();
    // 第一步：进入确认态（aria-label 切换为确认文案），尚未发起删除
    await clickAsync(delBtn!);
    const confirming = hubQueryAll('.hdu-icon-btn').find((b) => b.getAttribute('aria-label') === '再点一次确认移入回收站');
    expect(confirming).toBeDefined();
    expect(calls.some((c) => c.op === 'fav.softDelete')).toBe(false);
    // 第二步：确认 → fav.softDelete 软删除（进回收站），面板内成功 toast
    await clickAsync(confirming!);
    const delCall = calls.find((c) => c.op === 'fav.softDelete');
    expect(delCall).toBeDefined();
    expect((delCall!.args as { ids: string[] }).ids).toEqual(['fav-video-1']);
    expect(hubQueryAll('.hdu-toast').some((t) => (t.textContent ?? '').includes('已移入回收站'))).toBe(true);
  });

  it('删除 toast 的「撤销」按钮走 trash.restore 一键还原', async () => {
    stubOps({ 'fav.list': [makeVideoFav()], 'fav.softDelete': undefined, 'trash.restore': undefined });
    await renderElement(createElement(BiliHubPanel, { open: true, onClose: () => {}, dark: false }));
    const delBtn = hubQueryAll('.hdu-icon-btn').find((b) => b.getAttribute('aria-label') === '删除')!;
    await clickAsync(delBtn);
    await clickAsync(hubQueryAll('.hdu-icon-btn').find((b) => b.getAttribute('aria-label') === '再点一次确认移入回收站')!);
    const undoBtn = hubQueryAll('.hdu-toast').flatMap((t) => Array.from(t.querySelectorAll('button'))).find((b) => b.textContent === '撤销');
    expect(undoBtn).toBeDefined();
    await clickAsync(undoBtn!);
    const restoreCall = calls.find((c) => c.op === 'trash.restore');
    expect(restoreCall).toBeDefined();
    expect((restoreCall!.args as { keys: string[] }).keys).toEqual(['favorite:fav-video-1']);
    expect(hubQueryAll('.hdu-toast').some((t) => (t.textContent ?? '').includes('已撤销删除'))).toBe(true);
  });
});

describe('VideoFavCard 相对收藏时间（第 241 轮巡检，B 站学习中心 showFavoritedAt）', () => {
  it('近期收藏显示相对时间（今天/昨天/N 天前），远期回落 MM-DD HH:mm', async () => {
    const now = Date.now();
    stubOps({
      'fav.list': [
        makeVideoFav({ id: 'fav-today', favoritedAt: now - 2 * 3600_000 }),
        makeTimeFav({ id: 'fav-days', favoritedAt: now - 3 * 86_400_000 }),
        makeAiFav({ id: 'fav-old', favoritedAt: new Date(2024, 0, 15, 9, 5, 0).getTime() }),
      ],
    });
    await renderElement(createElement(BiliHubPanel, { open: true, onClose: () => {}, dark: false }));
    const grid = hubText('.hdu-knowledge-grid');
    expect(grid).toContain('收藏于 今天');
    expect(grid).toContain('收藏于 3 天前');
    // 满 7 天回落绝对时间（手写 pad 格式，避免 ICU 差异）
    expect(grid).toMatch(/收藏于 1-15 09:05/);
    expect(grid).not.toContain('收藏于 7 天前');
  });
});

describe('BiliHubPanel 面板关闭后焦点回归（第 293 轮，可访问性域）', () => {
  it('关闭后焦点还原到打开前元素', async () => {
    stubOps();
    const outside = document.createElement('button');
    outside.textContent = '面板外按钮';
    document.body.append(outside);
    outside.focus();
    await renderElement(createElement(BiliHubPanel, { open: true, onClose: () => {}, dark: false }));
    await renderElement(createElement(BiliHubPanel, { open: false, onClose: () => {}, dark: false }));
    expect(document.activeElement).toBe(outside);
  });
});
