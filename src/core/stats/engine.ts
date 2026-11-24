/**
 * 学习时长统计引擎（§4.3 统计口径 / §7 C1）。
 *
 * 口径（逐条实现，且为验收对照点）：
 *  1. 仅"播放中 + 页面前台可见 + 非挂机"累计；
 *  2. 累计的是**真实墙钟时间**，与倍速无关（2 倍速播放 60 秒只计 60 秒）；
 *  3. 挂机判定：页面**失去焦点**且 `idleThresholdMin`（默认 15 分钟）内无任何交互心跳
 *     （拖动/暂停/提问/收藏/笔记/大纲操作）→ 之后的时间不再累计；页面保持焦点时视为在学
 *     （专注观看不应被误判）；
 *  4. 跨零点按**本地时区**自然日拆分，一条记录不跨日；
 *  5. 单日封顶 16 小时：达到上限后仍继续写流水，但 `valid=false`（审计可见、不进报表）；
 *  6. 重复观看重复计。
 *
 * 引擎不含 IO：时间由调用方注入，落库由调用方消费返回的记录，便于单元测试。
 */

import type { WatchRecordEntity } from '../shared/types';
import { STATS_LIMITS } from '../shared/constants';
import { localDayKey, startOfLocalDay } from '../shared/utils';

export interface TickInput {
  courId: number;
  teclId: number;
  /** 当前时间戳（毫秒） */
  now: number;
  state: { currentTime: number; duration: number; paused: boolean; rate: number };
  visible: boolean;
  focused: boolean;
  /** 本 tick 是否携带用户交互（拖动/暂停/提问/收藏/笔记等） */
  interacted: boolean;
}

export interface EngineOptions {
  idleThresholdSec: number;
  dailyCapSec?: number;
  /** 单个 tick 最多计入的墙钟毫秒（防止休眠/进程挂起后的时间跳跃被计入） */
  maxTickGapMs?: number;
  /** 小于该秒数的分片丢弃（避免产生大量碎片记录） */
  minSegmentSec?: number;
}

export interface ClosedSegment {
  courId: number;
  teclId: number;
  date: string;
  startTs: number;
  endTs: number;
  durationSec: number;
  speed: number;
  firstWatch: boolean;
  valid: boolean;
  reason: 'pause' | 'hidden' | 'unfocused-idle' | 'midnight' | 'switch' | 'gap' | 'flush' | 'capped';
}

interface OpenSegment {
  courId: number;
  teclId: number;
  startTs: number;
  lastTs: number;
  /** 本段总墙钟时长 */
  durationMs: number;
  /** 其中计入有效学习的部分（达到单日封顶前的部分） */
  validMs: number;
  /** 达到单日封顶后的部分（仍写流水，但 valid=false） */
  invalidMs: number;
  speed: number;
}

interface SessionRuntime {
  lastInteractionTs: number;
  seenValid: boolean;
}

const DEFAULTS = {
  dailyCapSec: STATS_LIMITS.dailyCapSec,
  maxTickGapMs: 2000,
  minSegmentSec: 1,
};

export class StatsEngine {
  private readonly opts: Required<EngineOptions>;
  private open: OpenSegment | null = null;
  private readonly sessions = new Map<number, SessionRuntime>();
  /** 每个自然日已累计的有效秒数（引擎自记账；可由 seedDayTotal 注入历史值） */
  private readonly dayTotals = new Map<string, number>();

  constructor(options: EngineOptions) {
    this.opts = { ...DEFAULTS, ...options };
  }

  /** 注入某日的历史累计（用于封顶判断；由 SW 首次启动时从 DB 载入） */
  seedDayTotal(date: string, sec: number): void {
    this.dayTotals.set(date, Math.max(this.dayTotals.get(date) ?? 0, sec));
  }

  /** 记录一次用户交互（提问/收藏/笔记/大纲/播放控制等） */
  noteInteraction(courId: number, now = Date.now()): void {
    this.runtime(courId).lastInteractionTs = now;
  }

  /** 处理一次心跳，返回本次需要落库的记录（可能为空，跨零点时可能多条） */
  tick(input: TickInput): ClosedSegment[] {
    const { courId, teclId, now, state, visible, focused, interacted } = input;
    const rt = this.runtime(courId);
    if (interacted) rt.lastInteractionTs = now;
    if (focused) rt.lastInteractionTs = now;

    const idle = !focused && now - rt.lastInteractionTs > this.opts.idleThresholdSec * 1000;
    const validNow = !state.paused && visible && !idle;

    // 切换课次：先结算旧段
    const closed: ClosedSegment[] = [];
    if (this.open && this.open.courId !== courId) {
      closed.push(...this.closeSegment('switch'));
    }

    if (!validNow) {
      const reason: ClosedSegment['reason'] = state.paused
        ? 'pause'
        : !visible
          ? 'hidden'
          : idle
            ? 'unfocused-idle'
            : 'gap';
      closed.push(...this.closeSegment(reason));
      return closed;
    }

    // 时间跳跃（休眠 / 进程挂起 / 心跳丢失）：结算旧段并重新开段
    if (this.open && now - this.open.lastTs > this.opts.maxTickGapMs) {
      closed.push(...this.closeSegment('gap'));
    }

    if (!this.open) {
      this.open = {
        courId,
        teclId,
        startTs: now,
        lastTs: now,
        durationMs: 0,
        validMs: 0,
        invalidMs: 0,
        speed: state.rate > 0 ? state.rate : 1,
      };
      return closed;
    }

    // 有效播放：按墙钟累计，必要时跨越零点拆分。
    // 单日封顶只影响"达到上限之后"的部分：同一段内可能既有有效部分又有封顶后的审计部分，
    // 结算时按封顶点拆成两条流水（不能把整段一起判为 invalid）。
    let remaining = Math.min(now - this.open.lastTs, this.opts.maxTickGapMs);
    while (remaining > 0 && this.open) {
      const open: OpenSegment = this.open;
      const midnight = this.nextMidnight(open.lastTs);
      const take = Math.min(remaining, midnight - open.lastTs);
      const date = localDayKey(open.startTs);
      const totalBefore = this.dayTotals.get(date) ?? 0;
      const capRemainingMs = Math.max(0, (this.opts.dailyCapSec - totalBefore) * 1000);
      const validTake = Math.min(take, capRemainingMs);
      const invalidTake = take - validTake;

      open.durationMs += take;
      open.validMs += validTake;
      open.invalidMs += invalidTake;
      open.lastTs += take;
      if (validTake > 0) {
        this.dayTotals.set(date, totalBefore + validTake / 1000);
      }
      remaining -= take;

      if (open.lastTs >= midnight) {
        // 结算零点前的部分，并从零点重新开段
        closed.push(...this.closeSegment('midnight'));
        this.open = {
          courId,
          teclId,
          startTs: midnight,
          lastTs: midnight,
          durationMs: 0,
          validMs: 0,
          invalidMs: 0,
          speed: open.speed,
        };
      }
    }
    return closed;
  }

  /** 主动结算（暂停、页面卸载、路由切换时调用） */
  flush(reason: ClosedSegment['reason'] = 'flush'): ClosedSegment[] {
    return this.closeSegment(reason);
  }

  /** 当前打开段的实时信息（UI 显示"本次已学"） */
  peek(): { courId: number; startTs: number; durationSec: number } | null {
    if (!this.open) return null;
    return {
      courId: this.open.courId,
      startTs: this.open.startTs,
      durationSec: Math.round(this.open.validMs / 1000),
    };
  }

  /** 某课次在本次会话中的实时累计（权威值以 DB 为准） */
  liveValidSec(courId: number): number {
    return this.open?.courId === courId ? Math.round(this.open.validMs / 1000) : 0;
  }

  // ───────────────────────── 内部 ─────────────────────────

  private runtime(courId: number): SessionRuntime {
    let rt = this.sessions.get(courId);
    if (!rt) {
      rt = { lastInteractionTs: Date.now(), seenValid: false };
      this.sessions.set(courId, rt);
    }
    return rt;
  }

  private closeSegment(reason: ClosedSegment['reason']): ClosedSegment[] {
    const seg = this.open;
    if (!seg) return [];
    this.open = null;
    const durationSec = seg.durationMs / 1000;
    if (durationSec < this.opts.minSegmentSec) {
      // 过短的分片：丢弃并从当日总量中扣回有效部分，保持记账一致
      const date = localDayKey(seg.startTs);
      this.dayTotals.set(date, Math.max(0, (this.dayTotals.get(date) ?? 0) - seg.validMs / 1000));
      return [];
    }

    const rt = this.runtime(seg.courId);
    const out: ClosedSegment[] = [];
    const round = (ms: number) => Math.round((ms / 1000) * 100) / 100;

    // 有效部分：段首 → 封顶点（或段尾）
    if (seg.validMs > 0) {
      const firstWatch = !rt.seenValid;
      rt.seenValid = true;
      out.push({
        courId: seg.courId,
        teclId: seg.teclId,
        date: localDayKey(seg.startTs),
        startTs: seg.startTs,
        endTs: seg.startTs + seg.validMs,
        durationSec: round(seg.validMs),
        speed: seg.speed,
        firstWatch,
        valid: true,
        reason,
      });
    }

    // 封顶后的部分：仅审计，不进报表
    if (seg.invalidMs > 0) {
      out.push({
        courId: seg.courId,
        teclId: seg.teclId,
        date: localDayKey(seg.startTs + seg.validMs),
        startTs: seg.startTs + seg.validMs,
        endTs: seg.lastTs,
        durationSec: round(seg.invalidMs),
        speed: seg.speed,
        firstWatch: false,
        valid: false,
        reason,
      });
    }
    return out;
  }

  /** 下一个本地零点 */
  private nextMidnight(ts: number): number {
    const d = new Date(startOfLocalDay(ts));
    d.setDate(d.getDate() + 1);
    return d.getTime();
  }
}

/** 引擎产物 → 待落库实体 */
export function toWatchRecord(segment: ClosedSegment): WatchRecordEntity {
  return {
    courId: segment.courId,
    teclId: segment.teclId,
    date: segment.date,
    startTs: segment.startTs,
    endTs: segment.endTs,
    durationSec: segment.durationSec,
    playMode: 'vod',
    speed: segment.speed,
    firstWatch: segment.firstWatch,
    valid: segment.valid,
  };
}
