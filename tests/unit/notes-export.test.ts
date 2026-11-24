/**
 * 笔记导出序列化单测（第 106 轮巡检）：buildNotesMarkdown——锚点升序、
 * 无锚点排尾、脏数据跳过、空输入防御。输入取最小结构，HDU/B 站笔记实体通用。
 */
import { describe, expect, it } from 'vitest';
import { buildGroupedNotesMarkdown, buildNotesMarkdown } from '@/core/export/notes';

describe('buildNotesMarkdown（笔记导出，第 106 轮）', () => {
  it('按锚点升序渲染 [mm:ss] 标题；≥1h 带时位', () => {
    const md = buildNotesMarkdown(
      [
        { text: '第二个概念', anchorTime: 3675 },
        { text: '第一个概念', anchorTime: 65 },
      ],
      '高等数学（E2E） 第3节',
    );
    expect(md).toContain('# 学习笔记 · 高等数学（E2E） 第3节');
    expect(md).toContain('- 笔记数：2');
    expect(md.indexOf('[01:05] 第一个概念')).toBeGreaterThan(-1);
    expect(md.indexOf('[1:01:15] 第二个概念')).toBeGreaterThan(md.indexOf('[01:05] 第一个概念'));
  });

  it('无锚点笔记排最后；脏数据跳过；空输入返回结构骨架', () => {
    const md = buildNotesMarkdown(
      [
        { text: '无锚点笔记' },
        { text: '  ', anchorTime: 10 },
        { text: '有锚点笔记', anchorTime: 30 },
        null as never,
        { text: 123, anchorTime: 5 } as never,
      ],
      'B 站视频 P2',
    );
    expect(md).toContain('- 笔记数：2');
    expect(md.indexOf('[00:30] 有锚点笔记')).toBeGreaterThan(-1);
    expect(md.indexOf('无锚点笔记')).toBeGreaterThan(md.indexOf('[00:30] 有锚点笔记'));
    expect(md).not.toContain('123');
    const empty = buildNotesMarkdown([], 't');
    expect(empty).toContain('- 笔记数：0');
    expect(buildNotesMarkdown(null, 't')).toContain('# 学习笔记 · t');
  });
});

describe('buildGroupedNotesMarkdown（分组汇编，第 109 轮）', () => {
  it('按课程分组；组内锚点升序；空组剔除；总计数正确', () => {
    const md = buildGroupedNotesMarkdown(
      [
        { label: '高等数学（2026秋）', notes: [{ text: 'B2', anchorTime: 120 }, { text: 'B1', anchorTime: 30 }] },
        { label: '空组', notes: [] },
        { label: '其他', notes: [{ text: '无锚点' }] },
      ],
      '全部笔记（站内）',
    );
    expect(md).toContain('- 笔记数：3（2 个分组）');
    expect(md).toContain('## 高等数学（2026秋）（2）');
    expect(md.indexOf('[00:30] B1')).toBeLessThan(md.indexOf('[02:00] B2'));
    expect(md).toContain('## 其他（1）');
    expect(md).not.toContain('空组');
  });

  it('脏分组/脏标签防御；null 输入返回骨架', () => {
    const md = buildGroupedNotesMarkdown(
      [null as never, { label: 42, notes: [{ text: 'ok', anchorTime: 5 }] }],
      't',
    );
    expect(md).toContain('- 笔记数：1（1 个分组）');
    expect(md).toContain('## 其他（1）');
    expect(buildGroupedNotesMarkdown(null, 't')).toContain('- 笔记数：0（0 个分组）');
  });
});
