import { saveSettings } from '@/core/shared/settings';
import type { SessionMeta } from '@/core/shared/types';
import { uuid } from '@/core/shared/utils';
import { detectSite } from '../site/routes';
import { uiStore } from '../ui/store';
import type { ControllerContext } from './context';

export async function sendPageContext(ctx: ControllerContext): Promise<void> {
  try {
    await chrome.runtime.sendMessage({
      type: 'PAGE_CONTEXT',
      requestId: uuid(),
      context: { site: detectSite(), route: ctx.route, url: location.href },
    });
  } catch {
    /* 扩展重载时忽略 */
  }
}

export async function sendSessionMeta(meta: SessionMeta): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: 'SESSION_META', requestId: uuid(), meta });
  } catch {
    /* 忽略 */
  }
}

export function buildOverview(): unknown {
  const state = uiStore.getState();
  return {
    session: state.session,
    transcript: state.transcript
      ? {
          exists: state.transcript.segments.length > 0,
          partial: state.transcript.partial ?? false,
          coveredSec: state.transcript.coveredSec ?? 0,
        }
      : null,
    ai: state.ai
      ? { exists: true, stale: state.aiStale, topicCount: state.ai.topics.length }
      : { exists: false, stale: false, topicCount: 0 },
    job: state.job,
    watchedSec: state.watchedSec,
    watchRatio: state.watchRatio,
    pageKind: state.route.kind,
  };
}

export async function sendPanelState(ctx: ControllerContext, open: boolean): Promise<void> {
  const courId = uiStore.getState().session?.courId;
  try {
    await chrome.runtime.sendMessage({ type: 'PANEL_STATE', requestId: uuid(), open, courId });
  } catch {
    /* 忽略 */
  }
  if (open) ctx.markInteraction();
}

export function persistPanelPreference(ctx: ControllerContext, open: boolean): void {
  if (ctx.settings.ui.panelCollapsed === !open) return;
  const ui = { ...ctx.settings.ui, panelCollapsed: !open };
  ctx.settings = { ...ctx.settings, ui };
  void saveSettings({ ui });
}

/**
 * 监听 popup → 页面消息（POPUP_OVERVIEW 概览拉取 / UI_COMMAND 面板指令）。
 * 返回注销函数：由控制器 offPageMessage 持有，dispose 时调用，与拆分前注销时机一致。
 */
export function listenPageMessages(ctx: ControllerContext): () => void {
  const chromeApi = (globalThis as unknown as { chrome?: typeof chrome }).chrome;
  if (!chromeApi?.runtime?.onMessage) return () => undefined;
  const listener = (raw: unknown, _sender: chrome.runtime.MessageSender, sendResponse: (value?: unknown) => void) => {
    const message = raw as { type?: string; command?: string } | undefined;
    if (!message) return undefined;
    if (message.type === 'POPUP_OVERVIEW') {
      sendResponse({ type: 'POPUP_OVERVIEW_RESULT', overview: buildOverview() });
      return true;
    }
    if (message.type === 'UI_COMMAND') {
      if (message.command === 'openPanel') ctx.actions.setPanelOpen(true);
      else if (message.command === 'closePanel') ctx.actions.setPanelOpen(false);
      else if (message.command === 'togglePanel') ctx.actions.togglePanel();
      else if (message.command === 'openCenter') ctx.actions.openCenter();
      sendResponse({ ok: true });
      return true;
    }
    return undefined;
  };
  chromeApi.runtime.onMessage.addListener(listener);
  return () => chromeApi.runtime.onMessage.removeListener(listener);
}
