/**
 * 统一搜索结果呈现增强测试（第 256 轮巡检，检索域）：
 *  1. snippetToSegments 纯函数——【】标注解析为高亮片段，原文自带【】不误标；
 *  2. mergeSearchResults 层——transcript 条目 hitCount>1 透传、=1 不带（防噪声）。
 */
import { describe, expect, it } from 'vitest';
import { buildSnippet, markTextSegments, mergeSearchResults, snippetToSegments } from '@/core/search/unified';

describe('snippetToSegments（【】标注 → 高亮片段）', () => {
  it('命中段标 marked=true，前后文 marked=false，顺序保持', () => {
    const snippet = buildSnippet('线性代数中矩阵的秩是一个核心概念', '矩阵');
    const segments = snippetToSegments(snippet, '矩阵');
    expect(segments.some((s) => s.marked && s.text === '矩阵')).toBe(true);
    expect(segments.filter((s) => !s.marked).map((s) => s.text).join('')).toContain('线性代数');
  });

  it('多次出现只标 buildSnippet 的首次命中段（±40 字符窗口内）', () => {
    const snippet = '【极限】是分析的基础，极限概念贯穿始终';
    const segments = snippetToSegments(snippet, '极限');
    const marked = segments.filter((s) => s.marked);
    expect(marked).toHaveLength(1);
    expect(marked[0]?.text).toBe('极限');
  });

  it('原文自带【】不误标：只有与关键词逐字相等（大小写不敏感）的段才标', () => {
    const segments = snippetToSegments('…【公开课】讲到了【矩阵】的概念…', '矩阵');
    const marked = segments.filter((s) => s.marked);
    expect(marked).toHaveLength(1);
    expect(marked[0]?.text).toBe('矩阵');
    const plain = segments.find((s) => s.text === '公开课');
    expect(plain?.marked).toBe(false);
  });

  it('无标注 / 空关键词 / 空串：返回单段原文或空数组，不抛错', () => {
    expect(snippetToSegments('没有任何标注的摘要', '关键词')).toEqual([{ text: '没有任何标注的摘要', marked: false }]);
    expect(snippetToSegments('【关键词】在开头', '')).toEqual([{ text: '【关键词】在开头', marked: false }]);
    expect(snippetToSegments('', '关键词')).toEqual([]);
    expect(snippetToSegments(null, '关键词')).toEqual([]);
  });
});

describe('markTextSegments（原文关键词标注，第 258 轮）', () => {
  it('原始文本中关键词全部出现都标注（大小写不敏感、从左到右）', () => {
    const segments = markTextSegments('矩阵乘法与矩阵的秩', '矩阵');
    const marked = segments.filter((s) => s.marked);
    expect(marked).toHaveLength(2);
    expect(marked.every((s) => s.text === '矩阵')).toBe(true);
    expect(segments.map((s) => s.text).join('')).toBe('矩阵乘法与矩阵的秩');
  });

  it('大小写不敏感：原文大写也能命中并保留原文形态', () => {
    const segments = markTextSegments('The Matrix Reloaded', 'matrix');
    const marked = segments.filter((s) => s.marked);
    expect(marked).toHaveLength(1);
    expect(marked[0]?.text).toBe('Matrix');
  });

  it('无命中 / 空关键词 / 空串 / 非字符串：单段原文或空数组，不抛错', () => {
    expect(markTextSegments('没有命中词的句子', '矩阵')).toEqual([{ text: '没有命中词的句子', marked: false }]);
    expect(markTextSegments('任意文本', '')).toEqual([{ text: '任意文本', marked: false }]);
    expect(markTextSegments('', '矩阵')).toEqual([]);
    expect(markTextSegments(null, '矩阵')).toEqual([]);
  });
});

describe('mergeSearchResults（transcript hitCount 透传）', () => {
  const base = {
    favorites: [],
    notes: [],
  };

  it('hitCount > 1：条目携带 hitCount（供「命中 N 段」meta 行）', () => {
    const result = mergeSearchResults(
      {
        ...base,
        transcripts: [{ courId: 11, teclId: 21, hitCount: 4, title: '高等数学 A', best: { startSec: 300, text: '矩阵的秩' } }],
      },
      '矩阵',
    );
    const hit = result.groups[0]?.items[0];
    expect(hit?.kind).toBe('transcript');
    expect(hit?.hitCount).toBe(4);
  });

  it('hitCount = 1：不带 hitCount 字段（单段不展示 meta，避免噪声）', () => {
    const result = mergeSearchResults(
      {
        ...base,
        transcripts: [{ courId: 12, teclId: 22, hitCount: 1, title: '线性代数 B', best: { startSec: 60, text: '矩阵乘法' } }],
      },
      '矩阵',
    );
    const hit = result.groups[0]?.items[0];
    expect(hit?.hitCount).toBeUndefined();
  });

  it('hitSegments 透传（第 257 轮）：多段命中带段列表；脏段（缺 startSec/text）被过滤', () => {
    const result = mergeSearchResults(
      {
        ...base,
        transcripts: [
          {
            courId: 13,
            teclId: 23,
            hitCount: 3,
            title: '概率论 A',
            best: { startSec: 30, text: '矩阵' },
            segments: [
              { startSec: 30, text: '矩阵的定义' },
              { startSec: 'bad' as unknown as number, text: '脏段' },
              { startSec: 90, text: '' },
              { startSec: 120, text: '矩阵的秩' },
            ],
          },
        ],
      },
      '矩阵',
    );
    const hit = result.groups[0]?.items[0];
    expect(hit?.hitCount).toBe(3);
    expect(hit?.hitSegments).toEqual([
      { startSec: 30, text: '矩阵的定义' },
      { startSec: 120, text: '矩阵的秩' },
    ]);
  });

  it('hitSegments 仅在多段命中时透传：hitCount=1 时即使带 segments 也不带', () => {
    const result = mergeSearchResults(
      {
        ...base,
        transcripts: [
          { courId: 14, teclId: 24, hitCount: 1, title: '复变函数', best: { startSec: 10, text: '矩阵' }, segments: [{ startSec: 10, text: '矩阵' }] },
        ],
      },
      '矩阵',
    );
    const hit = result.groups[0]?.items[0];
    expect(hit?.hitSegments).toBeUndefined();
  });
});
