/**
 * 第 44 轮巡检新增能力单测：
 *  1) core/bili/assistant 新纯函数：outlineStepTarget（[ ] 大纲步进，移植 HDU
 *     playerSync.stepOutline 口径）、buildOverviewAnchors（速览回位锚点聚合）；
 *  2) BiliQaPanel 速览页签（四格 + 回到上次的位置 chips）与独立大纲页签
 *     （节点渲染 + 当前播放节点高亮 + 点击 seek）；
 *  3) BiliQaPanel [ ] 快捷键：大纲节点间步进 seek，输入态与 B 站占用键避让；
 *  4) BiliCollectApp FAB 收敛：主入口 + 菜单结构、四个子钮常驻 DOM（收起态程序化
 *     click 仍可打开面板），q/b/n 快捷键（问答页签 / 收藏此时刻 / 笔记页签）。
 */

// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({
  callOp: vi.fn(),
  onBackgroundEvent: vi.fn(() => () => undefined),
}));

vi.mock('@/core/shared/settings', () => ({
  loadSettings: vi.fn(),
  onSettingsChanged: vi.fn(() => () => undefined),
}));

import { callOp } from '@/core/shared/client';
import { loadSettings } from '@/core/shared/settings';
import { buildOverviewAnchors, outlineStepTarget } from '@/core/bili/assistant';
import { BiliQaPanel } from '@/entrypoints/content/ui/BiliQaPanel';
import { BiliCollectApp } from '@/entrypoints/content/ui/bili/BiliCollectApp';
import type { ChatMessageEntity, TranscriptEntity } from '@/core/shared/types';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;
const loadSettingsMock = loadSettings as unknown as Mock;

const SHORTCUTS = { ask: 'q', favorite: 'b', note: 'n', prevTopic: '[', nextTopic: ']' };

const TRANSCRIPT: TranscriptEntity = {
  mediaKey: 'bili:BV1Ov44',
  segments: [{ s: 0, e: 5, text: 'hello' }],
  model: 'bili-official-subtitle',
  lang: 'zh-CN',
  glossaryVersion: 0,
  createdAt: 0,
  source: 'bili-official-subtitle',
};

const OUTLINE = [
  { level: 1 as const, title: '开场', start: 0, end: 30 },
  { level: 1 as const, title: '特征值', start: 60, end: 120 },
];

const AI_RESULT = {
  mediaKey: 'bili:BV1Ov44',
  topics: [{ name: '特征值', summary: '', confidence: 'high' as const, intervals: [[60, 120]] }],
  outline: OUTLINE,
  generatedAt: 0,
  model: 'test',
};

const USER_MSG: ChatMessageEntity = {
  id: 'u1',
  mediaKey: 'bili:BV1Ov44',
  groupId: 'g1',
  role: 'user',
  content: '特征值是什么？',
  anchorTime: 65,
  status: 'done',
  createdAt: 1,
};

// ───────────────────────── 纯函数 ─────────────────────────

describe('outlineStepTarget（第 44 轮，[ ] 大纲步进）', () => {
  const outline = [
    { level: 1 as const, title: 'a', start: 10, end: 20 },
    { level: 1 as const, title: 'b', start: 30, end: 40 },
    { level: 2 as const, title: 'c', start: 50, end: 60 },
  ];

  it('按当前时间定位节点后步进，seek 到相邻节点 start', () => {
    expect(outlineStepTarget(outline, 12, 1)).toBe(30);
    expect(outlineStepTarget(outline, 35, 1)).toBe(50);
    expect(outlineStepTarget(outline, 35, -1)).toBe(10);
    // 片头（尚无节点覆盖）：[ 钳在首节点，] 前进到首节点
    expect(outlineStepTarget(outline, 5, 1)).toBe(10);
    expect(outlineStepTarget(outline, 5, -1)).toBe(10);
    // 末节点：] 钳在末节点
    expect(outlineStepTarget(outline, 55, 1)).toBe(50);
  });

  it('乱序输入按 start 排序后步进；空大纲返回 null', () => {
    const shuffled = [outline[2]!, outline[0]!, outline[1]!];
    expect(outlineStepTarget(shuffled, 12, 1)).toBe(30);
    expect(outlineStepTarget([], 10, 1)).toBeNull();
  });
});

describe('buildOverviewAnchors（第 44 轮，速览回位锚点）', () => {
  it('播放断点（≥30s）+ 最近 2 条提问 + 最近 2 条笔记', () => {
    const anchors = buildOverviewAnchors({
      lastPositionSec: 125.4,
      chats: [
        { role: 'user', anchorTime: 61 },
        { role: 'ai', anchorTime: 70 },
        { role: 'user', anchorTime: 95 },
        { role: 'user', anchorTime: null },
      ],
      notes: [{ anchorTime: 30 }, { anchorTime: 88 }],
    });
    expect(anchors.map((a) => a.label)).toEqual(['上次看到 02:05', '上次提问 01:01', '上次提问 01:35', '笔记 00:30', '笔记 01:28']);
    expect(anchors[0]?.kind).toBe('resume');
  });

  it('断点 <30s 不提示；全空返回空数组', () => {
    expect(buildOverviewAnchors({ lastPositionSec: 20, chats: [], notes: [] })).toEqual([]);
    expect(buildOverviewAnchors({ lastPositionSec: null, chats: [], notes: [] })).toEqual([]);
  });
});

// ───────────────────────── 测试基建（照 bili-polish 模式） ─────────────────────────

let calls: Array<{ op: string; args: unknown }> = [];

function stubOps(overrides: Record<string, unknown> = {}): void {
  calls = [];
  const table: Record<string, unknown> = {
    'transcript.get': TRANSCRIPT,
    'qa.groups': [{ groupId: 'g1', title: '会话', lastAt: 1, count: 1 }],
    'qa.list': [USER_MSG],
    'qa.ask': { chatId: 'c1', groupId: 'g1' },
    'ai.get': { result: AI_RESULT, stale: false },
    'ai.generate': { started: true },
    'ai.abort': undefined,
    'note.list': [],
    'video.progress.get': { lastPositionSec: 120, durationSec: 600 },
    ...overrides,
  };
  callOpMock.mockImplementation(async (op: string, args?: unknown) => {
    calls.push({ op, args });
    if (!(op in table)) throw new Error(`unexpected op: ${op}`);
    const value = table[op];
    return typeof value === 'function' ? value(args) : value;
  });
}

let host: HTMLElement;
let root: Root;

async function renderElement(el: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => {
    root.render(el);
  });
}

async function clickAsync(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await act(async () => {});
}

function fireKey(key: string, target?: Element): void {
  const el = target ?? document.body;
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

function query<T extends Element>(selector: string): T {
  const el = host.querySelector<T>(selector);
  if (!el) throw new Error(`element not found: ${selector}`);
  return el;
}

function tabButton(label: string): HTMLButtonElement {
  const btn = Array.from(host.querySelectorAll<HTMLButtonElement>('.bili-qa-tab')).find((b) => b.textContent === label);
  if (!btn) throw new Error(`tab not found: ${label}`);
  return btn;
}

function attachVideo(currentTime: number): HTMLVideoElement {
  const video = document.createElement('video');
  document.body.appendChild(video);
  video.currentTime = currentTime;
  return video;
}

function panelElement() {
  return createElement(BiliQaPanel, {
    bvid: 'BV1Ov44',
    open: true,
    onClose: () => {},
    readPageP: () => 1,
    onFavoriteMoment: () => {},
    videoTitle: '线性代数公开课',
    durationSec: 600,
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  window.history.replaceState({}, '', '/video/BV1Ov44/');
  loadSettingsMock.mockReset();
  loadSettingsMock.mockResolvedValue({ contextWindow: 'medium', shortcuts: { ...SHORTCUTS } });
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

// ───────────────────────── 速览页签 ─────────────────────────

describe('BiliQaPanel 速览页签（第 44 轮）', () => {
  it('四格指标 + 回到上次的位置 chips（播放断点/上次提问/笔记）', async () => {
    stubOps();
    attachVideo(65);
    await renderElement(panelElement());
    await clickAsync(tabButton('速览'));
    await act(async () => {});

    const cells = Array.from(host.querySelectorAll('.bili-ov-cell')).map((el) => el.textContent ?? '');
    expect(cells).toHaveLength(4);
    expect(cells[0]).toContain('视频时长');
    expect(cells[0]).toContain('10:00'); // durationSec=600 优先于 <video>（未伪装 duration）
    expect(cells[1]).toContain('播放位置');
    expect(cells[1]).toContain('01:05');
    expect(cells[2]).toContain('字幕覆盖');
    expect(cells[3]).toContain('1 个知识点');

    const anchors = Array.from(host.querySelectorAll('.bili-ov-anchor')).map((el) => el.textContent ?? '');
    expect(anchors).toEqual(['上次看到 02:00', '上次提问 01:05']);
  });

  it('无断点且无会话/笔记时不渲染锚点区块；未获取字幕给提示', async () => {
    stubOps({
      'video.progress.get': null,
      'qa.groups': [],
      'transcript.get': null,
    });
    await renderElement(panelElement());
    await clickAsync(tabButton('速览'));
    await act(async () => {});

    expect(host.querySelectorAll('.bili-ov-anchor')).toHaveLength(0);
    expect(host.textContent).toContain('未获取字幕');
  });
});

// ───────────────────────── 大纲页签 ─────────────────────────

describe('BiliQaPanel 大纲页签（第 44 轮）', () => {
  it('节点渲染 + 当前播放节点高亮 + 点击 seek 到节点起点', async () => {
    stubOps();
    const video = attachVideo(65);
    await renderElement(panelElement());
    await clickAsync(tabButton('大纲'));
    await act(async () => {});

    const nodes = Array.from(host.querySelectorAll<HTMLButtonElement>('.bili-ai-outline'));
    expect(nodes).toHaveLength(2);
    expect(nodes[0]?.textContent).toContain('开场');
    // 65s 落在 [60,120) → 第二个节点高亮
    expect(nodes[0]?.classList.contains('is-active')).toBe(false);
    expect(nodes[1]?.classList.contains('is-active')).toBe(true);

    await clickAsync(nodes[0]!);
    expect(video.currentTime).toBe(0);
  });

  it('无 AI 结果但有字幕 → 展示生成入口（ai.generate 携带窗口档位）', async () => {
    stubOps({ 'ai.get': { result: null, stale: false } });
    await renderElement(panelElement());
    await clickAsync(tabButton('大纲'));
    await act(async () => {});

    const generate = query<HTMLButtonElement>('.bili-ai-generate');
    expect(generate.textContent).toBe('生成 AI 标注');
    await clickAsync(generate);
    expect(calls.find((c) => c.op === 'ai.generate')?.args).toMatchObject({ mediaKey: 'bili:BV1Ov44' });
  });
});

// ───────────────────────── [ ] 快捷键 ─────────────────────────

describe('BiliQaPanel [ ] 大纲步进快捷键（第 44 轮）', () => {
  it('] 前进到下一节点起点、[ 回退到上一节点起点（当前播放位置定位）', async () => {
    stubOps();
    const video = attachVideo(10); // 位于节点 1 [0,30)
    await renderElement(panelElement());
    // 大纲数据在标注/大纲/速览页签加载：切到大纲页签后 [ ] 才有步进目标
    await clickAsync(tabButton('大纲'));
    await act(async () => {});

    fireKey(']');
    expect(video.currentTime).toBe(60);
    fireKey('[');
    expect(video.currentTime).toBe(0);
  });

  it('输入态不响应；B 站占用键（f/空格等）让行', async () => {
    stubOps();
    const video = attachVideo(10);
    await renderElement(panelElement());
    await clickAsync(tabButton('大纲'));
    await act(async () => {});

    // 非 input target：B 站占用键一律让行
    fireKey('f');
    fireKey(' ');
    fireKey('ArrowRight');
    expect(video.currentTime).toBe(10);

    // 页外 input 聚焦：输入态避让
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    fireKey(']', input);
    expect(video.currentTime).toBe(10);

    // 面板内输入框聚焦同样不响应（切到笔记页签；aiResult 已加载仍在）
    await clickAsync(tabButton('笔记'));
    const textarea = host.querySelector<HTMLTextAreaElement>('.bili-note-composer textarea');
    expect(textarea).not.toBeNull();
    fireKey(']', textarea!);
    expect(video.currentTime).toBe(10);
  });

  it('无大纲数据时静默忽略（问答页签下按 [ ] 不 seek、不报错）', async () => {
    stubOps({ 'ai.get': { result: null, stale: false } });
    const video = attachVideo(10);
    await renderElement(panelElement());
    await act(async () => {});

    fireKey(']');
    expect(video.currentTime).toBe(10);
  });
});

// ───────────────────────── FAB 收敛与 q/b/n 快捷键 ─────────────────────────

function stubAppOps(): void {
  stubOps({
    'fav.list': [],
    'folder.list': [],
    'fav.put': undefined,
  });
}

describe('BiliCollectApp FAB 收敛（第 44 轮）', () => {
  it('主入口 + 菜单结构；四个功能子钮常驻 DOM（收起态程序化 click 仍打开面板）', async () => {
    stubAppOps();
    await renderElement(createElement(BiliCollectApp));
    await act(async () => {});

    expect(host.querySelectorAll('.bili-fab-main')).toHaveLength(1);
    expect(host.querySelectorAll('.bili-fab-menu')).toHaveLength(1);
    expect(host.querySelectorAll('.bili-fab')).toHaveLength(1);
    expect(host.querySelectorAll('.bili-sub-fab')).toHaveLength(1);
    expect(host.querySelectorAll('.bili-qa-fab')).toHaveLength(1);
    expect(host.querySelectorAll('.bili-hub-fab')).toHaveLength(1);

    // 菜单未展开（无 is-open）时程序化点击问答子钮：面板照常打开（e2e/探针路径）
    await clickAsync(query('.bili-qa-fab'));
    expect(host.querySelector('.bili-qa-modal')).not.toBeNull();
  });

  it('点主钮展开菜单（is-open），点击子钮后收起', async () => {
    stubAppOps();
    await renderElement(createElement(BiliCollectApp));
    await act(async () => {});

    const main = query<HTMLButtonElement>('.bili-fab-main');
    await clickAsync(main);
    expect(host.querySelector('.bili-fab-menu.is-open')).not.toBeNull();
    await clickAsync(query('.bili-hub-fab'));
    expect(host.querySelector('.bili-fab-menu.is-open')).toBeNull();
    // 学习中心面板打开（独立宿主内，此处仅验证菜单收起不阻断）
  });
});

describe('BiliCollectApp q/b/n 快捷键（第 44 轮）', () => {
  it('q → 打开学习助手（问答页签）；n → 打开并切到笔记页签', async () => {
    stubAppOps();
    await renderElement(createElement(BiliCollectApp));
    await act(async () => {});

    fireKey('q');
    await act(async () => {});
    expect(host.querySelector('.bili-qa-modal')).not.toBeNull();
    expect(query('.bili-qa-tab.is-active').textContent).toBe('问答');

    fireKey('n');
    await act(async () => {});
    expect(query('.bili-qa-tab.is-active').textContent).toBe('笔记');
    expect(host.querySelector('.bili-note-composer textarea')).not.toBeNull();
  });

  it('b → 收藏此时刻（fav.put type=time，语义对齐 HDU addTimeFavorite）', async () => {
    stubAppOps();
    const video = attachVideo(65);
    await renderElement(createElement(BiliCollectApp));
    await act(async () => {});

    fireKey('b');
    await act(async () => {});
    const put = calls.find((c) => c.op === 'fav.put');
    expect(put).toBeDefined();
    const favorite = (put!.args as { favorite: { type: string; anchorTime: number } }).favorite;
    expect(favorite.type).toBe('time');
    expect(favorite.anchorTime).toBe(65);
    expect(host.textContent).toContain('已收藏此时刻');
    expect(video.isConnected).toBe(true);
  });

  it('输入态不响应快捷键（文本框聚焦时按 q/b/n 均让行）', async () => {
    stubAppOps();
    await renderElement(createElement(BiliCollectApp));
    await act(async () => {});

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    fireKey('q', input);
    fireKey('n', input);
    expect(host.querySelector('.bili-qa-modal')).toBeNull();
  });
});
