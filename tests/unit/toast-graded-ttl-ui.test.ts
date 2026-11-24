/**
 * Toast 时长分级与栈上限测试（第 249 轮巡检，提示域 / 反馈体验视角）：
 *  1. resolveToastTtl 纯函数：info 2.5s / success 3s / warn 4s / error 5s 分级默认值
 *     （原全类型统一 3.6s，错误偏短、info 偏长）；显式 ttl 覆盖默认（第 245 轮「排到」
 *     toast 显式 8s 先例保持兼容）；带 action 保底 8s（取 max：显式更长的 ttl 不被压缩）；
 *  2. pushToastToList 栈上限纯函数：同屏至多 3 条（原实现 slice(-3)+1 实际容 4 条，
 *     显式化统一为 3），最旧先出，新条目追加在栈尾；
 *  3. 渲染：pushToast 未显式传 ttl 时按 level 分级落 setTimeout（spy 核对延迟值）；
 *     error toast 附专用关闭钮（点击收起该条），info/success/warn 不附关闭钮
 *     （整条 toast 本就可点击关闭）；
 *  4. 栈上限裁剪渲染：短时间连推 4 条，同屏至多 3 条（断言以纯函数为主，渲染端防退化）。
 *
 * 注意：toastList 是模块级状态且真实定时器存活 2.5–8s，跨用例可能残留旧条目——
 * 渲染断言一律以「包含本用例唯一消息的那一条」定位，不做全局计数（栈上限渲染断言除外，
 * 上限裁剪后总数恒 ≤ 3，与残留无关）。
 *
 * jsdom + react-dom 客户端渲染，无 JSX、直接 createElement（照 shared-ui-extras.test.ts 模式）。
 */
// @vitest-environment jsdom

import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  pushToast,
  pushToastToList,
  resolveToastTtl,
  ToastHost,
  TOAST_STACK_MAX,
  TOAST_TTL_MS,
  TOAST_TTL_WITH_ACTION_MS,
} from '@/entrypoints/content/ui/components';
import type { ToastLevel } from '@/entrypoints/content/ui/components';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;

async function renderNode(node: React.ReactNode): Promise<void> {
  await act(async () => {
    root.render(node);
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

/** 找到文本包含 message 的那条 toast（跨用例残留隔离）；找不到返回 null */
function findToast(message: string): HTMLElement | null {
  return queryAll('.hdu-toast').find((el) => (el.textContent ?? '').includes(message)) as HTMLElement | null ?? null;
}

let seq = 0;
const uniqueMsg = (prefix: string): string => `${prefix}#${++seq}`;

beforeEach(() => {
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

describe('toast 时长分级 resolveToastTtl（第 249 轮纯函数）', () => {
  it('四类 level 各有分级默认值：info 2500 / success 3000 / warn 4000 / error 5000', () => {
    expect(TOAST_TTL_MS.info).toBe(2500);
    expect(TOAST_TTL_MS.success).toBe(3000);
    expect(TOAST_TTL_MS.warn).toBe(4000);
    expect(TOAST_TTL_MS.error).toBe(5000);
    const levels: ToastLevel[] = ['info', 'success', 'warn', 'error'];
    for (const level of levels) {
      expect(resolveToastTtl(level)).toBe(TOAST_TTL_MS[level]);
    }
  });

  it('显式 ttl 覆盖分级默认（第 245 轮「排到」8s 先例兼容）；带 action 保底 8s 且不被更长的显式 ttl 压缩', () => {
    // 无 action：显式 ttl 原样生效
    expect(resolveToastTtl('error', 3600)).toBe(3600);
    expect(resolveToastTtl('info', 8000)).toBe(8000);
    // 带 action：保底 8s（3600 显式被抬到 8000，先例中的 success+3600+撤销从 6s 变 8s）
    expect(resolveToastTtl('success', 3600, true)).toBe(TOAST_TTL_WITH_ACTION_MS);
    expect(TOAST_TTL_WITH_ACTION_MS).toBe(8000);
    // 显式更长不被压缩
    expect(resolveToastTtl('success', 8000, true)).toBe(8000);
    // 未传 ttl + action：max(分级默认, 8000) = 8000
    expect(resolveToastTtl('info', undefined, true)).toBe(8000);
  });
});

describe('toast 栈上限 pushToastToList（第 249 轮纯函数）', () => {
  const item = (id: number): { id: number; message: string; level: ToastLevel } => ({ id, message: `m${id}`, level: 'info' });

  it('同屏至多 3 条：新条目追加栈尾，超出从最旧端裁剪（最旧先出）', () => {
    expect(TOAST_STACK_MAX).toBe(3);
    const one = pushToastToList([], item(1));
    expect(one.map((t) => t.id)).toEqual([1]);
    const two = pushToastToList(one, item(2));
    expect(two.map((t) => t.id)).toEqual([1, 2]);
    const three = pushToastToList(two, item(3));
    expect(three.map((t) => t.id)).toEqual([1, 2, 3]);
    const four = pushToastToList(three, item(4));
    expect(four.map((t) => t.id)).toEqual([2, 3, 4]);
    const five = pushToastToList(four, item(5), 3);
    expect(five.map((t) => t.id)).toEqual([3, 4, 5]);
  });

  it('自定义 max 生效（1 条模式：总是只留最新）', () => {
    const list = pushToastToList([item(1), item(2)], item(3), 1);
    expect(list.map((t) => t.id)).toEqual([3]);
  });
});

describe('ToastHost 分级与关闭钮渲染（第 249 轮）', () => {
  it('未显式传 ttl 时按 level 分级落 setTimeout：error 5000 / info 2500 / success 带 action 8000', async () => {
    const timeoutSpy = vi.spyOn(window, 'setTimeout');
    try {
      await renderNode(createElement(ToastHost));
      await act(async () => {
        pushToast(uniqueMsg('分级error'), 'error');
        pushToast(uniqueMsg('分级info'), 'info');
        pushToast(uniqueMsg('分级action'), 'success', undefined, { label: '撤销', run: () => undefined });
      });
      const delays = timeoutSpy.mock.calls.map((call) => call[1]);
      expect(delays).toContain(TOAST_TTL_MS.error); // 5000
      expect(delays).toContain(TOAST_TTL_MS.info); // 2500
      expect(delays).toContain(TOAST_TTL_WITH_ACTION_MS); // 8000
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('error toast 附专用关闭钮，点击收起该条；info toast 不附关闭钮', async () => {
    await renderNode(createElement(ToastHost));
    const errMsg = uniqueMsg('错误提示');
    const infoMsg = uniqueMsg('普通提示');
    await act(async () => {
      pushToast(errMsg, 'error');
      pushToast(infoMsg, 'info');
    });
    const errToast = findToast(errMsg);
    expect(errToast).toBeTruthy();
    expect(errToast!.className).toContain('error');
    const errClose = errToast!.querySelector('.hdu-toast-close');
    expect(errClose).toBeTruthy();
    expect(errClose!.getAttribute('aria-label')).toBe('关闭提示');
    await clickAsync(errClose!);
    expect(findToast(errMsg)).toBeNull();

    const infoToast = findToast(infoMsg);
    expect(infoToast).toBeTruthy();
    expect(infoToast!.querySelector('.hdu-toast-close')).toBeNull();
  });

  it('关闭钮点击不触发 toast 本体的整条点击收起副作用之外的行为（stopPropagation 后仅收起一次）', async () => {
    await renderNode(createElement(ToastHost));
    const msg = uniqueMsg('仅收起一次');
    await act(async () => {
      pushToast(msg, 'error');
    });
    const toast = findToast(msg)!;
    await clickAsync(toast.querySelector('.hdu-toast-close')!);
    // 收起后栈里不再有该条；无残留的重复节点
    expect(queryAll('.hdu-toast').filter((el) => (el.textContent ?? '').includes(msg)).length).toBe(0);
  });

  it('短时连推 4 条 → 同屏至多 3 条（栈上限裁剪渲染端防退化）', async () => {
    await renderNode(createElement(ToastHost));
    await act(async () => {
      pushToast(uniqueMsg('栈裁剪'), 'info');
      pushToast(uniqueMsg('栈裁剪'), 'info');
      pushToast(uniqueMsg('栈裁剪'), 'info');
      pushToast(uniqueMsg('栈裁剪'), 'info');
    });
    expect(queryAll('.hdu-toast').length).toBeLessThanOrEqual(TOAST_STACK_MAX);
    expect(queryAll('.hdu-toast').length).toBe(TOAST_STACK_MAX);
  });
});
