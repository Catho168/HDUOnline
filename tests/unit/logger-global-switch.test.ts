/**
 * logger 全局开关测试（第 299 轮巡检，工程域）：「记录诊断日志」设置经
 * applyDebugLogEnabled 应用到模块级开关后，所有 logger 实例（任意 scope）同受约束——
 * 关闭时 debug/info 不写控制台也不落存储；warn/error 始终保留（诊断底线）；
 * setEnabled 为实例委托，改的是同一个全局开关。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { applyDebugLogEnabled, createLogger, readLogs } from '@/core/shared/logger';

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

afterEach(() => {
  // 恢复默认开启，避免泄漏到后续用例（logger 为模块级单例）
  applyDebugLogEnabled(true);
});

describe('logger 全局开关（第 299 轮）', () => {
  it('关闭后 debug/info 不落存储；warn/error 仍保留', async () => {
    applyDebugLogEnabled(false);
    const logger = createLogger('switch-off');
    logger.debug('调试不应写入');
    logger.info('信息不应写入');
    logger.warn('警告仍写入');
    logger.error('错误仍写入');
    await settle();
    const levels = (await readLogs())
      .filter((l) => l.scope === 'switch-off')
      .map((l) => l.level)
      .sort();
    expect(levels).toEqual(['error', 'warn']);
  });

  it('重新开启后 debug 恢复写入', async () => {
    applyDebugLogEnabled(false);
    const logger = createLogger('switch-reopen');
    logger.debug('关闭期');
    applyDebugLogEnabled(true);
    logger.debug('开启期');
    await settle();
    const messages = (await readLogs())
      .filter((l) => l.scope === 'switch-reopen')
      .map((l) => l.message);
    expect(messages).toEqual(['开启期']);
  });

  it('setEnabled 为实例方法，改的是全局开关（跨实例生效）', async () => {
    const a = createLogger('switch-inst-a');
    const b = createLogger('switch-inst-b');
    a.setEnabled(false);
    b.debug('b 关闭期');
    await settle();
    expect((await readLogs()).some((l) => l.scope === 'switch-inst-b')).toBe(false);
    a.setEnabled(true);
    b.debug('b 恢复期');
    await settle();
    expect(
      (await readLogs()).some((l) => l.scope === 'switch-inst-b' && l.message === 'b 恢复期'),
    ).toBe(true);
  });

  it('关闭后 info 不写控制台（writeLine 受 verbose 门控）', async () => {
    applyDebugLogEnabled(false);
    const lines: string[] = [];
    const origInfo = console.info;
    console.info = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      createLogger('switch-console').info('控制台静默');
      await settle();
      expect(lines.some((line) => line.includes('控制台静默'))).toBe(false);
    } finally {
      console.info = origInfo;
    }
  });
});
