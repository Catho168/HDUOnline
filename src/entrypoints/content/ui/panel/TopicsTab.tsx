/**
 * 本节助手「标注」页签（第 48 轮自 PlayPanel.tsx 纯搬移拆分，逻辑/文案/类名逐行未变）：
 * 知识点列表（低置信过滤 + 展开摘要 + 区间跳转）与 AI 标注生成入口。
 */

import { useState } from 'react';
import type { ContextWindowPreset, Topic } from '@/core/shared/types';
import { formatClock } from '@/core/shared/utils';
import { Button, Chip, EmptyState, cx } from '../components';
import { WindowPresetChips } from '../WindowPresetChips';
import { uiStore, useUiStore } from '../store';

export function TopicsTab({
  windowPreset,
  onSelectWindowPreset,
}: {
  /** 当前窗口档位（PlayPanel 顶层持有，问答 / 标注共用一档，同 B 站面板口径） */
  windowPreset: ContextWindowPreset;
  /** 档位点选上抛（父级登记「已交互」并更新受控值） */
  onSelectWindowPreset: (preset: ContextWindowPreset) => void;
}) {
  const state = useUiStore();
  const actions = uiStore.actions;
  const [hideLow, setHideLow] = useState(false);
  const processedNoSpeech =
    Boolean(state.transcript?.coverage?.length) && state.transcript?.segments.length === 0;
  // AI 标注窗口档位行（第 29 轮 HDU 新增，B 站面板同款共享组件）：有字幕（可生成）
  // 时展示；ai.generate 携带所选档位，缺省=全局设置
  const presetRow =
    state.transcript && state.transcript.segments.length > 0 ? (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
        <WindowPresetChips
          variant="hdu"
          value={windowPreset}
          onSelect={onSelectWindowPreset}
          ariaLabel="AI 标注上下文窗口"
          titlePrefix="AI 标注上下文窗口"
          titleSuffix="仅影响本面板标注生成"
        />
      </div>
    ) : null;
  if (!state.transcript || state.transcript.segments.length === 0) {
    return (
      <EmptyState
        icon={processedNoSpeech ? 'message' : 'wand'}
        title={processedNoSpeech ? '没有识别到有效语音' : '需要先生成字幕'}
        text={
          processedNoSpeech
            ? state.job?.warning ??
              '本节音频已处理，但没有识别到有效文字。请确认当前播放机位是否包含声音（部分机位只有画面），或换一个区段重新生成。'
            : '知识标注以字幕文本为依据。先生成字幕，再让 AI 提取知识点。'
        }
        action={
          <Button size="small" onClick={() => void actions.startTranscribe()}>
            {processedNoSpeech ? '重新生成' : '生成字幕'}
          </Button>
        }
      />
    );
  }
  if (!state.ai) {
    return (
      <div>
        {presetRow}
        <EmptyState
          icon="spark"
          title="还没有知识标注"
          text={state.busy.ai ? '正在生成，通常需要几十秒到几分钟…' : '根据本节字幕提取知识点与时间区间，点击条目可直接跳转。'}
          action={
            <Button
              size="small"
              variant="primary"
              loading={state.busy.ai}
              onClick={() => void actions.generateAi(false, { windowPreset })}
            >
              生成知识标注
            </Button>
          }
        />
      </div>
    );
  }
  const topics = hideLow ? state.ai.topics.filter((t) => t.confidence !== 'low') : state.ai.topics;
  return (
    <div>
      {presetRow}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
        <Chip tone="accent" icon="spark">AI 生成</Chip>
        <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>{state.ai.topics.length} 个知识点</span>
        <button type="button" className="hdu-filter-pill" style={{ marginLeft: 'auto' }} onClick={() => setHideLow((v) => !v)}>
          {hideLow ? '显示低置信' : '隐藏低置信'}
        </button>
      </div>
      {topics.map((topic, i) => (
        <TopicRow key={`${topic.name}-${i}`} topic={topic} />
      ))}
      {topics.length === 0 ? <EmptyState icon="spark" title="没有高置信度知识点" text="关闭「隐藏低置信」可查看全部结果。" /> : null}
    </div>
  );
}

function TopicRow({ topic }: { topic: Topic }) {
  const actions = uiStore.actions;
  const [open, setOpen] = useState(false);
  return (
    <div className={cx('hdu-topic', topic.confidence === 'low' ? 'low' : '')}>
      <div className="hdu-topic-head">
        <span className="hdu-topic-name">{topic.name}</span>
        {topic.confidence === 'low' ? <Chip>低置信</Chip> : topic.confidence === 'medium' ? <Chip tone="info">中置信</Chip> : null}
        <button type="button" className="hdu-btn ghost small" style={{ marginLeft: 'auto' }} onClick={() => actions.seek(topic.intervals[0]?.[0] ?? 0)}>
          跳到开头
        </button>
      </div>
      <button type="button" className="hdu-topic-sum" style={{ textAlign: 'left' }} onClick={() => setOpen((v) => !v)}>
        {open ? topic.summary : topic.summary.slice(0, 76) + (topic.summary.length > 76 ? '…' : '')}
      </button>
      <div className="hdu-topic-times">
        {topic.intervals.map(([start, end], i) => (
          <button type="button" className="hdu-topic-time" key={i} onClick={() => actions.seek(start)}>
            {formatClock(start)}–{formatClock(end)}
          </button>
        ))}
      </div>
    </div>
  );
}
