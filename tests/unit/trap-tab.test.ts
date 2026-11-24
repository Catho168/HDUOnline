/**
 * 浮层焦点圈闭（trapTab）自动化测试（第 274 轮巡检，可访问性域）。
 *
 * 通过 registerEscapeLayer 注册桩容器 + window 派发 Tab 键事件，验证第 39 轮
 * 统一派发链路的圈闭行为：
 *  1. 焦点在容器外 → Tab 进入容器首个可聚焦元素；
 *  2. 焦点在最后一个元素 → Tab 回绕到首个（圈闭）；
 *  3. Shift+Tab 在首个元素 → 回绕到最后一个；
 *  4. 容器内无可聚焦元素 → preventDefault（焦点不逃逸）；
 *  5. dispose 后不再圈闭（焦点行为交还页面）。
 */
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerEscapeLayer } from '@/entrypoints/content/ui/components';

let container: HTMLElement;
let first: HTMLButtonElement;
let last: HTMLButtonElement;
let registration: { dispose(): void } | null = null;

function tab(shift = false): boolean {
  const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true, cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  first = document.createElement('button');
  last = document.createElement('button');
  container.append(first, last);
  document.body.append(container);
  registration = registerEscapeLayer({ onEscape: () => {}, trapContainer: () => container });
});

afterEach(() => {
  registration?.dispose();
  registration = null;
  document.body.innerHTML = '';
});

describe('浮层焦点圈闭 trapTab（第 39 轮链路 · 第 274 轮自动化）', () => {
  it('焦点在容器外：Tab 进入容器首个可聚焦元素', () => {
    document.body.focus();
    expect(tab()).toBe(true);
    expect(document.activeElement).toBe(first);
  });

  it('焦点在最后一个元素：Tab 回绕到首个（圈闭不逃逸）', () => {
    last.focus();
    expect(tab()).toBe(true);
    expect(document.activeElement).toBe(first);
  });

  it('Shift+Tab 在首个元素：回绕到最后一个', () => {
    first.focus();
    expect(tab(true)).toBe(true);
    expect(document.activeElement).toBe(last);
  });

  it('容器内无可聚焦元素：preventDefault（焦点不逃逸出浮层）', () => {
    registration?.dispose();
    registration = registerEscapeLayer({ onEscape: () => {}, trapContainer: () => document.createElement('div') });
    document.body.focus();
    expect(tab()).toBe(true);
    expect(document.activeElement).not.toBe(first);
  });

  it('dispose 后不再圈闭（Tab 交还页面默认行为）', () => {
    registration?.dispose();
    registration = null;
    last.focus();
    expect(tab()).toBe(false);
    expect(document.activeElement).toBe(last);
  });
});
