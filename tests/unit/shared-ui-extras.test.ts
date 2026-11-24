/**
 * 共享 UI 小组件行为测试（第 227 轮巡检）：
 *  1. ShortcutsModal（快捷键速查，第 223/224 轮）：键位随 settings.shortcuts 实时显示、
 *     5 行清单齐全、Esc 关闭（Modal 的 Escape 归属层栈）；
 *  2. ToastHost 内联操作（第 227 轮）：pushToast 携带 action 时渲染操作按钮，
 *     点击执行 run 并收起该条 toast。
 */
// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ShortcutsModal } from '@/entrypoints/content/ui/ShortcutsModal';
import { pushToast, ToastHost } from '@/entrypoints/content/ui/components';
import type { ShortcutMap } from '@/core/shared/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CUSTOM: ShortcutMap = {
  ask: 'k',
  favorite: 'f',
  note: 'j',
  prevTopic: ',',
  nextTopic: '.',
};

let host: HTMLElement;
let root: Root;

async function renderNode(node: React.ReactNode): Promise<void> {
  await act(async () => {
    root.render(createElement('div', null, node));
  });
  await act(async () => {});
}

async function clickAsync(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await act(async () => {});
}

function queryAll(selector: string): Element[] {
  return Array.from(document.querySelectorAll(selector));
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  document.body.innerHTML = '';
});

describe('ShortcutsModal（快捷键速查，第 227 轮组件测试）', () => {
  it('键位实时显示自定义值，5 行清单齐全', async () => {
    await renderNode(createElement(ShortcutsModal, { open: true, onClose: () => undefined, shortcuts: CUSTOM }));
    const text = document.body.textContent ?? '';
    for (const key of [CUSTOM.ask, CUSTOM.favorite, CUSTOM.note, CUSTOM.prevTopic, CUSTOM.nextTopic]) {
      expect(text).toContain(key);
    }
    expect(text).toContain('AI 问答');
    expect(text).toContain('收藏此时刻');
    expect(text).toContain('新增时间点笔记');
    expect(text).toContain('快捷键速查');
  });

  it('closed 时不渲染', async () => {
    await renderNode(createElement(ShortcutsModal, { open: false, onClose: () => undefined, shortcuts: CUSTOM }));
    expect(document.body.textContent ?? '').not.toContain('快捷键速查');
  });

  it('Esc 关闭（Modal 的 Escape 归属层栈）', async () => {
    const onClose = vi.fn();
    await renderNode(createElement(ShortcutsModal, { open: true, onClose, shortcuts: CUSTOM }));
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await act(async () => {});
    expect(onClose).toHaveBeenCalled();
  });
});

describe('ToastHost 内联操作（第 227 轮组件测试）', () => {
  it('pushToast 携带 action 时渲染操作按钮，点击执行 run 并收起', async () => {
    const run = vi.fn(async () => undefined);
    await renderNode(createElement(ToastHost));
    await act(async () => {
      pushToast('已删除 2 项（可在学习看板回收站恢复）', 'success', 3600, { label: '撤销', run });
    });
    const btn = queryAll('.hdu-toast button').find((b) => (b.textContent ?? '').trim() === '撤销');
    expect(btn).toBeTruthy();
    await clickAsync(btn!);
    expect(run).toHaveBeenCalledTimes(1);
    // 点击后该条 toast 收起
    expect(queryAll('.hdu-toast').length).toBe(0);
  });

  it('无 action 的 toast 不渲染操作按钮', async () => {
    await renderNode(createElement(ToastHost));
    await act(async () => {
      pushToast('普通提示', 'info');
    });
    expect(queryAll('.hdu-toast button').length).toBe(0);
    expect(document.body.textContent ?? '').toContain('普通提示');
  });
});
