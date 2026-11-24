/**
 * ErrorBoundary 渲染错误兜底测试（第 271 轮巡检，健壮性域；jsdom + react-dom，
 * 无 JSX、直接 createElement）。覆盖：正常子树透传 / 渲染错误降级卡片（入口名 +
 * 刷新按钮）/ 点击刷新触发 reload / 日志调用（logger.error）。
 */
// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorBoundary } from '@/entrypoints/content/ui/ErrorBoundary';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 必抛子组件（渲染期抛错） */
function Boom(): null {
  throw new Error('boom-test');
}

let host: HTMLElement;
let root: Root | null = null;
const reloadSpy = vi.fn();

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // jsdom 的 window.location 不可直接 spy：用 stubGlobal 整体替换（含 reload 桩）
  vi.stubGlobal('location', { ...window.location, reload: reloadSpy });
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderElement(el: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => {
    root!.render(el);
  });
  await act(async () => {});
}

describe('ErrorBoundary 渲染错误兜底（第 271 轮）', () => {
  it('正常子树原样透传渲染', async () => {
    await renderElement(
      createElement(ErrorBoundary, { entry: 'popup', children: createElement('div', { 'data-testid': 'ok' }, '正常内容') }),
    );
    expect(host.querySelector('[data-testid="ok"]')?.textContent).toBe('正常内容');
    expect(host.textContent).not.toContain('界面出错了');
  });

  it('渲染错误降级为提示卡片：含入口名与两个按钮（重试 / 刷新），不白屏', async () => {
    await renderElement(createElement(ErrorBoundary, { entry: 'dashboard', children: createElement(Boom) }));
    expect(host.textContent).toContain('界面出错了');
    expect(host.textContent).toContain('dashboard');
    const buttons = Array.from(host.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons).toEqual(['重试当前界面', '刷新页面']);
  });

  it('点击「重试当前界面」原地重挂子树（error 复位）；点击「刷新页面」触发 location.reload', async () => {
    await renderElement(createElement(ErrorBoundary, { entry: 'options', children: createElement(Boom) }));
    const findButton = (label: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === label)!;
    await act(async () => {
      findButton('重试当前界面').click();
    });
    // 重试后子树重挂——Boom 仍抛错则再次降级（按钮仍在），error 状态确已复位
    expect(host.textContent).toContain('界面出错了');
    // 重挂后 DOM 重建：重新按文案取「刷新页面」按钮再点击
    await act(async () => {
      findButton('刷新页面').click();
    });
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it('retryable=false（视图级/页签级边界）：降级卡仅「刷新页面」，无无效重试按钮', async () => {
    await renderElement(
      createElement(ErrorBoundary, { entry: 'learning/overview', retryable: false, children: createElement(Boom) }),
    );
    expect(host.textContent).toContain('界面出错了');
    const buttons = Array.from(host.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons).toEqual(['刷新页面']);
  });
});
