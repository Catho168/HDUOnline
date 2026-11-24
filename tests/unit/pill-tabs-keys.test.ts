/**
 * PillTabs 方向键导航测试（第 278 轮巡检，可访问性域）：tablist 语义下
 * ←/→/Home/End 切换页签（onChange）+ roving tabindex（仅激活页签可 Tab）。
 */
// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PillTabs } from '@/entrypoints/content/ui/components';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ITEMS = [
  { value: 'a', label: '甲' },
  { value: 'b', label: '乙' },
  { value: 'c', label: '丙' },
];

let host: HTMLElement;
let root: Root | null = null;
const onChange = vi.fn();

function tabs(): Array<HTMLButtonElement> {
  return Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
}

async function pressKey(key: string): Promise<void> {
  const list = host.querySelector('[role="tablist"]');
  await act(async () => {
    list!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
  await act(async () => {});
}

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  onChange.mockClear();
  void 0;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

async function renderWith(value: string): Promise<void> {
  await act(async () => {
    root!.render(createElement(PillTabs, { value: value as 'a' | 'b' | 'c', items: ITEMS, onChange }));
  });
  await act(async () => {});
}

describe('PillTabs 方向键导航（第 278 轮）', () => {
  it('roving tabindex：仅激活页签可 Tab，其余 -1', async () => {
    await renderWith('b');
    const tabList = tabs();
    expect(tabList.map((t) => t.tabIndex)).toEqual([-1, 0, -1]);
    expect(tabList[1]?.getAttribute('aria-selected')).toBe('true');
  });

  it('ArrowRight / ArrowLeft 切换相邻页签并触发 onChange', async () => {
    await renderWith('b');
    await pressKey('ArrowRight');
    expect(onChange).toHaveBeenLastCalledWith('c');
    await renderWith('c');
    await pressKey('ArrowLeft');
    expect(onChange).toHaveBeenLastCalledWith('b');
  });

  it('Home / End 跳到首尾页签', async () => {
    await renderWith('b');
    await pressKey('Home');
    expect(onChange).toHaveBeenLastCalledWith('a');
    await renderWith('b');
    await pressKey('End');
    expect(onChange).toHaveBeenLastCalledWith('c');
  });

  it('边界不越界：首元素左键 / 尾元素右键维持当前', async () => {
    await renderWith('a');
    await pressKey('ArrowLeft');
    expect(onChange).not.toHaveBeenCalled();
    await renderWith('c');
    await pressKey('ArrowRight');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('非方向键不接管（如 Enter 冒泡给页面）', async () => {
    await renderWith('a');
    const list = host.querySelector('[role="tablist"]');
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    await act(async () => {
      list!.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });
});
