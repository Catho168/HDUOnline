/**
 * 时间点问答编排（A3，§6.4②）。
 *
 * - 上下文窗口：默认锚点前 3 分钟 / 后 1 分钟（档位可配：小/中/大）；
 * - 追问附上本会话最近 3 轮问答（token 上限 ~2000）；
 * - 流式输出：增量经 `QA_DELTA` 推给面板；完成后校验并落库；
 * - 锚点窗口内没有字幕时直接给出明确提示（不拿别处的转写冒充上下文）。
 */

import { ASR_PIPELINE_VERSION, CONTEXT_WINDOW_PRESETS, resolveContextWindowPreset } from '@/core/shared/constants';
import { AppError, toAppError } from '@/core/shared/errors';
import { createLogger } from '@/core/shared/logger';
import { hduCourIdOf, type MediaKey } from '@/core/shared/mediaRef';
import { getActiveProvider, loadSecrets, loadSettings } from '@/core/shared/settings';
import type { AsrJobEntity, ChatMessageEntity, LlmProviderConfig } from '@/core/shared/types';
import { getAsrJob } from '@/core/db/repo/asr';
import { getSession, putChat, updateChat } from '@/core/db/repo/content';
import { selectWindowSegments, transcriptRanges } from '@/core/llm/context';
import { buildQaSystemPrompt, buildQaUserPrompt } from '@/core/llm/prompts';
import { validateQaAnswer } from '@/core/llm/validate';
import { formatClock, summarize, uuid } from '@/core/shared/utils';
import { getTranscriptWithDemo, listChatsWithDemo } from './demoFallback';
import { runLlmViaOffscreen, abortLlmRun } from './llm';
import { emitToCour } from './tabs';

const log = createLogger('sw-qa');

/** 进行中的请求：chatId → 取消标记 / Offscreen runId / 已收到的流式文本 */
const inflight = new Map<string, { mediaKey: MediaKey; aborted: boolean; runId?: string; streamed?: string }>();

export interface AskArgs {
  mediaKey: MediaKey;
  question: string;
  anchorTime: number;
  groupId?: string;
  windowPreset?: 'small' | 'medium' | 'large';
  /** 覆盖窗口（"扩大窗口重答"） */
  windowOverride?: [number, number];
}

export interface AskResult {
  chatId: string;
  groupId: string;
  /** 未调用 LLM、答案已落库（UI 不应再显示"生成中"） */
  immediate?: boolean;
}

/**
 * 转写不可用时给准确的原因：作业仍在跑 / 已暂停 / 失败，而不是一律说"没有转写"。
 * 用户最容易被"转写看起来正常，提问却说字幕为空"误导的就是这一段。
 */
async function unavailableTranscriptMessage(mediaKey: MediaKey, kind: 'missing' | 'empty'): Promise<string> {
  const job = await getAsrJob(mediaKey).catch((): AsrJobEntity | null => null);
  if (job) {
    if (job.status === 'queued' || job.status === 'extracting' || job.status === 'transcribing') {
      const percent = Math.round(Math.min(1, Math.max(0, job.progress)) * 100);
      return `本节字幕正在转写中（${percent}%），首个片段完成后即可提问`;
    }
    if (job.status === 'paused') return '本节转写已暂停，请先在面板底部继续转写后再提问';
    if (job.status === 'failed' && job.error) return `本节转写失败：${job.error}。请重新生成字幕后提问`;
  }
  return kind === 'missing'
    ? '本节还没有转写文本，请先生成转写后再提问'
    : '本节转写没有产出有效文字（可能是静音、当前机位没有声音，或输出被判为无效）。请确认音源后重新生成字幕后重试';
}

/** 把覆盖区间格式化为“00:00–20:00、30:00–40:00” */
function formatRangeLabel(ranges: Array<{ start: number; end: number }>): string | null {
  if (ranges.length === 0) return null;
  return `${ranges
    .slice(0, 3)
    .map((range) => `${formatClock(range.start)}–${formatClock(range.end)}`)
    .join('、')}${ranges.length > 3 ? ' 等' : ''}`;
}

export async function ask(args: AskArgs): Promise<AskResult> {
  const question = args.question.trim();
  if (!question) throw new AppError('INVALID_INPUT', { detail: '问题不能为空' });

  const provider = await getActiveProvider();
  if (!provider) throw new AppError('LLM_NO_PROVIDER');

  const transcript = await getTranscriptWithDemo(args.mediaKey);
  if (!transcript) {
    throw new AppError('INVALID_INPUT', { userMessage: await unavailableTranscriptMessage(args.mediaKey, 'missing') });
  }

  const settings = await loadSettings();
  const secrets = await loadSecrets();
  // per-request 档位解析单份化（第 28 轮）：args.windowPreset ?? settings.contextWindow
  // 口径收敛到 shared 的 resolveContextWindowPreset（与 ai.generate 共用）
  const preset = CONTEXT_WINDOW_PRESETS[resolveContextWindowPreset(args.windowPreset, settings.contextWindow)];
  const courId = hduCourIdOf(args.mediaKey);
  const durationSec = transcript.durationSec ?? (courId !== undefined ? ((await getSession(courId).catch(() => null))?.durationSec ?? 0) : 0);
  const windowRange: [number, number] = args.windowOverride ?? [
    Math.max(0, args.anchorTime - preset.before),
    durationSec > 0 ? Math.min(durationSec, args.anchorTime + preset.after) : args.anchorTime + preset.after,
  ];
  const windowSegments = selectWindowSegments(transcript.segments, windowRange);

  // groupId 复用：同一会话内追问保持同一分组
  const groupId = args.groupId ?? uuid();
  const now = Date.now();

  // 落库用户消息
  const userMessage: ChatMessageEntity = {
    id: uuid(),
    mediaKey: args.mediaKey,
    ...(courId !== undefined ? { courId } : {}),
    groupId,
    role: 'user',
    content: question,
    anchorTime: args.anchorTime,
    contextActual: windowRange,
    status: 'done',
    createdAt: now,
  };

  const chatId = uuid();

  // 锚点窗口内没有可用字幕：区分三种情况，不能拿别处的转写冒充上下文。
  //  - 该时段已处理但没有有效文字（静音/音源无声/幻觉被过滤）；
  //  - 该时段尚未处理（报告真实覆盖区间，而不是“有文字的 8 秒”）；
  //  - 整节还没有任何转写。
  if (windowSegments.length === 0) {
    const coverage = transcript.coverage?.length
      ? transcript.coverage
      : transcript.window
        ? [transcript.window]
        : [];
    const speechRanges = transcriptRanges(transcript.segments);
    const displayRanges = coverage.length > 0 ? coverage : speechRanges;
    const covered = formatRangeLabel(displayRanges);
    const anchorCovered = displayRanges.some(
      (range) => args.anchorTime >= range.start && args.anchorTime <= range.end,
    );
    const stalePipeline =
      transcript.segments.length > 0 && transcript.pipelineVersion !== ASR_PIPELINE_VERSION;
    // 作业仍在跑时不要急着下“没有语音”的结论，沿用统一的“正在转写”提示
    const job = await getAsrJob(args.mediaKey).catch((): AsrJobEntity | null => null);
    const jobRunning =
      job?.status === 'queued' || job?.status === 'extracting' || job?.status === 'transcribing';

    let content: string;
    if (jobRunning) {
      content = await unavailableTranscriptMessage(args.mediaKey, 'empty');
    } else if (stalePipeline) {
      // 旧版最典型的问题就是把长段讲解压缩到几秒（截图里的“只转写了 8 秒”），
      // 不再复述这组误导性的时间范围，直接建议重转。
      content = `本节字幕由旧版转写生成，时间轴可能不可靠（旧版可能把长段内容压缩到几秒），建议重新生成。当前时间点 ${formatClock(
        args.anchorTime,
      )} 附近没有可用字幕。`;
    } else if (coverage.length > 0 && anchorCovered) {
      content = `当前时间点 ${formatClock(
        args.anchorTime,
      )} 附近的音频已处理，但没有识别到有效语音（可能是静音、当前机位没有声音，或输出被判为无效）。可换一个时间点，或确认机位声音后重新生成当前片段。`;
    } else if (coverage.length > 0 && covered) {
      content = `当前时间点 ${formatClock(
        args.anchorTime,
      )} 不在已处理范围内（本节已处理 ${covered}）。请把进度拖到已处理区段，或先生成当前片段。`;
    } else if (covered) {
      content = anchorCovered
        ? `当前时间点 ${formatClock(args.anchorTime)} 附近没有字幕（本节已转写 ${covered}）。可在设置中调大问答上下文窗口，或把进度拖到已转写区段再问。`
        : `当前时间点 ${formatClock(args.anchorTime)} 附近还没有字幕（本节已转写 ${covered}）。请把进度拖到已转写区段，或先生成当前片段的字幕后重试。`;
    } else {
      content = await unavailableTranscriptMessage(args.mediaKey, 'empty');
    }
    log.info('锚点窗口内无可用字幕，直接返回不足提示', {
      mediaKey: args.mediaKey,
      anchorTime: args.anchorTime,
      windowRange,
      covered,
      anchorCovered,
      coverageRanges: coverage.length,
    });
    const message: ChatMessageEntity = {
      id: chatId,
      mediaKey: args.mediaKey,
      ...(courId !== undefined ? { courId } : {}),
      groupId,
      role: 'ai',
      content,
      anchorTime: args.anchorTime,
      contextActual: windowRange,
      // 没有可依据的字幕，不给 evidence，避免面板显示一个点进去是空白的"依据"跳转
      insufficient: true,
      status: 'done',
      createdAt: now + 1,
    };
    await putChat(userMessage);
    await putChat(message);
    await emitToCour(args.mediaKey, { name: 'QA_DONE', data: { chatId, message } });
    return { chatId, groupId, immediate: true };
  }

  await putChat(userMessage);

  // 占位的 AI 消息（流式写入）
  const aiMessage: ChatMessageEntity = {
    id: chatId,
    mediaKey: args.mediaKey,
    ...(courId !== undefined ? { courId } : {}),
    groupId,
    role: 'ai',
    content: '',
    anchorTime: args.anchorTime,
    contextActual: windowRange,
    status: 'streaming',
    createdAt: now + 1,
  };
  await putChat(aiMessage);

  inflight.set(chatId, { mediaKey: args.mediaKey, aborted: false });

  void runAnswer({
    args,
    chatId,
    groupId,
    question,
    windowRange,
    durationSec,
    provider,
    settings,
    secrets,
    transcriptSegments: transcript.segments,
    windowSegments,
  }).catch(async (err) => {
    const appErr = toAppError(err);
    const entry = inflight.get(chatId);
    const aborted = entry?.aborted === true;
    inflight.delete(chatId);
    if (aborted) {
      // 用户已点"停止生成"：保留 aborted 状态与已收到的片段，不显示失败
      await updateChat(chatId, { status: 'aborted', content: entry?.streamed ?? '' });
      return;
    }
    log.warn('问答失败', appErr.code);
    await updateChat(chatId, { status: 'failed', error: appErr.userMessage });
    await emitToCour(args.mediaKey, { name: 'QA_FAILED', data: { chatId, error: appErr.toJSON() } });
  });

  return { chatId, groupId };
}

interface RunAnswerContext {
  args: AskArgs;
  chatId: string;
  groupId: string;
  question: string;
  windowRange: [number, number];
  durationSec: number;
  provider: LlmProviderConfig;
  settings: Awaited<ReturnType<typeof loadSettings>>;
  secrets: Awaited<ReturnType<typeof loadSecrets>>;
  transcriptSegments: Array<{ s: number; e: number; text: string }>;
  /** 已在调用前按锚点窗口裁剪；调用方保证非空 */
  windowSegments: Array<{ s: number; e: number; text: string }>;
}

async function runAnswer(ctx: RunAnswerContext): Promise<void> {
  const { chatId, groupId, question, windowRange, durationSec, windowSegments } = ctx;

  // 追问历史：本会话最近 3 轮（§6.4②）
  const history = (await listChatsWithDemo(ctx.args.mediaKey, groupId))
    .filter((m) => m.status === 'done' && m.content && m.id !== chatId)
    .slice(-6)
    .map((m) => ({
      role: (m.role === 'ai' ? 'assistant' : 'user') as 'user' | 'assistant',
      content: summarize(m.content, 400),
    }));

  const userPrompt = buildQaUserPrompt({
    segments: windowSegments,
    question,
    anchorSec: ctx.args.anchorTime,
    history,
    windowRange,
  });

  let streamed = '';
  const result = await runLlmViaOffscreen({
    provider: {
      kind: ctx.provider.kind,
      baseUrl: ctx.provider.baseUrl,
      model: ctx.provider.model,
      apiKey: ctx.provider.apiKey,
    },
    timeouts: {
      connectMs: ctx.settings.llm.timeoutConnectMs,
      firstByteMs: ctx.settings.llm.timeoutFirstByteMs,
      totalMs: ctx.settings.llm.timeoutTotalMs,
    },
    allowLocalEndpoints: ctx.secrets.allowLocalEndpoints,
    system: buildQaSystemPrompt(ctx.args.anchorTime),
    messages: [{ role: 'user', content: userPrompt }],
    maxTokens: 2048,
    temperature: ctx.settings.llm.temperature,
    jsonMode: true,
    stream: true,
    onRunId: (runId) => {
      const entry = inflight.get(chatId);
      if (!entry) return;
      entry.runId = runId;
      // 问题落库后、请求发出前用户已点停止：立即中止，避免继续消耗
      if (entry.aborted) abortLlmRun(runId);
    },
    onDelta: (text) => {
      const entry = inflight.get(chatId);
      // 停止生成后丢弃迟到的增量（请求仍可能在 Offscreen 侧跑完）
      if (entry?.aborted) return;
      streamed += text;
      if (entry) entry.streamed = streamed;
      // 流式内容是 JSON 片段：只在面板上做"生成中"指示，不直接渲染为答案
      void emitToCour(ctx.args.mediaKey, { name: 'QA_DELTA', data: { chatId, groupId, text } });
    },
  });

  if (inflight.get(chatId)?.aborted) {
    inflight.delete(chatId);
    await updateChat(chatId, { status: 'aborted', content: streamed });
    return;
  }

  const validated = validateQaAnswer(result.text, durationSec || ctx.transcriptSegments.at(-1)?.e || 0, windowRange);
  const finalMessage: ChatMessageEntity = {
    id: chatId,
    mediaKey: ctx.args.mediaKey,
    groupId,
    role: 'ai',
    content: validated.answer,
    anchorTime: ctx.args.anchorTime,
    contextActual: windowRange,
    evidence: validated.evidence,
    insufficient: validated.insufficient,
    status: 'done',
    createdAt: Date.now(),
  };
  await putChat(finalMessage);
  inflight.delete(chatId);

  await emitToCour(ctx.args.mediaKey, { name: 'QA_DONE', data: { chatId, message: finalMessage } });
}

export function abortAsk(chatId: string): void {
  const entry = inflight.get(chatId);
  if (!entry) return;
  entry.aborted = true;
  // 请求已在 Offscreen 执行时立即中止；尚未拿到 runId 时由 onRunId 补发
  if (entry.runId) abortLlmRun(entry.runId);
}
