/**
 * uiStore 动作——面板与学习中心 UI 编排（D13 拆分，第 45 轮自 content/index.tsx
 * 纯搬移；面板开合经 ctx 上报状态与偏好落盘，logic/文案逐行未变）。
 */

import { pushToast } from '../../ui/components';
import { uiStore, type PanelTab, type UiActions } from '../../ui/store';
import type { ControllerContext } from '../context';

export function panelActions(ctx: ControllerContext): Pick<UiActions, 'setPanelOpen' | 'togglePanel' | 'setPanelTab' | 'openCourPicker' | 'closeCourPicker' | 'openCenter' | 'closeCenter' | 'setCenterView' | 'suppressCenter' | 'restoreCenter' | 'copyText' | 'showToast'> {
  return {
    setPanelOpen: (open) => {
      uiStore.patch({ panelOpen: open });
      ctx.persistPanelPreference(open);
      void ctx.sendPanelState(open);
    },
    togglePanel: () => {
      const open = !uiStore.getState().panelOpen;
      uiStore.patch({ panelOpen: open });
      ctx.persistPanelPreference(open);
      void ctx.sendPanelState(open);
    },
    setPanelTab: (tab: PanelTab) => uiStore.patch({ panelTab: tab }),
    openCourPicker: () => uiStore.patch({ courPickerOpen: true }),
    closeCourPicker: () => uiStore.patch({ courPickerOpen: false }),
    openCenter: (view) =>
      uiStore.patch({
        centerOpen: true,
        centerSuppressed: false,
        ...(view ? { centerView: view } : {}),
      }),
    closeCenter: () => uiStore.patch({ centerOpen: false }),
    setCenterView: (centerView) => uiStore.patch({ centerView }),
    suppressCenter: () => uiStore.patch({ centerSuppressed: true, centerOpen: false }),
    restoreCenter: () => uiStore.patch({ centerSuppressed: false, centerOpen: true }),
    copyText: async (text) => {
      try {
        await navigator.clipboard.writeText(text);
        pushToast('已复制', 'success');
      } catch {
        pushToast('复制失败，请手动选择文本', 'warn');
      }
    },
    showToast: (message, level) => pushToast(message, level ?? 'info'),
  };
}
