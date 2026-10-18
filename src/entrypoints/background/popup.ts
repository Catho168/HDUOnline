/** Popup 速览数据装配（§2.2 Popup/Options/Dashboard ↔ SW）。 */

import { getAsrJob } from '@/core/db/repo/asr';
import { getAiResult, getSession, getTranscript } from '@/core/db/repo/content';
import { getActiveProvider } from '@/core/shared/settings';
import type { PopupOverview } from '@/core/shared/types';
import { statsService } from './stats';
import { subscription } from './tabs';

/**
 * 组装 Popup 展示所需的全部数据（一次往返，避免 popup 打开时多次请求）。
 * courId 缺省时取该标签页当前订阅的课次。
 */
export async function buildPopupOverview(courIdArg: number | undefined, tabId: number | undefined): Promise<PopupOverview> {
  const sub = tabId !== undefined ? subscription(tabId) : undefined;
  const courId = courIdArg ?? sub?.courId;
  const pageKind = sub?.routeKind ?? null;
  if (courId === undefined) {
    return { session: null, transcript: null, ai: null, job: null, watchedSec: 0, watchRatio: 0, pageKind };
  }

  const [session, transcript, ai, job, provider, summary] = await Promise.all([
    getSession(courId).catch(() => null),
    getTranscript(courId).catch(() => null),
    getAiResult(courId).catch(() => ({ result: null, stale: false })),
    getAsrJob(courId).catch(() => null),
    getActiveProvider().catch(() => null),
    statsService.sessionSummary(courId).catch(() => ({ watchedSec: 0, watchRatio: 0, lastPositionSec: null })),
  ]);

  return {
    session: session
      ? {
          courId,
          teclId: session.teclId,
          courseName: session.courseName ?? '',
          teacherNames: [],
          durationSec: session.durationSec ?? 0,
          views: [],
          courLabel: session.courLabel ?? `课次 ${courId}`,
          letiNumber: session.letiNumber,
        }
      : null,
    transcript: transcript
      ? { exists: true, partial: transcript.partial === true, coveredSec: transcript.coveredSec ?? 0 }
      : { exists: false, partial: false, coveredSec: 0 },
    ai: {
      exists: ai.result !== null,
      stale: ai.stale || (ai.result !== null && provider !== null && ai.result.model !== provider.model),
      topicCount: ai.result?.topics.length ?? 0,
    },
    job,
    watchedSec: summary.watchedSec,
    watchRatio: summary.watchRatio,
    pageKind,
  };
}
