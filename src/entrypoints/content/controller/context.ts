import type { AppSettings, RouteInfo, SessionListItem, SessionMeta } from '@/core/shared/types';
import type { CourseSyncResult, ScheduleSyncResult } from './dom';
import type { PlayerHandle } from '../site/player';
import type { SessionResolver } from '../site/sessionResolve';
import type { UiActions } from '../ui/store';

/**
 * ControllerContext：主控制器注入给 controller/ 子模块的窄接口。
 *
 * - 仅类型、零运行时依赖：子模块只允许 import 本文件与叶子模块（dom/site/ui/shared），
 *   子模块互调一律经 ctx 方法，防止与主控制器循环 import；
 * - 成员按拆分批次按需生长，命名一旦定义保持稳定；
 * - settings/route 是活引用（applySettings/applyRoute 等会整体重赋值），
 *   子模块严禁缓存快照，必须每次经 getter 读取。
 */
export interface ControllerContext {
  /** 全局设置（活引用；persistPanelPreference/saveSetting 会整体重赋值） */
  get settings(): AppSettings;
  set settings(next: AppSettings);
  /** 当前路由信息（活引用；applyRoute/selectCour 会重赋值） */
  get route(): RouteInfo;
  /** 控制器是否已销毁（dispose 后不再执行任何站点/后台交互） */
  get disposed(): boolean;
  /** 当前播放器句柄（非播放页/路由 teardown 后为 null） */
  get player(): PlayerHandle | null;
  /** 当前会话元数据（课次识别完成前为 null） */
  get meta(): SessionMeta | null;
  /** 会话识别器（路由销毁后置空） */
  get resolver(): SessionResolver | null;
  /** uiStore 动作集（挂载在控制器上，D13 的实现） */
  get actions(): UiActions;
  /** 最近用户交互心跳时间戳（markInteraction 写入） */
  get lastInteractionAt(): number;
  /** 播放器/进度条/右栏矩形缓存（updateRects 写入，applyRoute 重置） */
  get rectCache(): { video: string; timeline: string; rail: string };
  /** 收口 lastInteractionAt 写入（用户交互心跳） */
  markInteraction(): void;
  /** 注册随路由销毁的清理（pageCleanups：锚点/观察器等页面级资源） */
  registerPageCleanup(cleanup: () => void): void;
  /** 注册随控制器销毁的清理（globalCleanups：全局监听等） */
  registerGlobalCleanup(cleanup: () => void): void;
  /** 当前课次 ID（已识别会话优先，识别中回落 resolution.courId） */
  getCourId(): number | undefined;
  /** 播放页会话重识别编排（重入守卫在控制器实现内，第 4 批迁 playPage） */
  resolveAndLoad(reason: string): Promise<void>;
  /** 统计结算 stats.flush（reason 仅用于日志） */
  flushStats(reason: 'pause' | 'hidden' | 'switch' | 'flush'): Promise<void>;
  /** ASR 窗口自动跟进 tick（followBusy 防重入在实现内） */
  followTick(): Promise<void>;
  // ───────── 第 4 批生长（playPage / sessionData / actions）─────────
  /** 播放页会话候选（loadCandidates 写入、applyRoute 重置；resolveAndLoad 消费） */
  getCandidates(): SessionListItem[];
  setCandidates(list: SessionListItem[]): void;
  /** 挂载播放器句柄 / 会话识别器（initPlayPage 赋值，teardownPage 摘除） */
  setPlayer(player: PlayerHandle | null): void;
  setResolver(resolver: SessionResolver | null): void;
  /** 会话元数据写入（loadSession 装载成功 / applyRoute 重置） */
  setMeta(meta: SessionMeta | null): void;
  /** 路由整体重赋值（resolveAndLoad 命中新媒体课次 / selectCour 手动选课） */
  setRoute(next: RouteInfo): void;
  /** 页面级定时器注册（teardownPage 统一清理；playPage 的 tick/follow/延时任务） */
  registerPageInterval(id: number): void;
  registerPageTimeout(id: number): void;
  /** 播放器状态同步与矩形测量（playerSync 转发；initPlayPage 事件回调用） */
  syncFromPlayer(): void;
  updateRects(): void;
  /** 注入式 UI 锚点（anchors 转发；initPlayPage 装配） */
  ensurePlayHeaderAnchor(): void;
  ensureAnchorProbe(): void;
  /**
   * 会话装载竞态守卫（R1）：loadToken 留在控制器实现内，playPage/sessionData
   * 只经这三个方法访问，禁止自行 ++loadToken。
   */
  nextLoadToken(): number;
  isLoadTokenCurrent(token: number): boolean;
  currentLoadToken(): number;
  /** D7/D8/D13 互调统一走 ctx（防循环 import） */
  loadCandidates(): Promise<void>;
  loadSession(courId: number): Promise<void>;
  loadRelated(courId: number, token: number): Promise<void>;
  /** 页面→后台消息（messaging 转发；loadSession/setPanelOpen 接线） */
  sendPageContext(): Promise<void>;
  sendSessionMeta(meta: SessionMeta): Promise<void>;
  sendPanelState(open: boolean): Promise<void>;
  persistPanelPreference(open: boolean): void;
  /** 站点只读同步（siteSync 转发；D13 syncCourses/syncSchedule 用） */
  syncSiteCache(force: boolean): Promise<CourseSyncResult>;
  syncSchedule(force: boolean): Promise<ScheduleSyncResult>;
  /** 新鲜视频直链（asrFollow 转发；D13 startTranscribe/capture 用） */
  freshAudio(viewNum: number): Promise<{ url: string; viewNum: number; durationSec: number } | null>;
}
