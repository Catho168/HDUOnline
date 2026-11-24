/**
 * B 站体验打磨小包（第 27 轮任务 A）单测：
 *  1) 纯逻辑（node 语义直测）：
 *     - buildTimelineMarkers 右缘钳制：start ≥ duration 的区间 left=100%/width=0，
 *       近缘区间（left∈(99.65,100)）按 100-left 整带钳制不再保 0.35 下限
 *       （第 29 轮审计#1 与 HDU timelineMarkerRect 同口径，双端都不溢出右缘），
 *       时长中部的普通窄区间仍保最小可点宽度；
 *     - notePlaceholderText：实时时间 → 「记一笔（mm:ss）」，空值 → 静态回退文案；
 *  2) BiliQaPanel（jsdom，callOp / loadSettings 整体 mock，照 bili-ai.test.ts 模式）：
 *     - 问答上下文窗口档位：初值沿用全局设置、切换仅影响本面板后续 qa.ask（per-request
 *       windowPreset，不回写全局设置）；
 *     - 笔记输入框 placeholder 随播放时间实时更新（500ms 节流）、无 <video> 回退静态文案；
 *  3) BiliTimelineMarkers：越界区间（width=0）不在叠加条渲染（不溢出右缘）；
 *  4) BiliWatchCard：stats.bili.overview 请求失败显示「加载失败 + 重试」并与「还没有
 *     站外观看记录」空态区分；重试重新拉取，成功后渲染数据；成功但无数据仍显示空态。
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

import { callOp, onBackgroundEvent } from '@/core/shared/client';
import { AppError } from '@/core/shared/errors';
import { loadSettings } from '@/core/shared/settings';
import { NOTE_PLACEHOLDER_FALLBACK, notePlaceholderText, QA_NO_SUBTITLE_MESSAGE } from '@/core/bili/assistant';
import { buildTimelineMarkers } from '@/core/bili/aiMarkers';
import { timelineMarkerRect } from '@/core/shared/timelineMarkers';
import { BiliQaPanel } from '@/entrypoints/content/ui/BiliQaPanel';
import { BiliCollectApp } from '@/entrypoints/content/ui/bili/BiliCollectApp';
import { BiliTimelineMarkers } from '@/entrypoints/content/ui/bili/BiliTimelineMarkers';
import { BiliWatchCard } from '@/entrypoints/content/ui/LearningCenter';
import type { AiResultEntity, ChatMessageEntity, TranscriptEntity, Topic } from '@/core/shared/types';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;
const onEventMock = onBackgroundEvent as unknown as Mock;
const loadSettingsMock = loadSettings as unknown as Mock;

// ───────────────────────── 测试数据 ─────────────────────────

const TRANSCRIPT: TranscriptEntity = {
  mediaKey: 'bili:BV1Polish01',
  segments: [{ s: 0, e: 5, text: 'hello' }],
  model: 'bili-official-subtitle',
  lang: 'zh-CN',
  glossaryVersion: 0,
  createdAt: 0,
  source: 'bili-official-subtitle',
};

const OVERVIEW = {
  range: { kind: 'week' as const, startDay: '2026-01-05', endDay: '2026-01-11' },
  top: [{ bvid: 'BV1Top01', title: '拓扑学导论', totalSec: 600, share: 1 }],
  recent: [
    {
      bvid: 'BV1Top01',
      title: '拓扑学导论',
      totalSec: 600,
      lastDay: '2026-01-11',
      lastWatchedAt: 0,
      lastPositionSec: 30,
      durationSec: 600,
      url: 'https://www.bilibili.com/video/BV1Top01',
    },
  ],
  streakDays: 3,
};

// ───────────────────────── 纯逻辑：时间轴右缘钳制 ─────────────────────────

describe('buildTimelineMarkers 右缘钳制（第 27 轮）', () => {
  it('start ≥ duration：left 钳 100、width=0（不叠加最小宽度，left+width 不溢出 100）', () => {
    const markers = buildTimelineMarkers(
      [{ name: '越界', summary: '', confidence: 'high', intervals: [[120, 150], [200, 210]] }],
      100,
    );
    expect(markers).toHaveLength(2);
    for (const marker of markers) {
      expect(marker.leftPercent).toBe(100);
      expect(marker.widthPercent).toBe(0);
      expect(marker.leftPercent + marker.widthPercent).toBeLessThanOrEqual(100);
    }
  });

  it('普通区间与行内窄区间行为不变：窄区间保最小可点宽度 0.35，近缘带与越界钳到右缘内', () => {
    const markers = buildTimelineMarkers(
      [{ name: 't', summary: '', confidence: 'low', intervals: [[0, 0.1], [10, 35], [99.98, 105]] }],
      100,
    );
    expect(markers[0]?.widthPercent).toBeCloseTo(0.35);
    expect(markers[1]).toMatchObject({ leftPercent: 10, widthPercent: 25 });
    // 近缘区间（left=99.98 ∈ (99.65,100)）：按 100-left 整带钳制 width=0.02，不再保
    // 0.35 下限（第 29 轮审计#1，与 HDU timelineMarkerRect 同口径），left+width 恰 100
    expect(markers[2]?.leftPercent).toBeCloseTo(99.98);
    expect(markers[2]?.widthPercent).toBeCloseTo(0.02);
    expect(markers[2]!.leftPercent + markers[2]!.widthPercent).toBeLessThanOrEqual(100);
  });

  it('与 HDU timelineMarkerRect 同口径（第 29 轮审计#1）：任意区间 left/width 逐值一致', () => {
    const cases: Array<[number, number, number]> = [
      [0, 0.1, 100], // 行首窄区间：保 0.35 最小宽度
      [10, 35, 100], // 普通区间：按占比
      [99.7, 100, 100], // 近缘带：width=100-left=0.3（不再溢出到 100.35）
      [99.98, 105, 100], // 近缘带：width=0.02
      [120, 150, 100], // 起点越界：left=100、width=0
      [0, 50, 80], // 非百进制时长：普通区间
      [79.9, 95, 80], // 非百进制时长的近缘带
    ];
    for (const [start, end, duration] of cases) {
      const marker = buildTimelineMarkers(
        [{ name: 't', summary: '', confidence: 'low', intervals: [[start, end]] }],
        duration,
      )[0];
      const rect = timelineMarkerRect(start, end, duration);
      expect(marker?.leftPercent).toBe(rect.leftPercent);
      expect(marker?.widthPercent).toBe(rect.widthPercent);
      expect(marker!.leftPercent + marker!.widthPercent).toBeLessThanOrEqual(100);
    }
  });

  it('无 topics / 时长非法 → 空数组（回归不变）', () => {
    expect(buildTimelineMarkers([], 100)).toEqual([]);
    expect(buildTimelineMarkers([{ name: 't', summary: '', confidence: 'low', intervals: [[0, 1]] }], 0)).toEqual([]);
  });
});

// ───────────────────────── 纯逻辑：笔记 placeholder 文案 ─────────────────────────

describe('notePlaceholderText', () => {
  it('有实时时间 → 「记一笔（mm:ss）」；空值（video 不可用）→ 静态回退文案', () => {
    expect(notePlaceholderText('01:05')).toBe('记一笔（01:05）');
    expect(notePlaceholderText('00:00')).toBe('记一笔（00:00）');
    expect(notePlaceholderText(null)).toBe(NOTE_PLACEHOLDER_FALLBACK);
    expect(notePlaceholderText(undefined)).toBe(NOTE_PLACEHOLDER_FALLBACK);
  });
});

// ───────────────────────── BiliQaPanel UI ─────────────────────────

let calls: Array<{ op: string; args: unknown }> = [];

/** 面板挂载期 op 桩（每次调用重建桩表，用例内传 overrides 切换分支） */
function stubOps(overrides: Record<string, unknown> = {}): void {
  calls = [];
  const table: Record<string, unknown> = {
    'transcript.get': TRANSCRIPT,
    'qa.groups': [],
    'qa.list': [],
    'qa.ask': { chatId: 'c1', groupId: 'g1' },
    'ai.get': { result: null, stale: false },
    'ai.generate': { started: true },
    'ai.abort': undefined,
    'note.list': [],
    ...overrides,
  };
  callOpMock.mockImplementation(async (op: string, args?: unknown) => {
    calls.push({ op, args });
    if (!(op in table)) throw new Error(`unexpected op: ${op}`);
    const value = table[op];
    return typeof value === 'function' ? value(args) : value;
  });
  onEventMock.mockImplementation((handler: (event: PanelEvent) => void) => {
    lastEventHandler = handler;
    return () => undefined;
  });
}

/** 面板订阅的背景事件（onBackgroundEvent 回调参数的最小结构） */
interface PanelEvent {
  name: string;
  data: unknown;
}

/** 当前处于订阅状态的背景事件处理器（面板重订阅后旧处理器已被 React 清理，只保留最新） */
let lastEventHandler: ((event: PanelEvent) => void) | null = null;

/** 模拟 SW 推送背景事件（QA_DELTA / QA_DONE 等；投递给当前订阅中的处理器） */
function firePanelEvent(name: string, data: unknown): void {
  if (!lastEventHandler) throw new Error('no active background-event handler');
  act(() => {
    lastEventHandler?.({ name, data });
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

function panelElement() {
  return createElement(BiliQaPanel, {
    bvid: 'BV1Polish01',
    open: true,
    onClose: () => {},
    readPageP: () => 1,
    onFavoriteMoment: () => {},
  });
}

/** 分 P 轮询用可变页码（readPageP 闭包读取，模拟 B 站 SPA 切 P 不重载页面） */
let pollPage = 1;

function pollPanelElement() {
  return createElement(BiliQaPanel, {
    bvid: 'BV1Polish01',
    open: true,
    onClose: () => {},
    readPageP: () => pollPage,
    onFavoriteMoment: () => {},
  });
}

/** 分 P 轮询「恢复该 P 最近会话」断言用的历史消息（mediaKey 为 P2 分 P 键） */
const USER_MSG_P2: ChatMessageEntity = {
  id: 'u-p2',
  mediaKey: 'bili:BV1Polish01:p2',
  groupId: 'g-p2',
  role: 'user',
  content: 'P2 会话消息',
  anchorTime: 5,
  status: 'done',
  createdAt: 1,
};

/** 触发 React 受控 input 的 onChange（原生 setter + input 事件） */
function typeQuestion(value: string): void {
  const el = query<HTMLInputElement>('.bili-qa-composer input');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  loadSettingsMock.mockReset();
  loadSettingsMock.mockResolvedValue({ contextWindow: 'medium' });
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

describe('BiliQaPanel 问答上下文窗口档位（第 27 轮）', () => {
  it('初值沿用全局设置（loadSettings.contextWindow=large → 大档高亮），切换仅影响本面板后续 qa.ask', async () => {
    loadSettingsMock.mockResolvedValue({ contextWindow: 'large' });
    stubOps();
    await renderElement(panelElement());
    await act(async () => {});

    const chips = () => Array.from(host.querySelectorAll<HTMLButtonElement>('.bili-qa-window-chip'));
    expect(chips().map((c) => c.textContent)).toEqual(['小', '中', '大']);
    expect(chips().findIndex((c) => c.classList.contains('is-active'))).toBe(2);

    // 切到「小」：仅本地状态变化，不动全局设置（loadSettings 只读一次）
    await clickAsync(chips()[0]!);
    expect(chips().findIndex((c) => c.classList.contains('is-active'))).toBe(0);
    expect(loadSettingsMock).toHaveBeenCalledTimes(1);

    // 提问：qa.ask 携带切换后的 per-request 档位
    typeQuestion('这个概念是什么意思？');
    await clickAsync(query('.bili-qa-send'));
    const ask = calls.find((c) => c.op === 'qa.ask');
    expect(ask?.args).toMatchObject({ mediaKey: 'bili:BV1Polish01', windowPreset: 'small' });
  });

  it('未切换时按全局设置（medium）随 qa.ask 下发', async () => {
    loadSettingsMock.mockResolvedValue({ contextWindow: 'medium' });
    stubOps();
    await renderElement(panelElement());
    await act(async () => {});

    typeQuestion('再问一个');
    await clickAsync(query('.bili-qa-send'));
    expect(calls.find((c) => c.op === 'qa.ask')?.args).toMatchObject({ windowPreset: 'medium' });
  });

  it('全局设置读取失败：保持默认档位（medium），不阻塞面板', async () => {
    loadSettingsMock.mockRejectedValue(new Error('storage unavailable'));
    stubOps();
    await renderElement(panelElement());
    await act(async () => {});

    const chips = Array.from(host.querySelectorAll<HTMLButtonElement>('.bili-qa-window-chip'));
    expect(chips.find((c) => c.classList.contains('is-active'))?.textContent).toBe('中');
  });
});

describe('BiliQaPanel 笔记 placeholder 实时更新（第 27 轮）', () => {
  it('随播放时间更新（500ms 节流），无 <video> 回退静态文案', async () => {
    vi.useFakeTimers();
    stubOps({ 'note.list': [] });
    const video = document.createElement('video');
    document.body.appendChild(video);
    video.currentTime = 65;
    await renderElement(panelElement());
    await act(async () => {});
    await clickAsync(tabButton('笔记'));

    const textarea = () => host.querySelector<HTMLTextAreaElement>('.bili-note-composer textarea');
    // 页签打开即读取一次
    expect(textarea()?.placeholder).toBe('记一笔（01:05）');

    // 500ms 节流窗口内不提前更新
    video.currentTime = 130;
    await act(async () => {
      vi.advanceTimersByTime(499);
    });
    expect(textarea()?.placeholder).toBe('记一笔（01:05）');
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(textarea()?.placeholder).toBe('记一笔（02:10）');

    // 播放器不可用（节点移除）→ 回退静态文案
    video.remove();
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(textarea()?.placeholder).toBe(NOTE_PLACEHOLDER_FALLBACK);
  });

  it('非笔记页签不轮询：问答页签推进 1s 不产生 note.list 之外的额外读取', async () => {
    vi.useFakeTimers();
    stubOps({ 'note.list': [] });
    const video = document.createElement('video');
    document.body.appendChild(video);
    video.currentTime = 10;
    await renderElement(panelElement());
    await act(async () => {});
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(calls.filter((c) => c.op === 'note.list')).toHaveLength(0);
  });
});

// ───────────────────────── 问答页签分 P 轮询跟随（第 27 轮 P2-1） ─────────────────────────

describe('BiliQaPanel 问答页签分 P 轮询跟随（第 27 轮 P2-1）', () => {
  it('切 P 后按新 mediaKey 重读 transcript：新 P 无字幕隐藏输入框，再有字幕恢复', async () => {
    vi.useFakeTimers();
    pollPage = 1;
    stubOps({
      // P2（bili:BV1Polish01:p2）无字幕，其余分 P 有字幕
      'transcript.get': (args?: { mediaKey?: string }) =>
        args?.mediaKey === 'bili:BV1Polish01:p2' ? null : TRANSCRIPT,
    });
    await renderElement(pollPanelElement());
    await act(async () => {});
    expect(callOpMock).toHaveBeenCalledWith('transcript.get', { mediaKey: 'bili:BV1Polish01' });
    expect(host.querySelector('.bili-qa-composer')).not.toBeNull();

    // SPA 切到 P2（无字幕）：轮询 1s 内按新 mediaKey 重读 → 输入框隐藏 + 友好空态
    pollPage = 2;
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(callOpMock).toHaveBeenCalledWith('transcript.get', { mediaKey: 'bili:BV1Polish01:p2' });
    expect(host.querySelector('.bili-qa-composer')).toBeNull();
    expect(query('.bili-qa-empty').textContent).toContain(QA_NO_SUBTITLE_MESSAGE);

    // 再切到 P3（有字幕）：输入框恢复，meta 带分 P
    pollPage = 3;
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(callOpMock).toHaveBeenCalledWith('transcript.get', { mediaKey: 'bili:BV1Polish01:p3' });
    expect(host.querySelector('.bili-qa-composer')).not.toBeNull();
    expect(query('.bili-qa-meta').textContent).toContain('P3');
  });

  it('切 P 后恢复该 P 的最近会话：qa.groups / qa.list 按新 mediaKey 重读并上屏', async () => {
    vi.useFakeTimers();
    pollPage = 1;
    stubOps({
      'qa.groups': (args?: { mediaKey?: string }) =>
        args?.mediaKey === 'bili:BV1Polish01:p2' ? [{ groupId: 'g-p2', title: 'P2 会话', lastAt: 2, count: 1 }] : [],
      'qa.list': (args?: { mediaKey?: string; groupId?: string }) =>
        args?.mediaKey === 'bili:BV1Polish01:p2' && args?.groupId === 'g-p2' ? [USER_MSG_P2] : [],
    });
    await renderElement(pollPanelElement());
    await act(async () => {});
    expect(callOpMock).toHaveBeenCalledWith('qa.groups', { mediaKey: 'bili:BV1Polish01' });

    pollPage = 2;
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(callOpMock).toHaveBeenCalledWith('qa.groups', { mediaKey: 'bili:BV1Polish01:p2' });
    expect(callOpMock).toHaveBeenCalledWith('qa.list', { mediaKey: 'bili:BV1Polish01:p2', groupId: 'g-p2' });
    expect(query('.bili-qa-body').textContent).toContain('P2 会话消息');
  });

  it('qa.ask 转写缺失类错误映射 B 站文案；其余错误照常展示', async () => {
    vi.useFakeTimers();
    pollPage = 1;
    stubOps({
      'qa.ask': () =>
        Promise.reject(new AppError('INVALID_INPUT', { userMessage: '本节还没有转写文本，请先生成转写后再提问' })),
    });
    await renderElement(pollPanelElement());
    await act(async () => {});
    typeQuestion('这个概念是什么意思？');
    await clickAsync(query('.bili-qa-send'));
    expect(query('.bili-qa-error').textContent).toBe(QA_NO_SUBTITLE_MESSAGE);

    // 其余错误（LLM 未配置）不走映射，照常展示 SW 的 userMessage
    stubOps({
      'qa.ask': () => Promise.reject(new AppError('LLM_NO_PROVIDER')),
    });
    typeQuestion('再问一个');
    await clickAsync(query('.bili-qa-send'));
    expect(query('.bili-qa-error').textContent).toBe('尚未配置 AI 服务，请在设置中添加');
  });
});

// ───────────────────────── 收藏此时刻 url 快照（第 27 轮 P2-2） ─────────────────────────

describe('BiliCollectApp 收藏此时刻 url 快照（第 27 轮 P2-2）', () => {
  it('收藏 url 取动作触发时的 location 现值（含 ?p= 与 ?t=），SPA 切 P 后再收藏跟随新 URL', async () => {
    stubOps({
      'fav.list': [],
      'folder.list': [],
      'video.progress.get': null,
      'fav.put': undefined,
    });
    const video = document.createElement('video');
    video.currentTime = 65;
    document.body.appendChild(video);

    // 经 ?t= 进页且带分 P：动作时 location 现值应原样落 metadata.url
    window.history.replaceState({}, '', '/video/BV1Polish01/?p=2&t=100');
    document.title = '测试视频标题';
    await renderElement(createElement(BiliCollectApp));
    await act(async () => {});
    await clickAsync(query('.bili-qa-fab'));
    await clickAsync(query('.bili-qa-moment'));

    const puts = () => calls.filter((c) => c.op === 'fav.put');
    const metaOf = (call?: { args: unknown }) =>
      (call?.args as { favorite?: { metadata?: Record<string, unknown> } })?.favorite?.metadata;
    expect(puts()).toHaveLength(1);
    const firstMeta = metaOf(puts()[0]);
    expect(firstMeta?.url).toBe(window.location.href);
    expect(firstMeta?.url).toContain('/video/BV1Polish01/?p=2&t=100');
    expect(firstMeta?.p).toBe(2);

    // SPA 切 P / 进度变化后再收藏：url 反映动作时现值（挂载时快照会停留在旧 URL）
    window.history.replaceState({}, '', '/video/BV1Polish01/?p=3&t=55');
    await clickAsync(query('.bili-qa-moment'));
    expect(puts()).toHaveLength(2);
    const secondMeta = metaOf(puts()[1]);
    expect(secondMeta?.url).toBe(window.location.href);
    expect(secondMeta?.url).toContain('/video/BV1Polish01/?p=3&t=55');
    expect(secondMeta?.p).toBe(3);
  });
});

// ───────────────────────── BiliTimelineMarkers 零宽标记过滤 ─────────────────────────

describe('BiliTimelineMarkers 越界区间不渲染（第 27 轮）', () => {
  it('width=0 的越界区间不渲染标记，不溢出播放器右缘', async () => {
    const topics: Topic[] = [
      { name: '函数定义', summary: '', confidence: 'high', intervals: [[10, 35], [200, 210]] },
    ];
    const aiResult = {
      mediaKey: 'bili:BV1Polish01',
      topics,
      outline: [],
      generatedAt: 0,
      model: 'test',
    } as unknown as AiResultEntity;
    stubOps({ 'ai.get': { result: aiResult, stale: false } });
    const video = document.createElement('video');
    document.body.appendChild(video);
    Object.defineProperty(video, 'duration', { configurable: true, get: () => 100 });
    video.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 640, height: 360, right: 640, bottom: 360, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    await renderElement(createElement(BiliTimelineMarkers, { bvid: 'BV1Polish01', readPageP: () => 1 }));
    await act(async () => {});

    const marks = Array.from(host.querySelectorAll<HTMLButtonElement>('.bili-timeline-mark'));
    expect(marks).toHaveLength(1);
    expect(marks[0]?.style.left).toBe('10%');
  });
});

// ───────────────────────── BiliWatchCard 错误态/空态区分 ─────────────────────────

describe('BiliWatchCard 错误态与空态区分（第 27 轮）', () => {
  function stubOverview(impl: () => Promise<unknown>): void {
    calls = [];
    callOpMock.mockImplementation(async (op: string, args?: unknown) => {
      calls.push({ op, args });
      if (op !== 'stats.bili.overview') throw new Error(`unexpected op: ${op}`);
      return impl();
    });
  }

  it('请求失败 → 显示「加载失败 + 重试」，不误显示空态；重试重新拉取，成功后渲染数据', async () => {
    stubOverview(() => Promise.reject(new Error('rpc down')));
    await renderElement(createElement(BiliWatchCard));
    await act(async () => {});
    expect(calls.filter((c) => c.op === 'stats.bili.overview')).toHaveLength(1);
    expect(host.textContent).toContain('加载失败');
    expect(host.textContent).not.toContain('还没有站外观看记录');
    const retry = query('.hdu-empty button');
    expect(retry.textContent).toBe('重试');

    stubOverview(() => Promise.resolve(OVERVIEW));
    await clickAsync(retry);
    // 重试触发了新一轮拉取（stubOverview 已重置 calls，此处 1 条即重试本身的请求）
    expect(calls.filter((c) => c.op === 'stats.bili.overview')).toHaveLength(1);
    expect(calls.at(-1)?.args).toEqual({ kind: 'week' });
    expect(host.textContent).toContain('拓扑学导论');
    expect(host.textContent).not.toContain('加载失败');
  });

  it('成功但无数据 → 仍显示「还没有站外观看记录」空态', async () => {
    stubOverview(() => Promise.resolve({ range: OVERVIEW.range, top: [], recent: [], streakDays: 0 }));
    await renderElement(createElement(BiliWatchCard));
    await act(async () => {});
    expect(host.textContent).toContain('还没有站外观看记录');
    expect(host.textContent).not.toContain('加载失败');
  });

  it('切周期（week→month）同样走「失败 → 重试」链路', async () => {
    stubOverview(() => Promise.reject(new Error('rpc down')));
    await renderElement(createElement(BiliWatchCard));
    await act(async () => {});
    expect(host.textContent).toContain('加载失败');

    const monthTab = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === '本月');
    expect(monthTab).toBeDefined();
    stubOverview(() => Promise.resolve({ ...OVERVIEW, range: { ...OVERVIEW.range, kind: 'month' } }));
    await clickAsync(monthTab!);
    expect(calls.at(-1)?.args).toEqual({ kind: 'month' });
    expect(host.textContent).toContain('拓扑学导论');
  });
});

// ───────────────────────── 问答页签切 P 竞态三修（第 28 轮 P2-1） ─────────────────────────

/** P2-1③ 用：旧 P1 的流式终稿（mediaKey 为 P1 裸键） */
const AI_MSG_P1: ChatMessageEntity = {
  id: 'c1',
  mediaKey: 'bili:BV1Polish01',
  groupId: 'g1',
  role: 'ai',
  content: '旧P的流式答案',
  anchorTime: 5,
  status: 'done',
  createdAt: 9,
};

/** P2-1③ 用：属于当前 P2 的终稿（mediaKey 为 P2 分 P 键） */
const AI_MSG_P2: ChatMessageEntity = {
  id: 'c2',
  mediaKey: 'bili:BV1Polish01:p2',
  groupId: 'g1',
  role: 'ai',
  content: 'P2的流式答案',
  anchorTime: 5,
  status: 'done',
  createdAt: 10,
};

describe('BiliQaPanel 问答页签切 P 竞态三修（第 28 轮 P2-1）', () => {
  it('P2-1① handleAsk 写入守卫：切 P 后旧 P 的 qa.ask 迟到完成不写入新 P 视图、groupId 不跨 P 带走', async () => {
    vi.useFakeTimers();
    pollPage = 1;
    let resolveAsk: (value: unknown) => void = () => undefined;
    stubOps({
      'qa.ask': () =>
        new Promise((resolve) => {
          resolveAsk = resolve;
        }),
    });
    await renderElement(pollPanelElement());
    await act(async () => {});
    typeQuestion('这个概念是什么意思？');
    await clickAsync(query('.bili-qa-send'));

    // SPA 切到 P2（轮询重置新 P 状态），随后旧 P 的 qa.ask 才迟到完成
    pollPage = 2;
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    resolveAsk({ chatId: 'c1', groupId: 'g-old' });
    await act(async () => {});

    // 旧 P 迟到完成未点亮任何流式/生成中状态（写入守卫生效）
    expect(query('.bili-qa-send').textContent).toBe('提问');

    // 旧 P 的 groupId 不跨 P 带走：在 P2 再提问时 groupId 为 undefined（新会话语义）
    stubOps({ 'qa.ask': { chatId: 'c2', groupId: 'g-new' } });
    typeQuestion('再问一个');
    await clickAsync(query('.bili-qa-send'));
    const ask = calls.find((c) => c.op === 'qa.ask');
    expect(ask?.args).toMatchObject({ mediaKey: 'bili:BV1Polish01:p2', windowPreset: 'medium' });
    expect((ask?.args as { groupId?: string }).groupId).toBeUndefined();
  });

  it('P2-1② 流式中切 P：1s 轮询先 qa.abort 旧流再重置，消除幽灵生成中与并发双流', async () => {
    vi.useFakeTimers();
    pollPage = 1;
    stubOps();
    await renderElement(pollPanelElement());
    await act(async () => {});
    typeQuestion('这个概念是什么意思？');
    await clickAsync(query('.bili-qa-send'));
    // 流式进行中：composer 显示「停止」
    expect(query('.bili-qa-send').textContent).toBe('停止');

    pollPage = 2;
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    // 旧流被 abort（SW 侧中止并落 aborted 终态），本地流式态同步清除
    expect(calls.some((c) => c.op === 'qa.abort' && (c.args as { chatId?: string })?.chatId === 'c1')).toBe(true);
    expect(query('.bili-qa-send').textContent).toBe('提问');
    expect(query('.bili-qa-body').textContent).not.toContain('生成中');
  });

  it('P2-1③ 迟到 QA_DELTA / QA_DONE 按 mediaKey 复核：旧 P 流不串显进新 P 视图', async () => {
    vi.useFakeTimers();
    pollPage = 1;
    stubOps();
    await renderElement(pollPanelElement());
    await act(async () => {});
    typeQuestion('这个概念是什么意思？');
    await clickAsync(query('.bili-qa-send'));
    pollPage = 2;
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    // 旧 P（P1）的迟到增量与迟到终稿：均不得进入 P2 视图
    firePanelEvent('QA_DELTA', { chatId: 'c1', groupId: 'g1', text: '{"answer":' });
    firePanelEvent('QA_DONE', { chatId: 'c1', message: AI_MSG_P1 });
    expect(query('.bili-qa-send').textContent).toBe('提问');
    expect(query('.bili-qa-body').textContent).not.toContain('旧P的流式答案');

    // 对照：属于当前 P2 的 QA_DONE 正常落位（复核不误伤本 P 消息）
    firePanelEvent('QA_DONE', { chatId: 'c2', message: AI_MSG_P2 });
    expect(query('.bili-qa-body').textContent).toContain('P2的流式答案');
  });

  it('迟到 QA_FAILED 按 mediaKey 复核（第 29 轮审计#4）：旧 P 失败不写新 P 视图、不复位新 P 生成中', async () => {
    vi.useFakeTimers();
    pollPage = 1;
    stubOps();
    await renderElement(pollPanelElement());
    await act(async () => {});
    typeQuestion('这个概念是什么意思？');
    await clickAsync(query('.bili-qa-send'));
    expect(query('.bili-qa-send').textContent).toBe('停止');

    // SPA 切到 P2（轮询 abort 旧流并清除流式登记），再在 P2 发起新提问（c2 流式进行中）
    pollPage = 2;
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    stubOps({ 'qa.ask': { chatId: 'c2', groupId: 'g2' } });
    typeQuestion('再问一个');
    await clickAsync(query('.bili-qa-send'));
    expect(query('.bili-qa-send').textContent).toBe('停止');

    // 旧 P（P1）的迟到失败（chatId=c1，非当前流式登记）：三链复核不写任何 state——
    // P2 的「生成中」不被误清（按钮保持「停止」），失败文案也不串显进新 P 视图
    firePanelEvent('QA_FAILED', {
      chatId: 'c1',
      error: { code: 'LLM_SERVER_ERROR', userMessage: 'AI 服务返回错误', retryable: true },
    });
    expect(query('.bili-qa-send').textContent).toBe('停止');
    expect(query('.bili-qa-body').textContent).not.toContain('AI 服务返回错误');

    // 对照：当前 P2 流（c2）的失败正常处理——复位 asking，按钮恢复「提问」
    firePanelEvent('QA_FAILED', {
      chatId: 'c2',
      error: { code: 'LLM_TIMEOUT', userMessage: 'AI 请求超时', retryable: true },
    });
    expect(query('.bili-qa-send').textContent).toBe('提问');
  });
});

// ───────────────────────── AI 标注页签窗口档位 chips（第 28 轮） ─────────────────────────

describe('BiliQaPanel AI 标注页签窗口档位 chips（第 28 轮）', () => {
  it('标注页签同款三档 chips：初值沿用全局设置、点选仅本地生效，ai.generate 携带所选档位', async () => {
    loadSettingsMock.mockResolvedValue({ contextWindow: 'large' });
    stubOps();
    await renderElement(panelElement());
    await act(async () => {});
    await clickAsync(tabButton('AI 标注'));
    await act(async () => {});
    await act(async () => {});

    const chips = () => Array.from(host.querySelectorAll<HTMLButtonElement>('.bili-qa-window-chip'));
    expect(chips().map((c) => c.textContent)).toEqual(['小', '中', '大']);
    expect(chips().findIndex((c) => c.classList.contains('is-active'))).toBe(2);
    expect(chips()[0]?.title).toContain('AI 标注上下文窗口');

    // 点选「小」：仅本地状态变化（P3-1 已交互登记后，异步设置回填不再覆盖）
    await clickAsync(chips()[0]!);
    expect(chips().findIndex((c) => c.classList.contains('is-active'))).toBe(0);

    // 生成请求携带所选档位（per-request windowPreset 全链）
    await clickAsync(query('.bili-ai-generate'));
    expect(calls.find((c) => c.op === 'ai.generate')?.args).toMatchObject({
      mediaKey: 'bili:BV1Polish01',
      windowPreset: 'small',
    });
  });

  it('问答页签 chips tooltip 已更新：不再写「AI 标注生成沿用全局设置」', async () => {
    stubOps();
    await renderElement(panelElement());
    await act(async () => {});
    const qaChip = host.querySelector<HTMLButtonElement>('.bili-qa-window-chip');
    expect(qaChip?.title).toContain('问答上下文窗口');
    expect(qaChip?.title).toContain('亦可面板选档');
    expect(qaChip?.title).not.toContain('沿用全局设置');
  });
});
