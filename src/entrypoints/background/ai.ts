/**
 * 知识点标注 + 内容大纲编排（A1/A2，§6.4①）。
 *
 * 流程：缓存检查 → 组装提示词 → 经 Offscreen 调 LLM → 校验（失败则纠错重试 1 次）
 *       → 落库 aiResults → 广播事件。
 *
 * 三种请求格式（anthropic-messages / openai-chat / openai-responses）由 Offscreen
 * 按 provider.kind 选择适配器；SW 只负责编排、校验与持久化。
 *
 * 上下文窗口档位（第 28 轮，第 27 轮建议 4）：ai.generate 支持可选 per-request
 * windowPreset（协议与 qa.ask 对齐），缺省回落全局设置；标注无锚点窗口，档位落到
 * 提示词分块粒度（见 runGeneration），HDU 侧不传参行为不变。
 */

import { PROMPT_VERSION, resolveContextWindowPreset } from '@/core/shared/constants';
import { AppError, toAppError } from '@/core/shared/errors';
import { createLogger } from '@/core/shared/logger';
import { hduCourIdOf, type MediaKey } from '@/core/shared/mediaRef';
import { getActiveProvider, loadSecrets, loadSettings } from '@/core/shared/settings';
import type { AiResultEntity, ContextWindowPreset, LlmProviderConfig, TranscriptSegment } from '@/core/shared/types';
import { getAiResult, putAiResult } from '@/core/db/repo/content';
import { buildRetryInstruction, buildTopicsUserPrompt, TOPICS_SYSTEM_PROMPT } from '@/core/llm/prompts';
import { validateTopicsOutline } from '@/core/llm/validate';
import { runLlmViaOffscreen, abortLlmRun } from './llm';
import { getAiResultWithDemo, getTranscriptWithDemo } from './demoFallback';
import { emitToCour } from './tabs';

const log = createLogger('sw-ai');

/** 进行中的生成任务（mediaKey → 取消标记 / Offscreen runId） */
const inflight = new Map<MediaKey, { aborted: boolean; startedAt: number; runId?: string }>();

/** 标注提示词的既有分块粒度（10 分钟块；未显式选档时保持不变，HDU 零变化） */
const DEFAULT_TOPICS_BLOCK_SEC = 600;

/**
 * 显式携带 windowPreset 时的标注提示词分块粒度映射（第 28 轮）：档位语义与问答
 * 上下文窗口对齐（小=更紧凑 / 大=更宽裕），落到标注侧即提示词按 5/10/20 分钟分块。
 * 只影响提示词的组织粒度，不裁剪转写内容（标注仍面向全片，无锚点窗口）。
 */
const TOPIC_BLOCK_SEC_BY_PRESET: Record<ContextWindowPreset, number> = {
  small: 300,
  medium: 600,
  large: 1200,
};

export async function loadAiResult(mediaKey: MediaKey): Promise<{ result: AiResultEntity | null; stale: boolean }> {
  return getAiResultWithDemo(mediaKey);
}

export async function generateTopics(
  mediaKey: MediaKey,
  force = false,
  windowPreset?: ContextWindowPreset,
): Promise<{ started: boolean; reason?: string }> {
  if (inflight.has(mediaKey)) return { started: false, reason: '已有生成任务在进行中' };

  // ── 缓存命中（mediaKey + promptVersion + model，§6.4③） ──
  const provider = await getActiveProvider();
  const cached = await getAiResult(mediaKey);
  if (
    !force &&
    cached.result &&
    cached.result.promptVersion === PROMPT_VERSION &&
    provider &&
    cached.result.model === provider.model
  ) {
    log.info('AI 结果缓存命中', { mediaKey });
    await emitToCour(mediaKey, {
      name: 'AI_DONE',
      data: {
        mediaKey,
        result: { topicCount: cached.result.topics.length, outlineCount: cached.result.outline.length, cached: true },
      },
    });
    return { started: true };
  }

  const transcript = await getTranscriptWithDemo(mediaKey);
  if (!transcript || transcript.segments.length === 0) {
    throw new AppError('INVALID_INPUT', { userMessage: '尚无可用的转写文本，请先生成本节转写' });
  }
  if (!provider) {
    throw new AppError('LLM_NO_PROVIDER');
  }

  inflight.set(mediaKey, { aborted: false, startedAt: Date.now() });
  // 异步执行，调用方（面板）通过事件接收进度；per-request 档位随任务透传（第 28 轮）
  void runGeneration(mediaKey, transcript.segments, transcript.durationSec ?? 0, provider, windowPreset).catch(
    async (err) => {
      const aborted = inflight.get(mediaKey)?.aborted === true;
      inflight.delete(mediaKey);
      if (aborted) {
        log.info('生成已被取消，忽略失败', { mediaKey });
        return;
      }
      const appErr = toAppError(err);
      log.warn('知识点生成失败', appErr.code);
      await emitToCour(mediaKey, { name: 'AI_FAILED', data: { mediaKey, error: appErr.toJSON() } });
    },
  );
  return { started: true };
}

async function runGeneration(
  mediaKey: MediaKey,
  segments: TranscriptSegment[],
  durationSec: number,
  provider: LlmProviderConfig,
  windowPreset?: ContextWindowPreset,
): Promise<void> {
  const settings = await loadSettings();
  const secrets = await loadSecrets();
  const emitProgress = (stage: 'preparing' | 'requesting' | 'validating' | 'retrying', progress?: number) =>
    emitToCour(mediaKey, { name: 'AI_PROGRESS', data: { mediaKey, stage, progress } });

  await emitProgress('preparing');
  // per-request 档位消费（第 28 轮，第 27 轮建议 4）：解析口径与 qa.ask 完全一致——
  // args.windowPreset ?? settings.contextWindow，档位解析单份化走 shared 的
  // resolveContextWindowPreset（qa.ts 同款）。
  const preset = resolveContextWindowPreset(windowPreset, settings.contextWindow);
  // 消费点：标注提示词的分块粒度。仅当调用方显式携带档位时按档位取值
  // （小=5min / 中=10min / 大=20min）；缺省（HDU 不传参）保持既有 600s 分块——
  // 协议可选参数缺省=旧行为，HDU 侧行为零变化。
  const blockSec = windowPreset === undefined ? DEFAULT_TOPICS_BLOCK_SEC : TOPIC_BLOCK_SEC_BY_PRESET[preset];
  const userPrompt = buildTopicsUserPrompt(segments, durationSec, blockSec);

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
        const entry = inflight.get(mediaKey);
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
    mediaKey,
    courId: hduCourIdOf(mediaKey),
    promptVersion: PROMPT_VERSION,
    model: provider.model,
    topics: validated.topics,
    outline: validated.outline,
    createdAt: Date.now(),
    warnings: validated.warnings,
  };
  if (inflight.get(mediaKey)?.aborted) {
    log.info('生成已被取消，丢弃结果', { mediaKey });
    inflight.delete(mediaKey);
    return;
  }
  await putAiResult(result);
  inflight.delete(mediaKey);

  await emitToCour(mediaKey, {
    name: 'AI_DONE',
    data: {
      mediaKey,
      result: { topicCount: result.topics.length, outlineCount: result.outline.length, cached: false },
    },
  });
}

export function abortGeneration(mediaKey: MediaKey): void {
  const entry = inflight.get(mediaKey);
  if (!entry) return;
  entry.aborted = true;
  // 请求已在 Offscreen 执行时立即中止；尚未拿到 runId 时由 onRunId 补发
  if (entry.runId) abortLlmRun(entry.runId);
}
