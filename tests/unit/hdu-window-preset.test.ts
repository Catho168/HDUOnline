/**
 * 第 29 轮 HDU parity 小包单测：
 *  1) HDU PlayPanel 窗口档位 chips（jsdom，uiStore actions 打桩）：
 *     - 初值同步取 uiStore.settings.contextWindow（全局设置，无异步竞态）；
 *     - 未点选时跟随全局设置；点选后 qa.ask（actions.ask）与 ai.generate
 *       （actions.generateAi）携带所选档位（per-request windowPreset）；
 *     - 「已交互不覆盖」：点选后全局设置异步刷新（store patch）不回填所选档；
 *  2) 两面板共享组件一致性：BiliQaPanel 与 PlayPanel 的档位 chips 来自同一共享
 *     WindowPresetChips——档位选项契约一致（小/中/大）、受控选中态一致，
 *     皮肤类名按面板区分（bili-qa-window-chip / hdu-window-chip）；
 *  3) errorTextOf 用户可见路径（第 29 轮 err.message 清尾）：
 *     - LearningCenter 数据加载失败、dashboard 导出失败、options 测试连接失败：
 *       AppError 显示 userMessage，非 Error 异常值显示语境化兜底文案。
 *
 * 模式照 bili-polish.test.ts / two-step-confirm.test.ts：react-dom 客户端渲染，
 * 无 JSX 直接 createElement；callOp 整体 mock（op → 返回值查表桩）。
 */
// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({
  callOp: vi.fn(),
  onBackgroundEvent: vi.fn(() => () => undefined),
}));

// settings 用 importOriginal 展开真模块（storage.ts 在非扩展环境自动退化为内存实现，
// 模块加载无 chrome 依赖），仅把 loadSettings 换成可编程桩（BiliQaPanel 初值读取用）
vi.mock('@/core/shared/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/shared/settings')>();
  return { ...actual, loadSettings: vi.fn() };
});

import { callOp } from '@/core/shared/client';
import { loadSettings } from '@/core/shared/settings';
import { AppError } from '@/core/shared/errors';
import { DEFAULT_SETTINGS } from '@/core/shared/constants';
import type { ContextWindowPreset, SecretsStore, SessionMeta, TranscriptEntity } from '@/core/shared/types';
import { PlayPanel } from '@/entrypoints/content/ui/PlayPanel';
import { BiliQaPanel } from '@/entrypoints/content/ui/BiliQaPanel';
import { LearningCenter } from '@/entrypoints/content/ui/LearningCenter';
import { Data } from '@/entrypoints/dashboard/App';
import { AiSection } from '@/entrypoints/options/App';
import { uiStore } from '@/entrypoints/content/ui/store';
import { WINDOW_PRESET_OPTIONS } from '@/entrypoints/content/ui/WindowPresetChips';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;
const loadSettingsMock = loadSettings as unknown as Mock;

// ───────────────────────── 测试数据 ─────────────────────────

const SESSION: SessionMeta = {
  courId: 9001,
  teclId: 77,
  courseName: '高等数学（上）',
  teacherNames: ['张三'],
  durationSec: 600,
  views: [],
  courLabel: '第1节课',
};

const HDU_TRANSCRIPT: TranscriptEntity = {
  mediaKey: 'hdu:9001',
  courId: 9001,
  segments: [{ s: 0, e: 5, text: 'hello' }],
  model: 'whisper-small',
  lang: 'zh',
  glossaryVersion: 0,
  createdAt: 0,
  source: 'local-asr',
};

const BILI_TRANSCRIPT: TranscriptEntity = {
  mediaKey: 'bili:BV1Parity01',
  segments: [{ s: 0, e: 5, text: 'hello' }],
  model: 'bili-official-subtitle',
  lang: 'zh-CN',
  glossaryVersion: 0,
  createdAt: 0,
  source: 'bili-official-subtitle',
};

const SECRETS: SecretsStore = {
  providers: [
    { id: 'p-1', label: 'DeepSeek', kind: 'openai-chat', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: 'sk-1' },
  ],
  activeProviderId: 'p-1',
  allowLocalEndpoints: false,
  modelSource: { remoteHost: 'hf-mirror.com' },
  userGlossary: {},
};

// ───────────────────────── 挂载辅助 ─────────────────────────

let host: HTMLElement;
let root: Root;

async function renderElement(el: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => {
    root.render(el);
  });
}

/** 等一轮微任务/ effect（Promise 链落定后断言） */
async function flush(): Promise<void> {
  await act(async () => {});
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

function buttonByText(label: string, selector = 'button'): HTMLButtonElement {
  const btn = Array.from(host.querySelectorAll<HTMLButtonElement>(selector)).find((b) => b.textContent === label);
  if (!btn) throw new Error(`button not found: ${label}`);
  return btn;
}

/** 触发 React 受控 textarea 的 onChange（原生 setter + input 事件） */
function typeTextarea(el: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** HDU 档位 chips（hdu 皮肤类名） */
function hduChips(): HTMLButtonElement[] {
  return Array.from(host.querySelectorAll<HTMLButtonElement>('.hdu-window-chip'));
}

/** B 站档位 chips（bili 皮肤类名） */
function biliChips(): HTMLButtonElement[] {
  return Array.from(host.querySelectorAll<HTMLButtonElement>('.bili-qa-window-chip'));
}

// ───────────────────────── PlayPanel 打桩 ─────────────────────────

const askSpy = vi.fn(async () => {});
const generateAiSpy = vi.fn(async () => {});

function stubUiActions(): void {
  uiStore.bindActions({
    ask: askSpy,
    generateAi: generateAiSpy,
    // 页签切换走 store patch，保证点击 .hdu-panel-tab 后目标页签真实渲染
    setPanelTab: (tab) => uiStore.patch({ panelTab: tab }),
  });
}

/** 面板可见态：全局档位可指定，transcript 有内容（问答/标注页签进入可交互分支） */
function patchPlayState(contextWindow: ContextWindowPreset): void {
  uiStore.patch({
    ready: true,
    panelOpen: true,
    panelTab: 'qa',
    settings: { ...DEFAULT_SETTINGS, contextWindow },
    session: SESSION,
    resolution: { phase: 'resolved', courId: 9001 },
    transcript: HDU_TRANSCRIPT,
    ai: null,
    chats: [],
    notes: [],
    favorites: [],
    busy: { session: false, transcript: false, ai: false, ask: false, capture: false },
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  callOpMock.mockReset();
  loadSettingsMock.mockReset();
  loadSettingsMock.mockResolvedValue({ contextWindow: 'medium' });
  askSpy.mockClear();
  generateAiSpy.mockClear();
  stubUiActions();
});

afterEach(() => {
  act(() => root.unmount());
});

// ───────────────────────── 1) PlayPanel 窗口档位 chips ─────────────────────────

describe('HDU PlayPanel 窗口档位 chips（第 29 轮）', () => {
  it('初值同步取全局设置（large → 大档高亮）；未点选时提问携带全局档位，且跟随后续全局设置', async () => {
    patchPlayState('large');
    await renderElement(createElement(PlayPanel));

    expect(hduChips().map((c) => c.textContent)).toEqual(['小', '中', '大']);
    expect(hduChips().findIndex((c) => c.classList.contains('is-active'))).toBe(2);

    // 未点选直接提问：qa.ask 请求携带全局设置档位（large）
    typeTextarea(query<HTMLTextAreaElement>('.hdu-composer textarea'), '这一段的重点是什么？');
    await clickAsync(query('.hdu-composer .hdu-btn'));
    expect(askSpy).toHaveBeenCalledTimes(1);
    expect(askSpy).toHaveBeenLastCalledWith('这一段的重点是什么？', { windowPreset: 'large' });

    // 未交互时跟随全局设置：store 里的设置刷新 → 初值随之更新（无「已交互」锁定）
    await act(async () => {
      uiStore.patch({ settings: { ...DEFAULT_SETTINGS, contextWindow: 'small' } });
    });
    expect(hduChips().findIndex((c) => c.classList.contains('is-active'))).toBe(0);
  });

  it('点选「小」后 qa.ask / ai.generate 均携带所选档位；已点选后全局设置刷新不覆盖（已交互守卫）', async () => {
    patchPlayState('medium');
    await renderElement(createElement(PlayPanel));

    // 点选「小」：仅本面板生效
    await clickAsync(hduChips()[0]!);
    expect(hduChips().findIndex((c) => c.classList.contains('is-active'))).toBe(0);

    // 提问：qa.ask 携带所选档位
    typeTextarea(query<HTMLTextAreaElement>('.hdu-composer textarea'), '解释一下这个概念');
    await clickAsync(query('.hdu-composer .hdu-btn'));
    expect(askSpy).toHaveBeenLastCalledWith('解释一下这个概念', { windowPreset: 'small' });

    // 已交互守卫：全局设置异步刷新（onSettingsChanged → store patch 的等价场景）不回填
    await act(async () => {
      uiStore.patch({ settings: { ...DEFAULT_SETTINGS, contextWindow: 'large' } });
    });
    expect(hduChips().findIndex((c) => c.classList.contains('is-active'))).toBe(0);

    // 标注页签：同款 chips 共享同一档位状态；生成知识标注携带所选档位
    await clickAsync(buttonByText('标注', '.hdu-panel-tab'));
    expect(hduChips().findIndex((c) => c.classList.contains('is-active'))).toBe(0);
    await clickAsync(buttonByText('生成知识标注'));
    expect(generateAiSpy).toHaveBeenLastCalledWith(false, { windowPreset: 'small' });

    // 标注页签内改选「大」后，底部工具栏的「标注」入口同样携带最新所选档位
    await clickAsync(hduChips()[2]!);
    const footerGenerate = Array.from(host.querySelectorAll<HTMLButtonElement>('.hdu-panel-actions .hdu-btn'))
      .find((b) => b.textContent === '标注');
    await clickAsync(footerGenerate!);
    expect(generateAiSpy).toHaveBeenLastCalledWith(undefined, { windowPreset: 'large' });
  });

  it('大纲页签的生成入口同样携带面板所选档位（所有 ai.generate 调用点同口径）', async () => {
    patchPlayState('medium');
    await renderElement(createElement(PlayPanel));

    await clickAsync(hduChips()[2]!); // 选「大」
    await clickAsync(buttonByText('大纲', '.hdu-panel-tab'));
    await clickAsync(buttonByText('生成大纲'));
    expect(generateAiSpy).toHaveBeenLastCalledWith(false, { windowPreset: 'large' });
  });
});

// ───────────────────────── 2) 两面板共享组件一致性 ─────────────────────────

describe('两面板窗口档位 chips 共享一致性（第 29 轮）', () => {
  it('BiliQaPanel 与 PlayPanel 渲染同一份档位选项与受控选中契约（皮肤类名按面板区分）', async () => {
    loadSettingsMock.mockResolvedValue({ contextWindow: 'large' });
    callOpMock.mockImplementation(async (op: string) => {
      const table: Record<string, unknown> = {
        'transcript.get': BILI_TRANSCRIPT,
        'qa.groups': [],
        'qa.list': [],
        'ai.get': { result: null, stale: false },
        'note.list': [],
      };
      return op in table ? table[op] : null;
    });
    patchPlayState('large');

    // 两面板同时挂载：B 站走 loadSettings 初值，HDU 走 uiStore.settings 初值
    await renderElement(
      createElement('div', null, [
        createElement(BiliQaPanel, {
          key: 'bili',
          bvid: 'BV1Parity01',
          open: true,
          onClose: () => {},
          readPageP: () => 1,
          onFavoriteMoment: () => {},
        }),
        createElement(PlayPanel, { key: 'hdu' }),
      ]),
    );
    await flush();

    // 同一份选项契约（共享 WINDOW_PRESET_OPTIONS），同一受控选中语义（is-active）
    const expectedLabels = WINDOW_PRESET_OPTIONS.map((o) => o.label);
    expect(biliChips().map((c) => c.textContent)).toEqual(expectedLabels);
    expect(hduChips().map((c) => c.textContent)).toEqual(expectedLabels);
    expect(biliChips().findIndex((c) => c.classList.contains('is-active'))).toBe(2);
    expect(hduChips().findIndex((c) => c.classList.contains('is-active'))).toBe(2);
    // 皮肤按面板区分：类名不同（B 站沿用 .bili-qa-window*，HDU 用自注入的 .hdu-window-*）
    expect(biliChips()[0]!.className).toContain('bili-qa-window-chip');
    expect(hduChips()[0]!.className).toContain('hdu-window-chip');
  });
});

// ───────────────────────── 3) errorTextOf 用户可见路径 ─────────────────────────

describe('errorTextOf 用户可见路径（第 29 轮 err.message 清尾）', () => {
  it('LearningCenter：course.bundles 失败 → AppError 显示 userMessage；非 Error 显示语境化兜底', async () => {
    uiStore.patch({ centerView: 'overview' });
    callOpMock.mockImplementation(async (op: string) => {
      if (op === 'course.bundles') throw new AppError('DB_FAILED', { detail: 'idb broken' });
      // report 允许 null（catch 兜底口径）；其余解析为空数组，避免旁路各 op 的 .catch 类型兜底
      if (op === 'stats.report') return null;
      return [];
    });
    await renderElement(createElement(LearningCenter));
    await flush();
    expect(host.textContent).toContain('数据读取失败');
    expect(host.textContent).toContain('本地数据读写失败');

    // 非 Error 异常值（字符串 throw）：回退语境化兜底文案，而非直显 "boom"
    callOpMock.mockImplementation(async (op: string) => {
      if (op === 'course.bundles') throw 'boom';
      if (op === 'stats.report') return null;
      return [];
    });
    await act(async () => {
      uiStore.patch({ centerDataVersion: uiStore.getState().centerDataVersion + 1 });
    });
    await flush();
    expect(host.textContent).toContain('课程数据读取失败');
    expect(host.textContent).not.toContain('boom');
  });

  it('dashboard 导出失败：AppError 显示 userMessage；非 Error 显示兜底', async () => {
    const notify = vi.fn();
    const usage = {
      indexedDbBytes: 1,
      opfsBytes: 1,
      quotaBytes: 100,
      screenshotCount: 0,
      transcriptCount: 0,
      modelCached: false,
    };
    callOpMock.mockImplementation(async (op: string) => {
      if (op === 'storage.usage') return usage;
      if (op === 'trash.list') return [];
      if (op === 'export.build') throw new AppError('DB_FAILED', { detail: 'export failed' });
      return null;
    });
    await renderElement(createElement(Data, { notify }));
    await flush();

    await clickAsync(buttonByText('复习卡片'));
    expect(notify).toHaveBeenLastCalledWith('本地数据读写失败', true);

    callOpMock.mockImplementation(async (op: string) => {
      if (op === 'storage.usage') return usage;
      if (op === 'trash.list') return [];
      if (op === 'export.build') throw 'nope';
      return null;
    });
    await clickAsync(buttonByText('复习卡片'));
    expect(notify).toHaveBeenLastCalledWith('导出失败', true);
    expect(notify).toHaveBeenLastCalledWith(expect.not.stringContaining('nope'), true);
  });

  it('options 测试连接失败：AppError 显示 userMessage；非 Error（含 undefined）显示兜底', async () => {
    const notify = vi.fn();
    callOpMock.mockImplementation(async (op: string) => {
      if (op === 'ai.testProvider') throw new AppError('LLM_AUTH_FAILED', { detail: '401' });
      return null;
    });
    await renderElement(createElement(AiSection, { secrets: SECRETS, setSecrets: () => {}, notify }));
    await flush();

    await clickAsync(buttonByText('测试'));
    expect(notify).toHaveBeenLastCalledWith('AI 服务鉴权失败，请检查 API Key', true);

    callOpMock.mockImplementation(async (op: string) => {
      if (op === 'ai.testProvider') throw undefined;
      return null;
    });
    await clickAsync(buttonByText('测试'));
    expect(notify).toHaveBeenLastCalledWith('连接失败', true);
  });
});
