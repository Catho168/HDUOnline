/**
 * B 站学习助手（第 24 轮功能扩展第一批）单测：
 *  1) 纯逻辑（core/bili/assistant，node 语义直测）：分 P 参数解析回退、
 *     时间点收藏 payload 组装、字幕搜索过滤、当前行下标、问答可用性判定；
 *  2) UI 冒烟（jsdom + react-dom 客户端渲染，无 JSX、直接 createElement，
 *     照 bili-subtitle-panel.test.ts 模式；callOp/onBackgroundEvent 整体 mock）：
 *     字幕搜索过滤/空态/seek、问答面板无字幕空态/发起 qa.ask/分 P mediaKey/
 *     流式事件终稿/收藏此时刻回调。
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
import { AppError } from '@/core/shared/errors';
import {
  biliQaAskErrorText,
  buildAiFavorite,
  buildMomentFavorite,
  currentSegmentIndex,
  filterTranscriptSegments,
  parseBiliPageParam,
  qaAvailability,
  QA_NO_SUBTITLE_MESSAGE,
} from '@/core/bili/assistant';
import { BiliSubtitlePanel } from '@/entrypoints/content/ui/BiliSubtitlePanel';
import { BiliQaPanel } from '@/entrypoints/content/ui/BiliQaPanel';
import type { ChatMessageEntity, TranscriptEntity, TranscriptSegment } from '@/core/shared/types';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;
const onEventMock = onBackgroundEvent as unknown as Mock;

// ───────────────────────── 纯逻辑 ─────────────────────────

describe('parseBiliPageParam 分 P 参数解析（原 readBiliPageP 口径）', () => {
  it('合法值：1–4 位十进制且 ≥1 原样返回', () => {
    expect(parseBiliPageParam('1')).toBe(1);
    expect(parseBiliPageParam('3')).toBe(3);
    expect(parseBiliPageParam('9999')).toBe(9999);
    expect(parseBiliPageParam('007')).toBe(7); // 前导零经 Number 归一
  });

  it('非法/缺省回退 P1：空串、null、0、负数、非数字、超长数字串、0x/1e 记法', () => {
    expect(parseBiliPageParam('')).toBe(1);
    expect(parseBiliPageParam(null)).toBe(1);
    expect(parseBiliPageParam(undefined)).toBe(1);
    expect(parseBiliPageParam('0')).toBe(1);
    expect(parseBiliPageParam('abc')).toBe(1);
    expect(parseBiliPageParam('12345')).toBe(1); // 超 4 位：防 Number 精度/1e+21 形状
    expect(parseBiliPageParam('0x2')).toBe(1);
    expect(parseBiliPageParam('1e2')).toBe(1);
    expect(parseBiliPageParam('-1')).toBe(1);
    expect(parseBiliPageParam('1.5')).toBe(1);
  });
});

describe('buildMomentFavorite 时间点收藏 payload 组装', () => {
  const BASE = { id: 'fav-1', bvid: 'BV1Test01', title: '测试视频标题', currentTime: 12.7, url: 'https://www.bilibili.com/video/BV1Test01/', now: 1700000000000 };

  it('type=time、anchorTime 向下取整、标题带「标题 · 时刻」（命名惯例同 HDU addTimeFavorite）', () => {
    const fav = buildMomentFavorite({ ...BASE, p: 1 });
    expect(fav.type).toBe('time');
    expect(fav.anchorTime).toBe(12);
    expect(fav.snapshot.title).toBe('测试视频标题 · 00:12');
    expect(fav.snapshot.content).toContain('00:12');
    expect(fav.folderId).toBeNull();
    expect(fav.tags).toEqual([]);
    expect(fav.pinned).toBe(false);
    expect(fav.favoritedAt).toBe(BASE.now);
    expect(fav.metadata?.platform).toBe('bilibili');
    expect(fav.metadata?.bvid).toBe('BV1Test01');
  });

  it('P1 不带 p 字段且 mediaKey 为裸键；p≥2 metadata 带分 P 与分 P 键', () => {
    const p1 = buildMomentFavorite({ ...BASE, p: 1 });
    expect(p1.metadata?.mediaKey).toBe('bili:BV1Test01');
    expect(p1.metadata?.p).toBeUndefined();

    const p3 = buildMomentFavorite({ ...BASE, p: 3 });
    expect(p3.metadata?.p).toBe(3);
    expect(p3.metadata?.mediaKey).toBe('bili:BV1Test01:p3');
    expect(p3.snapshot.content).toContain('P3');
  });

  it('非法 currentTime 钳制为 0；负值不产生负锚点', () => {
    const fav = buildMomentFavorite({ ...BASE, currentTime: -5 });
    expect(fav.anchorTime).toBe(0);
  });
});

describe('buildAiFavorite AI 回答收藏 payload 组装（第 33 轮）', () => {
  const CHAT = { chatId: 'c1', question: '函数是什么意思', answer: '这是一个测试答案', anchorTime: 12.7, groupId: 'g1' };
  const BASE = {
    id: 'fav-ai-1',
    bvid: 'BV1Test01',
    title: '测试视频标题',
    chat: CHAT,
    url: 'https://www.bilibili.com/video/BV1Test01/',
    now: 1700000000000,
  };

  it('type=ai、refId=chatId、标题=回答摘要（36 字）、content=回答全文，字段口径同 HDU favoriteChat', () => {
    const fav = buildAiFavorite({ ...BASE });
    expect(fav.type).toBe('ai');
    expect(fav.refId).toBe('c1');
    expect(fav.snapshot.title).toBe('这是一个测试答案');
    expect(fav.snapshot.content).toBe('这是一个测试答案');
    expect(fav.anchorTime).toBe(12);
    expect(fav.folderId).toBeNull();
    expect(fav.tags).toEqual([]);
    expect(fav.pinned).toBe(false);
    expect(fav.favoritedAt).toBe(BASE.now);
  });

  it('metadata 带 platform/bvid/mediaKey/url/videoTitle/question/groupId；P1 省略 p（裸键口径）', () => {
    const fav = buildAiFavorite({ ...BASE, p: 1 });
    expect(fav.metadata).toEqual({
      platform: 'bilibili',
      bvid: 'BV1Test01',
      mediaKey: 'bili:BV1Test01',
      url: BASE.url,
      videoTitle: '测试视频标题',
      question: '函数是什么意思',
      groupId: 'g1',
    });
  });

  it('p≥2 metadata 带分 P 与分 P mediaKey 键', () => {
    const fav = buildAiFavorite({ ...BASE, p: 2 });
    expect(fav.metadata?.p).toBe(2);
    expect(fav.metadata?.mediaKey).toBe('bili:BV1Test01:p2');
  });

  it('回答超长时标题截断到 36 字（含省略号）；缺 groupId 不落该键；非法锚点不落 anchorTime', () => {
    const long = 'x'.repeat(50);
    const fav = buildAiFavorite({
      ...BASE,
      chat: { ...CHAT, answer: long, anchorTime: -3, groupId: undefined },
    });
    expect(fav.snapshot.title).toBe(`${'x'.repeat(35)}…`);
    expect(fav.snapshot.content).toBe(long);
    expect('anchorTime' in fav).toBe(false);
    expect(fav.metadata?.groupId).toBeUndefined();
    expect('groupId' in (fav.metadata ?? {})).toBe(false);
  });
});

describe('filterTranscriptSegments 字幕搜索过滤', () => {
  const SEGMENTS: TranscriptSegment[] = [
    { s: 10, e: 14, text: '欢迎来到本节课' },
    { s: 65, e: 70, text: '今天讲第一章 Function' },
    { s: 120, e: 126, text: '函数的定义与性质' },
    { s: 200, e: 205, text: '再举一个函数的例子' },
  ];

  it('命中：大小写不敏感子串匹配，保留原段引用', () => {
    const hits = filterTranscriptSegments(SEGMENTS, 'function');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.text).toBe('今天讲第一章 Function');

    expect(filterTranscriptSegments(SEGMENTS, '函数')).toHaveLength(2);
  });

  it('无结果：返回空数组', () => {
    expect(filterTranscriptSegments(SEGMENTS, '不存在的关键词')).toEqual([]);
  });

  it('空查询/纯空白：返回全部段的副本（不过滤）', () => {
    expect(filterTranscriptSegments(SEGMENTS, '')).toHaveLength(4);
    expect(filterTranscriptSegments(SEGMENTS, '   ')).toHaveLength(4);
    // 副本而非原数组：避免调用方误改共享状态
    const all = filterTranscriptSegments(SEGMENTS, '');
    expect(all).not.toBe(SEGMENTS);
    expect(all[0]).toBe(SEGMENTS[0]);
  });
});

describe('currentSegmentIndex 当前行下标', () => {
  const SEGMENTS: TranscriptSegment[] = [
    { s: 10, e: 14, text: 'a' },
    { s: 65, e: 70, text: 'b' },
  ];

  it('s<=t<e 命中对应行；行间隙与句尾边界不高亮', () => {
    expect(currentSegmentIndex(SEGMENTS, 12)).toBe(0);
    expect(currentSegmentIndex(SEGMENTS, 66)).toBe(1);
    expect(currentSegmentIndex(SEGMENTS, 20)).toBe(-1); // 间隙
    expect(currentSegmentIndex(SEGMENTS, 70)).toBe(-1); // e 不含
    expect(currentSegmentIndex(SEGMENTS, 5)).toBe(-1); // 片头
  });

  it('未传 currentTime（undefined/非数值）不高亮', () => {
    expect(currentSegmentIndex(SEGMENTS, undefined)).toBe(-1);
    expect(currentSegmentIndex(SEGMENTS, Number.NaN)).toBe(-1);
  });
});

describe('qaAvailability 问答可用性判定', () => {
  const TRANSCRIPT: TranscriptEntity = {
    mediaKey: 'bili:BV1Test01',
    segments: [{ s: 0, e: 5, text: 'hello' }],
    model: 'bili-official-subtitle',
    lang: 'zh-CN',
    glossaryVersion: 0,
    createdAt: 0,
    source: 'bili-official-subtitle',
  };

  it('有 transcript 且有段落 → 可用', () => {
    expect(qaAvailability(TRANSCRIPT)).toEqual({ available: true, message: '' });
  });

  it('无 transcript / 空段落 → 不可用，给友好空态文案（不发请求）', () => {
    expect(qaAvailability(null)).toEqual({ available: false, message: QA_NO_SUBTITLE_MESSAGE });
    expect(qaAvailability(undefined)).toEqual({ available: false, message: QA_NO_SUBTITLE_MESSAGE });
    expect(qaAvailability({ ...TRANSCRIPT, segments: [] }).available).toBe(false);
    expect(qaAvailability({ ...TRANSCRIPT, segments: [] }).message).toContain('暂无可用字幕');
  });
});

describe('biliQaAskErrorText qa.ask 失败文案映射（第 27 轮 P2-1）', () => {
  it('转写缺失类错误（SW 的 HDU 话术）映射为 B 站「暂无可用字幕」口径', () => {
    const missing = new AppError('INVALID_INPUT', { userMessage: '本节还没有转写文本，请先生成转写后再提问' });
    expect(biliQaAskErrorText(missing)).toBe(QA_NO_SUBTITLE_MESSAGE);

    const empty = new AppError('INVALID_INPUT', {
      userMessage: '本节转写没有产出有效文字（可能是静音、当前机位没有声音）。请确认音源后重新生成字幕后重试',
    });
    expect(biliQaAskErrorText(empty)).toBe(QA_NO_SUBTITLE_MESSAGE);
  });

  it('其余错误统一走兜底文案（第 222 轮收紧；第 255 轮兜底补「提问」语境词）：LLM 未配置 / 限流走 AppError 话术，普通 Error / 非 Error 异常值走语境化兜底', () => {
    expect(biliQaAskErrorText(new AppError('LLM_NO_PROVIDER'))).toBe('尚未配置 AI 服务，请在设置中添加');
    expect(biliQaAskErrorText(new AppError('LLM_RATE_LIMITED'))).toBe('AI 服务限流，请稍后重试');
    expect(biliQaAskErrorText(new Error('rpc down'))).toBe('提问失败，请稍后重试');
    expect(biliQaAskErrorText(undefined)).toBe('提问失败，请稍后重试');
  });
});

// ───────────────────────── UI 冒烟 ─────────────────────────

const TRANSCRIPT: TranscriptEntity = {
  mediaKey: 'bili:BV1Test01',
  segments: [
    { s: 10, e: 14, text: '欢迎来到本节课' },
    { s: 65, e: 70, text: '今天讲第一章 Function' },
    { s: 120, e: 126, text: '函数的定义与性质' },
    { s: 200, e: 205, text: '再举一个函数的例子' },
  ],
  model: 'bili-official-subtitle',
  lang: 'zh-CN',
  glossaryVersion: 0,
  createdAt: 0,
  source: 'bili-official-subtitle',
};

const USER_MSG: ChatMessageEntity = {
  id: 'u1',
  mediaKey: 'bili:BV1Test01',
  groupId: 'g1',
  role: 'user',
  content: '函数是什么意思',
  anchorTime: 12,
  status: 'done',
  createdAt: 1,
};

const AI_FINAL: ChatMessageEntity = {
  id: 'c1',
  mediaKey: 'bili:BV1Test01',
  groupId: 'g1',
  role: 'ai',
  content: '这是一个测试答案',
  anchorTime: 12,
  status: 'done',
  createdAt: 2,
};

let calls: Array<{ op: string; args: unknown }> = [];

/** QA 面板挂载期 op 桩（字幕搜索用例如需 transcript 桩可覆盖） */
function stubOps(overrides: Record<string, unknown> = {}): void {
  calls = [];
  const table: Record<string, unknown> = {
    'transcript.get': TRANSCRIPT,
    'qa.groups': [],
    'qa.list': [],
    'qa.ask': { chatId: 'c1', groupId: 'g1' },
    ...overrides,
  };
  callOpMock.mockImplementation(async (op: string, args?: unknown) => {
    calls.push({ op, args });
    if (!(op in table)) throw new Error(`unexpected op: ${op}`);
    return table[op];
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

/** 受控 input 输入（React 18 需走原生 value setter + input 事件） */
function type(el: Element, text: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function query<T extends Element>(selector: string): T {
  const el = host.querySelector<T>(selector);
  if (!el) throw new Error(`element not found: ${selector}`);
  return el;
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

describe('BiliSubtitlePanel 字幕搜索（第 24 轮功能扩展第一批）', () => {
  it('搜索框按关键词过滤行；meta 显示命中/总数；清空恢复全部', async () => {
    stubOps();
    await renderElement(createElement(BiliSubtitlePanel, { bvid: 'BV1Test01', open: true, onClose: () => {} }));
    await act(async () => {});
    expect(host.querySelectorAll('.bili-sub-row')).toHaveLength(4);

    const input = query('.bili-sub-search');
    type(input, '函数');
    await act(async () => {});
    let rows = Array.from(host.querySelectorAll('.bili-sub-row'));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.textContent).join('')).toContain('函数的定义与性质');
    expect(query('.bili-sub-meta').textContent).toContain('命中 2 / 共 4 条');

    // 大小写不敏感
    type(input, 'FUNCTION');
    await act(async () => {});
    rows = Array.from(host.querySelectorAll('.bili-sub-row'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('今天讲第一章');

    // 清空恢复全部
    type(input, '');
    await act(async () => {});
    expect(host.querySelectorAll('.bili-sub-row')).toHaveLength(4);
    expect(query('.bili-sub-meta').textContent).toContain('4 条');
  });

  it('无命中给友好空态；点击过滤后的行仍按页内 seek 跳转', async () => {
    stubOps();
    const video = document.createElement('video');
    document.body.appendChild(video);
    await renderElement(createElement(BiliSubtitlePanel, { bvid: 'BV1Test01', open: true, onClose: () => {} }));
    await act(async () => {});

    const input = query('.bili-sub-search');
    type(input, '不存在的词');
    await act(async () => {});
    expect(host.querySelectorAll('.bili-sub-row')).toHaveLength(0);
    expect(query('.bili-sub-empty').textContent).toContain('未找到与「不存在的词」匹配的字幕');

    // 过滤后行序变化，点击命中行仍 seek 到该句起点
    type(input, '函数');
    await act(async () => {});
    const rows = Array.from(host.querySelectorAll<HTMLButtonElement>('.bili-sub-row'));
    click(rows[0]!);
    expect(video.currentTime).toBe(120);

    // 搜索样式进组件自带样式（作用域限定 .bili-sub-scope）
    const css = host.querySelector('style')?.textContent ?? '';
    expect(css).toContain('.bili-sub-search');
  });
});

describe('BiliQaPanel 问答面板（第 24 轮功能扩展第一批）', () => {
  it('无官方字幕：面板打开给友好空态，不渲染输入框、不发起 qa.ask', async () => {
    stubOps({ 'transcript.get': null });
    await renderElement(
      createElement(BiliQaPanel, { bvid: 'BV1Test01', open: true, onClose: () => {}, readPageP: () => 1, onFavoriteMoment: () => {} }),
    );
    await act(async () => {});

    expect(callOpMock).toHaveBeenCalledWith('transcript.get', { mediaKey: 'bili:BV1Test01' });
    expect(query('.bili-qa-empty').textContent).toContain('该视频暂无可用字幕，无法基于内容问答');
    expect(host.querySelector('.bili-qa-composer')).toBeNull();
    expect(countCalls('qa.ask')).toBe(0);
    // 收藏此时刻入口在无字幕时仍可用
    expect(host.querySelector('.bili-qa-moment')).not.toBeNull();
  });

  it('有字幕：提问经 qa.ask 流式发起（anchorTime 取 <video> 当前时间），渲染会话消息', async () => {
    stubOps({
      'qa.ask': { chatId: 'c1', groupId: 'g1' },
      'qa.list': [USER_MSG, { ...AI_FINAL, status: 'streaming', content: '' }],
    });
    const video = document.createElement('video');
    video.currentTime = 12.7;
    document.body.appendChild(video);
    await renderElement(
      createElement(BiliQaPanel, { bvid: 'BV1Test01', open: true, onClose: () => {}, readPageP: () => 1, onFavoriteMoment: () => {} }),
    );
    await act(async () => {});

    const input = query('.bili-qa-composer input');
    type(input, '函数是什么意思');
    await clickAsync(query('.bili-qa-send'));

    expect(countCalls('qa.ask')).toBe(1);
    expect(calls.find((c) => c.op === 'qa.ask')?.args).toEqual({
      mediaKey: 'bili:BV1Test01',
      question: '函数是什么意思',
      anchorTime: 12,
      groupId: undefined,
      // 第 27 轮：面板随 qa.ask 携带 per-request 档位（未切换时即全局设置默认 medium）
      windowPreset: 'medium',
    });
    expect(calls.find((c) => c.op === 'qa.list')?.args).toEqual({ mediaKey: 'bili:BV1Test01', groupId: 'g1' });
    const body = query('.bili-qa-body').textContent ?? '';
    expect(body).toContain('函数是什么意思');
    expect(body).toContain('生成中…');
  });

  it('QA_DONE 事件到达后以终稿替换流式占位', async () => {
    stubOps({
      'qa.ask': { chatId: 'c1', groupId: 'g1' },
      'qa.list': [USER_MSG, { ...AI_FINAL, status: 'streaming', content: '' }],
    });
    await renderElement(
      createElement(BiliQaPanel, { bvid: 'BV1Test01', open: true, onClose: () => {}, readPageP: () => 1, onFavoriteMoment: () => {} }),
    );
    await act(async () => {});
    type(query('.bili-qa-composer input'), '函数是什么意思');
    await clickAsync(query('.bili-qa-send'));
    expect(query('.bili-qa-body').textContent).toContain('生成中…');

    // 模拟 SW 推送 QA_DONE（ask 设置 activeGroupId 后订阅 effect 重挂，取最新回调）
    const cb = onEventMock.mock.calls.at(-1)?.[0] as ((event: unknown) => void) | undefined;
    expect(cb).toBeTypeOf('function');
    await act(async () => {
      cb?.({ name: 'QA_DONE', data: { chatId: 'c1', message: AI_FINAL } });
    });
    const body = query('.bili-qa-body').textContent ?? '';
    expect(body).toContain('这是一个测试答案');
    expect(body).not.toContain('生成中…');
  });

  it('分 P：readPageP 返回 2 → qa.ask/qa.list 用分 P 键，meta 带 P2', async () => {
    stubOps({
      'qa.ask': { chatId: 'c1', groupId: 'g1' },
      'qa.list': [USER_MSG, AI_FINAL],
    });
    await renderElement(
      createElement(BiliQaPanel, { bvid: 'BV1Test01', open: true, onClose: () => {}, readPageP: () => 2, onFavoriteMoment: () => {} }),
    );
    await act(async () => {});
    expect(query('.bili-qa-meta').textContent).toContain('P2');
    expect(callOpMock).toHaveBeenCalledWith('transcript.get', { mediaKey: 'bili:BV1Test01:p2' });

    type(query('.bili-qa-composer input'), '继续问');
    await clickAsync(query('.bili-qa-send'));
    expect(calls.find((c) => c.op === 'qa.ask')?.args).toMatchObject({ mediaKey: 'bili:BV1Test01:p2' });
    expect(calls.find((c) => c.op === 'qa.list')?.args).toEqual({ mediaKey: 'bili:BV1Test01:p2', groupId: 'g1' });
  });

  it('immediate（锚点窗口无字幕的不足提示）：答案直接落定，不进流式态', async () => {
    stubOps({
      'qa.ask': { chatId: 'c9', groupId: 'g1', immediate: true },
      'qa.list': [USER_MSG, { ...AI_FINAL, id: 'c9', content: '当前时间点 附近还没有字幕', insufficient: true }],
    });
    await renderElement(
      createElement(BiliQaPanel, { bvid: 'BV1Test01', open: true, onClose: () => {}, readPageP: () => 1, onFavoriteMoment: () => {} }),
    );
    await act(async () => {});
    type(query('.bili-qa-composer input'), '问题');
    await clickAsync(query('.bili-qa-send'));

    const body = query('.bili-qa-body').textContent ?? '';
    expect(body).toContain('附近还没有字幕');
    expect(body).not.toContain('生成中…');
    // 发送按钮恢复可点（未处于流式态）
    expect((query('.bili-qa-send') as HTMLButtonElement).disabled).toBe(false);
  });

  it('工具行「收藏此时刻」点击回调宿主 onFavoriteMoment', async () => {
    stubOps();
    const onFavoriteMoment = vi.fn();
    await renderElement(
      createElement(BiliQaPanel, { bvid: 'BV1Test01', open: true, onClose: () => {}, readPageP: () => 1, onFavoriteMoment }),
    );
    await act(async () => {});
    click(query('.bili-qa-moment'));
    expect(onFavoriteMoment).toHaveBeenCalledTimes(1);
  });

  it('AI 回答「收藏」按钮（第 33 轮）：点击回调 onFavoriteChat 携带问答载荷，成功后置灰防重', async () => {
    stubOps({ 'qa.groups': [{ groupId: 'g1' }], 'qa.list': [USER_MSG, AI_FINAL] });
    const onFavoriteChat = vi.fn(async () => {});
    const onToast = vi.fn();
    await renderElement(
      createElement(BiliQaPanel, {
        bvid: 'BV1Test01',
        open: true,
        onClose: () => {},
        readPageP: () => 1,
        onFavoriteMoment: () => {},
        onFavoriteChat,
        onToast,
      }),
    );
    await act(async () => {});
    const favBtn = host.querySelector<HTMLButtonElement>('.bili-qa-fav');
    expect(favBtn).not.toBeNull();
    await clickAsync(favBtn!);
    expect(onFavoriteChat).toHaveBeenCalledTimes(1);
    expect(onFavoriteChat).toHaveBeenCalledWith({
      chatId: 'c1',
      question: '函数是什么意思',
      answer: '这是一个测试答案',
      anchorTime: 12,
      groupId: 'g1',
    });
    // 已收藏：按钮置灰（disabled），重复点击不再触发回调（宿主侧另有 refId 复核兜底）
    expect(favBtn!.disabled).toBe(true);
    await clickAsync(favBtn!);
    expect(onFavoriteChat).toHaveBeenCalledTimes(1);
  });

  it('AI 回答收藏失败（宿主返回 false）不置已收藏，按钮可重试（第 34 轮 P3-1）', async () => {
    stubOps({ 'qa.groups': [{ groupId: 'g1' }], 'qa.list': [USER_MSG, AI_FINAL] });
    const onFavoriteChat = vi.fn(async () => false);
    const onToast = vi.fn();
    await renderElement(
      createElement(BiliQaPanel, {
        bvid: 'BV1Test01',
        open: true,
        onClose: () => {},
        readPageP: () => 1,
        onFavoriteMoment: () => {},
        onFavoriteChat,
        onToast,
      }),
    );
    await act(async () => {});
    const favBtn = host.querySelector<HTMLButtonElement>('.bili-qa-fav');
    expect(favBtn).not.toBeNull();
    await clickAsync(favBtn!);
    expect(onFavoriteChat).toHaveBeenCalledTimes(1);
    // 失败：chatId 不入已收藏集合 → 按钮不置灰，可再次点击重试
    expect(favBtn!.disabled).toBe(false);
    await clickAsync(favBtn!);
    expect(onFavoriteChat).toHaveBeenCalledTimes(2);
  });

  it('笔记「转收藏」按钮（第 33 轮）：点击回调 onConvertNote 携带笔记 id', async () => {
    const note = { id: 'n1', mediaKey: 'bili:BV1Test01', anchorTime: 30, text: '重点：交换律不成立', createdAt: 1, updatedAt: 1 };
    stubOps({ 'note.list': [note] });
    const onConvertNote = vi.fn(async () => {});
    await renderElement(
      createElement(BiliQaPanel, {
        bvid: 'BV1Test01',
        open: true,
        onClose: () => {},
        readPageP: () => 1,
        onFavoriteMoment: () => {},
        onConvertNote,
      }),
    );
    await act(async () => {});
    // 切到笔记页签（note.list 轮询随即按当前 mediaKey 拉取）
    const notesTab = Array.from(host.querySelectorAll<HTMLButtonElement>('.bili-qa-tab')).find(
      (b) => b.textContent === '笔记',
    );
    await clickAsync(notesTab!);
    await act(async () => {});
    const convertBtn = host.querySelector<HTMLButtonElement>('.bili-note-convert');
    expect(convertBtn).not.toBeNull();
    await clickAsync(convertBtn!);
    expect(onConvertNote).toHaveBeenCalledTimes(1);
    expect(onConvertNote).toHaveBeenCalledWith('n1');
  });
});
