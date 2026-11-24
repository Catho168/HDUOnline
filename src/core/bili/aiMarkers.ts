/**
 * B 站「AI 标注」纯逻辑（第 25 轮功能扩展第二批：AI 标注/大纲 + 播放器时间轴叠加）。
 *
 * 与 core/bili/assistant.ts 同惯例：可单测的判定与换算从 UI 组件抽出，全部纯函数、
 * 不触 DOM / RPC，vitest node/jsdom 皆可直测。
 *
 *  - 时间轴标记换算：topics[].intervals → 播放器宽度百分比（left/width），几何换算
 *    直接复用 core/shared/timelineMarkers.ts 的 timelineMarkerRect（HDU TimelineLayer
 *    同一实现，第 29 轮审计#1 双端对齐）；
 *  - 当前高亮区间判定：start <= t < end，行间隙/未播放不高亮；
 *  - aiResult 就绪/可生成判定：有 aiResult → ready；无结果但有字幕 → can-generate；
 *    无字幕 → no-subtitle（第 14 轮裁决：B 站无官方字幕即作罢，不发起 ai.generate）；
 *  - 分 P mediaKey 组装复用 mediaRef.biliMediaKey（P1 裸键 / p≥2 分 P 键）。
 */

import type { AiResultEntity, Topic, TopicConfidence, TranscriptEntity } from '../shared/types';
import { timelineMarkerRect } from '../shared/timelineMarkers';

/** 无官方字幕时 AI 标注入口的统一空态文案（UI 与单测共用一份措辞） */
export const AI_ANNOTATION_NO_SUBTITLE_MESSAGE = '该视频暂无可用字幕，无法生成 AI 标注';

/** 单个时间轴标记（一个 topic 的一个时间区间） */
export interface TimelineMarker {
  /** `${topicIndex}-${intervalIndex}`，React key 与高亮比对共用 */
  key: string;
  topicIndex: number;
  intervalIndex: number;
  /** 所属知识点名（title 提示用） */
  name: string;
  confidence: TopicConfidence;
  /** 区间起点/终点（秒） */
  start: number;
  end: number;
  /** 相对播放器宽度的定位百分比（0–100，已钳制） */
  leftPercent: number;
  widthPercent: number;
}

/**
 * topics → 时间轴标记（left/width 百分比换算）。
 * durationSec <= 0 或无有效区间时返回空数组（调用方据此不渲染叠加条）；
 * 非有限数值的区间端点跳过（fail-soft，不让脏数据破坏整条渲染）；
 * 几何换算与 HDU 侧共用 timelineMarkerRect（第 29 轮审计#1 双端对齐）：近缘区间
 * （left∈(99.65,100)）按 100-left 整带钳制、不再保 0.35 最小宽度下限，起点越出
 * 时长（left=100）的区间 width=0——两侧都不再溢出播放器右缘，零宽标记由渲染层过滤。
 */
export function buildTimelineMarkers(topics: Topic[], durationSec: number): TimelineMarker[] {
  if (!(durationSec > 0) || topics.length === 0) return [];
  const markers: TimelineMarker[] = [];
  topics.forEach((topic, topicIndex) => {
    topic.intervals.forEach(([start, end], intervalIndex) => {
      if (!Number.isFinite(start) || !Number.isFinite(end)) return;
      const { leftPercent, widthPercent } = timelineMarkerRect(start, end, durationSec);
      markers.push({
        key: `${topicIndex}-${intervalIndex}`,
        topicIndex,
        intervalIndex,
        name: topic.name,
        confidence: topic.confidence,
        start,
        end,
        leftPercent,
        widthPercent,
      });
    });
  });
  return markers;
}

/**
 * 当前播放位置命中的标记 key（start <= t < end；行间隙/未播放/无效时间返回 null）。
 * 多区间重叠时取最早一个（与 HDU TimelineLayer 的逐条 active 判定同口径）。
 */
export function activeMarkerKey(markers: TimelineMarker[], currentTime: number | undefined): string | null {
  if (typeof currentTime !== 'number' || !Number.isFinite(currentTime)) return null;
  const hit = markers.find((m) => m.start <= currentTime && currentTime < m.end);
  return hit ? hit.key : null;
}

/** 知识点条目的跳转目标：首个区间起点；无有效区间回退 0 */
export function topicSeekTarget(topic: Topic): number {
  const start = topic.intervals[0]?.[0];
  return typeof start === 'number' && Number.isFinite(start) ? start : 0;
}

/** AI 标注区就绪态：决定面板渲染分支（结果 / 可生成 / 无字幕空态） */
export type AiAnnotationReadiness =
  | { state: 'ready'; aiResult: AiResultEntity }
  | { state: 'can-generate' }
  | { state: 'no-subtitle'; message: string };

/**
 * 判定 AI 标注区的渲染分支：
 *  - 已有 aiResult（当前 mediaKey）→ ready（展示 topics/outline）；
 *  - 无结果但 transcript 可用（≥1 段）→ can-generate（展示「生成 AI 标注」）；
 *  - 无 transcript → no-subtitle（友好空态，绝不发起 ai.generate）。
 */
export function aiAnnotationReadiness(
  aiResult: AiResultEntity | null | undefined,
  transcript: TranscriptEntity | null | undefined,
): AiAnnotationReadiness {
  if (aiResult) return { state: 'ready', aiResult };
  if (transcript && transcript.segments.length > 0) return { state: 'can-generate' };
  return { state: 'no-subtitle', message: AI_ANNOTATION_NO_SUBTITLE_MESSAGE };
}

/** AI_PROGRESS 阶段的展示文案（面板「生成中」指示用；未知阶段回退原值） */
export const AI_STAGE_LABELS: Record<string, string> = {
  preparing: '准备提示词',
  requesting: '请求模型',
  validating: '校验结果',
  retrying: '校验失败重试',
};
