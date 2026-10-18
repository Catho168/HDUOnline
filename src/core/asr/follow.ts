/**
 * 片段流式"浏览时跟进"的纯决策器（§5.2 B1）。
 *
 * 该模块**不访问任何扩展 API / IndexedDB / DOM**，只接收调用方整理好的快照，
 * 因此可以在 Node（vitest）里逐条验证限流、退避、抑制与窗口覆盖的边界。
 *
 * 调用方（SW）每个节拍提供：
 *  - 当前设置（模块 A、片段模式、后台跟进开关、片段半径）；
 *  - 播放器位置 / 暂停 / 可见性；
 *  - 课次时长、作业状态（仅作阻断判断）；
 *  - 当前机位已完成的 10 分钟分片覆盖（或引用实现的分片索引）；
 *  - 上次决策留下的 `FollowMemory`；
 *  - 当前时间 `now`（显式传入，保证可测）。
 *
 * 决策规则（与《技术实现文档》§5.2 及用户手册一致）：
 *  1. 仅在 模块 A 开启 + windowMode='around' + streamFollow 时工作；
 *  2. 暂停或页面不可见 → away；
 *  3. 时长未知 → no-duration；
 *  4. 作业运行中 → busy；作业暂停 → paused-job；
 *  5. 窗口内分片全部已覆盖 → covered；
 *  6. 两次自动启动至少间隔 20s（throttled）；
 *  7. 失败按 45s 起步指数退避，上限 10min；连续失败 4 次后停手（backoff）；
 *  8. 用户取消后 10min 内不再自动启动（suppressed）；
 *  9. 播放位置相对上一节拍移动 > 300s 视为拖动，重置退避/抑制；
 * 10. 换播放页会话（sessionId 变化）重置跟随时序记忆。
 */

import { ASR_PARAMS } from '../shared/constants';
import type { AppSettings, AsrJobStatus } from '../shared/types';
import {
  chunkInWindow,
  resolveWindow,
  windowChunkRange,
  windowHalfSecFromMinutes,
  type TranscribeWindow,
} from './window';

// ───────────────────────── 类型 ─────────────────────────

/** 与 ops.ts 中 `asr.follow` 的 reason 联合保持一致 */
export type FollowReason =
  | 'start'
  | 'disabled'
  | 'away'
  | 'no-duration'
  | 'busy'
  | 'paused-job'
  | 'no-range'
  | 'covered'
  | 'throttled'
  | 'backoff'
  | 'suppressed';

export interface ChunkCoverage {
  startSec: number;
  endSec: number;
}

/**
 * 跟进记忆（每个课次一份；仅存 SW 内存，SW 回收后自然重置）。
 * 字段全部为绝对值，便于直接序列化/日志展示。
 */
export interface FollowMemory {
  /** 上次自动作业启动时间（ms）；null = 从未启动 */
  lastStartAt: number | null;
  /** 上次自动作业覆盖的分片范围键（`viewNum:first-last`） */
  lastRangeKey: string | null;
  /** 连续失败次数（成功完成/拖动/手动转写后清零） */
  failureCount: number;
  /** 退避截止时间（ms） */
  backoffUntil: number;
  /** 取消抑制截止时间（ms） */
  suppressUntil: number;
  /** 上次观察到的播放位置（秒），用于识别拖动 */
  lastAroundSec: number | null;
  /** 上次观察到的播放页会话 */
  lastSessionId: string | null;
}

/** 设置输入：只需要模块开关与 asr 子项，允许直接传 AppSettings */
export type FollowSettings = Pick<AppSettings, 'modules' | 'asr'>;

export interface FollowPlayback {
  aroundSec: number;
  paused: boolean;
  visible: boolean;
}

export interface FollowTickInput {
  /** 决策时刻（ms）。省略时取 Date.now()；测试请显式传入 */
  now?: number;
  /** 完整设置（模块 A / 片段模式 / 后台跟进 / 半径） */
  settings?: FollowSettings;
  /**
   * 显式启用标志（引用实现的旧调用口径）。
   * 若同时提供 settings，仍会强制校验模块 A 与片段设置。
   */
  enabled?: boolean;
  aroundSec: number;
  paused: boolean;
  visible: boolean;
  durationSec: number;
  /** 作业状态；null/undefined/done/cancelled/failed 均不阻断（failed 由退避记忆处理） */
  jobStatus?: AsrJobStatus | null;
  /** 当前机位（默认 1） */
  viewNum?: number;
  /** 已完成分片索引（引用实现口径） */
  doneChunks?: number[];
  /** 已完成分片覆盖（本移植新增口径；与 doneChunks 求并集） */
  coverage?: ChunkCoverage[];
  /** 分片长度（默认 ASR_PARAMS.chunkSec） */
  chunkSec?: number;
  /** 片段半径（秒）；省略时由 settings.asr.windowMinutes 换算 */
  windowHalfSec?: number;
  /** 播放页会话标识（变化时重置时序记忆） */
  sessionId?: string;
}

/** 分组式输入（对应 `asr.follow` op 的语义） */
export interface FollowDecisionInput {
  settings: FollowSettings;
  playback: FollowPlayback;
  durationSec: number;
  jobStatus?: AsrJobStatus | null;
  coverage?: ChunkCoverage[];
  doneChunks?: number[];
  viewNum?: number;
  sessionId?: string;
  memory?: FollowMemory;
  /** 决策时刻（ms），省略取 Date.now() */
  nowMs?: number;
}

export interface FollowDecision {
  start: boolean;
  reason: FollowReason;
  /** 本次规划的窗口（进入可规划阶段后总是给出） */
  window?: TranscribeWindow;
  /** 窗口内待转分片索引 */
  missing: number[];
  /** 窗口内待转分片数 */
  missingChunks: number;
  /** 窗口内分片总数 */
  plannedChunks: number;
  /** 与窗口相交的分片闭区间 */
  range: { first: number; last: number } | null;
  /** 更新后的记忆（纯函数，不修改入参） */
  memory: FollowMemory;
}

// ───────────────────────── 记忆 ─────────────────────────

export function emptyFollowMemory(): FollowMemory {
  return {
    lastStartAt: null,
    lastRangeKey: null,
    failureCount: 0,
    backoffUntil: 0,
    suppressUntil: 0,
    lastAroundSec: null,
    lastSessionId: null,
  };
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeMemory(memory?: Partial<FollowMemory> | null): FollowMemory {
  const base = emptyFollowMemory();
  if (!memory) return base;
  return {
    lastStartAt:
      typeof memory.lastStartAt === 'number' && Number.isFinite(memory.lastStartAt)
        ? memory.lastStartAt
        : base.lastStartAt,
    lastRangeKey: typeof memory.lastRangeKey === 'string' ? memory.lastRangeKey : base.lastRangeKey,
    failureCount: Math.max(0, Math.floor(finiteNumber(memory.failureCount, 0))),
    backoffUntil: Math.max(0, finiteNumber(memory.backoffUntil, 0)),
    suppressUntil: Math.max(0, finiteNumber(memory.suppressUntil, 0)),
    lastAroundSec:
      typeof memory.lastAroundSec === 'number' && Number.isFinite(memory.lastAroundSec)
        ? memory.lastAroundSec
        : base.lastAroundSec,
    lastSessionId: typeof memory.lastSessionId === 'string' ? memory.lastSessionId : base.lastSessionId,
  };
}

/** 范围键：机位 + 分片闭区间（仅用于记忆展示/日志，不参与判定） */
export function followRangeKey(range: { first: number; last: number }, viewNum = 1): string {
  return `${viewNum}:${range.first}-${range.last}`;
}

/** 自动作业已发起：记录限流起点；**不清零失败计数**（退避要能逐次增长） */
export function noteFollowStarted(memory: FollowMemory, now: number, rangeKey?: string): FollowMemory {
  const current = normalizeMemory(memory);
  return {
    ...current,
    lastStartAt: finiteNumber(now, Date.now()),
    lastRangeKey: rangeKey ?? current.lastRangeKey,
  };
}

/** 用户手动发起转写：用户意图优先，解除取消抑制与退避 */
export function noteManualStart(memory: FollowMemory): FollowMemory {
  const current = normalizeMemory(memory);
  return {
    ...current,
    failureCount: 0,
    backoffUntil: 0,
    suppressUntil: 0,
    lastRangeKey: null,
  };
}

/** 自动作业成功完成：清退避与失败计数，保留限流起点 */
export function noteFollowDone(memory: FollowMemory): FollowMemory {
  const current = normalizeMemory(memory);
  return { ...current, failureCount: 0, backoffUntil: 0 };
}

/** 自动作业失败：指数退避（45s、90s、180s、360s……上限 10min） */
export function noteFollowFailed(memory: FollowMemory, now: number): FollowMemory {
  const current = normalizeMemory(memory);
  const failureCount = current.failureCount + 1;
  const delay = Math.min(
    ASR_PARAMS.followBackoffMaxMs,
    ASR_PARAMS.followBackoffBaseMs * 2 ** Math.min(20, failureCount - 1),
  );
  return {
    ...current,
    failureCount,
    backoffUntil: Math.max(finiteNumber(now, Date.now()), current.backoffUntil) + delay,
  };
}

/** 用户取消：10 分钟内不再自动启动；同时清退避，恢复后从干净状态开始 */
export function noteFollowCancelled(memory: FollowMemory, now: number): FollowMemory {
  const current = normalizeMemory(memory);
  return {
    ...current,
    failureCount: 0,
    backoffUntil: 0,
    suppressUntil: Math.max(finiteNumber(now, Date.now()), current.suppressUntil) + ASR_PARAMS.followCancelCooldownMs,
    lastRangeKey: null,
  };
}

// ───────────────────────── 决策 ─────────────────────────

const ACTIVE_JOB_STATUSES = new Set<AsrJobStatus>(['queued', 'extracting', 'transcribing']);
/** 覆盖判定容差：分片边界由浮点秒数换算而来，允许 1s 偏差 */
const COVERAGE_TOLERANCE_SEC = 1;

function settingsEnabled(settings?: FollowSettings): boolean | undefined {
  if (!settings) return undefined;
  // 模块 A 关闭时，任何自动转写都不得启动（§5.2 的模块边界）
  return (
    settings.modules?.a === true &&
    settings.asr.windowMode === 'around' &&
    settings.asr.streamFollow === true
  );
}

function resolveEnabled(input: FollowTickInput): boolean {
  const fromSettings = settingsEnabled(input.settings);
  if (input.enabled === false) return false;
  if (fromSettings === false) return false;
  return input.enabled === true || fromSettings === true;
}

function normalizeCoverage(coverage: ChunkCoverage[] | undefined): Array<{ start: number; end: number }> {
  if (!coverage || coverage.length === 0) return [];
  const out: Array<{ start: number; end: number }> = [];
  for (const item of coverage) {
    const start = Math.min(item.startSec, item.endSec);
    const end = Math.max(item.startSec, item.endSec);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) out.push({ start, end });
  }
  return out;
}

/**
 * 单步决策。
 *
 * @param input 调用方整理好的快照
 * @param memory 上次决策返回的记忆（首次传 emptyFollowMemory()）
 */
export function tickFollow(
  input: FollowTickInput,
  memory: FollowMemory = emptyFollowMemory(),
): FollowDecision {
  const now = finiteNumber(input.now, Date.now());
  let state = normalizeMemory(memory);
  const enabled = resolveEnabled(input);
  const durationSec = Math.max(0, finiteNumber(input.durationSec, 0));
  const chunkSec = Math.max(1, finiteNumber(input.chunkSec, ASR_PARAMS.chunkSec));
  const aroundValid = Number.isFinite(input.aroundSec);
  const aroundSec = aroundValid ? Math.max(0, input.aroundSec) : 0;

  // 换播放页会话：重置跟随时序记忆（避免上一页的限流/退避污染新页面）
  if (input.sessionId !== undefined && input.sessionId !== state.lastSessionId) {
    state = { ...emptyFollowMemory(), lastSessionId: input.sessionId };
  }

  // 拖动识别：与上一节拍位置相差 > 300s 视为 seek，恢复退避与取消抑制
  if (aroundValid) {
    if (
      state.lastAroundSec !== null &&
      Math.abs(aroundSec - state.lastAroundSec) > ASR_PARAMS.followSeekResetSec
    ) {
      state = { ...state, failureCount: 0, backoffUntil: 0, suppressUntil: 0 };
    }
    state = { ...state, lastAroundSec: aroundSec };
  }

  const quit = (
    reason: FollowReason,
    extra: Partial<Pick<FollowDecision, 'window' | 'range' | 'missing' | 'plannedChunks'>> = {},
  ): FollowDecision => {
    const missing = extra.missing ?? [];
    return {
      start: false,
      reason,
      memory: state,
      window: extra.window,
      range: extra.range ?? null,
      missing,
      missingChunks: missing.length,
      plannedChunks: extra.plannedChunks ?? 0,
    };
  };

  if (!enabled) return quit('disabled');
  if (input.paused || !input.visible) return quit('away');
  if (!(durationSec > 0)) return quit('no-duration');

  const status = input.jobStatus ?? null;
  if (status !== null && ACTIVE_JOB_STATUSES.has(status)) return quit('busy');
  if (status === 'paused') return quit('paused-job');

  if (!aroundValid) return quit('no-range');

  const halfSec =
    typeof input.windowHalfSec === 'number' && Number.isFinite(input.windowHalfSec)
      ? Math.max(0, input.windowHalfSec)
      : windowHalfSecFromMinutes(input.settings?.asr.windowMinutes);
  const window = resolveWindow(aroundSec, halfSec, durationSec);
  if (!(window.end > window.start)) return quit('no-range', { window });

  const range = windowChunkRange(window, durationSec, chunkSec);
  if (!range) return quit('no-range', { window });

  // 覆盖口径：分片索引（引用实现）与分片区间覆盖（本移植）取并集
  const doneSet = new Set((input.doneChunks ?? []).filter((n) => Number.isFinite(n)));
  const coverage = normalizeCoverage(input.coverage);
  const isCovered = (index: number, startSec: number, endSec: number): boolean => {
    if (doneSet.has(index)) return true;
    for (const span of coverage) {
      if (
        span.start <= startSec + COVERAGE_TOLERANCE_SEC &&
        span.end >= endSec - COVERAGE_TOLERANCE_SEC
      ) {
        return true;
      }
    }
    return false;
  };

  const missing: number[] = [];
  let plannedChunks = 0;
  for (let index = range.first; index <= range.last; index += 1) {
    // windowChunkRange 是粗区间：零宽窗口等边界情况下需要逐片复核
    if (!chunkInWindow(index, chunkSec, durationSec, window)) continue;
    plannedChunks += 1;
    const startSec = index * chunkSec;
    const endSec = Math.min(startSec + chunkSec, durationSec);
    if (!isCovered(index, startSec, Math.max(startSec, endSec))) missing.push(index);
  }

  const context = { window, range, missing, plannedChunks };
  if (plannedChunks === 0) return quit('no-range', context);
  if (missing.length === 0) return quit('covered', context);

  // 用户取消的优先级高于失败退避（显式意图优先）
  if (now < state.suppressUntil) return quit('suppressed', context);
  if (state.failureCount >= ASR_PARAMS.followMaxAttempts) return quit('backoff', context);
  if (now < state.backoffUntil) return quit('backoff', context);
  if (
    state.lastStartAt !== null &&
    now >= state.lastStartAt &&
    now - state.lastStartAt < ASR_PARAMS.followMinIntervalMs
  ) {
    return quit('throttled', context);
  }

  // 决策即启动：把本次启动写进记忆，保证重复调用天然满足 20s 限流。
  // （后台真正拿到直链后再调 noteFollowStarted 也只会把时间推后，不会放大退避。）
  const startedMemory = noteFollowStarted(
    state,
    now,
    followRangeKey(range, input.viewNum ?? 1),
  );

  return {
    start: true,
    reason: 'start',
    memory: startedMemory,
    window,
    range,
    missing,
    missingChunks: missing.length,
    plannedChunks,
  };
}

/**
 * 分组式便捷入口（对应 `asr.follow` op 的入参形状）：
 * 不维护跨调用记忆；后台需要持久跟进时请使用 `FollowTracker`。
 */
export function decideFollow(input: FollowDecisionInput): FollowDecision {
  return tickFollow(
    {
      now: input.nowMs,
      settings: input.settings,
      aroundSec: input.playback.aroundSec,
      paused: input.playback.paused,
      visible: input.playback.visible,
      durationSec: input.durationSec,
      jobStatus: input.jobStatus,
      viewNum: input.viewNum,
      coverage: input.coverage,
      doneChunks: input.doneChunks,
      sessionId: input.sessionId,
    },
    input.memory ?? emptyFollowMemory(),
  );
}

// ───────────────────────── 记忆容器（SW 侧使用） ─────────────────────────

export type FollowKey = string | number;

/**
 * 按课次保存跟进记忆的便捷容器。
 * `tickFollow` 在 start 时已经自动记录限流起点，本类只负责按 key 存取记忆。
 * SW 也可以只用上面的纯函数 + 自己的 Map；两者语义一致。
 */
export class FollowTracker {
  private readonly memories = new Map<FollowKey, FollowMemory>();

  /** 决策并写回该 key 的记忆 */
  decide(key: FollowKey, input: FollowTickInput): FollowDecision {
    const decision = tickFollow(input, this.memories.get(key) ?? emptyFollowMemory());
    this.memories.set(key, decision.memory);
    return decision;
  }

  /** 分组式决策并写回记忆 */
  decideGrouped(key: FollowKey, input: FollowDecisionInput): FollowDecision {
    const decision = decideFollow({ ...input, memory: this.memories.get(key) });
    this.memories.set(key, decision.memory);
    return decision;
  }

  noteStarted(key: FollowKey, now: number, rangeKey?: string): FollowMemory {
    const next = noteFollowStarted(this.memories.get(key) ?? emptyFollowMemory(), now, rangeKey);
    this.memories.set(key, next);
    return next;
  }

  noteManualStart(key: FollowKey): FollowMemory {
    const next = noteManualStart(this.memories.get(key) ?? emptyFollowMemory());
    this.memories.set(key, next);
    return next;
  }

  noteDone(key: FollowKey): FollowMemory {
    const next = noteFollowDone(this.memories.get(key) ?? emptyFollowMemory());
    this.memories.set(key, next);
    return next;
  }

  noteFailed(key: FollowKey, now: number): FollowMemory {
    const next = noteFollowFailed(this.memories.get(key) ?? emptyFollowMemory(), now);
    this.memories.set(key, next);
    return next;
  }

  noteCancelled(key: FollowKey, now: number): FollowMemory {
    const next = noteFollowCancelled(this.memories.get(key) ?? emptyFollowMemory(), now);
    this.memories.set(key, next);
    return next;
  }

  getMemory(key: FollowKey): FollowMemory {
    return { ...(this.memories.get(key) ?? emptyFollowMemory()) };
  }

  setMemory(key: FollowKey, memory: FollowMemory): void {
    this.memories.set(key, normalizeMemory(memory));
  }

  /** 重置单个课次；不传 key 时清空全部（SW 启动/课程切换时可用） */
  reset(key?: FollowKey): void {
    if (key === undefined) this.memories.clear();
    else this.memories.delete(key);
  }
}
