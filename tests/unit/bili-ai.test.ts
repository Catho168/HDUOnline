/**
 * B 站 AI 标注/大纲/时间轴（第 25 轮功能扩展第二批）单测：
 *  1) 纯逻辑（core/bili/aiMarkers，node 语义直测）：topics→时间轴标记 left/width 百分比
 *     换算（含钳制/非法区间 fail-soft）、当前高亮区间判定、aiResult 就绪/可生成/无字幕
 *     判定、知识点 seek 目标；
 *  2) UI 冒烟（jsdom + react-dom 客户端渲染，无 JSX、直接 createElement，
 *     照 bili-assistant.test.ts 模式；callOp/onBackgroundEvent 整体 mock）：
 *     - BiliQaPanel「AI 标注」tab：无字幕空态不发起 ai.generate、有字幕无结果点击生成
 *       （mediaKey 带分 P）、生成中可停止（ai.abort）、AI_PROGRESS 阶段指示、AI_DONE
 *       回读终稿、AI_FAILED 中性错误可重试、事件按 mediaKey 过滤、SPA 切 P 重读、
 *       已有结果时 topics/outline 渲染与点击 seek；
 *     - BiliTimelineMarkers：按 topics 渲染标记并跟随 <video> 定位、点击标记 seek、
 *       播放到区间高亮、无 aiResult 不渲染、分 P mediaKey。
 */

// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({
  callOp: vi.fn(),
  onBackgroundEvent: vi.fn(() => () => undefined),
}));

import { callOp, onBackgroundEvent } from '@/core/shared/client';
import {
  activeMarkerKey,
  aiAnnotationReadiness,
  buildTimelineMarkers,
  AI_ANNOTATION_NO_SUBTITLE_MESSAGE,
  topicSeekTarget,
} from '@/core/bili/aiMarkers';
import { BiliQaPanel } from '@/entrypoints/content/ui/BiliQaPanel';
import { BiliTimelineMarkers } from '@/entrypoints/content/ui/bili/BiliTimelineMarkers';
import type { AiResultEntity, Topic, TranscriptEntity } from '@/core/shared/types';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;
const onEventMock = onBackgroundEvent as unknown as Mock;

// ───────────────────────── 测试数据 ─────────────────────────

const TOPICS: Topic[] = [
  { name: '函数定义', summary: '函数的定义与基本性质', confidence: 'high', intervals: [[10, 35]] },
  { name: '例题讲解', summary: '两道典型例题', confidence: 'medium', intervals: [[40, 60], [70, 90]] },
];

const AI_RESULT: AiResultEntity = {
  mediaKey: 'bili:BV1Test01',
  promptVersion: 1,
  model: 'test-model',
  topics: TOPICS,
  outline: [
    { level: 1, title: '开场引入', start: 0, end: 10 },
    { level: 2, title: '函数定义', start: 10, end: 35, parent: 0 },
  ],
  createdAt: 0,
};

const TRANSCRIPT: TranscriptEntity = {
  mediaKey: 'bili:BV1Test01',
  segments: [{ s: 0, e: 5, text: 'hello' }],
  model: 'bili-official-subtitle',
  lang: 'zh-CN',
  glossaryVersion: 0,
  createdAt: 0,
  source: 'bili-official-subtitle',
};

// ───────────────────────── 纯逻辑 ─────────────────────────

describe('buildTimelineMarkers 标记换算', () => {
  it('按视频时长换算 left/width 百分比，key 为 区间下标-序号', () => {
    const markers = buildTimelineMarkers(TOPICS, 100);
    expect(markers).toHaveLength(3);
    expect(markers[0]).toMatchObject({ key: '0-0', name: '函数定义', leftPercent: 10, widthPercent: 25, start: 10, end: 35 });
    expect(markers[1]).toMatchObject({ key: '1-0', leftPercent: 40, widthPercent: 20 });
    expect(markers[2]).toMatchObject({ key: '1-1', leftPercent: 70, widthPercent: 20 });
  });

  it('过窄区间钳到最小可点宽度；越界区间左界钳 0–100、不再叠加最小宽度（width=0，第 27 轮）', () => {
    const markers = buildTimelineMarkers(
      [{ name: 't', summary: '', confidence: 'low', intervals: [[0, 0.1], [200, 210]] }],
      100,
    );
    expect(markers[0]?.widthPercent).toBeCloseTo(0.35);
    expect(markers[1]?.leftPercent).toBe(100);
    expect(markers[1]?.widthPercent).toBe(0);
    expect(markers[1]!.leftPercent + markers[1]!.widthPercent).toBeLessThanOrEqual(100);
  });

  it('无 topics / 时长非法 → 空数组（调用方据此不渲染叠加条）', () => {
    expect(buildTimelineMarkers([], 100)).toEqual([]);
    expect(buildTimelineMarkers(TOPICS, 0)).toEqual([]);
    expect(buildTimelineMarkers(TOPICS, -5)).toEqual([]);
    expect(buildTimelineMarkers(TOPICS, Number.NaN)).toEqual([]);
  });

  it('非有限端点的区间跳过（fail-soft，不让脏数据破坏整条渲染）', () => {
    const markers = buildTimelineMarkers(
      [{ name: 't', summary: '', confidence: 'high', intervals: [[Number.NaN, 5], [5, 10]] }],
      100,
    );
    expect(markers).toHaveLength(1);
    expect(markers[0]?.key).toBe('0-1');
  });
});

describe('activeMarkerKey 当前高亮区间判定', () => {
  const markers = buildTimelineMarkers(TOPICS, 100);

  it('start<=t<end 命中；行间隙与句尾边界不高亮', () => {
    expect(activeMarkerKey(markers, 20)).toBe('0-0');
    expect(activeMarkerKey(markers, 50)).toBe('1-0');
    expect(activeMarkerKey(markers, 80)).toBe('1-1');
    expect(activeMarkerKey(markers, 65)).toBeNull();
    expect(activeMarkerKey(markers, 90)).toBeNull();
    expect(activeMarkerKey(markers, 5)).toBeNull();
  });

  it('未播放 / 非数值时间不高亮', () => {
    expect(activeMarkerKey(markers, undefined)).toBeNull();
    expect(activeMarkerKey(markers, Number.NaN)).toBeNull();
  });
});

describe('aiAnnotationReadiness 就绪/可生成/无字幕判定', () => {
  it('已有 aiResult → ready（展示 topics/outline）', () => {
    expect(aiAnnotationReadiness(AI_RESULT, null)).toEqual({ state: 'ready', aiResult: AI_RESULT });
    expect(aiAnnotationReadiness(AI_RESULT, TRANSCRIPT).state).toBe('ready');
  });

  it('无结果但 transcript 可用 → can-generate（展示生成按钮）', () => {
    expect(aiAnnotationReadiness(null, TRANSCRIPT)).toEqual({ state: 'can-generate' });
  });

  it('无字幕（含空段落）→ no-subtitle，给友好文案，不发起生成', () => {
    const r = aiAnnotationReadiness(null, null);
    expect(r.state).toBe('no-subtitle');
    expect(r).toMatchObject({ message: AI_ANNOTATION_NO_SUBTITLE_MESSAGE });
    expect(AI_ANNOTATION_NO_SUBTITLE_MESSAGE).toBe('该视频暂无可用字幕，无法生成 AI 标注');
    expect(aiAnnotationReadiness(null, { ...TRANSCRIPT, segments: [] }).state).toBe('no-subtitle');
  });
});

describe('topicSeekTarget 知识点跳转目标', () => {
  it('取首个区间起点；无区间回退 0', () => {
    expect(topicSeekTarget(TOPICS[0]!)).toBe(10);
    expect(topicSeekTarget({ name: 'x', summary: '', confidence: 'low', intervals: [] })).toBe(0);
  });
});

// ───────────────────────── UI 冒烟 ─────────────────────────

let calls: Array<{ op: string; args: unknown }> = [];
const stubTable: Record<string, unknown> = {};

/** 面板/叠加条挂载期 op 桩（用例内改写 stubTable 的值即可切换分支） */
function stubOps(overrides: Record<string, unknown> = {}): void {
  calls = [];
  Object.assign(stubTable, {
    'transcript.get': TRANSCRIPT,
    'qa.groups': [],
    'qa.list': [],
    'qa.ask': { chatId: 'c1', groupId: 'g1' },
    'ai.get': { result: null, stale: false },
    'ai.generate': { started: true },
    'ai.abort': undefined,
    ...overrides,
  });
  callOpMock.mockImplementation(async (op: string, args?: unknown) => {
    calls.push({ op, args });
    if (!(op in stubTable)) throw new Error(`unexpected op: ${op}`);
    const value = stubTable[op];
    return typeof value === 'function' ? value(args) : value;
  });
  onEventMock.mockImplementation(() => () => undefined);
}

function countCalls(op: string): number {
  return calls.filter((c) => c.op === op).length;
}

let host: HTMLElement;
let root: Root;

async function renderElement(el: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => {
    root.render(el);
  });
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

/** 点击 + 让点击触发的异步链（callOp → setState → 重渲染）完全落定 */
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

function qaProps(overrides: Record<string, unknown> = {}) {
  return {
    bvid: 'BV1Test01',
    open: true,
    onClose: () => {},
    readPageP: () => 1,
    onFavoriteMoment: () => {},
    ...overrides,
  };
}

/** 打开面板后切到「AI 标注」分区（第 44 轮起五页签，按文本查找避免下标漂移） */
async function switchToAnnotate(): Promise<void> {
  const tabs = Array.from(host.querySelectorAll<HTMLButtonElement>('.bili-qa-tab'));
  const tab = tabs.find((b) => b.textContent === 'AI 标注');
  if (!tab) throw new Error('tab not found: AI 标注');
  await clickAsync(tab);
}

/** 切到「大纲」分区（第 44 轮独立页签） */
async function switchToOutline(): Promise<void> {
  const tabs = Array.from(host.querySelectorAll<HTMLButtonElement>('.bili-qa-tab'));
  const tab = tabs.find((b) => b.textContent === '大纲');
  if (!tab) throw new Error('tab not found: 大纲');
  await clickAsync(tab);
}

beforeEach(() => {
  document.body.innerHTML = '';
  window.history.replaceState({}, '', '/');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
});

describe('BiliQaPanel AI 标注 tab', () => {
  it('无字幕：标注区给友好空态，不渲染生成按钮、不发起 ai.generate', async () => {
    stubOps({ 'transcript.get': null });
    await renderElement(createElement(BiliQaPanel, qaProps()));
    await act(async () => {});
    await switchToAnnotate();

    expect(query('.bili-qa-empty').textContent).toContain('该视频暂无可用字幕，无法生成 AI 标注');
    expect(host.querySelector('.bili-ai-generate')).toBeNull();
    expect(countCalls('ai.generate')).toBe(0);
    // 标注区挂载会读取当前 mediaKey 的结果（无字幕也允许读，结果为空）
    expect(calls.find((c) => c.op === 'ai.get')?.args).toEqual({ mediaKey: 'bili:BV1Test01' });
  });

  it('有字幕无结果：点击「生成 AI 标注」发起 ai.generate（mediaKey 带当前分 P），进入生成中态', async () => {
    stubOps();
    await renderElement(createElement(BiliQaPanel, qaProps({ readPageP: () => 2 })));
    await act(async () => {});
    await switchToAnnotate();
    await clickAsync(query('.bili-ai-generate'));

    // 第 28 轮起 ai.generate 支持 per-request 档位：面板随请求下发 windowPreset
    //（未点选 chips 时=全局设置默认档 medium，与「缺省即全局」口径一致）
    expect(calls.find((c) => c.op === 'ai.generate')?.args).toEqual({
      mediaKey: 'bili:BV1Test01:p2',
      windowPreset: 'medium',
    });
    expect(query('.bili-ai-busy').textContent).toContain('正在生成 AI 标注');
    expect(host.querySelector('.bili-ai-stop')).not.toBeNull();
  });

  it('生成中点击停止 → ai.abort（当前 mediaKey），解除生成中态回到可生成', async () => {
    stubOps();
    await renderElement(createElement(BiliQaPanel, qaProps()));
    await act(async () => {});
    await switchToAnnotate();
    await clickAsync(query('.bili-ai-generate'));
    await clickAsync(query('.bili-ai-stop'));

    expect(calls.find((c) => c.op === 'ai.abort')?.args).toEqual({ mediaKey: 'bili:BV1Test01' });
    expect(host.querySelector('.bili-ai-busy')).toBeNull();
    expect(host.querySelector('.bili-ai-generate')).not.toBeNull();
  });

  it('AI_PROGRESS 驱动阶段指示；AI_DONE 后回读 ai.get 渲染 topics/outline 终稿', async () => {
    stubOps();
    await renderElement(createElement(BiliQaPanel, qaProps()));
    await act(async () => {});
    await switchToAnnotate();
    await clickAsync(query('.bili-ai-generate'));

    const cb = onEventMock.mock.calls.at(-1)?.[0] as ((event: unknown) => void) | undefined;
    expect(cb).toBeTypeOf('function');
    await act(async () => {
      cb?.({ name: 'AI_PROGRESS', data: { mediaKey: 'bili:BV1Test01', stage: 'requesting' } });
    });
    expect(query('.bili-ai-busy').textContent).toContain('请求模型');

    stubTable['ai.get'] = { result: AI_RESULT, stale: false };
    await act(async () => {
      cb?.({ name: 'AI_DONE', data: { mediaKey: 'bili:BV1Test01', result: { topicCount: 2, outlineCount: 2, cached: false } } });
    });
    expect(host.querySelector('.bili-ai-busy')).toBeNull();
    const names = Array.from(host.querySelectorAll('.bili-ai-topic-name')).map((el) => el.textContent);
    expect(names).toEqual(['函数定义', '例题讲解']);
    // 第 44 轮起 outline 移至独立「大纲」页签：标注页签只渲染知识点
    expect(host.querySelectorAll('.bili-ai-outline')).toHaveLength(0);
    expect(query('.bili-ai-section-head').textContent).toContain('2 个知识点');

    await switchToOutline();
    expect(host.querySelectorAll('.bili-ai-outline')).toHaveLength(2);
  });

  it('AI_FAILED：中性错误提示 + 可重试；点击重试再次发起 ai.generate', async () => {
    stubOps();
    await renderElement(createElement(BiliQaPanel, qaProps()));
    await act(async () => {});
    await switchToAnnotate();
    await clickAsync(query('.bili-ai-generate'));

    const cb = onEventMock.mock.calls.at(-1)?.[0] as ((event: unknown) => void) | undefined;
    await act(async () => {
      cb?.({ name: 'AI_FAILED', data: { mediaKey: 'bili:BV1Test01', error: { code: 'LLM_BAD_OUTPUT', userMessage: '生成失败，请稍后重试', retryable: true } } });
    });
    expect(host.querySelector('.bili-ai-busy')).toBeNull();
    expect(query('.bili-qa-error').textContent).toContain('生成失败，请稍后重试');
    expect(host.querySelector('.bili-ai-retry')).not.toBeNull();

    await clickAsync(query('.bili-ai-generate'));
    expect(countCalls('ai.generate')).toBe(2);
  });

  it('AI 事件按 mediaKey 过滤：其他分 P 的事件不驱动本页面板', async () => {
    stubOps();
    await renderElement(createElement(BiliQaPanel, qaProps({ readPageP: () => 2 })));
    await act(async () => {});
    await switchToAnnotate();
    await clickAsync(query('.bili-ai-generate'));

    const cb = onEventMock.mock.calls.at(-1)?.[0] as ((event: unknown) => void) | undefined;
    await act(async () => {
      cb?.({ name: 'AI_FAILED', data: { mediaKey: 'bili:BV1Test01', error: { code: 'X', userMessage: '别的分 P 的失败', retryable: true } } });
    });
    expect(host.querySelector('.bili-qa-error')).toBeNull();
    expect(host.querySelector('.bili-ai-busy')).not.toBeNull();
  });

  it('SPA 切 P：URL ?p= 变化后标注区按新 mediaKey 重读 transcript/aiResult', async () => {
    vi.useFakeTimers();
    try {
      let pageP = 1;
      stubOps();
      await renderElement(createElement(BiliQaPanel, qaProps({ readPageP: () => pageP })));
      await act(async () => {});
      await switchToAnnotate();
      expect(calls.filter((c) => c.op === 'ai.get').map((c) => c.args)).toEqual([{ mediaKey: 'bili:BV1Test01' }]);

      pageP = 3;
      await act(async () => {
        vi.advanceTimersByTime(1100);
      });
      expect(calls.filter((c) => c.op === 'ai.get').map((c) => c.args)).toContainEqual({ mediaKey: 'bili:BV1Test01:p3' });
      expect(calls.filter((c) => c.op === 'transcript.get').map((c) => c.args)).toContainEqual({ mediaKey: 'bili:BV1Test01:p3' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('已有 aiResult：渲染知识点与大纲，点击时间区间/大纲节点 seek 到对应起点', async () => {
    stubOps({ 'ai.get': { result: AI_RESULT, stale: false } });
    const video = document.createElement('video');
    document.body.appendChild(video);
    await renderElement(createElement(BiliQaPanel, qaProps()));
    await act(async () => {});
    await switchToAnnotate();

    const times = Array.from(host.querySelectorAll<HTMLButtonElement>('.bili-ai-time'));
    expect(times).toHaveLength(3);
    click(times[1]!); // 例题讲解第一区间 40s
    expect(video.currentTime).toBe(40);

    // 大纲节点在独立「大纲」页签（第 44 轮）：切页签后点击节点 seek 到起点
    await switchToOutline();
    const outlineRows = Array.from(host.querySelectorAll<HTMLButtonElement>('.bili-ai-outline'));
    expect(outlineRows).toHaveLength(2);
    click(outlineRows[1]!); // 函数定义 10s
    expect(video.currentTime).toBe(10);
  });
});

describe('BiliTimelineMarkers 播放器时间轴叠加', () => {
  /** 挂一个带时长与固定矩形（jsdom getBoundingClientRect 恒 0）的 <video> */
  function setupVideo(): HTMLVideoElement {
    const video = document.createElement('video');
    document.body.appendChild(video);
    Object.defineProperty(video, 'duration', { configurable: true, get: () => 100 });
    video.getBoundingClientRect = () =>
      ({ left: 100, top: 200, width: 640, height: 360, right: 740, bottom: 560, x: 100, y: 200, toJSON: () => ({}) }) as DOMRect;
    return video;
  }

  it('有 aiResult.topics：按区间渲染标记条，定位跟随 <video>，点击标记 seek 到区间起点', async () => {
    stubOps({ 'ai.get': { result: AI_RESULT, stale: false } });
    const video = setupVideo();
    window.history.replaceState({}, '', '/video/BV1Test01/');
    await renderElement(createElement(BiliTimelineMarkers, { bvid: 'BV1Test01', readPageP: () => 1 }));
    await act(async () => {});

    const marks = Array.from(host.querySelectorAll<HTMLButtonElement>('.bili-timeline-mark'));
    expect(marks).toHaveLength(3);
    const layer = query('.bili-timeline') as HTMLElement;
    expect(layer.style.left).toBe('100px');
    expect(layer.style.top).toBe('190px'); // video 顶边上方 10px
    expect(layer.style.width).toBe('640px');
    expect(marks[0]?.style.left).toBe('10%');
    expect(marks[0]?.style.width).toBe('25%');
    expect(marks[0]?.getAttribute('title')).toContain('函数定义');

    click(marks[1]!);
    expect(video.currentTime).toBe(40);
  });

  it('播放到区间时对应标记高亮（is-active）', async () => {
    stubOps({ 'ai.get': { result: AI_RESULT, stale: false } });
    const video = setupVideo();
    window.history.replaceState({}, '', '/video/BV1Test01/');
    await renderElement(createElement(BiliTimelineMarkers, { bvid: 'BV1Test01', readPageP: () => 1 }));
    await act(async () => {});

    video.currentTime = 50;
    await act(async () => {
      video.dispatchEvent(new Event('timeupdate'));
    });
    const active = host.querySelectorAll('.bili-timeline-mark.is-active');
    expect(active).toHaveLength(1);
    expect(active[0]?.getAttribute('title')).toContain('例题讲解');
  });

  it('无 aiResult（ai.get 为 null）：不渲染标记条', async () => {
    stubOps({ 'ai.get': { result: null, stale: false } });
    setupVideo();
    window.history.replaceState({}, '', '/video/BV1Test01/');
    await renderElement(createElement(BiliTimelineMarkers, { bvid: 'BV1Test01', readPageP: () => 1 }));
    await act(async () => {});
    expect(host.querySelector('.bili-timeline')).toBeNull();
  });

  it('分 P：readPageP 返回 2 → ai.get 用分 P 键 bili:<bvid>:p2', async () => {
    stubOps({ 'ai.get': { result: null, stale: false } });
    setupVideo();
    window.history.replaceState({}, '', '/video/BV1Test01/?p=2');
    await renderElement(createElement(BiliTimelineMarkers, { bvid: 'BV1Test01', readPageP: () => 2 }));
    await act(async () => {});
    expect(calls.find((c) => c.op === 'ai.get')?.args).toEqual({ mediaKey: 'bili:BV1Test01:p2' });
  });
});
