/**
 * dashboard / options 入口两步确认行为测试（jsdom + react-dom 客户端渲染，无 JSX、直接 createElement，
 * 照 plan-menu.test.ts / fav-edit-modal.test.ts 模式；callOp 整体 mock，op → 返回值用查表桩）。
 *
 * 覆盖第 10 轮去 window.confirm 后的行为约定（每入口各取代表性场景 + 开启型开关特例）：
 *  1. dashboard 概览「清空统计」（ConfirmButton）：第一次点击不执行、3 秒复原、二次点击执行；
 *  2. options「分类清除」（每行独立 ConfirmButton）：同上，二次点击带对应 kinds；
 *  3. options AI 服务「删除」（ConfirmIconButton）：图标按钮确认态切换 + 二次点击删除；
 *  4. options「允许本地推理端点」开启型两步确认：拨开关不立即生效，确认按钮 3 秒自动收回，
 *     点击「再点一次确认开启」才持久化（关闭方向无风险、即时生效，不在本文件展开）。
 *
 * 第 11 轮补充（无确认破坏操作收尾，接入共享 ConfirmButton / ConfirmIconButton）：
 *  5. dashboard 知识库「时间戳笔记」删除与「板书截图」删除（ConfirmIconButton）；
 *  6. dashboard 回收站单条「彻底删除」（ConfirmButton）；
 *  7. options 本地调试日志「清空」（ConfirmButton，clearLogs mock 断言）；
 *  8. 播放页面板「删除笔记」（NotesTab + ConfirmIconButton，store actions 打桩）。
 */
// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({ callOp: vi.fn() }));
// clearLogs 走 chrome.storage 包装层：mock 掉以便断言调用（readLogs 保留原实现走内存兜底）
vi.mock('@/core/shared/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/shared/logger')>();
  return { ...actual, clearLogs: vi.fn(async () => {}) };
});

import { callOp } from '@/core/shared/client';
import { clearLogs } from '@/core/shared/logger';
import { Data, Library, Overview } from '@/entrypoints/dashboard/App';
import { AiSection, DataSection } from '@/entrypoints/options/App';
import { NotesTab } from '@/entrypoints/content/ui/panel/NotesTab';
import { uiStore } from '@/entrypoints/content/ui/store';
import { DEFAULT_SETTINGS } from '@/core/shared/constants';
import type { DashboardReport, NoteEntity, SecretsStore, ScreenshotEntity } from '@/core/shared/types';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;

/** 记录 callOp 的调用序列（断言「发起过哪些 op / 带什么参数」） */
let calls: Array<{ op: string; args: unknown }> = [];

/** 概览最小报表（Overview 挂载即拉取 stats.report；数值不影响本文件断言） */
const REPORT: DashboardReport = {
  totalSec: 7200,
  weekSec: 1800,
  todaySec: 300,
  externalSeconds: 600,
  streakDays: 3,
  days: [],
  weeks: [],
  courses: [],
  sessions: [],
  goal: { weeklyTargetSec: 18000, weekSec: 1800, hitDaysThisWeek: 2 },
  generatedAt: 0,
};

/** 双 provider 固件：p-1 在使用中（删除后 activeProviderId 应回退到 p-2） */
const SECRETS: SecretsStore = {
  providers: [
    { id: 'p-1', label: 'DeepSeek', kind: 'openai-chat', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: 'sk-1' },
    { id: 'p-2', label: 'Claude', kind: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet', apiKey: 'sk-2' },
  ],
  activeProviderId: 'p-1',
  allowLocalEndpoints: false,
  modelSource: { remoteHost: 'hf-mirror.com' },
  userGlossary: {},
};

/** 知识库固件：一条时间戳笔记（第 11 轮接入两步删除） */
const NOTE: NoteEntity = { id: 'note-1', courId: 1, teclId: 11, anchorTime: 42, text: '重点：两步确认', createdAt: 0, updatedAt: 0 };
/** 知识库固件：一张板书截图（列表形态，无 blob） */
const SHOT: Omit<ScreenshotEntity, 'blob'> = {
  id: 'shot-1',
  courId: 1,
  view: 1,
  meta: { courseName: '高等数学', courLabel: '1.1', anchorTime: 30, watermark: false },
  createdAt: 0,
};
/** 回收站固件：一条待彻底删除的条目（trash.list 行形态，见 ops.ts 声明） */
const TRASH_ITEM = { key: 'k-1', kind: 'note', id: 'note-1', title: '笔记A', deletedAt: 0, expiresAt: 0 };

/** 被测 op 的默认桩；overrides 按 op 覆盖（第 11 轮补：知识库列表与删除、回收站列表与单条彻底删除） */
function stubOps(overrides: Record<string, unknown> = {}): void {
  calls = [];
  const table: Record<string, unknown> = {
    'stats.report': REPORT,
    'stats.clear': {},
    'storage.usage': null,
    'data.clear': {},
    'fav.list': [],
    'folder.list': [],
    'tag.list': [],
    'note.list': [],
    'shot.list': [],
    'trash.list': [],
    'note.softDelete': {},
    'shot.softDelete': {},
    'trash.purge': 0,
    ...overrides,
  };
  callOpMock.mockImplementation(async (op: string, args?: unknown) => {
    calls.push({ op, args });
    if (op in table) return table[op];
    throw new Error(`unexpected op: ${op}`);
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

/** 推进假定时器并让随之触发的 setState 重渲染落定 */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

function buttonWithText(text: string): HTMLButtonElement {
  const el = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === text);
  if (!el) throw new Error(`button not found: ${text}`);
  return el;
}

/** 取列表第 index 个元素（越界即抛错，同时收窄掉 TS 对下标访问的 undefined 分支） */
function at<T>(items: T[], index: number): T {
  const el = items[index];
  if (el === undefined) throw new Error(`item not found at index: ${index}`);
  return el;
}

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

describe('dashboard 概览「清空统计」两步确认（ConfirmButton）', () => {
  it('第一次点击只进入确认态（红色文案 + is-confirm 类），不发起 stats.clear', async () => {
    stubOps();
    const notify = vi.fn();
    await renderElement(createElement(Overview, { notify }));

    const btn = buttonWithText('清空统计');
    click(btn);
    expect(btn.textContent).toBe('再点一次确认清空统计');
    expect(btn.className).toContain('is-confirm');
    expect(countCalls('stats.clear')).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it('3 秒无操作自动复原：文案回到默认、不发起清空', async () => {
    stubOps();
    await renderElement(createElement(Overview, { notify: vi.fn() }));

    const btn = buttonWithText('清空统计');
    click(btn);
    expect(btn.textContent).toBe('再点一次确认清空统计');

    await advance(3000);
    expect(btn.textContent).toBe('清空统计');
    expect(btn.className).not.toContain('is-confirm');
    expect(countCalls('stats.clear')).toBe(0);
  });

  it('第二次点击才执行 stats.clear', async () => {
    stubOps();
    const notify = vi.fn();
    await renderElement(createElement(Overview, { notify }));

    const btn = buttonWithText('清空统计');
    click(btn); // 第一次：进入确认态
    await clickAsync(btn); // 第二次：确认清空

    expect(countCalls('stats.clear')).toBe(1);
    expect(notify).toHaveBeenCalledWith('学习统计已清空');
  });
});

describe('options「分类清除」两步确认（每行独立 ConfirmButton）', () => {
  function clearButtons(): HTMLButtonElement[] {
    return Array.from(host.querySelectorAll('button')).filter((b) => b.textContent === '清除');
  }

  it('第一次点击只进入确认态，不发起 data.clear', async () => {
    stubOps();
    await renderElement(createElement(DataSection, { settings: DEFAULT_SETTINGS, patchSettings: vi.fn(async () => {}), notify: vi.fn() }));

    expect(clearButtons()).toHaveLength(6);
    const btn = at(clearButtons(), 2); // 行序 ai → transcript → stats，取「学习统计」行
    click(btn);
    expect(btn.textContent).toBe('再点一次确认清除');
    expect(btn.className).toContain('is-confirm');
    expect(countCalls('data.clear')).toBe(0);
  });

  it('3 秒无操作自动复原，不发起清除', async () => {
    stubOps();
    await renderElement(createElement(DataSection, { settings: DEFAULT_SETTINGS, patchSettings: vi.fn(async () => {}), notify: vi.fn() }));

    const btn = at(clearButtons(), 2);
    click(btn);
    expect(btn.textContent).toBe('再点一次确认清除');

    await advance(3000);
    expect(btn.textContent).toBe('清除');
    expect(countCalls('data.clear')).toBe(0);
  });

  it('第二次点击才执行 data.clear（带对应 kinds）', async () => {
    stubOps();
    const notify = vi.fn();
    await renderElement(createElement(DataSection, { settings: DEFAULT_SETTINGS, patchSettings: vi.fn(async () => {}), notify }));

    const btn = at(clearButtons(), 2); // 「学习统计」行
    click(btn); // 第一次：进入确认态
    await clickAsync(btn); // 第二次：确认清除

    expect(countCalls('data.clear')).toBe(1);
    expect(calls.find((c) => c.op === 'data.clear')?.args).toEqual({ kinds: ['stats'] });
    expect(notify).toHaveBeenCalledWith('已清除');
  });
});

describe('options AI 服务「删除」两步确认（ConfirmIconButton）', () => {
  function deleteIconButtons(): HTMLButtonElement[] {
    return Array.from(host.querySelectorAll('button[aria-label="删除"]')) as HTMLButtonElement[];
  }

  it('第一次点击图标按钮只进入确认态（警示配色 + title/aria-label 切换），不删除', async () => {
    stubOps();
    const setSecrets = vi.fn();
    await renderElement(createElement(AiSection, { secrets: SECRETS, setSecrets, notify: vi.fn() }));

    expect(deleteIconButtons()).toHaveLength(2);
    const btn = at(deleteIconButtons(), 0); // 第一行（使用中的 p-1）
    click(btn);
    expect(btn.getAttribute('aria-label')).toBe('再点一次确认删除');
    expect(btn.getAttribute('title')).toBe('再点一次确认删除');
    expect(btn.className).toContain('is-confirm');
    expect(setSecrets).not.toHaveBeenCalled();
  });

  it('第二次点击才删除 provider（使用中档位回退到首个）', async () => {
    stubOps();
    const setSecrets = vi.fn();
    await renderElement(createElement(AiSection, { secrets: SECRETS, setSecrets, notify: vi.fn() }));

    const btn = at(deleteIconButtons(), 0);
    click(btn); // 第一次：进入确认态
    await clickAsync(btn); // 第二次：确认删除

    expect(setSecrets).toHaveBeenCalledTimes(1);
    expect(setSecrets).toHaveBeenCalledWith({
      ...SECRETS,
      providers: [SECRETS.providers[1]],
      activeProviderId: 'p-2',
    });
  });
});

describe('options「允许本地推理端点」开启型两步确认', () => {
  function localSwitch(): HTMLInputElement {
    const el = host.querySelector<HTMLInputElement>('.hdu-switch input');
    if (!el) throw new Error('switch not found');
    return el;
  }

  it('拨开关到「开」不立即生效：开关保持关闭、不持久化，出现「再点一次确认开启」', async () => {
    stubOps();
    const setSecrets = vi.fn();
    await renderElement(createElement(AiSection, { secrets: SECRETS, setSecrets, notify: vi.fn() }));

    click(localSwitch());
    // 确认按钮出现（红色警示样式），开关本身仍如实反映未生效状态
    const confirmBtn = buttonWithText('再点一次确认开启');
    expect(confirmBtn.className).toContain('is-confirm');
    expect(localSwitch().checked).toBe(false);
    expect(setSecrets).not.toHaveBeenCalled();
  });

  it('3 秒无操作自动收回确认按钮（不持久化）', async () => {
    stubOps();
    const setSecrets = vi.fn();
    await renderElement(createElement(AiSection, { secrets: SECRETS, setSecrets, notify: vi.fn() }));

    click(localSwitch());
    expect(buttonWithText('再点一次确认开启')).toBeDefined();

    await advance(3000);
    expect(Array.from(host.querySelectorAll('button')).some((b) => b.textContent === '再点一次确认开启')).toBe(false);
    expect(setSecrets).not.toHaveBeenCalled();
  });

  it('点击「再点一次确认开启」才持久化 allowLocalEndpoints=true', async () => {
    stubOps();
    const setSecrets = vi.fn();
    await renderElement(createElement(AiSection, { secrets: SECRETS, setSecrets, notify: vi.fn() }));

    click(localSwitch()); // 第一次：进入确认态
    const confirmBtn = buttonWithText('再点一次确认开启');
    await clickAsync(confirmBtn); // 第二次：确认开启

    expect(setSecrets).toHaveBeenCalledTimes(1);
    expect(setSecrets).toHaveBeenCalledWith({ ...SECRETS, allowLocalEndpoints: true });
    // 开关反映已生效状态
    expect(localSwitch().checked).toBe(true);
    // 确认按钮收回
    expect(Array.from(host.querySelectorAll('button')).some((b) => b.textContent === '再点一次确认开启')).toBe(false);
  });
});

// ───────────────────────── 第 11 轮补充：无确认破坏操作收尾 ─────────────────────────

/** 按 aria-label 取图标按钮（ConfirmIconButton 渲染为 <button aria-label=…>） */
function iconButtonByLabel(label: string): HTMLButtonElement {
  const el = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!el) throw new Error(`icon button not found: ${label}`);
  return el;
}

describe('dashboard 知识库「时间戳笔记」删除两步确认（ConfirmIconButton）', () => {
  /** 笔记删除场景的 Library 拉取桩：收藏/文件夹/标签/截图全空，只有一条笔记 */
  const LIB_NOTE_ONLY = { 'fav.list': [], 'folder.list': [], 'tag.list': [], 'shot.list': [], 'note.list': [NOTE] };

  it('第一次点击只进入确认态（title/aria-label 切换 + is-confirm），不发起 note.softDelete', async () => {
    stubOps(LIB_NOTE_ONLY);
    await renderElement(createElement(Library, { notify: vi.fn() }));

    const btn = iconButtonByLabel('删除');
    click(btn);
    expect(btn.getAttribute('aria-label')).toBe('再点一次确认移入回收站');
    expect(btn.getAttribute('title')).toBe('再点一次确认移入回收站');
    expect(btn.className).toContain('is-confirm');
    expect(countCalls('note.softDelete')).toBe(0);
  });

  it('3 秒无操作自动复原：label 回到「删除」，不发起删除', async () => {
    stubOps(LIB_NOTE_ONLY);
    await renderElement(createElement(Library, { notify: vi.fn() }));

    const btn = iconButtonByLabel('删除');
    click(btn);
    expect(btn.getAttribute('aria-label')).toBe('再点一次确认移入回收站');

    await advance(3000);
    expect(btn.getAttribute('aria-label')).toBe('删除');
    expect(btn.className).not.toContain('is-confirm');
    expect(countCalls('note.softDelete')).toBe(0);
  });

  it('第二次点击才执行 note.softDelete（带笔记 id）并提示', async () => {
    stubOps(LIB_NOTE_ONLY);
    const notify = vi.fn();
    await renderElement(createElement(Library, { notify }));

    const btn = iconButtonByLabel('删除');
    click(btn); // 第一次：进入确认态
    await clickAsync(btn); // 第二次：确认删除

    expect(countCalls('note.softDelete')).toBe(1);
    expect(calls.find((c) => c.op === 'note.softDelete')?.args).toEqual({ id: 'note-1' });
    expect(notify).toHaveBeenCalledWith('笔记已移入回收站');
  });
});

describe('dashboard「板书截图」删除两步确认（ConfirmIconButton）', () => {
  /** 截图删除场景的 Library 拉取桩：只有一张截图 */
  const LIB_SHOT_ONLY = { 'fav.list': [], 'folder.list': [], 'tag.list': [], 'note.list': [], 'shot.list': [SHOT] };

  it('第一次点击只进入确认态，不发起 shot.softDelete', async () => {
    stubOps(LIB_SHOT_ONLY);
    await renderElement(createElement(Library, { notify: vi.fn() }));

    const btn = iconButtonByLabel('删除截图');
    click(btn);
    expect(btn.getAttribute('aria-label')).toBe('再点一次确认移入回收站');
    expect(btn.className).toContain('is-confirm');
    expect(countCalls('shot.softDelete')).toBe(0);
  });

  it('第二次点击才执行 shot.softDelete（带截图 id）并提示', async () => {
    stubOps(LIB_SHOT_ONLY);
    const notify = vi.fn();
    await renderElement(createElement(Library, { notify }));

    const btn = iconButtonByLabel('删除截图');
    click(btn); // 第一次：进入确认态
    await clickAsync(btn); // 第二次：确认删除

    expect(countCalls('shot.softDelete')).toBe(1);
    expect(calls.find((c) => c.op === 'shot.softDelete')?.args).toEqual({ ids: ['shot-1'] });
    expect(notify).toHaveBeenCalledWith('截图已移入回收站');
  });
});

describe('dashboard 回收站单条「彻底删除」两步确认（ConfirmButton）', () => {
  it('第一次点击只进入确认态（红色文案 + is-confirm），不发起 trash.purge', async () => {
    stubOps({ 'trash.list': [TRASH_ITEM] });
    await renderElement(createElement(Data, { notify: vi.fn() }));

    const btn = buttonWithText('彻底删除');
    click(btn);
    expect(btn.textContent).toBe('再点一次确认删除');
    expect(btn.className).toContain('is-confirm');
    expect(countCalls('trash.purge')).toBe(0);
  });

  it('3 秒无操作自动复原：文案回到「彻底删除」，不发起删除', async () => {
    stubOps({ 'trash.list': [TRASH_ITEM] });
    await renderElement(createElement(Data, { notify: vi.fn() }));

    const btn = buttonWithText('彻底删除');
    click(btn);
    expect(btn.textContent).toBe('再点一次确认删除');

    await advance(3000);
    expect(btn.textContent).toBe('彻底删除');
    expect(countCalls('trash.purge')).toBe(0);
  });

  it('第二次点击才执行 trash.purge（带该条 key）', async () => {
    stubOps({ 'trash.list': [TRASH_ITEM] });
    await renderElement(createElement(Data, { notify: vi.fn() }));

    const btn = buttonWithText('彻底删除');
    click(btn); // 第一次：进入确认态
    await clickAsync(btn); // 第二次：确认彻底删除

    expect(countCalls('trash.purge')).toBe(1);
    expect(calls.find((c) => c.op === 'trash.purge')?.args).toEqual({ keys: ['k-1'] });
  });
});

describe('options 本地调试日志「清空」两步确认（ConfirmButton）', () => {
  function renderDataSection(notify: () => void): Promise<void> {
    return renderElement(createElement(DataSection, { settings: DEFAULT_SETTINGS, patchSettings: vi.fn(async () => {}), notify }));
  }

  it('第一次点击只进入确认态，不调用 clearLogs', async () => {
    stubOps();
    vi.mocked(clearLogs).mockClear();
    await renderDataSection(vi.fn());

    const btn = buttonWithText('清空');
    click(btn);
    expect(btn.textContent).toBe('再点一次确认清空');
    expect(btn.className).toContain('is-confirm');
    expect(clearLogs).not.toHaveBeenCalled();
  });

  it('第二次点击才清空日志并提示', async () => {
    stubOps();
    vi.mocked(clearLogs).mockClear();
    const notify = vi.fn();
    await renderDataSection(notify);

    const btn = buttonWithText('清空');
    click(btn); // 第一次：进入确认态
    await clickAsync(btn); // 第二次：确认清空

    expect(clearLogs).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('日志已清空');
  });
});

describe('播放页面板「删除笔记」两步确认（ConfirmIconButton + store actions）', () => {
  /** 打桩 deleteNote 并注入 store（NotesTab 通过 uiStore.actions 调用，不走 callOp） */
  function bindDeleteNote(): Mock {
    const deleteNote = vi.fn(async () => {});
    uiStore.bindActions({ deleteNote });
    return deleteNote;
  }

  function mountNotesTab(): Promise<void> {
    uiStore.patch({ notes: [NOTE], siteNotes: [] });
    return renderElement(createElement(NotesTab, { noteText: '', setNoteText: vi.fn(), onSubmit: vi.fn() }));
  }

  it('第一次点击只进入确认态（title/aria-label 切换 + is-confirm），不调用 deleteNote', async () => {
    const deleteNote = bindDeleteNote();
    await mountNotesTab();

    const btn = iconButtonByLabel('删除笔记');
    click(btn);
    expect(btn.getAttribute('aria-label')).toBe('再点一次确认删除');
    expect(btn.getAttribute('title')).toBe('再点一次确认删除');
    expect(btn.className).toContain('is-confirm');
    expect(deleteNote).not.toHaveBeenCalled();
  });

  it('第二次点击才调用 deleteNote（带笔记 id）', async () => {
    const deleteNote = bindDeleteNote();
    await mountNotesTab();

    const btn = iconButtonByLabel('删除笔记');
    click(btn); // 第一次：进入确认态
    await clickAsync(btn); // 第二次：确认删除

    expect(deleteNote).toHaveBeenCalledTimes(1);
    expect(deleteNote).toHaveBeenCalledWith('note-1');
  });
});
