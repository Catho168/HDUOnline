/**
 * 消息边界类型收窄集成测试（第 24 轮审计 P3 纵深防御）：
 * handleRequest 对 REQUEST args 的常见 id 类参数做运行时校验——
 *  1. courId/teclId 等数字 id 为字符串 / NaN / Infinity 时拒之门外（INVALID_INPUT，不进 handler）；
 *  2. mediaKey/bvid 等字符串 id 为非字符串 / 空串时拒绝；
 *  3. 嵌套容器（favorite/note/filter）内的 id 字段同样收窄；
 *  4. 合法消息（含缺省可选字段、字符串 id、无参 op）不受影响，正常进入 handler。
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { getDb } from '@/core/db';
import type { RequestMessage, ResponseMessage } from '@/core/shared/messages';
import type { OpName } from '@/core/shared/ops';
import { handleRequest } from '@/entrypoints/background/index';

beforeAll(async () => {
  await getDb();
});

function request(op: OpName, args: unknown): RequestMessage {
  return { type: 'REQUEST', requestId: 'req-test', op, args } as RequestMessage;
}

async function call(op: OpName, args: unknown, tabId?: number): Promise<ResponseMessage> {
  return handleRequest(request(op, args), tabId);
}

describe('handleRequest 消息边界类型收窄（第 24 轮 P3）', () => {
  it('courId 为字符串时被拒：INVALID_INPUT，不进 handler', async () => {
    const resp = await call('session.get', { courId: '123' });
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe('INVALID_INPUT');
    expect(resp.error?.detail).toContain('courId');
  });

  it('courId 为 NaN / Infinity 时被拒', async () => {
    for (const courId of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const resp = await call('session.get', { courId });
      expect(resp.ok, String(courId)).toBe(false);
      expect(resp.error?.code, String(courId)).toBe('INVALID_INPUT');
    }
  });

  it('teclId 为字符串时被拒', async () => {
    const resp = await call('course.get', { teclId: '42' });
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe('INVALID_INPUT');
  });

  it('mediaKey 非字符串 / 空串被拒；bvid 非字符串被拒', async () => {
    for (const args of [{ mediaKey: 42 }, { mediaKey: '' }, { bvid: 123 }]) {
      const resp = await call('transcript.get', args);
      expect(resp.ok, JSON.stringify(args)).toBe(false);
      expect(resp.error?.code, JSON.stringify(args)).toBe('INVALID_INPUT');
    }
    const bvidResp = await call('bili.subtitle.fetch', { bvid: 42 });
    expect(bvidResp.error?.code).toBe('INVALID_INPUT');
  });

  it('嵌套容器内的 id 字段同样收窄：favorite.courId 字符串被拒', async () => {
    const resp = await call('fav.put', { favorite: { id: 'fav-1', courId: 'oops' } });
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe('INVALID_INPUT');
  });

  it('groupId 非字符串 / 空串 / null 被拒（qa.list / qa.clear 入参，第 27 轮 P3-2）', async () => {
    for (const groupId of [42, '', null]) {
      const resp = await call('qa.list', { mediaKey: 'bili:BVdemo0001', groupId });
      expect(resp.ok, String(groupId)).toBe(false);
      expect(resp.error?.code, String(groupId)).toBe('INVALID_INPUT');
      expect(resp.error?.detail).toContain('groupId');
    }
    const clearResp = await call('qa.clear', { mediaKey: 'bili:BVdemo0001', groupId: '' });
    expect(clearResp.ok).toBe(false);
    expect(clearResp.error?.code).toBe('INVALID_INPUT');
    expect(clearResp.error?.detail).toContain('groupId');
  });

  it('合法 groupId 字符串放行，可选缺省仍放行（第 27 轮 P3-2 回归）', async () => {
    expect(await call('qa.list', { mediaKey: 'bili:BVdemo0001', groupId: 'g1' })).toMatchObject({
      ok: true,
      result: [],
    });
    expect(await call('qa.clear', { mediaKey: 'bili:BVdemo0001', groupId: 'g1' })).toMatchObject({ ok: true });
    // groupId 缺省（undefined）放行：qa.ask 新会话 / qa.list 全量读取的既有口径
    expect(await call('qa.list', { mediaKey: 'bili:BVdemo0001' })).toMatchObject({ ok: true, result: [] });
  });

  it('args 为非对象（字符串 / 数组）被拒', async () => {
    for (const args of ['oops', [1, 2, 3]]) {
      const resp = await call('session.get', args);
      expect(resp.ok).toBe(false);
      expect(resp.error?.code).toBe('INVALID_INPUT');
    }
  });

  it('合法消息不受影响：正常进入 handler 返回结果', async () => {
    expect(await call('course.list', {})).toMatchObject({ ok: true, result: [] });
    expect(await call('transcript.get', { mediaKey: 'bili:BVdemo0001' })).toMatchObject({ ok: true, result: null });
    expect(await call('session.get', { courId: 42 })).toMatchObject({ ok: true, result: null });
    expect(await call('fav.get', { id: 'not-exist' })).toMatchObject({ ok: true, result: null });
    // kv 合法键经消息边界后照常工作（白名单键放行）
    expect(await call('kv.get', { key: 'goal:adjust' })).toMatchObject({ ok: true, result: null });
  });

  it('字符串 id（favoriteId/chatId）与可选字段缺省合法通过', async () => {
    // favoriteId 本就是字符串主键（收藏 id），字符串合法
    expect(await call('review.cancel', { favoriteId: 'fav-nonexistent' })).toMatchObject({ ok: true });
    expect(await call('qa.abort', { chatId: 'chat-nonexistent' })).toMatchObject({ ok: true });
    // 可选 id 字段缺省放行
    expect(await call('fav.counts', {})).toMatchObject({ ok: true });
  });

  it('无参 op 传 undefined / 空对象 args 均放行', async () => {
    expect((await call('course.list', undefined)).ok).toBe(true);
    expect((await call('course.list', {})).ok).toBe(true);
  });

  it('windowPreset 非法取值 / 空串 / null / 非字符串被拒（qa.ask / ai.generate 档位，第 28 轮 P3-2）', async () => {
    for (const windowPreset of ['huge', '', null, 42]) {
      const resp = await call('qa.ask', { mediaKey: 'bili:BVdemo0001', question: 'q', anchorTime: 0, windowPreset });
      expect(resp.ok, String(windowPreset)).toBe(false);
      expect(resp.error?.code, String(windowPreset)).toBe('INVALID_INPUT');
      expect(resp.error?.detail, String(windowPreset)).toContain('windowPreset');
    }
    const aiResp = await call('ai.generate', { mediaKey: 'bili:BVdemo0001', windowPreset: 'tiny' });
    expect(aiResp.ok).toBe(false);
    expect(aiResp.error?.code).toBe('INVALID_INPUT');
    expect(aiResp.error?.detail).toContain('windowPreset');
  });

  it('合法 windowPreset 三档放行进 handler、缺省仍放行（第 28 轮 P3-2 回归）', async () => {
    for (const windowPreset of ['small', 'medium', 'large']) {
      // 测试环境未配置 provider：qa.ask 通过守卫进入 handler 后抛 LLM_NO_PROVIDER
      const resp = await call('qa.ask', { mediaKey: 'bili:BVdemo0001', question: 'q', anchorTime: 0, windowPreset });
      expect(resp.ok, String(windowPreset)).toBe(false);
      expect(resp.error?.code, String(windowPreset)).toBe('LLM_NO_PROVIDER');
    }
    // 缺省（undefined）放行：与既有口径一致
    const resp = await call('qa.ask', { mediaKey: 'bili:BVdemo0001', question: 'q', anchorTime: 0 });
    expect(resp.error?.code).toBe('LLM_NO_PROVIDER');
    // ai.generate 合法档位同样放行进 handler（无转写 → handler 级 INVALID_INPUT，
    // 序列化错误里不含 windowPreset 字样，证明不是守卫拦截）
    const aiResp = await call('ai.generate', { mediaKey: 'bili:BVdemo0001', windowPreset: 'large' });
    expect(aiResp.error?.code).toBe('INVALID_INPUT');
    expect(JSON.stringify(aiResp.error ?? {})).not.toContain('windowPreset');
  });

  it('question 非字符串 / 空串在消息边界被拒（qa.ask，第 30 轮审计#5）', async () => {
    // 非字符串原本会在 handler 的 args.question.trim() 处 TypeError 落成 UNKNOWN；
    // 空串原本由 handler 判 INVALID_INPUT——边界提前拦截后错误码一致、detail 指明字段
    for (const question of [42, null, {}, '']) {
      const resp = await call('qa.ask', { mediaKey: 'bili:BVdemo0001', question, anchorTime: 0 });
      expect(resp.ok, String(question)).toBe(false);
      expect(resp.error?.code, String(question)).toBe('INVALID_INPUT');
      expect(resp.error?.detail, String(question)).toContain('question');
    }
  });

  it('question 纯空白串放行进 handler，仍由 handler trim 后判空（语义不变）', async () => {
    const resp = await call('qa.ask', { mediaKey: 'bili:BVdemo0001', question: '   ', anchorTime: 0 });
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe('INVALID_INPUT');
    expect(resp.error?.detail).toContain('问题不能为空');
  });

  it('anchorTime 非有限数 / 非数值 / null 在消息边界被拒（qa.ask，第 30 轮审计#5）', async () => {
    // handler 直接拿 anchorTime 做窗口算术与 formatClock，非有限数必产生 NaN 窗口
    for (const anchorTime of [Number.NaN, Number.POSITIVE_INFINITY, '12', null]) {
      const resp = await call('qa.ask', { mediaKey: 'bili:BVdemo0001', question: 'q', anchorTime });
      expect(resp.ok, String(anchorTime)).toBe(false);
      expect(resp.error?.code, String(anchorTime)).toBe('INVALID_INPUT');
      expect(resp.error?.detail, String(anchorTime)).toContain('anchorTime');
    }
  });

  it('anchorTime 嵌套在 favorite 容器同样收窄；合法有限数放行进 handler（第 30 轮审计#5）', async () => {
    const resp = await call('fav.put', { favorite: { id: 'fav-guard-1', anchorTime: Number.NaN } });
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe('INVALID_INPUT');
    expect(resp.error?.detail).toContain('anchorTime');
    // 有限数放行（错误里不含 anchorTime 字样，证明不是守卫拦截）；
    // qa.ask 缺省 anchorTime 的放行已由上面 windowPreset 回归用例覆盖
    const okResp = await call('fav.put', { favorite: { id: 'fav-guard-2', anchorTime: 12.5 } });
    expect(JSON.stringify(okResp.error ?? {})).not.toContain('anchorTime');
  });

  it('stats.period 的 kind 越界取值在消息边界被拒（第 35 轮审计 P3-2）', async () => {
    // kind 为 stats.period/stats.bili.overview 与 export.build 共用字段名，
    // 白名单为两组合法值并集（week/month/cards/list/outline/backup）
    for (const kind of ['day', 'year', '', null, 7]) {
      const resp = await call('stats.period', { kind });
      expect(resp.ok, String(kind)).toBe(false);
      expect(resp.error?.code, String(kind)).toBe('INVALID_INPUT');
      expect(resp.error?.detail, String(kind)).toContain('kind');
    }
  });

  it('stats.period 合法 kind 放行进 handler；count 非有限数被拒、缺省放行（第 35 轮审计 P3-2）', async () => {
    for (const kind of ['week', 'month']) {
      const resp = await call('stats.period', { kind });
      expect(resp.ok, kind).toBe(true);
      expect(JSON.stringify(resp.error ?? {}), kind).not.toContain('kind');
    }
    for (const count of [Number.NaN, Number.POSITIVE_INFINITY, '4', null]) {
      const resp = await call('stats.period', { kind: 'week', count });
      expect(resp.ok, String(count)).toBe(false);
      expect(resp.error?.code, String(count)).toBe('INVALID_INPUT');
      expect(resp.error?.detail, String(count)).toContain('count');
    }
    const ok = await call('stats.period', { kind: 'week' });
    expect(ok.ok).toBe(true);
  });
});
