/**
 * errorTextOf 纯函数单测（第 27 轮审计 P3-3）：
 *  - AppError 取 userMessage（callOp 反序列化回来的就是 AppError，message === userMessage，
 *    既有行为不变）；
 *  - 普通 Error 一律回退兜底文案（第 222 轮收紧：内部技术文案不直显给用户）；
 *  - 其余异常值（字符串 throw / undefined / null 等）同样回退固定兜底文案；
 *  - 可选 fallback 供调用方保留语境化兜底文案。
 */

import { describe, expect, it } from 'vitest';

import { AppError, ERROR_TEXT_FALLBACK, errorTextOf, serializeError } from '@/core/shared/errors';

describe('errorTextOf 错误文案统一出口（第 27 轮 P3-3）', () => {
  it('AppError 取 userMessage（与既有 message===userMessage 展示路径行为一致）', () => {
    const friendly = new AppError('LLM_NO_PROVIDER');
    expect(errorTextOf(friendly)).toBe(friendly.userMessage);
    expect(errorTextOf(friendly)).toBe('尚未配置 AI 服务，请在设置中添加');

    const custom = new AppError('INVALID_INPUT', { userMessage: '本节还没有转写文本，请先生成转写后再提问' });
    expect(errorTextOf(custom)).toBe('本节还没有转写文本，请先生成转写后再提问');
  });

  it('普通 Error 一律回退兜底文案（第 222 轮收紧：不透出内部技术文案）', () => {
    expect(errorTextOf(new Error('network down'))).toBe(ERROR_TEXT_FALLBACK);
    expect(errorTextOf(new TypeError('cannot read properties of undefined'))).toBe(ERROR_TEXT_FALLBACK);
    expect(errorTextOf(new RangeError('Maximum call stack size exceeded'))).toBe(ERROR_TEXT_FALLBACK);
  });

  it('非 Error 异常值回退固定兜底文案（收窄 runtime 异常直显面）', () => {
    expect(errorTextOf('字符串异常')).toBe(ERROR_TEXT_FALLBACK);
    expect(errorTextOf(undefined)).toBe(ERROR_TEXT_FALLBACK);
    expect(errorTextOf(null)).toBe(ERROR_TEXT_FALLBACK);
    expect(errorTextOf(42)).toBe(ERROR_TEXT_FALLBACK);
    expect(errorTextOf({ code: 1 })).toBe(ERROR_TEXT_FALLBACK);
    expect(ERROR_TEXT_FALLBACK).toBe('操作失败，请重试');
  });

  it('可选 fallback：调用方保留语境化兜底；AppError 优先于 fallback，普通 Error 走 fallback', () => {
    expect(errorTextOf('oops', '提问失败')).toBe('提问失败');
    expect(errorTextOf(new Error('boom'), '提问失败')).toBe('提问失败');
    expect(errorTextOf(new AppError('LLM_TIMEOUT'), '提问失败')).toBe('AI 请求超时');
  });
});

describe('errorTextOf 结构化错误透传链（第 255 轮盘点收口）', () => {
  it('duck-typed 结构化错误（SerializedAppError 形态 / { userMessage }）非空字符串直取——跨模块未经 deserialize 的裸结构化对象不再丢文案', () => {
    // serializeError 产物（未过 deserializeError 的形态）在跨模块传递中直接进 errorTextOf
    const serialized = { code: 'INVALID_INPUT', userMessage: '备份文件结构损坏：缺 chapters', detail: 'x', retryable: false };
    expect(errorTextOf(serialized)).toBe('备份文件结构损坏：缺 chapters');
    // 最小 duck-typed 形态
    expect(errorTextOf({ userMessage: '导出文件已过期，请重新导出' })).toBe('导出文件已过期，请重新导出');
    // AppError 仍然优先（userMessage 语义一致，等值验证链路不被 duck-typing 改写）
    const appErr = new AppError('INVALID_INPUT', { userMessage: '结构化优先于兜底' });
    expect(errorTextOf(appErr)).toBe('结构化优先于兜底');
    // 自定义 fallback 不覆盖结构化 userMessage
    expect(errorTextOf({ userMessage: '导入失败（文件可能损坏）' }, '兜底')).toBe('导入失败（文件可能损坏）');
  });

  it('userMessage 空串 / 非字符串 / 普通对象维持回退（不扩大技术文案泄漏面）', () => {
    expect(errorTextOf({ userMessage: '' })).toBe(ERROR_TEXT_FALLBACK);
    expect(errorTextOf({ userMessage: 42 })).toBe(ERROR_TEXT_FALLBACK);
    expect(errorTextOf({ userMessage: null })).toBe(ERROR_TEXT_FALLBACK);
    expect(errorTextOf({ code: 1 })).toBe(ERROR_TEXT_FALLBACK);
    expect(errorTextOf({ code: 1 }, '语境兜底')).toBe('语境兜底');
    // 普通 Error 无 userMessage 字段 → 回退（既有第 222 轮收紧行为不变）
    expect(errorTextOf(new Error('Maximum call stack size exceeded'))).toBe(ERROR_TEXT_FALLBACK);
    // 技术文案即使藏在 message 字段也不透出
    expect(errorTextOf({ message: 'TypeError: x is not a function' })).toBe(ERROR_TEXT_FALLBACK);
  });

  it('serializeError → errorTextOf 链路直查（未经 deserializeError 的透传形态不丢 userMessage）', () => {
    const err = new AppError('STORAGE_QUOTA');
    const wire = serializeError(err);
    // 序列化产物是普通对象（不再 instanceof AppError），duck-typed 识别仍直取 userMessage
    expect(wire instanceof AppError).toBe(false);
    expect(wire.userMessage).toBe('本地存储空间不足，建议导出并清理数据');
    expect(errorTextOf(wire)).toBe('本地存储空间不足，建议导出并清理数据');
  });
});
