/**
 * logger detail 截断测试（第 273 轮巡检，工程域）：超长详情（如组件栈）写入时
 * 截断至 MAX_LOG_DETAIL（500）+ 省略号，防单条挤占环形日志配额；短详情原样保留。
 */
import { describe, expect, it } from 'vitest';
import { createLogger, readLogs, MAX_LOG_DETAIL } from '@/core/shared/logger';

describe('logger detail 截断（第 273 轮）', () => {
  it('超长 detail 截断至 MAX_LOG_DETAIL + 省略号', async () => {
    const logger = createLogger('test-truncate');
    logger.error('长详情', 'x'.repeat(1200));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const logs = await readLogs();
    const last = logs[logs.length - 1];
    expect(last?.message).toBe('长详情');
    expect(last?.detail?.length).toBe(MAX_LOG_DETAIL + 1);
    expect(last?.detail?.endsWith('…')).toBe(true);
  });

  it('短 detail 原样保留（不截断）', async () => {
    const logger = createLogger('test-short');
    logger.warn('短详情', '正常内容');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const logs = await readLogs();
    const last = logs[logs.length - 1];
    expect(last?.detail).toBe('正常内容');
  });
});
