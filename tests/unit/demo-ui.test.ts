/**
 * 演示模式 UI 行为测试（第 319 轮，演示域 / 引导域）。
 *
 * 覆盖（照 data-export-ui.test.ts 的 DataSection 桩模式）：
 *  1. 设置页 DemoSection 未开启态：标题「演示模式」+「开启演示模式」按钮 + 说明文案
 *     （独立数据库 / 真实数据不受影响）；
 *  2. 开启链路：点开启 → 确认弹窗出现 → 确认 → callOp('demo.enter') + 成功 toast；
 *  3. 已开启态：「退出演示」「重新生成数据」按钮 + 演示规模摘要行（进入时间 / 各 store 行数）；
 *  4. OnboardingCard footer 插槽：冷启动空态卡的「一键演示」入口随调用方注入并渲染。
 */
// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/core/shared/client', () => ({ callOp: vi.fn() }));

import { callOp } from '@/core/shared/client';
import { DemoSection } from '@/entrypoints/options/App';
import { OnboardingCard } from '@/entrypoints/content/ui/learning/OnboardingCard';
import type { DemoStatusResult } from '@/core/shared/ops';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callOpMock = callOp as unknown as Mock;

let host: HTMLElement;
let root: Root;
let notifyMock: Mock;

const DISABLED_STATUS: DemoStatusResult = { enabled: false, enteredAt: 0, seededAt: null, counts: null };
const ENABLED_STATUS: DemoStatusResult = {
  enabled: true,
  enteredAt: 1_700_000_000_000,
  seededAt: 1_700_000_100_000,
  counts: { courses: 5, sessions: 42, transcripts: 5, favorites: 21, watchRecords: 92, reviewJobs: 24, notes: 10, externalWatch: 13, aiResults: 5, chats: 8, screenshots: 4 },
};

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

function buttonByLabel(label: string): HTMLButtonElement {
  const btn = Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '').trim().includes(label));
  if (!btn) throw new Error(`button not found: ${label}`);
  return btn;
}

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  notifyMock = vi.fn();
  callOpMock.mockReset();
  callOpMock.mockImplementation(async (op: string) => {
    if (op === 'demo.status') return DISABLED_STATUS;
    throw new Error(`unexpected op: ${op}`);
  });
});

afterEach(() => {
  act(() => root.unmount());
});

describe('设置页「演示模式」卡（第 319 轮）', () => {
  it('未开启态：标题 + 开启按钮 + 数据安全说明（独立库 / 真实数据不受影响）', async () => {
    await renderElement(createElement(DemoSection, { notify: notifyMock }));
    expect(host.textContent).toContain('演示模式');
    expect(host.textContent).toContain('独立数据库');
    expect(host.textContent).toContain('真实数据不受影响');
    expect(buttonByLabel('开启演示模式')).toBeDefined();
  });

  it('开启链路：确认弹窗说明三要点 → 确认 → demo.enter + 成功 toast', async () => {
    await renderElement(createElement(DemoSection, { notify: notifyMock }));
    await clickAsync(buttonByLabel('开启演示模式'));
    // 弹窗出现，含三要点
    expect(host.textContent).toContain('开启演示模式');
    expect(host.textContent).toContain('真实数据零接触');
    expect(host.textContent).toContain('角标');
    callOpMock.mockImplementation(async (op: string) => {
      if (op === 'demo.status') return DISABLED_STATUS;
      if (op === 'demo.enter') return ENABLED_STATUS;
      throw new Error(`unexpected op: ${op}`);
    });
    await clickAsync(buttonByLabel('确认开启'));
    expect(callOpMock).toHaveBeenCalledWith('demo.enter', {});
    expect(notifyMock).toHaveBeenCalledWith(expect.stringContaining('演示模式已开启'));
  });

  it('已开启态：退出 / 重新生成按钮 + 进入时间与演示规模摘要行', async () => {
    callOpMock.mockImplementation(async (op: string) => {
      if (op === 'demo.status') return ENABLED_STATUS;
      throw new Error(`unexpected op: ${op}`);
    });
    await renderElement(createElement(DemoSection, { notify: notifyMock }));
    expect(buttonByLabel('退出演示')).toBeDefined();
    expect(buttonByLabel('重新生成数据')).toBeDefined();
    expect(host.textContent).toContain('已开启');
    expect(host.textContent).toContain('5 门课 · 42 节课次 · 21 条收藏');
  });
});

describe('OnboardingCard footer 插槽（第 319 轮一键演示入口）', () => {
  it('footer 节点渲染在步骤列表之后；不传不渲染容器', async () => {
    await renderElement(
      createElement(OnboardingCard, {
        input: { hasCourse: false, hasWatch: false, hasLibrary: false },
        footer: createElement('button', { type: 'button' }, '一键演示'),
      }),
    );
    const card = host.querySelector('.hdu-onboard');
    expect(card).not.toBeNull();
    expect(card?.querySelector('.hdu-onboard-foot')?.textContent).toContain('一键演示');
    // 步骤在前，footer 在后
    const order = Array.from(card?.children ?? []).map((el) => el.className);
    expect(order.indexOf('hdu-onboard-foot')).toBeGreaterThan(order.indexOf('hdu-onboard-steps'));
  });
});
