/**
 * 统计服务（SW 侧）：把 PLAYER_STATE 心跳喂给引擎，并把结算出的流水落库，
 * 同时回写 sessions 的完看度 / 观看状态 / 断点位置。
 */

import { STATS_LIMITS } from '@/core/shared/constants';
import { createLogger } from '@/core/shared/logger';
import { loadSettings } from '@/core/shared/settings';
import type { PlayerState } from '@/core/shared/types';
import { clamp, localDayKey } from '@/core/shared/utils';
import { getSession, patchSession } from '@/core/db/repo/content';
import { addWatchRecord, sumValidSecByDay, sumValidSecBySession } from '@/core/db/repo/stats';
import { StatsEngine, toWatchRecord, type ClosedSegment } from '@/core/stats/engine';
import { watchState } from '@/core/stats/aggregate';
import { emitToCour } from './tabs';

const log = createLogger('sw-stats');

interface TickArgs {
  courId: number;
  teclId: number;
  state: PlayerState;
  visible: boolean;
  focused: boolean;
  interacted: boolean;
}

class StatsService {
  private engine: StatsEngine | null = null;
  private finishThreshold = 0.9;
  private seededDay: string | null = null;
  /** 位置落库节流（§7 D1，默认 5s） */
  private lastPositionPersist = new Map<number, number>();

  async ensureEngine(): Promise<StatsEngine> {
    if (this.engine) return this.engine;
    const settings = await loadSettings();
    this.finishThreshold = settings.finishThreshold;
    this.engine = new StatsEngine({ idleThresholdSec: settings.idleThresholdMin * 60 });
    return this.engine;
  }

  /** 每次 SW 启动时用当日已有总量初始化封顶判断 */
  private async seedIfNeeded(engine: StatsEngine): Promise<void> {
    const today = localDayKey();
    if (this.seededDay === today) return;
    try {
      const total = await sumValidSecByDay(today);
      engine.seedDayTotal(today, total);
      this.seededDay = today;
    } catch (err) {
      log.warn('当日累计初始化失败', err);
    }
  }

  /** 记录一次交互心跳（提问/收藏/笔记/拖动等） */
  async interaction(courId: number): Promise<void> {
    const engine = await this.ensureEngine();
    engine.noteInteraction(courId);
  }

  async tick(args: TickArgs): Promise<void> {
    const engine = await this.ensureEngine();
    await this.seedIfNeeded(engine);
    const closed = engine.tick({
      courId: args.courId,
      teclId: args.teclId,
      now: Date.now(),
      state: args.state,
      visible: args.visible,
      focused: args.focused,
      interacted: args.interacted,
    });
    await this.persist(closed);
    await this.persistPosition(args);
  }

  /** 页面卸载 / 暂停 / 路由切换时结算 */
  async flush(courId?: number): Promise<void> {
    if (!this.engine) return;
    const peek = this.engine.peek();
    if (courId !== undefined && peek && peek.courId !== courId) return;
    const closed = this.engine.flush('flush');
    await this.persist(closed);
  }

  private async persistPosition(args: TickArgs): Promise<void> {
    const now = Date.now();
    const last = this.lastPositionPersist.get(args.courId) ?? 0;
    if (now - last < STATS_LIMITS.positionPersistSec * 1000) return;
    this.lastPositionPersist.set(args.courId, now);
    try {
      await patchSession(args.courId, {
        teclId: args.teclId,
        lastPositionSec: Math.floor(args.state.currentTime),
        durationSec: args.state.duration > 0 ? Math.floor(args.state.duration) : undefined,
      });
    } catch (err) {
      log.warn('断点位置落库失败', err);
    }
  }

  private async persist(closed: ClosedSegment[]): Promise<void> {
    if (closed.length === 0) return;
    const touched = new Set<number>();
    for (const segment of closed) {
      try {
        await addWatchRecord(toWatchRecord(segment));
      } catch (err) {
        log.warn('观看流水落库失败', err);
        continue;
      }
      touched.add(segment.courId);
      await this.refreshSessionStats(segment);
    }
    // 面板/学习中心据此刷新（结算后才会触发，频率与暂停/切课一致）
    for (const courId of touched) {
      await emitToCour(courId, { name: 'STATS_UPDATED', data: { courId } });
    }
  }

  /** 回写完看度与观看状态 */
  private async refreshSessionStats(segment: ClosedSegment): Promise<void> {
    try {
      if (!segment.valid) return;
      const session = await getSession(segment.courId);
      if (!session) return;
      const [watchedSec, durationSec] = await Promise.all([
        sumValidSecBySession(segment.courId),
        Promise.resolve(session.durationSec ?? 0),
      ]);
      const ratio = durationSec > 0 ? clamp(watchedSec / durationSec, 0, 1) : 0;
      await patchSession(segment.courId, {
        watchRatio: ratio,
        watchState: watchState(watchedSec, durationSec, this.finishThreshold),
        firstWatchedAt: session.firstWatchedAt ?? segment.startTs,
      });
    } catch (err) {
      log.warn('完看度回写失败', err);
    }
  }

  /** 课次实时汇总（面板顶部展示用） */
  async sessionSummary(courId: number): Promise<{ watchedSec: number; watchRatio: number; lastPositionSec: number | null }> {
    const session = await getSession(courId);
    const watchedSec = await sumValidSecBySession(courId);
    const durationSec = session?.durationSec ?? 0;
    return {
      watchedSec,
      watchRatio: durationSec > 0 ? clamp(watchedSec / durationSec, 0, 1) : 0,
      lastPositionSec: session?.lastPositionSec ?? null,
    };
  }
}

export const statsService = new StatsService();
