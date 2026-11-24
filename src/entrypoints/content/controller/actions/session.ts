/**
 * uiStore 动作——会话/课程编排（D13 拆分，第 45 轮自 content/index.tsx 纯搬移：
 * 会话刷新/手动选课/站内外跳转/课程与课表同步/设置保存；识别守卫与数据装载经
 * ctx（playPage/sessionData），逻辑与提示文案逐行未变）。
 */

import { callOp } from '@/core/shared/client';
import { hduMediaKey } from '@/core/shared/mediaRef';
import { saveSettings } from '@/core/shared/settings';
import type { AppSettings } from '@/core/shared/types';
import { lessonHash } from '../../site/navigation';
import { isPlayRoute } from '../../site/routes';
import { pushToast } from '../../ui/components';
import { uiStore, type UiActions } from '../../ui/store';
import type { ControllerContext } from '../context';

export function sessionActions(ctx: ControllerContext): Pick<UiActions, 'refresh' | 'syncCourses' | 'syncSchedule' | 'reloadSession' | 'selectCour' | 'saveSetting' | 'openSessionInSite'> {
  return {
    refresh: async () => {
      const state = uiStore.getState();
      if (state.session) await ctx.loadRelated(state.session.courId, ctx.currentLoadToken());
      const job = state.session
        ? await callOp('asr.status', { mediaKey: hduMediaKey(state.session.courId) }).catch(() => null)
        : null;
      uiStore.patch({ job });
    },
    syncCourses: async (opts) => {
      const result = await ctx.syncSiteCache(opts?.force ?? true);
      if (result.skipped) return;
      if (result.ok) {
        if (!opts?.quiet) {
          pushToast(
            result.courses > 0
              ? `已同步 ${result.courses} 门课程、${result.sessions} 节课`
              : '同步完成：站点暂无可同步的课程',
            'success',
          );
        }
        return;
      }
      pushToast(`课程同步失败：${result.error ?? '请在站点登录后重试'}`, 'error');
    },
    syncSchedule: async (opts) => {
      const result = await ctx.syncSchedule(opts?.force ?? true);
      if (result.skipped) return;
      if (result.ok) {
        if (!opts?.quiet) {
          pushToast(
            result.count > 0 ? `已同步本周 ${result.count} 节课` : '本周暂无课程安排（或站点尚未开放课表）',
            result.count > 0 ? 'success' : 'info',
          );
        }
        return;
      }
      pushToast(`课表同步失败：${result.error ?? '请稍后重试'}`, 'error');
    },
    reloadSession: async () => {
      const courId = uiStore.getState().session?.courId;
      if (courId) await ctx.loadSession(courId);
    },
    selectCour: async (courId) => {
      ctx.resolver?.setManual(courId);
      ctx.setRoute({ ...ctx.route, courId });
      uiStore.patch({
        resolution: {
          phase: 'resolved',
          courId,
          evidence: 'manual',
          confidence: 'direct',
          candidates: ctx.getCandidates(),
        },
      });
      await ctx.loadSession(courId);
    },
    saveSetting: async (key, value) => {
      const next = await saveSettings({ [key]: value } as Partial<AppSettings>);
      ctx.settings = next;
      uiStore.patch({ settings: next });
    },
    openSessionInSite: (courId, teclId, extra) => {
      const state = uiStore.getState();
      if (state.session?.courId === courId && isPlayRoute(state.route)) {
        // 第 104 轮巡检：统一搜索命中本课次时带 anchorSec 直接落锚点秒数（无则维持回片头）
        ctx.actions.seek(extra?.anchorSec ?? 0);
        return;
      }
      const input = {
        teclId: teclId ?? ctx.route.teclId ?? state.session?.teclId,
        teclCode: extra?.teclCode ?? ctx.route.teclCode,
        subjId: extra?.subjId ?? ctx.route.subjId,
        courId,
        prefer: 'play-center' as const,
      };
      const hash = lessonHash(input);
      uiStore.patch({ centerOpen: false });
      if (location.hash === hash) {
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      } else {
        location.hash = hash;
      }
    },
  };
}
