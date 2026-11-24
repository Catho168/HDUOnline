/**
 * 标签页订阅登记表：SW 需要知道"哪个标签页正在看哪个媒体"才能推送事件。
 * 内容脚本每次路由变化 / 面板打开都会刷新登记，SW 卸载后由内容脚本的下一次消息自动重建。
 *
 * 登记（B 站转写专项 §2）：转写/问答/AI 事件的载荷与路由统一用 mediaKey
 * （`hdu:<courId>` / `bili:<bvid>`）；courId 保留用于统计心跳与站点导航
 * （stats/library 链路仍按 courId）。登记时只带 courId 的消息会自动派生
 * `hdu:<courId>` 作为 mediaKey，HDU 页面行为不变。
 */

import type { EventMessage, EventPayload } from '@/core/shared/messages';
import { tabs } from '@/core/shared/runtime';
import { hduCourIdOf, hduMediaKey, type MediaKey } from '@/core/shared/mediaRef';
import type { RouteKind } from '@/core/shared/types';

export interface TabSubscription {
  tabId: number;
  /** 站内课次 ID（统计/导航链路仍按 courId；HDU 页面必有） */
  courId?: number;
  teclId?: number;
  /** 转写/问答/AI 事件的路由键 */
  mediaKey?: MediaKey;
  routeKind: RouteKind;
  panelOpen: boolean;
  lastSeen: number;
}

const registry = new Map<number, TabSubscription>();

/** 播放页路由种类（与内容脚本 routes.ts 的 PLAY_ROUTES 保持一致；SW 侧不引内容脚本依赖） */
const PLAY_KINDS = new Set<RouteKind>(['play-center', 'video-detail', 'play-video']);

export function registerTab(tabId: number, info: Partial<TabSubscription> & { routeKind?: RouteKind }): void {
  const prev = registry.get(tabId);
  // 新登记带 courId 时 mediaKey 必须跟随新值重算（页面切课次后不能沿用旧键路由事件）；
  // 只带 mediaKey（转写/问答/AI op 参数顺带刷新）时直接采用，并反解出 courId 供统计链路复用。
  const mediaKey =
    info.mediaKey ?? (info.courId !== undefined ? hduMediaKey(info.courId) : prev?.mediaKey);
  const courId =
    info.courId ?? prev?.courId ?? (mediaKey !== undefined ? hduCourIdOf(mediaKey) : undefined);
  registry.set(tabId, {
    tabId,
    // 播放心跳/元数据上报不携带路由种类，此时保留页面上下文登记的权威值（否则 play-center 会被覆盖）
    routeKind: info.routeKind ?? prev?.routeKind ?? 'other',
    courId,
    teclId: info.teclId ?? prev?.teclId,
    mediaKey: mediaKey ?? (courId !== undefined ? hduMediaKey(courId) : undefined),
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

/** 转写/问答/AI 事件按 mediaKey 路由 */
export function tabsForMedia(mediaKey: MediaKey): number[] {
  return [...registry.values()].filter((s) => s.mediaKey === mediaKey).map((s) => s.tabId);
}

export function subscription(tabId: number): TabSubscription | undefined {
  return registry.get(tabId);
}

async function sendEvent(tabId: number, event: EventPayload): Promise<void> {
  const message: EventMessage = { type: 'EVENT', event: event.name, payload: event };
  // runtime.tabs.sendMessage 在标签页已关闭 / 内容脚本未注入时返回 null（不抛错）
  await tabs.sendMessage(tabId, message);
}

/** 向关心该媒体的标签页推送事件（转写/问答/AI 链路） */
export async function emitToCour(mediaKey: MediaKey, event: EventPayload): Promise<void> {
  const tabIds = tabsForMedia(mediaKey);
  await Promise.all(tabIds.map((tabId) => sendEvent(tabId, event)));
}

/** 向所有已注入的播放页广播 */
export async function emitToAll(event: EventPayload): Promise<void> {
  const tabIds = [...registry.values()].filter((s) => PLAY_KINDS.has(s.routeKind)).map((s) => s.tabId);
  await Promise.all(tabIds.map((tabId) => sendEvent(tabId, event)));
}
