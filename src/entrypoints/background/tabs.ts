/**
 * 标签页订阅登记表：SW 需要知道"哪个标签页正在看哪个课次"才能推送事件。
 * 内容脚本每次路由变化 / 面板打开都会刷新登记，SW 卸载后由内容脚本的下一次消息自动重建。
 */

import type { EventMessage, EventPayload } from '@/core/shared/messages';
import { tabs } from '@/core/shared/runtime';
import type { RouteKind } from '@/core/shared/types';

export interface TabSubscription {
  tabId: number;
  courId?: number;
  teclId?: number;
  routeKind: RouteKind;
  panelOpen: boolean;
  lastSeen: number;
}

const registry = new Map<number, TabSubscription>();

/** 播放页路由种类（与内容脚本 routes.ts 的 PLAY_ROUTES 保持一致；SW 侧不引内容脚本依赖） */
const PLAY_KINDS = new Set<RouteKind>(['play-center', 'video-detail', 'play-video']);

export function registerTab(tabId: number, info: Partial<TabSubscription> & { routeKind?: RouteKind }): void {
  const prev = registry.get(tabId);
  registry.set(tabId, {
    tabId,
    courId: info.courId ?? prev?.courId,
    teclId: info.teclId ?? prev?.teclId,
    // 播放心跳/元数据上报不携带路由种类，此时保留页面上下文登记的权威值（否则 play-center 会被覆盖）
    routeKind: info.routeKind ?? prev?.routeKind ?? 'other',
    panelOpen: info.panelOpen ?? prev?.panelOpen ?? false,
    lastSeen: Date.now(),
  });
}

export function unregisterTab(tabId: number): void {
  registry.delete(tabId);
}

export function setPanelOpen(tabId: number, open: boolean): void {
  const sub = registry.get(tabId);
  if (sub) {
    sub.panelOpen = open;
    sub.lastSeen = Date.now();
  }
}

export function tabsForCour(courId: number): number[] {
  return [...registry.values()].filter((s) => s.courId === courId).map((s) => s.tabId);
}

export function subscription(tabId: number): TabSubscription | undefined {
  return registry.get(tabId);
}

export function clearTab(tabId: number): void {
  registry.delete(tabId);
}

async function sendEvent(tabId: number, event: EventPayload): Promise<void> {
  const message: EventMessage = { type: 'EVENT', event: event.name, payload: event };
  // runtime.tabs.sendMessage 在标签页已关闭 / 内容脚本未注入时返回 null（不抛错）
  await tabs.sendMessage(tabId, message);
}

/** 向关心该课次的标签页推送事件 */
export async function emitToCour(courId: number, event: EventPayload): Promise<void> {
  const tabIds = tabsForCour(courId);
  await Promise.all(tabIds.map((tabId) => sendEvent(tabId, event)));
}

/** 向所有已注入的播放页广播 */
export async function emitToAll(event: EventPayload): Promise<void> {
  const tabIds = [...registry.values()].filter((s) => PLAY_KINDS.has(s.routeKind)).map((s) => s.tabId);
  await Promise.all(tabIds.map((tabId) => sendEvent(tabId, event)));
}
