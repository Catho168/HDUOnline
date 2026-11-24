/**
 * 剪贴板复制 copyTextToClipboard（entrypoints/content/ui/clipboard.ts，第 235 轮巡检）单测。
 *
 * 覆盖（jsdom）：
 *  1. navigator.clipboard.writeText 可用 → 直接成功；
 *  2. writeText 被拒（reject）→ 回退 document.execCommand('copy') + 临时 textarea，
 *     execCommand 返回 true → 成功，且临时节点已被移除；
 *  3. execCommand 返回 false → 失败；
 *  4. 无 clipboard API（undefined）→ 走回退路径；
 *  5. 空文本直接失败（不调用任何剪贴板 API，避免「已复制」错觉）。
 */
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { copyTextToClipboard } from '@/entrypoints/content/ui/clipboard';

/** 临时替换 navigator.clipboard（jsdom 默认无该 API） */
function stubClipboard(impl: { writeText: (text: string) => Promise<void> } | undefined): void {
  Object.defineProperty(window.navigator, 'clipboard', { value: impl, configurable: true });
}

afterEach(() => {
  stubClipboard(undefined);
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('copyTextToClipboard（第 235 轮）', () => {
  it('clipboard.writeText 可用时直接成功', async () => {
    const writeText = vi.fn(async () => undefined);
    stubClipboard({ writeText });
    await expect(copyTextToClipboard('hello')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('writeText 被拒时回退 execCommand + 临时 textarea，成功后节点移除', async () => {
    stubClipboard({ writeText: async () => Promise.reject(new Error('denied')) });
    const execSpy = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { value: execSpy, configurable: true });
    await expect(copyTextToClipboard('share text')).resolves.toBe(true);
    expect(execSpy).toHaveBeenCalledWith('copy');
    expect(document.querySelector('textarea')).toBeNull();
    Object.defineProperty(document, 'execCommand', { value: undefined, configurable: true });
  });

  it('execCommand 返回 false 时整体失败', async () => {
    stubClipboard(undefined);
    Object.defineProperty(document, 'execCommand', { value: () => false, configurable: true });
    await expect(copyTextToClipboard('text')).resolves.toBe(false);
    Object.defineProperty(document, 'execCommand', { value: undefined, configurable: true });
  });

  it('空文本直接失败且不调用剪贴板 API', async () => {
    const writeText = vi.fn(async () => undefined);
    stubClipboard({ writeText });
    await expect(copyTextToClipboard('')).resolves.toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });
});
