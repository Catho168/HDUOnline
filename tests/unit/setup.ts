/**
 * 单元测试引导：提供 fake-indexeddb 与 Node 环境下缺失的最小 DOM 兼容项。
 *
 * 说明：被测代码（仓储层 / 统计 / 解析器 / 校验器）都设计为可在 Node 环境运行，
 * `chrome.storage` 不可用时自动退化为内存实现（见 core/shared/storage.ts），
 * 因此这里不安装 chrome API 桩，避免测试与浏览器行为耦合。
 */

import 'fake-indexeddb/auto';

// fetch 在部分用例中被替换；这里保证存在（Node 22 自带 undici）
if (typeof globalThis.fetch !== 'function') {
  globalThis.fetch = (() => Promise.reject(new Error('fetch not mocked'))) as unknown as typeof fetch;
}

// navigator.storage.getDirectory 在 Node 下不存在；相关模块会走降级分支
if (typeof globalThis.navigator === 'undefined') {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
}

// jsdom/Node 的部分组合缺少 randomUUID（utils.uuid 有兜底，但测试希望走真实路径）
if (typeof globalThis.crypto === 'undefined') {
  Object.defineProperty(globalThis, 'crypto', {
    value: {
      getRandomValues<T extends ArrayBufferView | null>(array: T): T {
        if (array && 'byteLength' in array) {
          const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
          for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
        }
        return array;
      },
      randomUUID(): string {
        const bytes = new Uint8Array(16);
        for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
        bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
        bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
        const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      },
    },
    configurable: true,
  });
}

export const noop = (): void => undefined;
