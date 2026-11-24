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
import { applyDebugLogEnabled, createLogger } from '@/core/shared/logger';
import type {
  ContentToBackground,
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
import type { MediaKey } from '@/core/shared/mediaRef';
import { hduCourIdOf } from '@/core/shared/mediaRef';
import { alarms, closeOffscreen, ensureOffscreen, runtime, tabs } from '@/core/shared/runtime';
import { loadSettings } from '@/core/shared/settings';
import { uuid } from '@/core/shared/utils';
import { runScheduledTasks, registerDailyTodoNotificationClick, nextDailyTodoTriggerMs, nextDueTomorrowTriggerMs, syncDailyTodoAlarm, syncDueTomorrowAlarm, ALARM_NAMES } from './alarms';
import { onSettingsChanged } from '@/core/shared/settings';
import { handleOffscreenEvent, reconcileJobsOnStartup, warmup } from './asr';
import { handleLlmOffscreenEvent } from './llm';
import { dispatchOp, housekeeping } from './ops';
import { buildPopupOverview } from './popup';
import { handleShotResult } from './screenshot';
import { installSiteWatch } from './siteWatch';
import { statsService } from './stats';
import { registerTab, setPanelOpen, unregisterTab } from './tabs';

const log = createLogger('sw');

// ───────────────────────── 生命周期 ─────────────────────────

/** 注册全部监听与启动逻辑（WXT 要求入口使用 defineBackground） */
function setupBackground(): void {
  // SW 恢复审计（第 252 轮，职责划分裁决）：本扩展不注册 chrome.runtime.onInstalled /
  // onStartup——全部启动逻辑（监听器重挂 / alarms 对账 / housekeeping / offscreen 重建 /
  // 作业对账）在每次 SW 启动幂等执行，「每次启动即对账」覆盖 install / browser 重启 /
  // SW 回收三种情形，不会因漏挂 onInstalled 分支而丢初始化（审计盘点表记巡检日志第 252 轮）。
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

  // 每日待办提醒：`when` 对准下一个本地触发时刻（默认 20:00，可在设置中调整），之后每 24h 一次。
  // chrome.alarms 本身持久化，但 SW 每次启动都重建一次同 alarm（create 同名即替换），
  // 等价于对账：无论 SW 被回收/重载多少次，alarm 缺失即重建、存在则重新对准。
  alarms.create(ALARM_NAMES.dailyTodo, { when: nextDailyTodoTriggerMs(), periodInMinutes: 24 * 60 });
  // 明日到期提醒（第 243 轮巡检，默认关）：时刻 = 每日待办提醒 +30 分钟（联动其偏移）
  alarms.create(ALARM_NAMES.dueTomorrow, { when: nextDueTomorrowTriggerMs(), periodInMinutes: 24 * 60 });
  // 按当前设置对账提醒时刻（第 83 轮巡检：提醒时间可配置），并在设置变更时再次对账
  void syncDailyTodoAlarm();
  void syncDueTomorrowAlarm();
  onSettingsChanged((settings) => {
    void syncDailyTodoAlarm();
    void syncDueTomorrowAlarm();
    // 诊断日志开关热更（第 291 轮，工程域）：settings.debug.logEnabled → logger 全局开关
    applyDebugLogEnabled(settings.debug.logEnabled);
    // 统计引擎内存态对账（第 252 轮 SW 恢复审计缺口 B）：完看阈值热更，
    // 不等 SW 重启（见 statsService.applySettings 注释）
    statsService.applySettings(settings);
  });
  // 待办/明日到期通知点击 → 打开学习看板（SW 内 listener 需在顶层注册，随 SW 启动重挂）
  registerDailyTodoNotificationClick();
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
  // 设置读取自第 252 轮起纳入兜底（SW 恢复审计缺口 A）：此前 loadSettings 在 try 外，
  // storage 异常会让 void bootstrap() 落成未处理 rejection，且 autoWarmup 用户当次
  // SW 生命周期静默失去预热；失败降级为跳过预热，不影响其他启动链路
  try {
    const settings = await loadSettings();
    // 诊断日志开关初始应用（第 291 轮，工程域）
    applyDebugLogEnabled(settings.debug.logEnabled);
    if (settings.asr.autoWarmup) {
      void warmup();
    }
  } catch (err) {
    log.warn('启动设置读取失败，跳过 ASR 预热', err);
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

    // 内容脚本无法直接打开非 web_accessible 的扩展页（dashboard.html），经 SW 代开
    case 'OPEN_DASHBOARD':
      try {
        await tabs.create(runtime.getURL('dashboard.html'));
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

// ───────────────────────── 消息边界类型收窄（第 24 轮审计 P3 纵深防御） ─────────────────────────

/**
 * REQUEST args 中跨 op 复用的 id 类参数类型清单：
 *  - number 字段出现时必须是有限数值（Number.isFinite，拒 NaN / Infinity / 字符串数字）；
 *  - string 字段出现时必须是非空字符串。
 * 可选字段缺省（undefined）放行；度量类字段（durationSec / limit / seconds 等带
 * null / NaN 兜底语义）与实体字段不在此清单，仍由各 handler 防御式解析，不逐 op 重复校验。
 */
const OP_ARG_FIELD_TYPES: Readonly<Record<string, 'number' | 'string'>> = {
  courId: 'number',
  teclId: 'number',
  mediaId: 'number',
  upMid: 'number',
  mediaKey: 'string',
  bvid: 'string',
  favoriteId: 'string',
  id: 'string',
  jobId: 'string',
  planId: 'string',
  chatId: 'string',
  videoId: 'string',
  fromId: 'string',
  toId: 'string',
  // qa.list / qa.clear 的会话分组入参（第 27 轮审计 P3-2）：可选字段缺省放行，
  // 出现时必须是非空字符串（qa.ask 的 groupId 复用语义同源）
  groupId: 'string',
  // qa.ask 的提问文本（第 30 轮审计#5）：handler 第一步就 args.question.trim()，
  // 非字符串会直接 TypeError 落成 UNKNOWN 兜底；边界拒非串/空串与 handler 的
  // 「问题不能为空」语义一致（纯空白串仍放行，由 handler trim 后判空，行为不变）
  question: 'string',
  // 锚点时刻（第 30 轮审计#5）：qa.ask 顶层入参 + favorite/note 容器内同名字段。
  // qa.ask handler 直接拿它做窗口算术与 formatClock，非有限数必产生 NaN 窗口和
  // 「NaN:NaN」时刻文案（handler 未防御，属于"非法类型必坏"）；全仓调用点核查
  // （HDU ask/addNote/addTimeFavorite/favoriteChat/favoriteOutline、B 站面板
  // readVideoCurrentTime/buildMomentFavorite）均传有限数或整字段缺省，无合法
  // null 语义，故按有限数收窄；缺省（undefined）放行沿用既有口径
  anchorTime: 'number',
  // stats.period 的周期数（第 35 轮审计 P3-2 纵深防御）：可选字段，出现时必须是有
  // 限数——handler 会把它带进周期桶算术，NaN/Infinity 会产出空/异常报表
  count: 'number',
};

/** 携带 id 类字段的嵌套容器（handleRequest 注册标签页时也会读取 favorite/note 的 id 字段） */
const OP_ARG_NESTED_CONTAINERS: readonly string[] = ['favorite', 'note', 'filter'];

/**
 * REQUEST args 中的枚举类参数清单（第 28 轮 P3-2）：字段出现时取值必须命中白名单，
 * 可选缺省（undefined）放行。与 OP_ARG_FIELD_TYPES 同风格的消息边界收窄——
 * 非法档位在消息边界即拒绝，不进 handler。
 */
const OP_ARG_ENUM_FIELDS: Readonly<Record<string, readonly string[]>> = {
  // qa.ask / ai.generate 的上下文窗口档位（per-request 档位，第 27/28 轮）：
  // 仅这三档放行，空串 / 其他取值 / null 一律拒绝
  windowPreset: ['small', 'medium', 'large'],
  // kind 字段为 stats.period / stats.bili.overview（week|month）与 export.build
  // （cards|list|outline|backup）共用字段名（第 35 轮审计 P3-2 纵深防御）：
  // 白名单取两组合法值并集，任一 op 传越界值在消息边界即拒，不进 handler
  kind: ['week', 'month', 'cards', 'list', 'outline', 'backup'],
};

/**
 * 轻量校验 REQUEST args 的 id 类参数：合法返回 null，否则返回错误描述。
 * 只做一次 typeof / Number.isFinite 级别的扫描，不引入校验依赖。
 */
function validateOpArgs(op: unknown, args: unknown): string | null {
  if (args === null || args === undefined) return null;
  if (typeof args !== 'object' || Array.isArray(args)) return 'args 必须是对象';
  const containers: Array<Record<string, unknown>> = [args as Record<string, unknown>];
  for (const name of OP_ARG_NESTED_CONTAINERS) {
    const nested = (args as Record<string, unknown>)[name];
    if (nested !== null && nested !== undefined && typeof nested === 'object' && !Array.isArray(nested)) {
      containers.push(nested as Record<string, unknown>);
    }
  }
  for (const container of containers) {
    for (const [field, kind] of Object.entries(OP_ARG_FIELD_TYPES)) {
      const value = container[field];
      if (value === undefined) continue;
      if (kind === 'number') {
        if (typeof value !== 'number' || !Number.isFinite(value)) return `${String(op)}: ${field} 必须是有限数值`;
      } else if (typeof value !== 'string' || value.length === 0) {
        return `${String(op)}: ${field} 必须是非空字符串`;
      }
    }
    for (const [field, allowed] of Object.entries(OP_ARG_ENUM_FIELDS)) {
      const value = container[field];
      if (value === undefined) continue;
      if (!allowed.includes(value as string)) return `${String(op)}: ${field} 必须是 ${allowed.join('/')}`;
    }
  }
  return null;
}

/** 导出仅为单测（消息边界校验）；生产路径只经 handleMessage 进入 */
export async function handleRequest(message: RequestMessage, tabId: number | undefined): Promise<ResponseMessage> {
  const requestId = message.requestId ?? uuid();
  // id 类参数类型不合法直接拒绝，不进 handler（第 24 轮审计 P3）
  const invalidArgs = validateOpArgs(message.op, message.args);
  if (invalidArgs) {
    return {
      type: 'RESPONSE',
      requestId,
      ok: false,
      error: serializeError(new AppError('INVALID_INPUT', { detail: invalidArgs })),
    };
  }
  const args = (message.args ?? {}) as {
    courId?: number;
    mediaKey?: MediaKey;
    teclId?: number;
    favorite?: { courId?: number; teclId?: number };
    note?: { courId?: number; teclId?: number };
  };
  // SW 可能刚被回收重启：从请求参数顺带刷新标签页订阅，保证后续事件能送达。
  // 转写/问答/AI op 参数是 mediaKey，站内键反解出 courId 供统计/导航链路复用。
  const courId =
    args.courId ?? (args.mediaKey !== undefined ? hduCourIdOf(args.mediaKey) : undefined) ?? args.favorite?.courId ?? args.note?.courId;
  if (tabId !== undefined && (typeof courId === 'number' || typeof args.mediaKey === 'string')) {
    registerTab(tabId, {
      courId,
      mediaKey: args.mediaKey,
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

export { closeOffscreen, tabs as runtimeTabs };
