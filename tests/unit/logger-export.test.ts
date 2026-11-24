/**
 * 日志导出格式化测试（第 300 轮巡检，功能域）：formatLogsAsText 将环形日志
 * 转为「[时间] [级别] [scope] 消息 + 可选详情行」的纯文本，供设置页「导出」
 * 按钮落盘离线排障；与日志区展示同构。
 */
import { describe, expect, it } from 'vitest';
import { formatLogsAsText, type LogEntry } from '@/core/shared/logger';

const entry = (over: Partial<LogEntry>): LogEntry => ({
  ts: 1732233600000,
  level: 'info',
  scope: 'test-scope',
  message: '消息',
  ...over,
});

describe('formatLogsAsText（第 300 轮）', () => {
  it('单条无详情：一行 [时间] [级别] [scope] 消息', () => {
    const text = formatLogsAsText([entry({ message: '启动完成' })]);
    expect(text).toContain('[info]');
    expect(text).toContain('[test-scope]');
    expect(text).toContain('启动完成');
    expect(text.split('\n')).toHaveLength(1);
  });

  it('带详情：详情另起一行', () => {
    const text = formatLogsAsText([entry({ level: 'warn', message: '失败', detail: 'stack-line' })]);
    const lines = text.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('[warn]');
    expect(lines[0]).toContain('失败');
    expect(lines[1]).toBe('stack-line');
  });

  it('多条逐条成行；空数组得空串', () => {
    const text = formatLogsAsText([entry({ message: 'a' }), entry({ message: 'b' })]);
    expect(text.split('\n')).toHaveLength(2);
    expect(formatLogsAsText([])).toBe('');
  });
});
