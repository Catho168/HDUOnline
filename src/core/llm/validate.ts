/**
 * AI 输出校验（技术文档 §6.4 输出契约）。
 *
 * ① 标注 + 大纲：时间越界裁剪并记 warning；条数约束；L2 的 parent 必须指向存在的 L1；
 *    术语忠实性抽查（topic.name 应在转写文本中有近似串，否则置信度降级为 low）。
 * ② 时间点问答：evidence 落在课次范围内；insufficient 时 answer 置空。
 */

import { AppError } from '../shared/errors';
import { clamp } from '../shared/utils';
import type { OutlineNode, Topic, TopicConfidence, TranscriptSegment } from '../shared/types';
import { extractJson } from './prompts';

export interface TopicsValidation {
  topics: Topic[];
  outline: OutlineNode[];
  warnings: string[];
}

const LIMITS = {
  topicsMin: 3,
  topicsMax: 30,
  outlineMin: 4,
  outlineMax: 40,
} as const;

function normalizeText(text: string): string {
  return text
    .replace(/[\s，。、；：？！,.;:?!（）()【】\[\]"'“”‘’·—\-_/\\|<>+=*&^%$#@~`]/g, '')
    .toLowerCase();
}

/** name 是否能在转写文本中找到近似串（bigram 覆盖率 ≥ 0.6 视为忠实）。 */
export function isTermSupported(name: string, haystack: string): boolean {
  const needle = normalizeText(name);
  if (needle.length === 0) return false;
  if (haystack.includes(needle)) return true;
  if (needle.length <= 2) return haystack.includes(needle);
  let hits = 0;
  let total = 0;
  for (let i = 0; i + 2 <= needle.length; i += 1) {
    total += 1;
    if (haystack.includes(needle.slice(i, i + 2))) hits += 1;
  }
  return total > 0 && hits / total >= 0.6;
}

function asConfidence(value: unknown): TopicConfidence {
  return value === 'high' || value === 'medium' || value === 'low' ? value : 'low';
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function maxTimeBound(durationSec: number): number {
  return Number.isFinite(durationSec) && durationSec > 0 ? durationSec : Number.MAX_SAFE_INTEGER;
}

/** 校验并规整“标注 + 大纲”输出。 */
export function validateTopicsOutline(rawText: string, durationSec: number, segments: TranscriptSegment[]): TopicsValidation {
  const json = extractJson(rawText);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new AppError('LLM_BAD_OUTPUT', {
      userMessage: 'AI 返回的内容不是合法 JSON',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new AppError('LLM_BAD_OUTPUT', { userMessage: 'AI 返回的 JSON 不是对象' });
  }
  const obj = parsed as { topics?: unknown; outline?: unknown };
  if (!Array.isArray(obj.topics) || !Array.isArray(obj.outline)) {
    throw new AppError('LLM_BAD_OUTPUT', { userMessage: 'AI 返回的 JSON 缺少 topics / outline 字段' });
  }

  const warnings: string[] = [];
  const haystack = normalizeText(segments.map((s) => s.text).join(''));
  const maxBound = maxTimeBound(durationSec);

  // ── topics ──
  const topics: Topic[] = [];
  for (let index = 0; index < obj.topics.length; index += 1) {
    const rawTopic = obj.topics[index];
    const t = rawTopic as { name?: unknown; summary?: unknown; confidence?: unknown; intervals?: unknown };
    const name = typeof t.name === 'string' ? t.name.trim() : '';
    if (!name) {
      warnings.push(`第 ${index + 1} 个知识点缺少名称，已跳过`);
      continue;
    }
    const rawIntervals = Array.isArray(t.intervals) ? t.intervals : [];
    const intervals: Array<[number, number]> = [];
    for (const pair of rawIntervals) {
      if (!Array.isArray(pair) || pair.length < 2) continue;
      let start = toNumber(pair[0]);
      let end = toNumber(pair[1]);
      if (start === null || end === null) continue;
      if (start > end) [start, end] = [end, start];
      if (start < 0 || end > maxBound) {
        const cs = clamp(start, 0, maxBound);
        const ce = clamp(end, 0, maxBound);
        warnings.push(`知识点「${name}」的时间区间越界，已裁剪`);
        start = cs;
        end = ce;
      }
      if (end - start < 1) continue;
      intervals.push([Math.round(start * 100) / 100, Math.round(end * 100) / 100]);
    }
    if (intervals.length === 0) {
      warnings.push(`知识点「${name}」缺少有效时间区间，已跳过`);
      continue;
    }
    let confidence = asConfidence(t.confidence);
    if (!isTermSupported(name, haystack) && confidence === 'high') {
      confidence = 'low';
      warnings.push(`知识点「${name}」未能在转写文本中找到依据，置信度已降级`);
    }
    topics.push({
      name,
      summary: typeof t.summary === 'string' ? t.summary.trim() : '',
      confidence,
      intervals: intervals.sort((a, b) => a[0] - b[0]),
    });
  }

  // ── outline ──
  const l1Indexes = new Set<number>();
  const outline: OutlineNode[] = [];
  const rawOutline = obj.outline as unknown[];
  rawOutline.forEach((rawNode, index) => {
    const n = rawNode as { level?: unknown; title?: unknown; start?: unknown; end?: unknown; parent?: unknown };
    const level = n.level === 2 ? 2 : 1;
    const title = typeof n.title === 'string' ? n.title.trim() : '';
    let start = toNumber(n.start);
    let end = toNumber(n.end);
    if (!title || start === null || end === null) {
      warnings.push(`大纲第 ${index + 1} 个节点字段不完整，已跳过`);
      return;
    }
    if (start > end) [start, end] = [end, start];
    if (start < 0 || end > maxBound) {
      warnings.push(`大纲节点「${title}」的时间越界，已裁剪`);
      start = clamp(start, 0, maxBound);
      end = clamp(end, 0, maxBound);
    }
    if (end - start < 1) {
      warnings.push(`大纲节点「${title}」时间区间无效，已跳过`);
      return;
    }
    const node: OutlineNode = {
      level,
      title,
      start: Math.round(start * 100) / 100,
      end: Math.round(end * 100) / 100,
    };
    if (level === 2) {
      const parent = toNumber(n.parent);
      if (parent === null || !Number.isInteger(parent) || !l1Indexes.has(parent)) {
        warnings.push(`大纲子节点「${title}」的父节点无效，已改为独立节点`);
        node.level = 1;
      } else {
        node.parent = parent;
      }
    }
    if (node.level === 1) l1Indexes.add(outline.length);
    outline.push(node);
  });

  if (topics.length < LIMITS.topicsMin) {
    throw new AppError('LLM_BAD_OUTPUT', {
      userMessage: `AI 生成的知识点过少（${topics.length} 个，至少需要 ${LIMITS.topicsMin} 个）`,
      detail: warnings.join('；'),
    });
  }
  if (outline.length < LIMITS.outlineMin) {
    throw new AppError('LLM_BAD_OUTPUT', {
      userMessage: `AI 生成的大纲节点过少（${outline.length} 个，至少需要 ${LIMITS.outlineMin} 个）`,
      detail: warnings.join('；'),
    });
  }
  if (topics.length > LIMITS.topicsMax) {
    warnings.push(`知识点数量 ${topics.length} 超过上限，已截断到 ${LIMITS.topicsMax}`);
    topics.length = LIMITS.topicsMax;
  }
  if (outline.length > LIMITS.outlineMax) {
    warnings.push(`大纲节点数 ${outline.length} 超过上限，已截断到 ${LIMITS.outlineMax}`);
    outline.length = LIMITS.outlineMax;
  }

  return { topics, outline, warnings };
}

export interface QaValidation {
  answer: string;
  evidence: { start: number; end: number };
  insufficient: boolean;
  warnings: string[];
}

/** 校验问答输出；evidence 越界时裁剪到课次范围内。 */
export function validateQaAnswer(rawText: string, durationSec: number, windowRange: [number, number]): QaValidation {
  const json = extractJson(rawText);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new AppError('LLM_BAD_OUTPUT', {
      userMessage: 'AI 返回的内容不是合法 JSON',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new AppError('LLM_BAD_OUTPUT', { userMessage: 'AI 返回的 JSON 不是对象' });
  }
  const obj = parsed as { answer?: unknown; evidence?: unknown; insufficient?: unknown };
  const warnings: string[] = [];
  const insufficient = obj.insufficient === true;
  const answer = typeof obj.answer === 'string' ? obj.answer.trim() : '';

  if (!insufficient && !answer) {
    throw new AppError('LLM_BAD_OUTPUT', { userMessage: 'AI 未给出回答内容' });
  }

  const maxBound = maxTimeBound(durationSec);
  const evidenceObj = obj.evidence as { start?: unknown; end?: unknown } | undefined;
  let start = toNumber(evidenceObj?.start);
  let end = toNumber(evidenceObj?.end);
  if (start === null || end === null) {
    // 缺失依据时退化为窗口范围，但记录 warning
    start = windowRange[0];
    end = windowRange[1];
    warnings.push('AI 未给出有效依据范围，已退化为本次上下文窗口');
  }
  if (start > end) [start, end] = [end, start];
  if (start < 0 || end > maxBound) {
    warnings.push('依据范围越界，已裁剪到课次时长内');
    start = clamp(start, 0, maxBound);
    end = clamp(end, 0, maxBound);
  }
  if (insufficient && answer) {
    warnings.push('AI 同时给出了 insufficient=true 与回答内容，已按“内容不足”处理');
  }
  return {
    answer: insufficient ? '' : answer,
    evidence: { start: Math.round(start), end: Math.round(end) },
    insufficient,
    warnings,
  };
}
