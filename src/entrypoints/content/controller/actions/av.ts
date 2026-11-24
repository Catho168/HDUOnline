/**
 * uiStore 动作——播放控制与音视频链路（D13 拆分，第 45 轮自 content/index.tsx
 * 纯搬移：seek/播放暂停、转写起停、AI 问答流式、截图、转写检索；直链经
 * ctx.freshAudio（asrFollow 转发），设置经 ctx.settings 活读取，口径逐行未变）。
 */

import { callOp } from '@/core/shared/client';
import { errorTextOf } from '@/core/shared/errors';
import { hduMediaKey } from '@/core/shared/mediaRef';
import type { ChatMessageEntity } from '@/core/shared/types';
import { pushToast } from '../../ui/components';
import { uiStore, type UiActions } from '../../ui/store';
import type { ControllerContext } from '../context';

export function avActions(ctx: ControllerContext): Pick<UiActions, 'seek' | 'togglePlay' | 'startTranscribe' | 'cancelTranscribe' | 'generateAi' | 'ask' | 'abortAsk' | 'newChatGroup' | 'loadChatGroup' | 'deleteChatGroup' | 'capture' | 'searchTranscript'> {
  return {
    seek: (seconds) => {
      ctx.markInteraction();
      ctx.player?.seek(seconds);
      uiStore.patch({ currentTime: seconds });
    },
    togglePlay: () => {
      const video = ctx.player?.getPrimary();
      if (!video) return;
      ctx.markInteraction();
      if (video.paused) void video.play().catch(() => undefined);
      else video.pause();
    },
    startTranscribe: async (opts) => {
      const state = uiStore.getState();
      if (!state.session) {
        pushToast('请先识别当前课次', 'error');
        return;
      }
      uiStore.patch({ busy: { ...state.busy, transcript: true } });
      try {
        const viewNum = ctx.player?.currentViewIndex(ctx.meta?.views) ?? 1;
        const fresh = await ctx.freshAudio(viewNum);
        if (!fresh) throw new Error('未能获取视频直链，请稍后重试');
        const { job } = await callOp('asr.start', {
          mediaKey: hduMediaKey(state.session.courId),
          viewNum: fresh.viewNum,
          teclId: state.session.teclId,
          audioUrl: fresh.url,
          durationSec: fresh.durationSec || state.duration,
          aroundSec: state.currentTime,
          windowMode: opts?.windowMode,
          force: opts?.force,
          auto: false,
        });
        uiStore.patch({ job });
        pushToast('已开始转写，进度会显示在面板中', 'info');
      } catch (err) {
        // errorTextOf：AppError 显示 userMessage，非 Error 异常值回退语境化兜底（第 29 轮审计#3 清尾）
        pushToast(errorTextOf(err, '转写启动失败'), 'error');
      } finally {
        uiStore.patch({ busy: { ...uiStore.getState().busy, transcript: false } });
      }
    },
    cancelTranscribe: async () => {
      const courId = uiStore.getState().session?.courId;
      if (!courId) return;
      const { job } = await callOp('asr.control', { mediaKey: hduMediaKey(courId), action: 'cancel' });
      // 取消整段作业会清掉未完成的转写：同步刷新，避免面板还显示已删除的字幕
      const transcript = await callOp('transcript.get', { mediaKey: hduMediaKey(courId) }).catch(() => null);
      uiStore.patch({ job, transcript });
      pushToast('已停止本轮转写', 'info');
    },
    generateAi: async (force, opts) => {
      const state = uiStore.getState();
      if (!state.session) return;
      if (!state.transcript || state.transcript.segments.length === 0) {
        pushToast('需要先生成字幕', 'warn');
        return;
      }
      uiStore.patch({ busy: { ...state.busy, ai: true } });
      try {
        // per-request 档位（第 29 轮 HDU 对齐）：面板选档时携带，缺省不传 → SW 侧
        // resolveContextWindowPreset 回落全局设置（与既有行为一致）
        const result = await callOp('ai.generate', {
          mediaKey: hduMediaKey(state.session.courId),
          force,
          windowPreset: opts?.windowPreset,
        });
        if (!result.started) {
          uiStore.patch({ busy: { ...uiStore.getState().busy, ai: false } });
          pushToast(result.reason === 'busy' ? '已有生成任务在进行' : '暂时无法生成', 'warn');
        }
      } catch (err) {
        uiStore.patch({ busy: { ...uiStore.getState().busy, ai: false } });
        // errorTextOf：AppError 显示 userMessage，非 Error 异常值回退语境化兜底（第 29 轮审计#3 清尾）
        pushToast(errorTextOf(err, '生成失败'), 'error');
      }
    },
    ask: async (question, opts) => {
      const state = uiStore.getState();
      if (!state.session) return;
      if (!question.trim()) return;
      const anchorTime = Math.floor(state.currentTime);
      uiStore.patch({ busy: { ...state.busy, ask: true } });
      try {
        const mediaKey = hduMediaKey(state.session.courId);
        const result = await callOp('qa.ask', {
          mediaKey,
          question: question.trim(),
          anchorTime,
          groupId: state.activeGroupId,
          // per-request 档位：面板选档优先，缺省仍发全局设置值（与既有行为一致）
          windowPreset: opts?.windowPreset ?? ctx.settings.contextWindow,
        });
        const chats = await callOp('qa.list', { mediaKey, groupId: result.groupId }).catch(() => []);
        // 与事件推送合并：qa.list 可能读到"流式占位"，而 QA_DONE 已经把它改成终态
        const merged = new Map<string, ChatMessageEntity>();
        if (result.groupId === state.activeGroupId) {
          for (const chat of uiStore.getState().chats) merged.set(chat.id, chat);
        }
        for (const chat of chats) {
          const existing = merged.get(chat.id);
          if (existing && existing.status !== 'streaming' && chat.status === 'streaming') continue;
          merged.set(chat.id, chat);
        }
        const nextChats = [...merged.values()].sort((a, b) => a.createdAt - b.createdAt);
        const streaming = nextChats.some((chat) => chat.id === result.chatId && chat.status === 'streaming');
        uiStore.patch({
          activeGroupId: result.groupId,
          chats: nextChats,
          streamingChatId: streaming ? result.chatId : undefined,
          ...(result.immediate ? { busy: { ...uiStore.getState().busy, ask: false } } : {}),
        });
      } catch (err) {
        uiStore.patch({ busy: { ...state.busy, ask: false } });
        // errorTextOf：AppError 显示 userMessage，非 Error 异常值回退语境化兜底（第 29 轮审计#3 清尾）
        pushToast(errorTextOf(err, '提问失败'), 'error');
      }
    },
    abortAsk: async (chatId) => {
      await callOp('qa.abort', { chatId }).catch(() => undefined);
      uiStore.patch({ streamingChatId: undefined, busy: { ...uiStore.getState().busy, ask: false } });
    },
    newChatGroup: () => uiStore.patch({ activeGroupId: undefined, chats: [], streamingChatId: undefined }),
    // 会话历史管理（第 88 轮巡检）：切换到指定历史会话（加载该组全部消息）
    loadChatGroup: async (groupId) => {
      const state = uiStore.getState();
      if (!state.session) return;
      const mediaKey = hduMediaKey(state.session.courId);
      const chats = await callOp('qa.list', { mediaKey, groupId }).catch(() => [] as ChatMessageEntity[]);
      uiStore.patch({ activeGroupId: groupId, chats, streamingChatId: undefined });
    },
    // 会话历史管理（第 88 轮巡检）：删除指定历史会话；删的是当前会话则清空展示
    deleteChatGroup: async (groupId) => {
      const state = uiStore.getState();
      if (!state.session) return;
      const mediaKey = hduMediaKey(state.session.courId);
      await callOp('qa.clear', { mediaKey, groupId }).catch(() => undefined);
      if (uiStore.getState().activeGroupId === groupId) {
        uiStore.patch({ activeGroupId: undefined, chats: [], streamingChatId: undefined });
      }
    },
    capture: async () => {
      const state = uiStore.getState();
      if (!state.session) return;
      const viewNum = ctx.player?.currentViewIndex(ctx.meta?.views) ?? 1;
      uiStore.patch({ busy: { ...state.busy, capture: true } });
      try {
        const fresh = await ctx.freshAudio(viewNum);
        if (!fresh) throw new Error('未能获取视频直链');
        const result = await callOp(
          'shot.capture',
          {
            courId: state.session.courId,
            teclId: state.session.teclId,
            view: fresh.viewNum,
            atSec: Math.floor(state.currentTime),
            url: fresh.url,
            meta: {
              courseName: state.session.courseName,
              courLabel: state.session.courLabel,
              anchorTime: Math.floor(state.currentTime),
              watermark: ctx.settings.screenshotWatermark,
            },
            watermark: ctx.settings.screenshotWatermark,
          },
          { timeoutMs: 90_000 },
        );
        pushToast(`截图已保存（${result.width}×${result.height}）`, 'success');
      } catch (err) {
        // errorTextOf：AppError 显示 userMessage，非 Error 异常值回退语境化兜底（第 29 轮审计#3 清尾）
        pushToast(errorTextOf(err, '截图失败'), 'error');
      } finally {
        uiStore.patch({ busy: { ...uiStore.getState().busy, capture: false } });
      }
    },
    searchTranscript: async (query) => {
      const state = uiStore.getState();
      const trimmed = query.trim();
      if (!trimmed || !state.session) return;
      uiStore.patch({ transcriptSearch: { query: trimmed, results: [], loading: true } });
      try {
        const hits = await callOp('transcript.search', {
          query: trimmed,
          mediaKeys: [hduMediaKey(state.session.courId)],
          limit: 60,
        });
        uiStore.patch({ transcriptSearch: { query: trimmed, results: hits, loading: false } });
      } catch {
        uiStore.patch({ transcriptSearch: { query: trimmed, results: [], loading: false } });
      }
    },
  };
}
