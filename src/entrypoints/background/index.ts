/**
 * Service Worker（编排器，无 DOM，短生命周期）— 入口。
 *
 * 职责（§2.1）：
 *  - 消息路由：REQUEST（数据/编排操作）、PAGE_CONTEXT、SESSION_META、PLAYER_STATE、PANEL_STATE；
 *  - 持久化唯一入口：所有内容脚本发来的读写都经此落到 IndexedDB；
 *  - 任务编排：转写作业、AI 生成、问答、复习提醒（alarms）、数据清理；
 *  - Offscreen 生命周期管理。
 */

import { defineBackground } from 'wxt/utils/define-background';
import { AppError, serializeError } from '@/core/shared/errors';
import { createLogger } from '@/core/shared/logger';
import type {
  ContentToBackground,
  EventMessage,
  OffscreenOutboundEnvelope,
  OverviewResultMessage,
  PageContextMessage,
  PanelStateMessage,
  PlayerStateMessage,
  PopupOverviewMessage,
  RequestMessage,
  ResponseMessage,
  SessionMetaMessage,
} from '@/core/shared/messages';
import type { OpName } from '@/core/shared/ops';
import { alarms, closeOffscreen, ensureOffscreen, runtime, tabs } from '@/core/shared/runtime';
import { loadSettings } from '@/core/shared/settings';
import { uuid } from '@/core/shared/utils';
import { runScheduledTasks, ALARM_NAMES } from './alarms';
import { handleOffscreenEvent, reconcileJobsOnStartup, warmup } from './asr';
import { handleLlmOffscreenEvent } from './llm';
import { dispatchOp, housekeeping } from './ops';
import { buildPopupOverview } from './popup';
import { handleShotResult } from './screenshot';
import { installSiteWatch } from './siteWatch';
import { statsService } from './stats';
import { emitToCour, registerTab, setPanelOpen, unregisterTab } from './tabs';

const log = createLogger('sw');

// ───────────────────────── 生命周期 ─────────────────────────

/** 注册全部监听与启动逻辑（WXT 要求入口使用 defineBackground） */
function setupBackground(): void {
  if (!runtime.available()) return;
  log.info('Service Worker 已启动');
  void bootstrap();
  // 只读观测站点请求（课次识别证据链；WebRequest 不可用时静默降级）
  installSiteWatch();

  runtime.onMessage((message, sender) => {
    const tabId = sender.tab?.id;
    return handleMessage(message, tabId, sender);
  });

  // 标签页关闭时清理订阅
  tabs.onRemoved((tabId) => {
    unregisterTab(tabId);
  });

  // 定时任务（回收站清理 / 复习提醒 / 周报）
  alarms.create(ALARM_NAMES.daily, { periodInMinutes: 60 * 12 });
  alarms.onAlarm((alarm) => {
    void runScheduledTasks(alarm.name, log);
  });
}

export default defineBackground(() => {
  setupBackground();
});

async function bootstrap(): Promise<void> {
  await housekeeping();
  try {
    await ensureOffscreen();
    await reconcileJobsOnStartup();
  } catch (err) {
    log.warn('Offscreen 初始化失败（转写与 AI 功能将在使用时重试）', err);
  }
  const settings = await loadSettings();
  if (settings.asr.autoWarmup) {
    void warmup();
  }
}

// ───────────────────────── 消息处理 ─────────────────────────

async function handleMessage(
  raw: unknown,
  tabId: number | undefined,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  if (!raw || typeof raw !== 'object') return undefined;
  const message = raw as ContentToBackground | OffscreenOutboundEnvelope | { type: string };

  // Offscreen → SW
  if (message.type === 'OFFSCREEN_EVENT') {
    const payload = (message as OffscreenOutboundEnvelope).payload;
    if (await handleOffscreenEvent(payload)) return { ok: true };
    if (handleLlmOffscreenEvent(payload)) return { ok: true };
    if (await handleShotResult(payload)) return { ok: true };
    return { ok: true };
  }

  switch (message.type) {
    case 'PAGE_CONTEXT':
      return handlePageContext(message as PageContextMessage, tabId, sender.url);

    case 'SESSION_META':
      return handleSessionMeta(message as SessionMetaMessage, tabId);

    case 'PLAYER_STATE':
      return handlePlayerState(message as PlayerStateMessage, tabId);

    case 'PANEL_STATE':
      return handlePanelState(message as PanelStateMessage, tabId);

    case 'POPUP_OVERVIEW':
      return handlePopupOverview(message as PopupOverviewMessage, tabId);

    case 'REQUEST':
      return handleRequest(message as RequestMessage, tabId);

    // 内容脚本/页面可用于重置 SW 空闲计时器（长任务期间保活）
    case 'KEEPALIVE':
      return { ok: true };

    case 'OPEN_OPTIONS':
      try {
        await chrome.runtime.openOptionsPage();
      } catch {
        /* 忽略 */
      }
      return { ok: true };

    default:
      return undefined;
  }
}

async function handlePageContext(
  message: PageContextMessage,
  tabId: number | undefined,
  url?: string,
): Promise<unknown> {
  const { route, site } = message.context;
  if (tabId !== undefined) {
    registerTab(tabId, {
      routeKind: route.kind,
      courId: route.courId,
      teclId: route.teclId,
    });
  }
  log.debug('页面上下文', { site, kind: route.kind, courId: route.courId, url });
  return { ok: true };
}

async function handleSessionMeta(message: SessionMetaMessage, tabId: number | undefined): Promise<unknown> {
  const { meta } = message;
  if (tabId !== undefined) {
    registerTab(tabId, { courId: meta.courId, teclId: meta.teclId });
  }
  try {
    await dispatchOp('session.saveMeta', { meta });
    log.info('会话元数据已落库', { courId: meta.courId, duration: meta.durationSec });
    return { ok: true };
  } catch (err) {
    const appErr = err instanceof AppError ? err : new AppError('DB_FAILED', { cause: err });
    log.warn('会话元数据落库失败', appErr.detail);
    return { ok: false, error: serializeError(appErr) };
  }
}

async function handlePlayerState(message: PlayerStateMessage, tabId: number | undefined): Promise<unknown> {
  if (tabId !== undefined) {
    registerTab(tabId, { courId: message.courId, teclId: message.teclId });
  }
  try {
    await dispatchOp('stats.tick', {
      courId: message.courId,
      teclId: message.teclId,
      state: message.state,
      visible: message.visible,
      focused: message.focused,
      interacted: message.interacted,
    });
  } catch (err) {
    log.warn('统计心跳失败', err);
  }
  return { ok: true };
}

async function handlePanelState(message: PanelStateMessage, tabId: number | undefined): Promise<unknown> {
  if (tabId !== undefined) {
    setPanelOpen(tabId, message.open);
    if (message.courId !== undefined) registerTab(tabId, { courId: message.courId });
  }
  return { ok: true };
}

async function handlePopupOverview(
  message: PopupOverviewMessage,
  tabId: number | undefined,
): Promise<OverviewResultMessage> {
  const overview = await buildPopupOverview(message.courId, tabId);
  return { type: 'POPUP_OVERVIEW_RESULT', overview };
}

async function handleRequest(message: RequestMessage, tabId: number | undefined): Promise<ResponseMessage> {
  const requestId = message.requestId ?? uuid();
  const args = message.args as {
    courId?: number;
    teclId?: number;
    favorite?: { courId?: number; teclId?: number };
    note?: { courId?: number; teclId?: number };
  };
  // SW 可能刚被回收重启：从请求参数顺带刷新标签页订阅，保证后续事件能送达
  const courId = args.courId ?? args.favorite?.courId ?? args.note?.courId;
  if (tabId !== undefined && typeof courId === 'number') {
    registerTab(tabId, {
      courId,
      teclId: args.teclId ?? args.favorite?.teclId ?? args.note?.teclId,
    });
  }
  try {
    const result = await dispatchOp(message.op as OpName, message.args as never);
    // 交互型操作同时刷新统计引擎的"最后交互时间"
    if (tabId !== undefined && INTERACTION_OPS.has(message.op as string) && typeof courId === 'number') {
      await statsService.interaction(courId);
    }
    return { type: 'RESPONSE', requestId, ok: true, result };
  } catch (err) {
    const serialized = serializeError(err);
    if (serialized.code === 'DB_FAILED' || serialized.code === 'UNKNOWN') {
      log.warn(`操作失败：${message.op}`, serialized.detail ?? serialized.code);
    }
    return { type: 'RESPONSE', requestId, ok: false, error: serialized };
  }
}

const INTERACTION_OPS = new Set<string>([
  'qa.ask',
  'fav.put',
  'note.put',
  'note.update',
  'ai.generate',
  'asr.start',
  'transcript.search',
  'review.plan',
]);

/** 供其他模块（alarms / 页面）复用的事件广播 */
export async function broadcastEvent(courId: number, event: EventMessage['payload']): Promise<void> {
  await emitToCour(courId, event);
}

export { closeOffscreen, tabs as runtimeTabs };

/** 面板"停止生成"：转发给 Offscreen 取消 LLM 请求 */
export async function abortLlm(runId: string): Promise<void> {
  const { abortLlmRun } = await import('./llm');
  abortLlmRun(runId);
}

/** 显式触发一次 Offscreen 关闭（Options 页"释放资源"用） */
export async function shutdownOffscreen(): Promise<void> {
  await closeOffscreen();
}
