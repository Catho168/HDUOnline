/**
 * 每周计划取消入口与刷新联动行为测试（jsdom + react-dom 客户端渲染，无 JSX、直接 createElement，
 * 照 modal-focus.test.ts 模式；callOp 整体 mock，op → 返回值用查表桩）。
 *
 * 覆盖第 9 轮新增的行为约定：
 *  1. 今日待办 video 分区头的计划 Chip 点击弹出摘要菜单；
 *     第一次点「取消计划」只进入确认态（红色文案），不发起 plan.weekly.cancel；
 *  2. 确认后真正取消：plan.weekly.cancel 带 planId 调用、菜单关闭、今日待办重载
 *     （取消计划的刷新联动）；
 *  3. 点击菜单外（document 捕获 mousedown + composedPath）关闭浮层；
 *  4. BiliImportModal 生成计划成功后自增 uiStore.centerDataVersion（生成计划的刷新联动）。
 */
// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({ callOp: vi.fn() }));

import { callOp } from '@/core/shared/client';
import { TodayTodoCard } from '@/entrypoints/content/ui/learning/TodayTodoCard';
import { BiliImportModal } from '@/entrypoints/content/ui/BiliImportModal';
import { uiStore } from '@/entrypoints/content/ui/store';
import { localDayKey } from '@/core/shared/utils';
import type { WeeklyPlan } from '@/core/plan/weekly';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;

/** 记录 callOp 的调用序列（断言「发起过哪些 op / 带什么参数」） */
let calls: Array<{ op: string; args: unknown }> = [];

const PLAN: WeeklyPlan = {
  id: 'plan-1',
  label: '网课收藏夹',
  perDay: 2,
  bvids: ['BV1A', 'BV2B', 'BV3C', 'BV4D'],
  startDate: localDayKey(),
  createdAt: 0,
  updatedAt: 0,
};

/** 四个未看完的视频收藏（每个 bvid 一条，watchedRatio=0 保证进入待学分区） */
const VIDEO_FAVS = PLAN.bvids.map((bvid, i) => ({
  id: `fav-${i}`,
  type: 'video',
  refId: bvid,
  snapshot: { title: `视频 ${i}`, content: '' },
  folderId: null,
  tags: [],
  pinned: false,
  favoritedAt: 0,
  updatedAt: 0,
  metadata: { platform: 'bilibili', bvid, url: `https://www.bilibili.com/video/${bvid}`, uploader: 'UP 主' },
}));

/** 今日待办五路信号 + 计划取消的默认桩；overrides 按 op 覆盖 */
function stubOps(overrides: Record<string, unknown> = {}): void {
  calls = [];
  const table: Record<string, unknown> = {
    'todo.today.get': [],
    'review.due': [],
    'schedule.missed': [],
    'fav.list': VIDEO_FAVS,
    'plan.weekly.get': { plans: [PLAN] },
    'plan.weekly.cancel': { ok: true },
    ...overrides,
  };
  callOpMock.mockImplementation(async (op: string, args?: unknown) => {
    calls.push({ op, args });
    if (op === 'fav.put') return (args as { favorite: unknown }).favorite;
    if (op === 'plan.weekly.create') {
      return {
        plan: { id: 'plan-9', perDay: 2, bvids: ['BV1A'], startDate: localDayKey(), createdAt: 0, updatedAt: 0 },
      };
    }
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

function query<T extends Element>(selector: string): T {
  const el = host.querySelector<T>(selector);
  if (!el) throw new Error(`element not found: ${selector}`);
  return el;
}

function buttonWithText(text: string): HTMLButtonElement {
  const el = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === text);
  if (!el) throw new Error(`button not found: ${text}`);
  return el;
}

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
});

describe('每周计划 Chip 摘要菜单（今日待办）', () => {
  it('Chip 点击弹出摘要菜单；第一次点「取消计划」只进入确认态、不发起取消', async () => {
    stubOps();
    await renderElement(createElement(TodayTodoCard, { reloadKey: 0 }));

    click(query('.hdu-plan-menu-anchor > button'));
    const menu = query('.hdu-plan-menu');
    // 摘要：主计划 label、合并总数 / 每天条数、起止区间（startDate=今天，4 个 × 每天 2 = 2 天）
    expect(menu.textContent).toContain('网课收藏夹');
    expect(menu.textContent).toContain('共 4 个视频 · 每天 2 个');
    const start = new Date();
    const end = new Date();
    end.setDate(end.getDate() + 1);
    expect(menu.textContent).toContain(
      `${start.getMonth() + 1}月${start.getDate()}日 – ${end.getMonth() + 1}月${end.getDate()}日`,
    );

    const cancelButton = query<HTMLButtonElement>('.hdu-plan-menu-actions button');
    click(cancelButton);
    // 确认态：文案变化 + is-confirm 修饰类；尚未发起取消
    expect(cancelButton.textContent).toBe('再点一次确认取消');
    expect(cancelButton.className).toContain('is-confirm');
    expect(countCalls('plan.weekly.cancel')).toBe(0);
  });

  it('确认后调用 plan.weekly.cancel（带 planId）、关闭菜单并重载今日待办', async () => {
    stubOps();
    await renderElement(createElement(TodayTodoCard, { reloadKey: 0 }));
    const todoGetsAfterMount = countCalls('todo.today.get');

    click(query('.hdu-plan-menu-anchor > button'));
    const cancelButton = query<HTMLButtonElement>('.hdu-plan-menu-actions button');
    click(cancelButton); // 第一次：进入确认态
    await clickAsync(cancelButton); // 第二次：确认取消

    expect(countCalls('plan.weekly.cancel')).toBe(1);
    expect(calls.find((c) => c.op === 'plan.weekly.cancel')?.args).toEqual({ planId: 'plan-1' });
    // 成功后菜单关闭
    expect(host.querySelector('.hdu-plan-menu')).toBeNull();
    // 刷新联动：今日待办在挂载后重新拉取（todo.today.get 再次调用）
    expect(countCalls('todo.today.get')).toBeGreaterThan(todoGetsAfterMount);
  });

  it('点击菜单外（document 捕获 mousedown）关闭浮层', async () => {
    stubOps();
    await renderElement(createElement(TodayTodoCard, { reloadKey: 0 }));
    click(query('.hdu-plan-menu-anchor > button'));
    expect(host.querySelector('.hdu-plan-menu')).not.toBeNull();

    act(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(host.querySelector('.hdu-plan-menu')).toBeNull();
  });
});

describe('BiliImportModal 生成计划的刷新联动', () => {
  it('生成计划成功后自增 uiStore.centerDataVersion，并展示计划摘要', async () => {
    stubOps({
      'bili.nav.get': { isLogin: true },
      'bili.favlist.folders': { folders: [{ id: '100', title: '网课收藏夹', mediaCount: 1 }] },
      // 单页返回、hasMore=false：分页循环一轮即止（无页间延时）
      'bili.favlist.items': {
        items: [{ bvid: 'BV1A', title: '视频 A', intro: '', coverUrl: '', uploader: 'UP 主', durationSec: 600 }],
        total: 1,
        hasMore: false,
      },
    });
    await renderElement(createElement(BiliImportModal, { open: true, onClose: () => {} }));
    // pick 阶段：点收藏夹 → fetching → importing → done
    await clickAsync(query('.hdu-session-row'));
    const versionBefore = uiStore.getState().centerDataVersion;

    await clickAsync(buttonWithText('生成计划'));
    expect(countCalls('plan.weekly.create')).toBe(1);
    // 刷新联动：centerDataVersion 恰好 +1（今日待办卡监听该信号）
    expect(uiStore.getState().centerDataVersion).toBe(versionBefore + 1);
    // done 阶段展示计划摘要
    expect(host.textContent).toContain('已生成计划：共 1 个视频');
  });
});
