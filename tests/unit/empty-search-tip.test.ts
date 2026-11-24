/**
 * 空结果建议词测试（第 308 轮巡检，检索域/可用性）：emptySearchTip 按关键词长度
 * 给出空结果建议——超过阈值（默认 16 字）点名「关键词较长（N 字）」引导取核心词，
 * 否则给通用建议；统一搜索与 B 站字幕空结果共用同一口径。
 */
import { describe, expect, it } from 'vitest';
import { emptySearchTip } from '@/entrypoints/content/ui/learning/recentQueries';

describe('emptySearchTip（第 308 轮）', () => {
  it('短关键词（≤16 字）给通用建议', () => {
    expect(emptySearchTip('高等数学')).toBe('试试更短的关键词，或换个说法');
    expect(emptySearchTip('字'.repeat(16))).toBe('试试更短的关键词，或换个说法');
  });

  it('长关键词（>16 字）点名字数（17 字边界）', () => {
    expect(emptySearchTip('字'.repeat(17))).toBe('关键词较长（17 字）——试试更短的关键词，或只取核心词重搜');
  });

  it('长度按 trim 后计（首尾空白不算字数）', () => {
    expect(emptySearchTip('   高等数学   ')).toBe('试试更短的关键词，或换个说法');
    expect(emptySearchTip(`  ${'字'.repeat(17)}  `)).toContain('（17 字）');
  });

  it('非字符串 / 空串防御：回落通用建议', () => {
    expect(emptySearchTip(undefined)).toBe('试试更短的关键词，或换个说法');
    expect(emptySearchTip(42)).toBe('试试更短的关键词，或换个说法');
    expect(emptySearchTip('   ')).toBe('试试更短的关键词，或换个说法');
  });

  it('自定义阈值生效', () => {
    expect(emptySearchTip('字'.repeat(4), 3)).toContain('（4 字）');
    expect(emptySearchTip('字'.repeat(4), 4)).toBe('试试更短的关键词，或换个说法');
  });
});
