/**
 * 问答记录导出单测（第 81 轮巡检）：core/export/chats 的 buildChatsMarkdown——
 * 用户/AI 消息分块、锚点与依据区间、字幕不足/生成中占位、空列表结构、时间注入。
 */
import { describe, expect, it } from 'vitest';
import { buildChatsMarkdown } from '@/core/export/chats';
import type { ChatMessageEntity } from '@/core/shared/types';

const NOW = new Date(2026, 10, 18, 12, 0, 0, 0).getTime();

function msg(overrides: Partial<ChatMessageEntity>): ChatMessageEntity {
  return {
    id: 'm1',
    mediaKey: 'hdu:1',
    groupId: 'g1',
    role: 'user',
    content: '问题',
    status: 'done',
    createdAt: 1,
    ...overrides,
  } as ChatMessageEntity;
}

describe('buildChatsMarkdown（问答记录导出，第 81 轮）', () => {
  it('混合消息：问带锚点、答带依据区间、字幕不足占位', () => {
    const md = buildChatsMarkdown(
      [
        msg({ role: 'user', content: '这一段的重点是什么？', anchorTime: 95 }),
        msg({ role: 'ai', content: '重点是矩阵乘法的分块思想。', status: 'done', evidence: { start: 60, end: 120 } }),
        msg({ id: 'm3', role: 'ai', content: '', status: 'done', insufficient: true }),
      ],
      '高等数学 · 第3节课',
      NOW,
    );
    expect(md).toContain('# 问答记录 · 高等数学 · 第3节课');
    expect(md).toContain('- 消息数：3（回答完成 2 条）');
    expect(md).toContain('## 问（@01:35）');
    expect(md).toContain('这一段的重点是什么？');
    expect(md).toContain('### 答（依据 01:00–02:00）');
    expect(md).toContain('（字幕不足，未能回答）');
    expect(md).toContain('> 导出自智慧课堂学习助手');
  });

  it('空列表仍输出结构；生成中消息给占位；时间可注入', () => {
    const md = buildChatsMarkdown([msg({ role: 'ai', content: '', status: 'streaming' })], 'B 站视频', NOW);
    expect(md).toContain('- 消息数：1（回答完成 0 条）');
    expect(md).toContain('（生成中）');
    // 注入时间落在导出行（不锁本地化格式，仅确认 now 生效）
    expect(md).toContain('- 导出时间：');
  });

  it('脏输入（非数组/空项）不抛错', () => {
    const md = buildChatsMarkdown([null as unknown as ChatMessageEntity, msg({ role: 'user', content: 'ok' })], 't', NOW);
    expect(md).toContain('ok');
  });
});
