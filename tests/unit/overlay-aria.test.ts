/**
 * 浮层族无障碍渲染断言（第 248 轮巡检，无障碍域/质量视角）。
 *
 * 第 243 轮 Esc 共享 hook、共享 Modal（role=dialog + aria-modal + aria-labelledby +
 * 焦点移入/归还）之后，本轮浮层族五元组审计（触发 / 关闭途径 / role·aria / 焦点管理）
 * 补齐四处缺口，本文件逐一渲染断言锁定（仿 modal-focus.test.ts / plan-menu.test.ts 模式）：
 *  1. LearningCenter 主面板（.hdu-center）：role=dialog + aria-modal=true（此前缺
 *     aria-modal，屏幕阅读器可能仍允许漫游遮罩后的宿主页内容）；
 *  2. BiliSubtitlePanel 字幕浮层（.bili-sub-modal）：role=dialog + aria-modal=true +
 *     aria-labelledby 指向面板标题 h3（此前无 role，栈顶 Tab 圈闭已有、语义缺失）；
 *  3. BiliQaPanel 会话历史弹层（.bili-qa-history）：role=dialog + aria-modal=true +
 *     aria-labelledby 指向头部标题 span（此前仅关闭钮有 aria-label，弹层本体匿名）；
 *  4. WeeklyPlanChip 计划菜单（hdu-plan-menu）：关闭后焦点归还触发钮（对齐共享
 *     Modal 的 lastFocus 归还先例；此前 Esc 收起后焦点悬空丢失）。
 */
// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({
  callOp: vi.fn(),
  onBackgroundEvent: vi.fn(() => () => undefined),
}));

import { callOp } from '@/core/shared/client';
import { LearningCenter } from '@/entrypoints/content/ui/LearningCenter';
import { BiliSubtitlePanel } from '@/entrypoints/content/ui/BiliSubtitlePanel';
import { BiliQaPanel } from '@/entrypoints/content/ui/BiliQaPanel';
import { TodayTodoCard } from '@/entrypoints/content/ui/learning/TodayTodoCard';
import { uiStore } from '@/entrypoints/content/ui/store';
import type { WeeklyPlan } from '@/core/plan/weekly';
import { localDayKey } from '@/core/shared/utils';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;

let host: HTMLElement;
let root: Root;

async function renderElement(el: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => {
    root.render(el);
  });
  // 让挂载触发的多级异步链（callOp → setState）完全落定
  for (let i = 0; i < 3; i += 1) await act(async () => {});
}

/** 兜底桩：命中查表原样返回，未知 op 一律回 []（审计断言只看渲染结构，不关心数据流） */
function stubAnyOps(table: Record<string, unknown> = {}): void {
  callOpMock.mockImplementation(async (op: string) => {
    if (op in table) return table[op];
    return [];
  });
}

function dialogOf(selector: string): HTMLElement {
  const el = host.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`element not found: ${selector}`);
  return el;
}

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  callOpMock.mockReset();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  uiStore.patch({ centerView: 'overview' });
});

describe('浮层 role/aria 渲染断言（第 248 轮）', () => {
  it('LearningCenter 主面板：role=dialog + aria-modal=true + aria-label（aria-modal 补缺）', async () => {
    stubAnyOps({ 'course.bundles': [], 'fav.list': [], 'folder.list': [], 'note.list': [], 'schedule.list': [], 'stats.report': null });
    await renderElement(createElement(LearningCenter));

    const center = dialogOf('.hdu-center');
    expect(center.getAttribute('role')).toBe('dialog');
    expect(center.getAttribute('aria-modal')).toBe('true');
    expect(center.getAttribute('aria-label')).toBe('智慧课堂学习中心');
  });

  it('BiliSubtitlePanel 字幕浮层：role=dialog + aria-modal=true + aria-labelledby 指向标题 h3', async () => {
    stubAnyOps({ 'transcript.get': null });
    await renderElement(
      createElement(BiliSubtitlePanel, { bvid: 'BV1AriaTest01', open: true, onClose: () => {} }),
    );

    const dialog = dialogOf('.bili-sub-modal');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const labelledby = dialog.getAttribute('aria-labelledby');
    expect(labelledby).toBeTruthy();
    // aria-labelledby 指向的标题元素真实存在且文本为面板标题（候选 D：标题与内容关联）
    const title = document.getElementById(labelledby!);
    expect(title?.textContent).toBe('字幕');
  });

  it('BiliQaPanel 会话历史弹层：role=dialog + aria-modal=true + aria-labelledby 指向头部标题', async () => {
    stubAnyOps({ 'transcript.get': null, 'qa.groups': [], 'qa.groupsAll': [], 'qa.list': [], 'note.list': [] });
    await renderElement(
      createElement(BiliQaPanel, { bvid: 'BV1AriaTest02', open: true, onClose: () => {}, readPageP: () => 1, onFavoriteMoment: () => {} }),
    );

    // 打开会话历史（第 88 轮入口按钮）
    const openBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === '会话历史');
    if (!openBtn) throw new Error('会话历史按钮未渲染');
    await act(async () => {
      openBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await act(async () => {});

    const dialog = dialogOf('.bili-qa-history');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const labelledby = dialog.getAttribute('aria-labelledby');
    expect(labelledby).toBeTruthy();
    expect(document.getElementById(labelledby!)?.textContent).toContain('会话历史');
  });
});

describe('WeeklyPlanChip 关闭后焦点归还（第 248 轮）', () => {
  const PLAN: WeeklyPlan = {
    id: 'plan-aria',
    label: '网课收藏夹',
    perDay: 2,
    bvids: ['BV1A', 'BV2B', 'BV3C', 'BV4D'],
    startDate: localDayKey(),
    createdAt: 0,
    updatedAt: 0,
  };
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
    metadata: { platform: 'bilibili', bvid, url: `https://www.bilibili.com/video/${bvid}` },
  }));

  function stubTodoOps(): void {
    callOpMock.mockImplementation(async (op: string) => {
      if (op === 'todo.today.get') return [];
      if (op === 'review.due') return [];
      if (op === 'schedule.missed') return [];
      if (op === 'fav.list') return VIDEO_FAVS;
      if (op === 'plan.weekly.get') return { plans: [PLAN] };
      return null;
    });
  }

  function pressEscape(): void {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  }

  it('Esc 收起菜单：菜单关闭且焦点归还触发 chip（aria-expanded 复位 false）', async () => {
    stubTodoOps();
    await renderElement(createElement(TodayTodoCard, { reloadKey: 0 }));

    const trigger = host.querySelector<HTMLButtonElement>('.hdu-plan-menu-anchor > button');
    if (!trigger) throw new Error('计划 chip 触发钮未渲染');
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    act(() => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    const menu = host.querySelector('.hdu-plan-menu');
    expect(menu).not.toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    act(() => {
      pressEscape();
    });
    expect(host.querySelector('.hdu-plan-menu')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    // 焦点归还（候选 B）：Esc 收起后不悬空，回到触发钮
    expect(document.activeElement).toBe(trigger);
  });
});
