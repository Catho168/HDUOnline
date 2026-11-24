import { callOp, onBackgroundEvent } from '@/core/shared/client';
import type { EventPayload } from '@/core/shared/messages';
import { hduMediaKey } from '@/core/shared/mediaRef';
import type { ChatMessageEntity } from '@/core/shared/types';
import { noteObservedUrl } from '../site/observations';
import { isPlayRoute, parseRoute } from '../site/routes';
import { pushToast } from '../ui/components';
import { uiStore } from '../ui/store';
import type { ControllerContext } from './context';

/** 当前课次 ID（已识别会话优先，识别中回落 resolution.courId） */
export function currentCourId(): number | undefined {
  return uiStore.getState().session?.courId ?? uiStore.getState().resolution.courId;
}

/** 订阅后台事件并分发到 handleEvent（注销句柄仍由控制器 offBackgroundEvent 持有，与拆分前一致） */
export function installBackgroundEvents(ctx: ControllerContext): () => void {
  return onBackgroundEvent((payload) => handleEvent(ctx, payload));
}

/** 后台事件分发（转写/问答/AI 载荷按 mediaKey 归属校验，非当前课次不消费） */
export function handleEvent(ctx: ControllerContext, payload: EventPayload): void {
  const state = uiStore.getState();
  // 转写/问答/AI 事件载荷已 mediaKey 化：入口处按当前课次推导后比对（课次未识别时不消费）
  const isForCurrentCour = (mediaKey: string): boolean => {
    const current = currentCourId();
    return current !== undefined && mediaKey === hduMediaKey(current);
  };
  switch (payload.name) {
    case 'ASR_PROGRESS': {
      if (!isForCurrentCour(payload.data.mediaKey)) return;
      uiStore.patch({ job: payload.data.job });
      return;
    }
    case 'ASR_SEGMENTS': {
      if (!isForCurrentCour(payload.data.mediaKey)) return;
      void callOp('transcript.get', { mediaKey: payload.data.mediaKey })
        .then((transcript) => uiStore.patch({ transcript }))
        .catch(() => undefined);
      return;
    }
    case 'ASR_DONE': {
      if (!isForCurrentCour(payload.data.mediaKey)) return;
      void callOp('asr.status', { mediaKey: payload.data.mediaKey })
        .then((job) => uiStore.patch({ job }))
        .catch(() => undefined);
      void callOp('transcript.get', { mediaKey: payload.data.mediaKey })
        .then((transcript) => uiStore.patch({ transcript }))
        .catch(() => undefined);
      if (!payload.data.auto) pushToast('本节字幕已更新', 'success');
      return;
    }
    case 'ASR_FAILED': {
      if (!isForCurrentCour(payload.data.mediaKey)) return;
      if (!payload.data.auto) pushToast(payload.data.error.userMessage, 'error');
      void callOp('asr.status', { mediaKey: payload.data.mediaKey })
        .then((job) => uiStore.patch({ job }))
        .catch(() => undefined);
      return;
    }
    case 'AI_PROGRESS': {
      if (!isForCurrentCour(payload.data.mediaKey)) return;
      uiStore.patch({ busy: { ...state.busy, ai: true } });
      return;
    }
    case 'AI_DONE': {
      if (!isForCurrentCour(payload.data.mediaKey)) return;
      void callOp('ai.get', { mediaKey: payload.data.mediaKey })
        .then((ai) => uiStore.patch({ ai: ai.result, aiStale: ai.stale, busy: { ...uiStore.getState().busy, ai: false } }))
        .catch(() => undefined);
      pushToast(payload.data.result.cached ? '已载入缓存的标注' : '知识标注已生成', 'success');
      return;
    }
    case 'AI_FAILED': {
      if (!isForCurrentCour(payload.data.mediaKey)) return;
      uiStore.patch({ busy: { ...uiStore.getState().busy, ai: false } });
      pushToast(payload.data.error.userMessage, 'error');
      return;
    }
    case 'QA_DELTA': {
      if (payload.data.groupId !== state.activeGroupId && state.activeGroupId) return;
      const existing = state.chats.find((chat) => chat.id === payload.data.chatId);
      const next: ChatMessageEntity = existing
        ? { ...existing, content: `${existing.content}${payload.data.text}`, status: 'streaming' }
        : {
            id: payload.data.chatId,
            mediaKey: hduMediaKey(state.session?.courId ?? 0),
            courId: state.session?.courId ?? 0,
            groupId: payload.data.groupId,
            role: 'ai',
            content: payload.data.text,
            status: 'streaming',
            createdAt: Date.now(),
          };
      uiStore.patch({
        chats: [...state.chats.filter((chat) => chat.id !== next.id), next],
        streamingChatId: payload.data.chatId,
        activeGroupId: payload.data.groupId,
        busy: { ...state.busy, ask: true },
      });
      return;
    }
    case 'QA_DONE': {
      const message = payload.data.message as ChatMessageEntity | undefined;
      if (message) {
        const chats = state.chats.filter((chat) => chat.id !== message.id && !(chat.role === 'ai' && chat.content === '' && chat.groupId === message.groupId));
        uiStore.patch({
          chats: [...chats, message],
          streamingChatId: undefined,
          busy: { ...state.busy, ask: false },
        });
      }
      return;
    }
    case 'QA_FAILED': {
      const chats = state.chats.map((chat) =>
        chat.id === payload.data.chatId ? { ...chat, status: 'failed' as const, error: payload.data.error.userMessage } : chat,
      );
      uiStore.patch({ chats, streamingChatId: undefined, busy: { ...state.busy, ask: false } });
      pushToast(payload.data.error.userMessage, 'error');
      return;
    }
    case 'MODEL_DONE': {
      pushToast('转写模型已就绪', 'success');
      return;
    }
    case 'MODEL_FAILED': {
      pushToast(payload.data.error.userMessage, 'error');
      return;
    }
    case 'SITE_SESSION_HINT': {
      if (!isPlayRoute(parseRoute())) return;
      noteObservedUrl(payload.data.url);
      ctx.resolver?.noteObservedUrl(payload.data.url);
      if (!uiStore.getState().session && uiStore.getState().resolution.phase !== 'resolving') {
        void ctx.resolveAndLoad('site-request');
      }
      return;
    }
    case 'UI_COMMAND': {
      if (payload.data.command === 'openPanel') ctx.actions.setPanelOpen(true);
      else if (payload.data.command === 'closePanel') ctx.actions.setPanelOpen(false);
      else if (payload.data.command === 'togglePanel') ctx.actions.togglePanel();
      else if (payload.data.command === 'openCenter') ctx.actions.openCenter();
      else if (payload.data.command === 'toast' && payload.data.message) pushToast(payload.data.message, payload.data.level ?? 'info');
      return;
    }
    default:
      return;
  }
}
