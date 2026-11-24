/**
 * Modal 焦点管理集成测试（第 282 轮巡检，可访问性域）：真实 Modal 组件渲染 +
 * registerEscapeLayer 统一派发链路——打开焦点入弹窗、Tab 圈闭、Esc 关闭、
 * 关闭后焦点还原打开前元素。
 */
// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Modal } from '@/entrypoints/content/ui/components';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root | null = null;
let outside: HTMLButtonElement;
const onClose = vi.fn();

function tab(shift = false): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true, cancelable: true }));
}

function escape(): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
}

function dialog(): HTMLElement {
  return host.querySelector('[role="dialog"]')!;
}

function focusables(): HTMLElement[] {
  return Array.from(host.querySelectorAll<HTMLElement>('[role="dialog"] button'));
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  outside = document.createElement('button');
  outside.textContent = '外部按钮';
  document.body.appendChild(outside);
  outside.focus();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  vi.restoreAllMocks();
});

async function renderModal(open: boolean): Promise<void> {
  await act(async () => {
    root!.render(
      createElement(Modal, {
        open,
        title: '测试弹窗',
        onClose,
        children: [
          createElement('button', { key: 'a' }, '操作一'),
          createElement('button', { key: 'b' }, '操作二'),
        ],
      }),
    );
  });
  await act(async () => {});
}

describe('Modal 焦点管理（第 282 轮 · 第 39 轮圈闭链路实组件验证）', () => {
  it('打开时焦点移入弹窗容器；Tab 在尾元素回绕到首元素', async () => {
    await renderModal(true);
    expect(document.activeElement).toBe(dialog());
    const buttons = focusables();
    expect(buttons).toHaveLength(3); // 关闭按钮 + 两个 children
    buttons[2]!.focus();
    tab();
    expect(document.activeElement).toBe(buttons[0]);
  });

  it('Shift+Tab 在首元素回绕到尾元素', async () => {
    await renderModal(true);
    const buttons = focusables();
    buttons[0]!.focus();
    tab(true);
    expect(document.activeElement).toBe(buttons[2]);
  });

  it('Esc 触发 onClose（栈顶消费，不穿透）', async () => {
    await renderModal(true);
    escape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('关闭后焦点还原到打开前元素', async () => {
    await renderModal(true);
    expect(onClose).not.toHaveBeenCalled();
    await renderModal(false);
    expect(document.activeElement).toBe(outside);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });
});
