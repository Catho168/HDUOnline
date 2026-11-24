/**
 * 问答记录导出（第 81 轮巡检）：把当前会话的问答消息序列化为 Markdown。
 * 纯函数、无副作用（下载由 UI 层经 reviewCards.downloadTextFile 完成）；
 * 流式中 / 空内容行如实标注，跳转锚点（提问 @时刻、回答依据区间）一并保留。
 */

import type { ChatMessageEntity } from '../shared/types';
import { formatClock } from '../shared/utils';

/** 单条消息 → Markdown 行块（用户=二级标题，AI=三级标题 + 依据区间） */
function messageBlock(message: ChatMessageEntity): string[] {
  const lines: string[] = [];
  if (message.role === 'user') {
    const anchor = message.anchorTime != null ? `（@${formatClock(message.anchorTime)}）` : '';
    lines.push(`## 问${anchor}`);
    lines.push(message.content || '（无内容）');
  } else {
    const evidence = message.evidence ? `依据 ${formatClock(message.evidence.start)}–${formatClock(message.evidence.end)}` : '';
    lines.push(`### 答${evidence ? `（${evidence}）` : ''}`);
    lines.push(
      message.content ||
        (message.insufficient ? '（字幕不足，未能回答）' : message.status === 'streaming' ? '（生成中）' : '（无内容）'),
    );
  }
  lines.push('');
  return lines;
}

/** 问答消息 → Markdown（标题 + 汇总 + 逐条问答 + 附注；空列表输出空记录结构，不抛错） */
export function buildChatsMarkdown(messages: ChatMessageEntity[], title: string, now: number = Date.now()): string {
  const list = Array.isArray(messages) ? messages : [];
  const generated = new Date(now);
  const generatedLabel = Number.isFinite(generated.getTime()) ? generated.toLocaleString() : String(now);
  const answered = list.filter((m) => m && m.role === 'ai' && m.status === 'done').length;

  const lines: string[] = [];
  lines.push(`# 问答记录 · ${title}`);
  lines.push('');
  lines.push(`- 导出时间：${generatedLabel}`);
  lines.push(`- 消息数：${list.length}（回答完成 ${answered} 条）`);
  lines.push('');
  for (const message of list) {
    if (!message || typeof message !== 'object') continue;
    lines.push(...messageBlock(message));
  }
  lines.push('> 导出自智慧课堂学习助手；问答仅基于提问锚点附近的字幕上下文，锚点为提问时的播放位置。');
  return lines.join('\n');
}
