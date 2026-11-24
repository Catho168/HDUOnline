/**
 * uiStore 动作——笔记与收藏（D13 拆分，第 45 轮自 content/index.tsx 纯搬移；
 * 时间点/问答/大纲三类收藏与笔记增删转藏，落库口径逐行未变）。
 */

import { callOp } from '@/core/shared/client';
import { formatClock, summarize, uuid } from '@/core/shared/utils';
import type { FavoriteEntity, NoteEntity } from '@/core/shared/types';
import { pushToast } from '../../ui/components';
import { uiStore, type UiActions } from '../../ui/store';
import type { ControllerContext } from '../context';

export function noteActions(ctx: ControllerContext): Pick<UiActions, 'addNote' | 'deleteNote' | 'convertNote' | 'addTimeFavorite' | 'favoriteChat' | 'favoriteOutline'> {
  return {
    addNote: async (text, atSec) => {
      const state = uiStore.getState();
      if (!state.session) return;
      const now = Date.now();
      const note: NoteEntity = {
        id: uuid(),
        courId: state.session.courId,
        teclId: state.session.teclId,
        anchorTime: Math.floor(atSec),
        text: text.trim(),
        createdAt: now,
        updatedAt: now,
      };
      await callOp('note.put', { note });
      const notes = await callOp('note.list', { courId: state.session.courId }).catch(() => state.notes);
      uiStore.patch({ notes });
      ctx.markInteraction();
    },
    deleteNote: async (id) => {
      await callOp('note.softDelete', { id });
      const courId = uiStore.getState().session?.courId;
      if (courId) uiStore.patch({ notes: await callOp('note.list', { courId }).catch(() => []) });
    },
    convertNote: async (id) => {
      await callOp('note.toFavorite', { id });
      const courId = uiStore.getState().session?.courId;
      if (courId) uiStore.patch({ favorites: await callOp('fav.list', { filter: { courId, limit: 200 } }).catch(() => []) });
      pushToast('已转为收藏', 'success');
    },
    addTimeFavorite: async () => {
      const state = uiStore.getState();
      if (!state.session) return;
      const now = Date.now();
      const favorite: FavoriteEntity = {
        id: uuid(),
        type: 'time',
        snapshot: {
          title: `${state.session.courseName} · ${formatClock(state.currentTime)}`,
          content: `${state.session.courLabel} 的时间点 ${formatClock(state.currentTime)}`,
        },
        teclId: state.session.teclId,
        courId: state.session.courId,
        anchorTime: Math.floor(state.currentTime),
        folderId: null,
        tags: [],
        pinned: false,
        favoritedAt: now,
        updatedAt: now,
      };
      await callOp('fav.put', { favorite });
      const favorites = await callOp('fav.list', { filter: { courId: state.session.courId, limit: 200 } }).catch(() => state.favorites);
      uiStore.patch({ favorites });
      pushToast('已收藏当前时间点', 'success');
      ctx.markInteraction();
    },
    favoriteChat: async (chatId) => {
      const state = uiStore.getState();
      const chat = state.chats.find((item) => item.id === chatId);
      if (!chat || !state.session) return;
      const now = Date.now();
      const favorite: FavoriteEntity = {
        id: uuid(),
        type: 'ai',
        refId: chat.id,
        snapshot: { title: summarize(chat.content, 36), content: chat.content },
        teclId: state.session.teclId,
        courId: state.session.courId,
        anchorTime: chat.anchorTime,
        folderId: null,
        tags: [],
        pinned: false,
        favoritedAt: now,
        updatedAt: now,
      };
      await callOp('fav.put', { favorite });
      const favorites = await callOp('fav.list', { filter: { courId: state.session.courId, limit: 200 } }).catch(() => state.favorites);
      uiStore.patch({ favorites });
      pushToast('回答已收藏到知识库', 'success');
    },
    favoriteOutline: async (index) => {
      const state = uiStore.getState();
      const node = state.ai?.outline[index];
      if (!node || !state.session) return;
      const now = Date.now();
      const favorite: FavoriteEntity = {
        id: uuid(),
        type: 'outline',
        snapshot: { title: node.title, content: `${formatClock(node.start)}–${formatClock(node.end)}` },
        teclId: state.session.teclId,
        courId: state.session.courId,
        anchorTime: node.start,
        folderId: null,
        tags: [],
        pinned: false,
        favoritedAt: now,
        updatedAt: now,
      };
      await callOp('fav.put', { favorite });
      pushToast('大纲节点已收藏', 'success');
    },
  };
}
