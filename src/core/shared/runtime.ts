/**
 * chrome.* API 的轻封装。
 * 目的：① 为单元测试提供可用性判断；② 统一处理 Offscreen / tabs / alarms 的
 * 平台差异与 lastError；③ 让上层模块不直接散落 `chrome as any`。
 */

type ChromeApi = typeof chrome;
const g = globalThis as unknown as { chrome?: ChromeApi };

function api(): ChromeApi | undefined {
  return g.chrome;
}

export const runtime = {
  available(): boolean {
    return Boolean(api()?.runtime?.id);
  },
  id(): string | undefined {
    return api()?.runtime?.id;
  },
  getURL(path: string): string {
    const fromChrome = api()?.runtime?.getURL?.(path);
    if (fromChrome) return fromChrome;
    // 扩展页面创建的 Dedicated Worker 中 Chrome 不注入 chrome.*（实测 chrome 为 undefined）。
    // 此时用 Worker 脚本自身的位置还原扩展资源根：
    // chrome-extension://<id>/asr-worker.js → chrome-extension://<id>/wasm/
    const href = (globalThis as { location?: { href?: string } }).location?.href;
    if (href?.startsWith('chrome-extension://')) {
      try {
        return new URL(path.replace(/^\/+/, ''), href).href;
      } catch {
        /* 落入下方兜底 */
      }
    }
    return path;
  },
  async sendMessage<T = unknown>(message: unknown): Promise<T> {
    const chromeApi = api();
    if (!chromeApi?.runtime?.sendMessage) throw new Error('chrome.runtime unavailable');
    return (await chromeApi.runtime.sendMessage(message)) as T;
  },
  onMessage(
    handler: (message: unknown, sender: chrome.runtime.MessageSender) => unknown,
    options: { external?: boolean } = {},
  ): void {
    const chromeApi = api();
    if (!chromeApi?.runtime) return;
    const listener = (
      message: unknown,
      sender: chrome.runtime.MessageSender,
      sendResponse: (response?: unknown) => void,
    ): boolean | undefined => {
      try {
        const result = handler(message, sender);
        if (result instanceof Promise) {
          result.then(sendResponse).catch((err) => {
            sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
          });
          return true;
        }
        if (result !== undefined) {
          sendResponse(result);
          return true;
        }
        return undefined;
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
        return true;
      }
    };
    if (options.external && chromeApi.runtime.onMessageExternal) {
      chromeApi.runtime.onMessageExternal.addListener(listener);
    } else {
      chromeApi.runtime.onMessage.addListener(listener);
    }
  },
};

export const tabs = {
  async sendMessage<T = unknown>(tabId: number, message: unknown): Promise<T | null> {
    try {
      return (await api()?.tabs?.sendMessage(tabId, message)) as T;
    } catch {
      // 标签页尚未加载内容脚本 / 已关闭：静默
      return null;
    }
  },
  async query(query: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]> {
    return (await api()?.tabs?.query(query)) ?? [];
  },
  onRemoved(cb: (tabId: number) => void): void {
    api()?.tabs?.onRemoved?.addListener(cb);
  },
  onUpdated(cb: (tabId: number, info: { status?: string; url?: string }) => void): void {
    api()?.tabs?.onUpdated?.addListener(cb as never);
  },
};

export const alarms = {
  create(name: string, info: chrome.alarms.AlarmCreateInfo): void {
    api()?.alarms?.create(name, info);
  },
  onAlarm(cb: (alarm: chrome.alarms.Alarm) => void): void {
    api()?.alarms?.onAlarm?.addListener(cb);
  },
  async clear(name: string): Promise<void> {
    await api()?.alarms?.clear(name);
  },
};

export const notifications = {
  async create(
    id: string,
    options: { type: 'basic'; iconUrl: string; title: string; message: string; silent?: boolean },
  ): Promise<void> {
    try {
      await api()?.notifications?.create(id, options as never);
    } catch {
      /* 用户关闭通知权限时静默 */
    }
  },
};

export const permissions = {
  async contains(origins: string[]): Promise<boolean> {
    try {
      return (await api()?.permissions?.contains({ origins })) ?? false;
    } catch {
      return false;
    }
  },
  async request(origins: string[]): Promise<boolean> {
    try {
      return (await api()?.permissions?.request({ origins })) ?? false;
    } catch {
      return false;
    }
  },
};

// ───────────────────────── Offscreen 生命周期 ─────────────────────────

const OFFSCREEN_PATH = 'offscreen.html';

async function hasOffscreenDocument(): Promise<boolean> {
  const chromeApi = api();
  if (!chromeApi) return false;
  const getContexts = (
    chromeApi.runtime as unknown as {
      getContexts?: (filter: { contextTypes: string[]; documentUrls?: string[] }) => Promise<Array<{ contextType: string }>>;
    }
  ).getContexts;
  if (typeof getContexts === 'function') {
    try {
      const contexts = await getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [chromeApi.runtime.getURL(OFFSCREEN_PATH)] });
      return contexts.length > 0;
    } catch {
      /* 回退到 hasDocument */
    }
  }
  const hasDocument = (chromeApi.offscreen as unknown as { hasDocument?: () => Promise<boolean> }).hasDocument;
  if (typeof hasDocument === 'function') {
    try {
      return await hasDocument();
    } catch {
      return false;
    }
  }
  return false;
}

export async function ensureOffscreen(): Promise<void> {
  const chromeApi = api();
  if (!chromeApi?.offscreen) return;
  if (await hasOffscreenDocument()) return;
  try {
    await chromeApi.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['WORKERS' as chrome.offscreen.Reason],
      justification: '在本机完成语音转写、模型推理与长时 AI 流式请求',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // 并发创建时 Chrome 会报 "Only a single offscreen document may be created"
    if (!message.includes('single offscreen')) throw err;
  }
}

export async function closeOffscreen(): Promise<void> {
  const chromeApi = api();
  if (!chromeApi?.offscreen) return;
  try {
    if (await hasOffscreenDocument()) await chromeApi.offscreen.closeDocument();
  } catch {
    /* 已关闭 */
  }
}

/** SW → Offscreen 的统一发送出口 */
export async function sendToOffscreen(message: unknown): Promise<void> {
  await ensureOffscreen();
  await runtime.sendMessage(message);
}

// ───────────────────────── webRequest（只读观测） ─────────────────────────

export interface ObservedRequest {
  url: string;
  tabId: number;
  timeStamp: number;
}

export function observeRequests(
  filter: { urls: string[] },
  cb: (req: ObservedRequest) => void,
): boolean {
  const chromeApi = api();
  const onBeforeRequest = chromeApi?.webRequest?.onBeforeRequest;
  if (!onBeforeRequest) return false;
  try {
    onBeforeRequest.addListener(
      (details) => {
        if (details.tabId < 0) return undefined;
        cb({ url: details.url, tabId: details.tabId, timeStamp: details.timeStamp });
        return undefined;
      },
      { urls: filter.urls, types: ['xmlhttprequest'] },
      [] as Array<'blocking' | 'requestBody' | 'extraHeaders'>,
    );
    return true;
  } catch {
    return false;
  }
}
