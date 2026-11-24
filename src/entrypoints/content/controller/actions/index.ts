/**
 * uiStore 动作组装（D13，第 45 轮自 content/index.tsx 纯搬移拆分）：
 * 按内聚块分为 panel（面板/学习中心 UI）、session（会话/课程编排）、
 * av（播放控制/转写/问答/截图/检索）、notes（笔记与三类收藏）四文件，
 * 此处按 UiActions 全量键组装（缺键由 satisfies 在编译期暴露）。
 */

import { avActions } from './av';
import { noteActions } from './notes';
import { panelActions } from './panel';
import { sessionActions } from './session';
import type { UiActions } from '../../ui/store';
import type { ControllerContext } from '../context';

export function createActions(ctx: ControllerContext): UiActions {
  const actions = {
    ...panelActions(ctx),
    ...sessionActions(ctx),
    ...avActions(ctx),
    ...noteActions(ctx),
  };
  return actions satisfies UiActions;
}
