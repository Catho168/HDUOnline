/**
 * 知识点标注 + 内容大纲编排（A1/A2，§6.4①）。
 *
 * 流程：缓存检查 → 组装提示词 → 经 Offscreen 调 LLM → 校验（失败则纠错重试 1 次）
 *       → 落库 aiResults → 广播事件。
 *
 * 三种请求格式（anthropic-messages / openai-chat / openai-responses）由 Offscreen
 * 按 provider.kind 选择适配器；SW 只负责编排、校验与持久化。
 */

import { PROMPT_VERSION } from '@/core/shared/constants';
import { AppError, toAppError } from '@/core/shared/errors';
import { createLogger } from '@/core/shared/logger';
import { getActiveProvider, loadSecrets, loadSettings } from '@/core/shared/settings';
import type { AiResultEntity, LlmProviderConfig, TranscriptSegment } from '@/core/shared/types';
import { getAiResult, getSession, getTranscript, putAiResult } from '@/core/db/repo/content';
import { buildRetryInstruction, buildTopicsUserPrompt, TOPICS_SYSTEM_PROMPT } from '@/core/llm/prompts';
import { validateTopicsOutline } from '@/core/llm/validate';
import { runLlmViaOffscreen, abortLlmRun } from './llm';
import { emitToCour } from './tabs';

const log = createLogger('sw-ai');

/** 进行中的生成任务（courId → 取消标记 / Offscreen runId） */
const inflight = new Map<number, { aborted: boolean; startedAt: number; runId?: string }>();

export async function loadAiResult(courId: number): Promise<{ result: AiResultEntity | null; stale: boolean }> {
  return getAiResult(courId);
}

export async function generateTopics(courId: number, force = false): Promise<{ started: boolean; reason?: string }> {
  if (inflight.has(courId)) return { started: false, reason: '已有生成任务在进行中' };

  // ── 缓存命中（courId + promptVersion + model，§6.4③） ──
  const provider = await getActiveProvider();
  const cached = await getAiResult(courId);
  if (
    !force &&
    cached.result &&
    cached.result.promptVersion === PROMPT_VERSION &&
    provider &&
    cached.result.model === provider.model
  ) {
    log.info('AI 结果缓存命中', { courId });
    await emitToCour(courId, {
      name: 'AI_DONE',
      data: {
        courId,
        result: { topicCount: cached.result.topics.length, outlineCount: cached.result.outline.length, cached: true },
      },
    });
    return { started: true };
  }

  const transcript = await getTranscript(courId);
  if (!transcript || transcript.segments.length === 0) {
    throw new AppError('INVALID_INPUT', { userMessage: '尚无可用的转写文本，请先生成本节转写' });
  }
  if (!provider) {
    throw new AppError('LLM_NO_PROVIDER');
  }

  inflight.set(courId, { aborted: false, startedAt: Date.now() });
  // 异步执行，调用方（面板）通过事件接收进度
  void runGeneration(courId, transcript.segments, transcript.durationSec ?? 0, provider).catch(async (err) => {
    const aborted = inflight.get(courId)?.aborted === true;
    inflight.delete(courId);
    if (aborted) {
      log.info('生成已被取消，忽略失败', { courId });
      return;
    }
    const appErr = toAppError(err);
    log.warn('知识点生成失败', appErr.code);
    await emitToCour(courId, { name: 'AI_FAILED', data: { courId, error: appErr.toJSON() } });
  });
  return { started: true };
}

async function runGeneration(
  courId: number,
  segments: TranscriptSegment[],
  durationSec: number,
  provider: LlmProviderConfig,
): Promise<void> {
  const settings = await loadSettings();
  const secrets = await loadSecrets();
  const emitProgress = (stage: 'preparing' | 'requesting' | 'validating' | 'retrying', progress?: number) =>
    emitToCour(courId, { name: 'AI_PROGRESS', data: { courId, stage, progress } });

  await emitProgress('preparing');
  const userPrompt = buildTopicsUserPrompt(segments, durationSec);

  const run = (extraInstruction?: string) =>
    runLlmViaOffscreen({
      provider: {
        kind: provider.kind,
        baseUrl: provider.baseUrl,
        model: provider.model,
        apiKey: provider.apiKey,
      },
      timeouts: {
        connectMs: settings.llm.timeoutConnectMs,
        firstByteMs: settings.llm.timeoutFirstByteMs,
        totalMs: settings.llm.timeoutTotalMs,
      },
      allowLocalEndpoints: secrets.allowLocalEndpoints,
      system: TOPICS_SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: userPrompt },
        ...(extraInstruction ? ([{ role: 'user', content: extraInstruction }] as const) : []),
      ],
      maxTokens: 8192,
      temperature: settings.llm.temperature,
      jsonMode: true,
      // 生成时长可能较长：面板通过事件观察状态，不消费文本增量
      stream: false,
      onRunId: (runId) => {
        const entry = inflight.get(courId);
        if (!entry) return;
        entry.runId = runId;
        // 用户可能在提示词组装阶段就点了取消：一拿到 runId 立即转发
        if (entry.aborted) abortLlmRun(runId);
      },
    });

  await emitProgress('requesting');
  const first = await run();
  await emitProgress('validating');

  let validated;
  try {
    validated = validateTopicsOutline(first.text, durationSec, segments);
  } catch (err) {
    const appErr = toAppError(err, 'LLM_BAD_OUTPUT');
    // §6.4①：原样重试 1 次（追加纠错指令）
    await emitProgress('retrying');
    log.info('首次输出校验失败，追加纠错指令重试', appErr.detail);
    const second = await run(buildRetryInstruction(appErr.userMessage));
    validated = validateTopicsOutline(second.text, durationSec, segments);
  }

  const result: AiResultEntity = {
    courId,
    promptVersion: PROMPT_VERSION,
    model: provider.model,
    topics: validated.topics,
    outline: validated.outline,
    createdAt: Date.now(),
    warnings: validated.warnings,
  };
  if (inflight.get(courId)?.aborted) {
    log.info('生成已被取消，丢弃结果', { courId });
    inflight.delete(courId);
    return;
  }
  await putAiResult(result);
  inflight.delete(courId);

  await emitToCour(courId, {
    name: 'AI_DONE',
    data: {
      courId,
      result: { topicCount: result.topics.length, outlineCount: result.outline.length, cached: false },
    },
  });
}

export function abortGeneration(courId: number): void {
  const entry = inflight.get(courId);
  if (!entry) return;
  entry.aborted = true;
  // 请求已在 Offscreen 执行时立即中止；尚未拿到 runId 时由 onRunId 补发
  if (entry.runId) abortLlmRun(entry.runId);
}

/** 供面板/仪表盘判断是否可生成（LLM 是否已配置） */
export async function aiAvailability(): Promise<{ ok: boolean; message?: string }> {
  const provider = await getActiveProvider();
  if (!provider) return { ok: false, message: '尚未配置 AI 服务，请在设置中添加' };
  return { ok: true };
}

/** 会话元数据兜底：生成时若缺失时长，用转写覆盖范围兜底 */
export async function resolveDuration(courId: number, fallback: number): Promise<number> {
  if (fallback > 0) return fallback;
  const session = await getSession(courId).catch(() => null);
  return session?.durationSec ?? 0;
}
