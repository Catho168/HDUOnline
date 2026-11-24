/**
 * 站点请求观测（课次识别证据链，只读）。
 *
 * 背景：站点新播放页 `#/play-center` 的 URL 不含课次 ID，而站点每次打开/切换课次都会请求
 * `/jy-application-resourcemanage/v1/course_vod_urls_new?courseId={课次ID}`。
 * MV3 的内容脚本运行在隔离环境，无法读取页面自己的 fetch/XHR，因此由 SW 侧用
 * `chrome.webRequest`（**只读观测，无 webRequestBlocking，不修改任何请求**）捕获该请求，
 * 把地址推送给发起请求的标签页，内容脚本据此确定"当前正在播放哪一课次"。
 *
 * 排除自身请求：
 *  - `runtime.observeRequests` 已丢弃 `tabId < 0` 的请求（扩展自身发起的请求在 webRequest
 *    中 tabId 为 -1；Offscreen / SW 的调用不会作为页面证据）；
 *  - 同时只接受两个主站源 + 两个固定接口路径，进一步避免把扩展或其他站点的请求当证据。
 *
 * 注：新版 `observeRequests` 的 `ObservedRequest` 不暴露 initiator，无法再按
 * `chrome-extension://` 前缀精确区分"内容脚本发起"的请求；tabId 过滤与路径白名单
 * 是当前契约下可用的等价保护。
 */

import { API_PREFIX, SITE_ORIGINS } from '@/core/shared/constants';
import { createLogger } from '@/core/shared/logger';
import type { EventMessage, EventPayload } from '@/core/shared/messages';
import { observeRequests, tabs } from '@/core/shared/runtime';

const log = createLogger('site-watch');

/** 只观测这两个接口（课次相关且体量小），不订阅全部流量 */
const WATCHED_PATHS = ['course_vod_urls_new', 'course_vod_videoinfos'] as const;
const WATCHED_PATH_SUFFIXES = WATCHED_PATHS.map((path) => `${API_PREFIX}/v1/${path}`);
const SITE_ORIGIN_SET = new Set<string>(Object.values(SITE_ORIGINS));

/** 从观测到的地址里取出课次 ID（仅做字符串解析） */
export function courIdFromObservedUrl(url: string): number | undefined {
  const matched = url.match(/[?&]courseId=(\d+)/);
  if (!matched?.[1]) return undefined;
  const parsed = Number(matched[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** 只接受两个主站源上的两个固定接口路径 */
function isWatchedSiteUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (!SITE_ORIGIN_SET.has(url.origin)) return false;
    return WATCHED_PATH_SUFFIXES.some((suffix) => url.pathname === suffix || url.pathname === `${suffix}/`);
  } catch {
    return false;
  }
}

export function installSiteWatch(): void {
  const urls = Object.values(SITE_ORIGINS).flatMap((origin) =>
    WATCHED_PATHS.map((path) => `${origin}${API_PREFIX}/v1/${path}*`),
  );
  const installed = observeRequests({ urls }, (req) => {
    // tabId 过滤由 runtime.observeRequests 完成；这里再做一次防御
    if (typeof req.tabId !== 'number' || req.tabId < 0) return;
    if (!isWatchedSiteUrl(req.url)) return;
    const courId = courIdFromObservedUrl(req.url);
    const event: EventPayload = {
      name: 'SITE_SESSION_HINT',
      data: courId === undefined ? { url: req.url } : { url: req.url, courId },
    };
    const message: EventMessage = { type: 'EVENT', event: event.name, payload: event };
    void tabs.sendMessage(req.tabId, message);
  });
  if (!installed) {
    log.info('webRequest 不可用（课次识别将只依赖地址/播放器与页面线索）');
    return;
  }
  log.info('站点请求观测已启用', { count: urls.length });
}
