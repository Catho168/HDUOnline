/**
 * B 站字幕 UI 冒烟测试（jsdom + react-dom 客户端渲染，无 JSX、直接 createElement，
 * 照 plan-menu.test.ts 模式；callOp 整体 mock）。
 *
 * 覆盖第 14 轮字幕入口的最小闭环：
 *  1. BiliSubtitlePanel：transcript.get 读 `bili:<bvid>` → 时间+文本列表；点击行
 *     seek 页内 <video>（与续看 chip 同路径）；关闭/空态；
 *  2. BiliCollectApp 字幕入口（FAB）：点击 → bili.subtitle.fetch →
 *     none 弹中性提示（作罢非错误样式）/ ok 弹「字幕已就绪」并打开浮层。
 * 第 15 轮共享化（external 模式）与第 16 轮增强（多 P p 参 / 当前行高亮 / AI 标记）
 * 的用例见各自 describe。
 */

// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({ callOp: vi.fn() }));

import { callOp } from '@/core/shared/client';
import { BiliSubtitlePanel } from '@/entrypoints/content/ui/BiliSubtitlePanel';
import { BiliCollectApp } from '@/entrypoints/content/ui/bili/BiliCollectApp';
import type { TranscriptEntity } from '@/core/shared/types';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;

const TRANSCRIPT: TranscriptEntity = {
  mediaKey: 'bili:BV1Subtitle01',
  segments: [
    { s: 10, e: 14, text: '欢迎来到本节课' },
    { s: 65, e: 70, text: '今天讲第一章' },
  ],
  model: 'bili-official-subtitle',
  lang: 'zh-CN',
  glossaryVersion: 0,
  createdAt: 0,
  source: 'bili-official-subtitle',
};

let calls: Array<{ op: string; args: unknown }> = [];

/** CollectApp 挂载期的既有 op 桩 + 字幕 op 覆盖 */
function stubOps(overrides: Record<string, unknown> = {}): void {
  calls = [];
  const table: Record<string, unknown> = {
    'fav.list': [],
    'folder.list': [],
    'video.progress.get': null,
    'transcript.get': TRANSCRIPT,
    'bili.subtitle.fetch': { status: 'none' },
    ...overrides,
  };
  callOpMock.mockImplementation(async (op: string, args?: unknown) => {
    calls.push({ op, args });
    if (!(op in table)) throw new Error(`unexpected op: ${op}`);
    return table[op];
  });
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

describe('BiliSubtitlePanel 字幕查看浮层', () => {
  it('渲染时间+文本列表；点击行 seek 页内 <video>（不整页跳转）', async () => {
    stubOps();
    const video = document.createElement('video');
    document.body.appendChild(video);
    await renderElement(createElement(BiliSubtitlePanel, { bvid: 'BV1Subtitle01', open: true, onClose: () => {} }));
    await act(async () => {});

    expect(callOpMock).toHaveBeenCalledWith('transcript.get', { mediaKey: 'bili:BV1Subtitle01' });
    const rows = Array.from(host.querySelectorAll<HTMLButtonElement>('.bili-sub-row'));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('00:10');
    expect(rows[0]?.textContent).toContain('欢迎来到本节课');
    // 65s → 1:05（formatClock 分秒口径）
    expect(rows[1]?.textContent).toContain('01:05');

    click(rows[0]!);
    expect(video.currentTime).toBe(10);
    // 页内 seek：不发生 ?t= 整页跳转
    expect(window.location.pathname).toBe('/');
  });

  it('open=false 不渲染；读取失败/无字幕时展示空态文案', async () => {
    stubOps({ 'transcript.get': null });
    await renderElement(createElement(BiliSubtitlePanel, { bvid: 'BV1Subtitle01', open: false, onClose: () => {} }));
    expect(host.querySelector('.bili-modal-backdrop')).toBeNull();

    await renderElement(createElement(BiliSubtitlePanel, { bvid: 'BV1Subtitle01', open: true, onClose: () => {} }));
    await act(async () => {});
    expect(query('.bili-sub-empty').textContent).toContain('尚未获取字幕');
  });

  it('关闭后焦点回归打开前元素（第 279 轮，可访问性域）', async () => {
    stubOps();
    const outside = document.createElement('button');
    outside.textContent = '浮层外按钮';
    document.body.append(outside);
    outside.focus();
    await renderElement(createElement(BiliSubtitlePanel, { bvid: 'BV1Subtitle01', open: true, onClose: () => {} }));
    await act(async () => {});
    // 关闭浮层（open 翻转触发 cleanup：注销归属层并还原焦点）
    await renderElement(createElement(BiliSubtitlePanel, { bvid: 'BV1Subtitle01', open: false, onClose: () => {} }));
    expect(document.activeElement).toBe(outside);
  });

  it('搜索命中词高亮（第 259 轮，跨端一致性）：过滤结果行内命中词渲染 <mark>，清空后恢复原文', async () => {
    stubOps();
    await renderElement(createElement(BiliSubtitlePanel, { bvid: 'BV1Subtitle01', open: true, onClose: () => {} }));
    await act(async () => {});

    const search = host.querySelector<HTMLInputElement>('.bili-sub-search');
    expect(search).toBeTruthy();
    // React 受控输入赋值：走原生 value setter 再派发 input 事件
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(search!, '第一章');
      search!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const marks = host.querySelectorAll('.bili-sub-text mark');
    expect(marks).toHaveLength(1);
    expect(marks[0]?.textContent).toBe('第一章');

    // 清空查询：恢复原文、无 mark
    await act(async () => {
      setter?.call(search!, '');
      search!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.querySelectorAll('.bili-sub-text mark')).toHaveLength(0);
    expect(host.querySelectorAll('.bili-sub-row')).toHaveLength(2);
  });

  it('搜索命中计数（第 261/264/266 轮）：meta 行显示「命中 X / 共 Y 条 · Z 处」，清空后无处数', async () => {
    stubOps();
    await renderElement(createElement(BiliSubtitlePanel, { bvid: 'BV1Subtitle01', open: true, onClose: () => {} }));
    await act(async () => {});

    const search = host.querySelector<HTMLInputElement>('.bili-sub-search');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(search!, '第一章');
      search!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // 计数并入既有 meta 行（第 266 轮修齐：独立 count 行与 meta 计数重复，已移除）
    const meta = host.querySelector('.bili-sub-meta');
    expect(meta?.textContent).toContain('命中 1 / 共 2 条');
    // 按词计（第 264 轮）：「第一章」在 1 段中出现 1 次 → 1 处
    expect(meta?.textContent).toContain('1 处');

    await act(async () => {
      setter?.call(search!, '');
      search!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.querySelector('.bili-sub-meta')?.textContent).not.toContain('处');
  });

  it('清除搜索按钮（第 266 轮，跨端一致性）：有输入时出现 ×，点击清空（高亮与处数随之消失）', async () => {
    stubOps();
    await renderElement(createElement(BiliSubtitlePanel, { bvid: 'BV1Subtitle01', open: true, onClose: () => {} }));
    await act(async () => {});

    const search = host.querySelector<HTMLInputElement>('.bili-sub-search');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(search!, '第一章');
      search!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const clear = host.querySelector<HTMLButtonElement>('.bili-sub-clear');
    expect(clear).toBeTruthy();
    await act(async () => {
      clear!.click();
    });
    expect(search!.value).toBe('');
    expect(host.querySelectorAll('.bili-sub-text mark')).toHaveLength(0);
    expect(host.querySelectorAll('.bili-sub-row')).toHaveLength(2);
    expect(host.querySelector('.bili-sub-clear')).toBeNull();
    // 焦点回归输入框（第 267 轮）：与统一搜索清除按钮同行为
    expect(document.activeElement).toBe(search);
  });

  it('搜索空结果建议（第 263 轮，检索域 / 空态体验）：无命中时显示换词提示', async () => {
    stubOps();
    await renderElement(createElement(BiliSubtitlePanel, { bvid: 'BV1Subtitle01', open: true, onClose: () => {} }));
    await act(async () => {});

    const search = host.querySelector<HTMLInputElement>('.bili-sub-search');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(search!, '不存在的词条');
      search!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const empty = host.querySelector('.bili-sub-empty');
    expect(empty?.textContent).toContain('未找到与「不存在的词条」匹配的字幕');
    expect(empty?.textContent).toContain('试试更短的关键词');
  });
});

describe('BiliSubtitlePanel 共享化（学习中心 external 模式，第 15 轮）', () => {
  it("seekMode='external'：页内即使有 <video> 也不 seek，点击行新标签打开 B 站 ?t= 外链", async () => {
    stubOps();
    // HDU 播放页场景：页内确实存在 <video>（站内播放器），但它与 B 站视频无关
    const video = document.createElement('video');
    document.body.appendChild(video);
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    await renderElement(
      createElement(BiliSubtitlePanel, { bvid: 'BV1Subtitle01', open: true, onClose: () => {}, seekMode: 'external' }),
    );
    await act(async () => {});

    const rows = Array.from(host.querySelectorAll<HTMLButtonElement>('.bili-sub-row'));
    expect(rows).toHaveLength(2);
    click(rows[1]!); // 65s 的句子
    expect(openSpy).toHaveBeenCalledWith('https://www.bilibili.com/video/BV1Subtitle01?t=65', '_blank', 'noopener,noreferrer');
    // 站内播放器绝不能被 seek，也不整页跳转
    expect(video.currentTime).toBe(0);
    expect(window.location.pathname).toBe('/');
  });

  it('打开时注入组件自带样式（.bili-sub-scope 作用域，HDU 侧无 BILI_CSS 也能完整渲染）', async () => {
    stubOps();
    await renderElement(createElement(BiliSubtitlePanel, { bvid: 'BV1Subtitle01', open: true, onClose: () => {} }));
    const css = host.querySelector('style')?.textContent ?? '';
    expect(css).toContain('.bili-sub-scope');
    expect(css).toContain('.bili-sub-row');
    expect(css).toContain('data-theme="dark"]');
  });
});

describe('BiliCollectApp 字幕入口（FAB）', () => {
  it('点击字幕入口发起 bili.subtitle.fetch（URL 无 ?p= 时按 P1）；none 弹中性提示（作罢，非错误样式）', async () => {
    stubOps({ 'bili.subtitle.fetch': { status: 'none' } });
    window.history.replaceState({}, '', '/video/BV1Subtitle01/');
    await renderElement(createElement(BiliCollectApp, null));

    const fab = query('.bili-sub-fab');
    await clickAsync(fab);
    expect(countCalls('bili.subtitle.fetch')).toBe(1);
    expect(calls.find((c) => c.op === 'bili.subtitle.fetch')?.args).toEqual({ bvid: 'BV1Subtitle01', p: 1 });
    const toast = query('.bili-toast');
    expect(toast.textContent).toContain('该视频没有可用字幕');
    // 作罢提示不挂错误样式
    expect(toast.className).not.toContain('is-error');
  });

  it('ok：提示「字幕已就绪」并打开查看浮层，浮层内为字幕列表', async () => {
    stubOps({ 'bili.subtitle.fetch': { status: 'ok', cached: false, segments: 2, lan: 'zh-CN', lanDoc: '中文字幕' } });
    window.history.replaceState({}, '', '/video/BV1Subtitle01/');
    await renderElement(createElement(BiliCollectApp, null));

    await clickAsync(query('.bili-sub-fab'));
    expect(query('.bili-toast').textContent).toContain('字幕已就绪（2 条 · 中文字幕）');
    // 浮层已打开（transcript.get 由浮层发起），列表可读
    expect(countCalls('transcript.get')).toBe(1);
    expect(host.querySelectorAll('.bili-sub-row')).toHaveLength(2);
  });

  it('接口失败：toast 挂 is-error 错误样式并透出 userMessage', async () => {
    calls = [];
    const { AppError } = await import('@/core/shared/errors');
    callOpMock.mockImplementation(async (op: string, args?: unknown) => {
      calls.push({ op, args });
      if (op === 'bili.subtitle.fetch') {
        throw new AppError('BILI_API_FAILED', { userMessage: '请求被 B 站风控拦截，请稍后再试' });
      }
      if (op === 'fav.list' || op === 'folder.list') return [];
      if (op === 'video.progress.get') return null;
      return null;
    });
    window.history.replaceState({}, '', '/video/BV1Subtitle01/');
    await renderElement(createElement(BiliCollectApp, null));

    await clickAsync(query('.bili-sub-fab'));
    const toast = query('.bili-toast');
    expect(toast.textContent).toContain('请求被 B 站风控拦截');
    expect(toast.className).toContain('is-error');
  });

  it('多 P：URL 带 ?p=3 → op 透传 p=3，toast 带分 P（P3），浮层读分 P 键', async () => {
    stubOps({ 'bili.subtitle.fetch': { status: 'ok', cached: false, segments: 2, lan: 'zh-CN', lanDoc: '中文字幕' } });
    window.history.replaceState({}, '', '/video/BV1Subtitle01/?p=3');
    await renderElement(createElement(BiliCollectApp, null));

    await clickAsync(query('.bili-sub-fab'));
    expect(calls.find((c) => c.op === 'bili.subtitle.fetch')?.args).toEqual({ bvid: 'BV1Subtitle01', p: 3 });
    expect(query('.bili-toast').textContent).toContain('字幕已就绪（2 条 · 中文字幕 · P3）');
    // 浮层按分 P 键读取字幕（bili:<bvid>:p3，第 16 轮 mediaKey 多 P 语法）
    expect(callOpMock).toHaveBeenCalledWith('transcript.get', { mediaKey: 'bili:BV1Subtitle01:p3' });
    expect(host.querySelectorAll('.bili-sub-row')).toHaveLength(2);
  });

  it('多 P：URL ?p= 非法（p=0 / 非数字）按 P1 兜底，toast 不带分 P', async () => {
    stubOps({ 'bili.subtitle.fetch': { status: 'ok', cached: false, segments: 2, lan: 'zh-CN', lanDoc: '中文字幕' } });
    window.history.replaceState({}, '', '/video/BV1Subtitle01/?p=abc');
    await renderElement(createElement(BiliCollectApp, null));

    await clickAsync(query('.bili-sub-fab'));
    expect(calls.find((c) => c.op === 'bili.subtitle.fetch')?.args).toEqual({ bvid: 'BV1Subtitle01', p: 1 });
    expect(query('.bili-toast').textContent).toContain('字幕已就绪（2 条 · 中文字幕）');
    expect(callOpMock).toHaveBeenCalledWith('transcript.get', { mediaKey: 'bili:BV1Subtitle01' });
  });
});

describe('BiliCollectApp 当前行高亮接线（第 16 轮包 B）', () => {
  it('打开浮层后监听 <video> timeupdate（节流 500ms）驱动 is-current 高亮', async () => {
    stubOps({ 'bili.subtitle.fetch': { status: 'ok', cached: false, segments: 2, lan: 'zh-CN', lanDoc: '中文字幕' } });
    const video = document.createElement('video');
    document.body.appendChild(video);
    window.history.replaceState({}, '', '/video/BV1Subtitle01/');
    await renderElement(createElement(BiliCollectApp, null));

    await clickAsync(query('.bili-sub-fab'));
    let rows = Array.from(host.querySelectorAll<HTMLButtonElement>('.bili-sub-row'));
    expect(rows).toHaveLength(2);
    // 初始位置 0 在首句之前：无高亮
    expect(rows.every((r) => !r.className.includes('is-current'))).toBe(true);

    // timeupdate → currentTime=12 落在首句（10–14）→ 第一行高亮
    video.currentTime = 12;
    await act(async () => {
      video.dispatchEvent(new Event('timeupdate'));
    });
    await act(async () => {});
    rows = Array.from(host.querySelectorAll<HTMLButtonElement>('.bili-sub-row'));
    expect(rows[0]?.className).toContain('is-current');

    // 节流：紧随的第二发（跨行位置）被 500ms 窗口吸收，高亮不动
    video.currentTime = 66;
    await act(async () => {
      video.dispatchEvent(new Event('timeupdate'));
    });
    await act(async () => {});
    rows = Array.from(host.querySelectorAll<HTMLButtonElement>('.bili-sub-row'));
    expect(rows[0]?.className).toContain('is-current');

    // 跨过节流窗口后的 timeupdate → 第二句（65–70）高亮
    await new Promise((resolve) => setTimeout(resolve, 510));
    await act(async () => {
      video.dispatchEvent(new Event('timeupdate'));
    });
    await act(async () => {});
    rows = Array.from(host.querySelectorAll<HTMLButtonElement>('.bili-sub-row'));
    expect(rows[1]?.className).toContain('is-current');
    expect(rows[0]?.className).not.toContain('is-current');
  }, 10_000);

  it('SPA 替换 <video> 节点后重挂：is-current 高亮跟随新节点（切 P/切清晰度场景）', async () => {
    stubOps({ 'bili.subtitle.fetch': { status: 'ok', cached: false, segments: 2, lan: 'zh-CN', lanDoc: '中文字幕' } });
    const video1 = document.createElement('video');
    document.body.appendChild(video1);
    window.history.replaceState({}, '', '/video/BV1Subtitle01/');
    await renderElement(createElement(BiliCollectApp, null));

    await clickAsync(query('.bili-sub-fab'));
    video1.currentTime = 12;
    await act(async () => {
      video1.dispatchEvent(new Event('timeupdate'));
    });
    await act(async () => {});
    let rows = Array.from(host.querySelectorAll<HTMLButtonElement>('.bili-sub-row'));
    expect(rows[0]?.className).toContain('is-current');

    // B 站 SPA 换节点：旧 <video> 摘除、新节点插入（同一批次，watcher 需重新捕获）
    let video2!: HTMLVideoElement;
    await act(async () => {
      video1.remove();
      video2 = document.createElement('video');
      document.body.appendChild(video2);
    });
    await act(async () => {});

    // 新节点的 timeupdate → 高亮恢复跟随（监听若仍挂在已摘除的旧节点上则不会更新）
    await new Promise((resolve) => setTimeout(resolve, 510));
    video2.currentTime = 66;
    await act(async () => {
      video2.dispatchEvent(new Event('timeupdate'));
    });
    await act(async () => {});
    rows = Array.from(host.querySelectorAll<HTMLButtonElement>('.bili-sub-row'));
    expect(rows[1]?.className).toContain('is-current');
    expect(rows[0]?.className).not.toContain('is-current');
  }, 10_000);

  it('面板关闭即停等待；重开仍能捕获晚就绪的 <video>（SPA 兜底保留）', async () => {
    stubOps({ 'bili.subtitle.fetch': { status: 'ok', cached: false, segments: 2, lan: 'zh-CN', lanDoc: '中文字幕' } });
    // 页面尚无 <video>（晚就绪场景）：浮层可开，但无播放位置 → 无高亮
    window.history.replaceState({}, '', '/video/BV1Subtitle01/');
    await renderElement(createElement(BiliCollectApp, null));

    await clickAsync(query('.bili-sub-fab'));
    let rows = Array.from(host.querySelectorAll<HTMLButtonElement>('.bili-sub-row'));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => !r.className.includes('is-current'))).toBe(true);

    // 关闭面板：等待轮询随清理终止（watcher.stop）
    click(query('.bili-modal-close'));
    await act(async () => {});
    expect(host.querySelector('.bili-sub-scope')).toBeNull();

    // 播放器在关闭之后才出现；重开浮层 → 重新捕获已就绪的 video，高亮恢复
    const video = document.createElement('video');
    document.body.appendChild(video);
    await clickAsync(query('.bili-sub-fab'));
    video.currentTime = 12;
    await act(async () => {
      video.dispatchEvent(new Event('timeupdate'));
    });
    await act(async () => {});
    rows = Array.from(host.querySelectorAll<HTMLButtonElement>('.bili-sub-row'));
    expect(rows[0]?.className).toContain('is-current');
  }, 10_000);
});

describe('BiliSubtitlePanel 当前行高亮与 AI 标记（第 16 轮包 B）', () => {
  it('currentTime 落在 s<=t<e 的行加 is-current；行间隙无高亮；不传 currentTime 无高亮', async () => {
    stubOps();
    await renderElement(
      createElement(BiliSubtitlePanel, { bvid: 'BV1Subtitle01', open: true, onClose: () => {}, currentTime: 12 }),
    );
    await act(async () => {});
    let rows = Array.from(host.querySelectorAll<HTMLButtonElement>('.bili-sub-row'));
    expect(rows[0]?.className).toContain('is-current');
    expect(rows[1]?.className).not.toContain('is-current');

    // 推进播放位置到第二句（65s 行）
    await renderElement(
      createElement(BiliSubtitlePanel, { bvid: 'BV1Subtitle01', open: true, onClose: () => {}, currentTime: 66 }),
    );
    rows = Array.from(host.querySelectorAll<HTMLButtonElement>('.bili-sub-row'));
    expect(rows[0]?.className).not.toContain('is-current');
    expect(rows[1]?.className).toContain('is-current');

    // 行间隙（20s 无字幕）与句尾边界（70s 不含）不高亮
    await renderElement(
      createElement(BiliSubtitlePanel, { bvid: 'BV1Subtitle01', open: true, onClose: () => {}, currentTime: 70 }),
    );
    rows = Array.from(host.querySelectorAll<HTMLButtonElement>('.bili-sub-row'));
    expect(rows.every((row) => !row.className.includes('is-current'))).toBe(true);

    // LearningCenter 宿主不传 currentTime → 无高亮
    await renderElement(createElement(BiliSubtitlePanel, { bvid: 'BV1Subtitle01', open: true, onClose: () => {} }));
    rows = Array.from(host.querySelectorAll<HTMLButtonElement>('.bili-sub-row'));
    expect(rows.every((row) => !row.className.includes('is-current'))).toBe(true);
    // 高亮样式进 PANEL_CSS（.is-current 作用域规则 + 暗色变量）
    const css = host.querySelector('style')?.textContent ?? '';
    expect(css).toContain('.bili-sub-row.is-current');
    expect(css).toContain('--b-accent-soft');
  });

  it('aiSubtitle 缺省（旧数据/本地 ASR）不渲染标记', async () => {
    stubOps();
    await renderElement(
      createElement(BiliSubtitlePanel, { bvid: 'BV1Subtitle01', open: true, onClose: () => {} }),
    );
    await act(async () => {});
    expect(host.querySelector('.bili-sub-ai')).toBeNull();
    // 样式进 PANEL_CSS 作用域（第 16 轮包 B 新增）
    const css = host.querySelector('style')?.textContent ?? '';
    expect(css).toContain('.bili-sub-ai');
  });

  it('aiSubtitle=true 渲染「AI 生成」小标记', async () => {
    const aiTranscript: TranscriptEntity = { ...TRANSCRIPT, aiSubtitle: true };
    stubOps({ 'transcript.get': aiTranscript });
    await renderElement(
      createElement(BiliSubtitlePanel, { bvid: 'BV1Subtitle01', open: true, onClose: () => {} }),
    );
    await act(async () => {});
    const badge = query('.bili-sub-ai');
    expect(badge.textContent).toBe('AI 生成');
  });

  it('p≥2：读分 P 键 bili:<bvid>:p<N>；external 外链带 ?p=N 再跟 &t=', async () => {
    stubOps();
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    await renderElement(
      createElement(BiliSubtitlePanel, {
        bvid: 'BV1Subtitle01',
        p: 2,
        open: true,
        onClose: () => {},
        seekMode: 'external',
      }),
    );
    await act(async () => {});
    expect(callOpMock).toHaveBeenCalledWith('transcript.get', { mediaKey: 'bili:BV1Subtitle01:p2' });

    const rows = Array.from(host.querySelectorAll<HTMLButtonElement>('.bili-sub-row'));
    click(rows[1]!); // 65s 的句子
    expect(openSpy).toHaveBeenCalledWith(
      'https://www.bilibili.com/video/BV1Subtitle01?p=2&t=65',
      '_blank',
      'noopener,noreferrer',
    );
  });
});

describe('BiliSubtitlePanel Tab 圈闭（第 39 轮巡检）', () => {
  function pressTab(shift = false): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    return event;
  }

  it('浮层为栈顶时 Tab 圈闭在浮层内：焦点在外被拉回首元素，末尾回绕、开头回绕', async () => {
    stubOps();
    await renderElement(createElement(BiliSubtitlePanel, { bvid: 'BV1Subtitle01', open: true, onClose: () => {} }));
    await act(async () => {});
    const closeBtn = query<HTMLButtonElement>('.bili-modal-close');
    const rows = Array.from(host.querySelectorAll<HTMLButtonElement>('.bili-sub-row'));
    expect(rows).toHaveLength(2);

    // 焦点在浮层外（宿主容器）→ Tab 被消费并拉回浮层首个可聚焦元素（关闭按钮）
    host.focus();
    const tab = pressTab();
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(closeBtn);

    // 焦点在末行 → Tab 回绕到首元素（关闭按钮）
    rows[rows.length - 1]!.focus();
    expect(pressTab().defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(closeBtn);

    // Shift+Tab 在首元素（关闭按钮）→ 回绕到末元素（最后一行）
    closeBtn.focus();
    expect(pressTab(true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(rows[rows.length - 1]);
  });

  it('浮层关闭（注销归属）后 Tab 不再被浮层圈闭，焦点管理交还宿主', async () => {
    stubOps();
    await renderElement(createElement(BiliSubtitlePanel, { bvid: 'BV1Subtitle01', open: false, onClose: () => {} }));
    // 焦点放在浮层外的真实可聚焦元素上（jsdom 里无 tabindex 的 div focus() 是 no-op）
    const outside = document.createElement('button');
    outside.textContent = '浮层外按钮';
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement).toBe(outside);
    const tab = pressTab();
    expect(tab.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(outside);
  });
});

describe('BiliSubtitlePanel 渐进渲染（第 276 轮，性能域）', () => {
  it('超长转写先渲染 200 段，「显示更多」追加剩余；换查询词重置窗口', async () => {
    const segments = Array.from({ length: 250 }, (_, i) => ({ s: i * 10, e: i * 10 + 9, text: `第 ${i} 句` }));
    stubOps({
      'transcript.get': {
        mediaKey: 'bili:BV1Subtitle01',
        segments,
        model: 'bili-official-subtitle',
        lang: 'zh-CN',
        glossaryVersion: 0,
        createdAt: 0,
        source: 'bili-official-subtitle',
      },
    });
    await renderElement(createElement(BiliSubtitlePanel, { bvid: 'BV1Subtitle01', open: true, onClose: () => {} }));
    await act(async () => {});

    expect(host.querySelectorAll('.bili-sub-row')).toHaveLength(200);
    const more = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      b.textContent?.includes('还有 50 段'),
    );
    expect(more?.textContent).toContain('还有 50 段');
    await act(async () => {
      more!.click();
    });
    expect(host.querySelectorAll('.bili-sub-row')).toHaveLength(250);

    // 换查询词：过滤结果变化 → 渐进窗口重置（「第 1 句」仅精确命中 1 段）
    const search = host.querySelector<HTMLInputElement>('.bili-sub-search');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(search!, '第 1 句');
      search!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.querySelectorAll('.bili-sub-row')).toHaveLength(1);
    expect(host.textContent).not.toContain('还有');
  });

  it('定位当前句按钮（第 295 轮，体验域）：当前行滚入视野；无当前句不渲染', async () => {
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    // 首段从 s=30 起：currentTime=3 落在片头间隙（无当前句）
    const segments = Array.from({ length: 250 }, (_, i) => ({ s: 30 + i * 10, e: 30 + i * 10 + 9, text: `第 ${i} 句` }));
    stubOps({
      'transcript.get': {
        mediaKey: 'bili:BV1Subtitle01',
        segments,
        model: 'bili-official-subtitle',
        lang: 'zh-CN',
        glossaryVersion: 0,
        createdAt: 0,
        source: 'bili-official-subtitle',
      },
    });
    // currentTime = 1500 → 命中 index 147（已渲染）
    await renderElement(
      createElement(BiliSubtitlePanel, { bvid: 'BV1Subtitle01', open: true, currentTime: 1500, onClose: () => {} }),
    );
    await act(async () => {});
    const locate = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent === '定位当前句',
    );
    expect(locate).toBeTruthy();
    await act(async () => {
      locate!.click();
    });
    // rAF 回调在 jsdom 下一帧执行：等一拍再断言
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(scrollSpy).toHaveBeenCalled();
    expect(scrollSpy.mock.calls[0]?.[0]).toEqual({ block: 'center' });

    // 无当前句（currentTime=3 落在片头间隙）：定位按钮不渲染
    await renderElement(
      createElement(BiliSubtitlePanel, { bvid: 'BV1Subtitle01', open: true, currentTime: 3, onClose: () => {} }),
    );
    await act(async () => {});
    expect(
      Array.from(host.querySelectorAll<HTMLButtonElement>('button')).some((b) => b.textContent === '定位当前句'),
    ).toBe(false);
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });
});
