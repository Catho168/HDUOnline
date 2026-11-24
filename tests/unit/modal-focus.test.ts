/**
 * Modal 焦点管理行为测试（jsdom + react-dom 客户端渲染，无 JSX、直接 createElement）。
 *
 * 覆盖审查报告 P1-1 / P1-5 的三条行为约定：
 *  1. 打开弹窗后焦点移入弹窗容器（tabIndex=-1）；
 *  2. Tab / Shift+Tab 在弹窗内首尾圈闭（aria-modal=true 不再形同虚设）；
 *  3. 关闭弹窗后焦点恢复到打开前的元素，且只恢复一次（onClose 引用变化不再打断焦点管理）。
 */
// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Modal, registerEscapeLayer } from '@/entrypoints/content/ui/components';

// React 18 并发渲染下 act() 需要显式声明测试环境
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let trigger: HTMLButtonElement;

/** 以指定 open 状态渲染 Modal：body 一个按钮 + footer 一个按钮，共 3 个可聚焦元素 */
function renderModal(open: boolean, onClose: () => void): void {
  act(() => {
    root.render(
      createElement(Modal, {
        open,
        title: '测试弹窗',
        onClose,
        // children 必须显式传入 props：createElement 的 rest 参数不参与必填 children 的类型检查
        children: [
          createElement('button', { type: 'button', key: 'body' }, '内部按钮'),
          createElement('button', { type: 'button', key: 'foot' }, '底部按钮'),
        ],
      }),
    );
  });
}

function dialog(): HTMLElement {
  const el = host.querySelector('[role="dialog"]');
  if (!(el instanceof HTMLElement)) throw new Error('弹窗未渲染');
  return el;
}

/** 以指定开合渲染两个平级 Modal（外层 + 内层）：验证共享 Escape 归属栈的栈顶语义 */
function renderTwoModals(
  outerOpen: boolean,
  innerOpen: boolean,
  onOuterClose: () => void,
  onInnerClose: () => void,
): void {
  act(() => {
    root.render(
      createElement('div', null,
        createElement(Modal, {
          open: outerOpen,
          title: '外层弹窗',
          onClose: onOuterClose,
          children: createElement('button', { type: 'button', key: 'outer' }, '外层按钮'),
        }),
        createElement(Modal, {
          open: innerOpen,
          title: '内层弹窗',
          onClose: onInnerClose,
          children: createElement('button', { type: 'button', key: 'inner' }, '内层按钮'),
        }),
      ),
    );
  });
}

function pressKey(key: 'Tab' | 'Escape', shift = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, shiftKey: shift, bubbles: true, cancelable: true });
  window.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  trigger = document.createElement('button');
  trigger.textContent = '触发按钮';
  document.body.appendChild(trigger);
});

afterEach(() => {
  renderModal(false, () => {});
});

afterAll(() => {
  act(() => root.unmount());
});

describe('Modal 焦点管理', () => {
  it('打开后焦点移入弹窗容器，关闭后恢复到打开前的元素', () => {
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    renderModal(true, () => {});
    expect(document.activeElement).toBe(dialog());

    renderModal(false, () => {});
    expect(document.activeElement).toBe(trigger);
  });

  it('焦点在末尾时 Tab 回绕到首个可聚焦元素，在开头时 Shift+Tab 回绕到末尾', () => {
    renderModal(true, () => {});
    const focusables = Array.from(dialog().querySelectorAll<HTMLElement>('button'));
    expect(focusables.length).toBeGreaterThanOrEqual(2);
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (!first || !last) throw new Error('可聚焦元素缺失');

    last.focus();
    const tab = pressKey('Tab');
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);

    const shiftTab = pressKey('Tab', true);
    expect(shiftTab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
  });

  it('onClose 引用每次渲染变化不影响焦点管理，Esc 仍能触发最新回调', () => {
    trigger.focus();
    let closed = 0;
    const onClose = (): void => {
      closed += 1;
    };
    renderModal(true, onClose);
    // 模拟 store 变化触发重渲染（onClose 是新闭包）：焦点必须仍留在弹窗内
    renderModal(true, onClose);
    expect(document.activeElement).toBe(dialog());

    pressKey('Escape');
    expect(closed).toBe(1);
    // onClose 驱动父级把 open 置为 false 后，焦点才随副作用清理恢复
    renderModal(false, onClose);
    expect(document.activeElement).toBe(trigger);
  });

  it('多弹窗并存（第 37 轮抽共享 Escape 归属栈）：Esc 只关栈顶，外层保持', () => {
    const outerClose = vi.fn();
    const innerClose = vi.fn();
    // 外层先开、内层后开 → 内层是归属栈顶
    renderTwoModals(true, true, outerClose, innerClose);
    expect(document.querySelectorAll('[role="dialog"]').length).toBe(2);

    pressKey('Escape');
    expect(innerClose).toHaveBeenCalledTimes(1);
    expect(outerClose).not.toHaveBeenCalled();

    // 内层关闭（注销归属）后：Esc 回到外层弹窗的既有行为
    renderTwoModals(true, false, outerClose, innerClose);
    pressKey('Escape');
    expect(outerClose).toHaveBeenCalledTimes(1);
    expect(innerClose).toHaveBeenCalledTimes(1);
  });
});

describe('registerEscapeLayer 共享派发器（第 39 轮巡检：Esc/Tab 由注册器统一派发给栈顶）', () => {
  /** 已登记的测试浮层句柄集合（afterEach 统一注销，防泄漏影响后续用例） */
  const disposers: Array<() => void> = [];

  /** 建一个带单按钮容器的测试浮层并登记：返回 onEscape 探针与注销函数 */
  function registerTestLayer(label: string) {
    const container = document.createElement('div');
    container.dataset.label = label;
    const button = document.createElement('button');
    button.textContent = `${label}按钮`;
    container.appendChild(button);
    document.body.appendChild(container);
    const onEscape = vi.fn();
    const layer = registerEscapeLayer({ onEscape, trapContainer: () => container });
    const dispose = (): void => {
      layer.dispose();
      container.remove();
    };
    disposers.push(dispose);
    return { onEscape, container, button, dispose };
  }

  afterEach(() => {
    while (disposers.length) disposers.pop()!();
  });

  it('Esc 只派发给栈顶浮层的 onEscape（死 API 变真实契约），外层不感知', () => {
    const outer = registerTestLayer('outer');
    const inner = registerTestLayer('inner');

    pressKey('Escape');
    expect(inner.onEscape).toHaveBeenCalledTimes(1);
    expect(outer.onEscape).not.toHaveBeenCalled();

    // 栈顶注销后：Esc 派发给新的栈顶
    inner.dispose();
    pressKey('Escape');
    expect(outer.onEscape).toHaveBeenCalledTimes(1);
    expect(inner.onEscape).toHaveBeenCalledTimes(1);
    outer.dispose();
  });

  it('Tab 转交栈顶浮层的 trapContainer 圈闭；全部注销后不再派发', () => {
    const layer = registerTestLayer('only');
    layer.button.focus();

    // 容器内只有一个可聚焦元素（首尾同为它）：Tab 被消费、焦点保持在容器内
    const tab = pressKey('Tab');
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(layer.button);

    // 全部注销（栈空）：共享监听器不再圈闭 Tab
    layer.dispose();
    layer.button.focus();
    const tabAfter = pressKey('Tab');
    expect(tabAfter.defaultPrevented).toBe(false);
  });
});
