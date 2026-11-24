/**
 * 片段流式"浏览时跟进"决策器测试（§5.2 B1）。
 *
 * `tickFollow` 是纯函数：显式传入 now / 播放位置 / 覆盖情况 / 记忆，逐条验证
 * 禁用模式、暂停与不可见、窗口覆盖、节流、退避、最大尝试次数、拖动重置、
 * 取消抑制与会话切换。
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/core/shared/constants';
import {
  FollowTracker,
  decideFollow,
  emptyFollowMemory,
  followRangeKey,
  noteFollowCancelled,
  noteFollowDone,
  noteFollowFailed,
  noteFollowStarted,
  tickFollow,
  type FollowMemory,
  type FollowSettings,
  type FollowTickInput,
} from '@/core/asr/follow';
import { ASR_PARAMS } from '@/core/shared/constants';

const NOW = 1_800_000_000_000;

function makeSettings(patch: { a?: boolean; windowMode?: 'full' | 'around'; streamFollow?: boolean } = {}): FollowSettings {
  return {
    modules: {
      a: patch.a ?? true,
      b: true,
      c: true,
      d: true,
      incentive: true,
    },
    asr: {
      ...DEFAULT_SETTINGS.asr,
      windowMode: patch.windowMode ?? 'around',
      streamFollow: patch.streamFollow ?? true,
      windowMinutes: 10,
    },
  };
}

function makeInput(overrides: Partial<FollowTickInput> = {}): FollowTickInput {
  return {
    now: NOW,
    settings: makeSettings(),
    aroundSec: 1500,
    paused: false,
    visible: true,
    durationSec: 2820,
    chunkSec: 600,
    windowHalfSec: 600,
    ...overrides,
  };
}

describe('follow 禁用模式', () => {
  it('模块 A 关闭 / 整段模式 / 未开启后台跟进 均不启动', () => {
    expect(tickFollow(makeInput({ settings: makeSettings({ a: false }) })).reason).toBe('disabled');
    expect(tickFollow(makeInput({ settings: makeSettings({ windowMode: 'full' }) })).reason).toBe('disabled');
    expect(tickFollow(makeInput({ settings: makeSettings({ streamFollow: false }) })).reason).toBe('disabled');
  });

  it('显式 enabled=false 优先于任何设置', () => {
    const decision = tickFollow(makeInput({ enabled: false }));
    expect(decision.start).toBe(false);
    expect(decision.reason).toBe('disabled');
  });

  it('显式 enabled=true 可独立启用（旧调用口径）', () => {
    const decision = tickFollow(makeInput({ settings: undefined, enabled: true }));
    expect(decision.start).toBe(true);
    expect(decision.reason).toBe('start');
  });

  it('设置关闭时显式 enabled=true 也不得绕过模块边界', () => {
    const decision = tickFollow(makeInput({ settings: makeSettings({ a: false }), enabled: true }));
    expect(decision.start).toBe(false);
    expect(decision.reason).toBe('disabled');
  });
});

describe('播放状态阻断', () => {
  it('暂停或页面不可见 → away', () => {
    expect(tickFollow(makeInput({ paused: true })).reason).toBe('away');
    expect(tickFollow(makeInput({ visible: false })).reason).toBe('away');
  });

  it('时长未知 → no-duration', () => {
    expect(tickFollow(makeInput({ durationSec: 0 })).reason).toBe('no-duration');
  });

  it('作业运行中 → busy；作业暂停 → paused-job', () => {
    expect(tickFollow(makeInput({ jobStatus: 'queued' })).reason).toBe('busy');
    expect(tickFollow(makeInput({ jobStatus: 'extracting' })).reason).toBe('busy');
    expect(tickFollow(makeInput({ jobStatus: 'transcribing' })).reason).toBe('busy');
    expect(tickFollow(makeInput({ jobStatus: 'paused' })).reason).toBe('paused-job');
  });

  it('已完成/失败/取消的作业不阻断（失败由退避记忆处理）', () => {
    for (const status of ['done', 'failed', 'cancelled'] as const) {
      expect(tickFollow(makeInput({ jobStatus: status })).start).toBe(true);
    }
  });

  it('播放位置非法或窗口为空 → no-range', () => {
    const invalid = tickFollow(makeInput({ aroundSec: Number.NaN }));
    expect(invalid.reason).toBe('no-range');
    const empty = tickFollow(makeInput({ aroundSec: 500, windowHalfSec: 0 }));
    expect(empty.reason).toBe('no-range');
    expect(empty.window).toEqual({ start: 500, end: 500 });
  });
});

describe('窗口覆盖', () => {
  it('窗口内分片全部覆盖 → covered（索引口径）', () => {
    const decision = tickFollow(makeInput({ doneChunks: [1, 2, 3] }));
    expect(decision.start).toBe(false);
    expect(decision.reason).toBe('covered');
    expect(decision.missingChunks).toBe(0);
    expect(decision.plannedChunks).toBe(3);
    expect(decision.range).toEqual({ first: 1, last: 3 });
  });

  it('覆盖区间按并集判定（半开窗口、1s 容差）', () => {
    const decision = tickFollow(
      makeInput({
        coverage: [
          { startSec: 600, endSec: 1200 },
          { startSec: 1200, endSec: 2400 },
        ],
      }),
    );
    expect(decision.reason).toBe('covered');
    expect(decision.missing).toEqual([]);
  });

  it('覆盖区间之外的窗口空档仍待转', () => {
    const decision = tickFollow(makeInput({ coverage: [{ startSec: 0, endSec: 600 }] }));
    expect(decision.start).toBe(true);
    expect(decision.missing).toEqual([1, 2, 3]);
    expect(decision.missingChunks).toBe(3);
    expect(decision.window).toEqual({ start: 900, end: 2100 });
  });

  it('doneChunks 与 coverage 取并集', () => {
    const decision = tickFollow(
      makeInput({
        doneChunks: [2],
        coverage: [{ startSec: 1800, endSec: 2400 }],
      }),
    );
    expect(decision.start).toBe(true);
    expect(decision.missing).toEqual([1]);
  });

  it('窗口落在结尾时只规划相交分片', () => {
    const decision = tickFollow(makeInput({ aroundSec: 2800, coverage: [{ startSec: 1800, endSec: 2400 }] }));
    expect(decision.window).toEqual({ start: 2200, end: 2820 });
    expect(decision.plannedChunks).toBe(2); // 分片 3、4
    expect(decision.missing).toEqual([4]);
  });
});

describe('节流与退避', () => {
  it('两次自动启动至少间隔 20s（FollowTracker 自动记录）', () => {
    const tracker = new FollowTracker();
    const first = tracker.decide('course:1', makeInput());
    expect(first.start).toBe(true);
    expect(first.memory.lastStartAt).toBe(NOW);

    const early = tracker.decide('course:1', makeInput({ now: NOW + ASR_PARAMS.followMinIntervalMs - 1 }));
    expect(early.start).toBe(false);
    expect(early.reason).toBe('throttled');

    const later = tracker.decide('course:1', makeInput({ now: NOW + ASR_PARAMS.followMinIntervalMs }));
    expect(later.start).toBe(true);
  });

  it('失败按 45s 起步指数退避，退避期内不启动', () => {
    const tracker = new FollowTracker();
    tracker.noteFailed('course:2', NOW);
    expect(tracker.getMemory('course:2').failureCount).toBe(1);
    expect(tracker.decide('course:2', makeInput({ now: NOW + 1000 })).reason).toBe('backoff');
    expect(tracker.decide('course:2', makeInput({ now: NOW + ASR_PARAMS.followBackoffBaseMs + 1 })).start).toBe(true);
  });

  it('退避时长逐次翻倍且单次上限 10 分钟', () => {
    const first = noteFollowFailed(emptyFollowMemory(), NOW);
    expect(first.backoffUntil - NOW).toBe(45_000);
    const second = noteFollowFailed(first, NOW);
    expect(second.backoffUntil - NOW).toBe(45_000 + 90_000);
    const capped = noteFollowFailed({ ...emptyFollowMemory(), failureCount: 19 }, NOW);
    expect(capped.failureCount).toBe(20);
    expect(capped.backoffUntil - NOW).toBe(ASR_PARAMS.followBackoffMaxMs);
  });

  it('连续失败 4 次后停止自动尝试', () => {
    const tracker = new FollowTracker();
    for (let i = 0; i < ASR_PARAMS.followMaxAttempts; i += 1) tracker.noteFailed('course:3', NOW + i * 1000);
    expect(tracker.getMemory('course:3').failureCount).toBe(ASR_PARAMS.followMaxAttempts);
    const decision = tracker.decide('course:3', makeInput({ now: NOW + 24 * 3600_000 }));
    expect(decision.start).toBe(false);
    expect(decision.reason).toBe('backoff');
  });

  it('成功完成 / 手动启动清除失败计数与退避', () => {
    const failed = noteFollowFailed(noteFollowFailed(emptyFollowMemory(), NOW), NOW);
    const afterDone = noteFollowDone(failed);
    expect(afterDone.failureCount).toBe(0);
    expect(afterDone.backoffUntil).toBe(0);

    const tracker = new FollowTracker();
    for (let i = 0; i < ASR_PARAMS.followMaxAttempts; i += 1) tracker.noteFailed('course:4', NOW);
    tracker.noteManualStart('course:4');
    expect(tracker.decide('course:4', makeInput({ now: NOW + 1000 })).start).toBe(true);
  });

  it('noteFollowStarted 不清零失败计数（退避需要逐次增长）', () => {
    const failed = noteFollowFailed(emptyFollowMemory(), NOW);
    const started = noteFollowStarted(failed, NOW + 1000, '1:1-3');
    expect(started.failureCount).toBe(1);
    expect(started.lastStartAt).toBe(NOW + 1000);
    expect(started.lastRangeKey).toBe('1:1-3');
    expect(followRangeKey({ first: 1, last: 3 }, 2)).toBe('2:1-3');
  });
});

describe('取消抑制与重置', () => {
  it('用户取消后 10 分钟内不自动启动', () => {
    const tracker = new FollowTracker();
    tracker.noteCancelled('course:5', NOW);
    expect(tracker.getMemory('course:5').suppressUntil).toBe(NOW + ASR_PARAMS.followCancelCooldownMs);
    expect(tracker.decide('course:5', makeInput({ now: NOW + 60_000 })).reason).toBe('suppressed');
    expect(tracker.decide('course:5', makeInput({ now: NOW + ASR_PARAMS.followCancelCooldownMs + 1 })).start).toBe(true);
  });

  it('取消优先于退避，且取消本身清除退避', () => {
    const failed = noteFollowFailed(emptyFollowMemory(), NOW);
    const cancelled = noteFollowCancelled(failed, NOW + 1000);
    expect(cancelled.failureCount).toBe(0);
    expect(cancelled.backoffUntil).toBe(0);
    const decision = tickFollow(makeInput({ now: NOW + 2000 }), cancelled);
    expect(decision.reason).toBe('suppressed');
  });

  it('播放位置相对上一节拍移动 > 300s 视为拖动，重置退避与抑制', () => {
    const memory: FollowMemory = {
      ...emptyFollowMemory(),
      failureCount: ASR_PARAMS.followMaxAttempts,
      backoffUntil: NOW + 10 * 3600_000,
      suppressUntil: NOW + 10 * 3600_000,
      lastAroundSec: 100,
    };
    const decision = tickFollow(makeInput({ now: NOW, aroundSec: 1000 }), memory);
    expect(decision.start).toBe(true);
    expect(decision.memory.failureCount).toBe(0);
    expect(decision.memory.backoffUntil).toBe(0);
    expect(decision.memory.suppressUntil).toBe(0);
  });

  it('小范围移动不重置退避', () => {
    const memory: FollowMemory = {
      ...emptyFollowMemory(),
      failureCount: 1,
      backoffUntil: NOW + 30_000,
      lastAroundSec: 1500,
    };
    const decision = tickFollow(makeInput({ now: NOW, aroundSec: 1700 }), memory);
    expect(decision.reason).toBe('backoff');
    expect(decision.memory.lastAroundSec).toBe(1700);
  });

  it('换播放页会话（sessionId 变化）重置跟随时序记忆', () => {
    const tracker = new FollowTracker();
    expect(tracker.decide('session', makeInput({ sessionId: 's1' })).start).toBe(true);
    expect(tracker.decide('session', makeInput({ sessionId: 's1', now: NOW + 1000 })).reason).toBe('throttled');
    const switched = tracker.decide('session', makeInput({ sessionId: 's2', now: NOW + 2000 }));
    expect(switched.start).toBe(true);
    expect(switched.memory.lastSessionId).toBe('s2');
  });

  it('reset 清空单个/全部记忆', () => {
    const tracker = new FollowTracker();
    tracker.noteFailed('a', NOW);
    tracker.noteFailed('b', NOW);
    tracker.reset('a');
    expect(tracker.getMemory('a').failureCount).toBe(0);
    expect(tracker.getMemory('b').failureCount).toBe(1);
    tracker.reset();
    expect(tracker.getMemory('b').failureCount).toBe(0);
  });
});

describe('分组式入口 decideFollow', () => {
  it('按 playback 快照给出相同决策，并可注入 memory', () => {
    const start = decideFollow({
      settings: makeSettings(),
      playback: { aroundSec: 1500, paused: false, visible: true },
      durationSec: 2820,
      nowMs: NOW,
    });
    expect(start.start).toBe(true);
    expect(start.range).toEqual({ first: 1, last: 3 });

    const throttled = decideFollow({
      settings: makeSettings(),
      playback: { aroundSec: 1500, paused: false, visible: true },
      durationSec: 2820,
      nowMs: NOW + 1000,
      memory: start.memory,
    });
    expect(throttled.start).toBe(false);
    expect(throttled.reason).toBe('throttled');
  });

  it('FollowTracker.decideGrouped 自动记录启动并保持限流', () => {
    const tracker = new FollowTracker();
    const first = tracker.decideGrouped('grouped', {
      settings: makeSettings(),
      playback: { aroundSec: 1500, paused: false, visible: true },
      durationSec: 2820,
      nowMs: NOW,
    });
    expect(first.start).toBe(true);
    const second = tracker.decideGrouped('grouped', {
      settings: makeSettings(),
      playback: { aroundSec: 1500, paused: false, visible: true },
      durationSec: 2820,
      nowMs: NOW + 1000,
    });
    expect(second.reason).toBe('throttled');
  });
});
