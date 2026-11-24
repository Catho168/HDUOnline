/**
 * logger 脱敏（redact）单测（第 282 轮巡检，工程域）：密钥 / 凭据形态写入前脱敏。
 */
import { describe, expect, it } from 'vitest';
import { redact } from '@/core/shared/logger';
import { redactUrl } from '@/core/shared/urlGuard';

describe('logger redact 脱敏（第 282 轮）', () => {
  it('sk- 密钥脱敏为 sk-***', () => {
    expect(redact('key=sk-abcdef1234567890')).toBe('key=sk-***');
  });

  it('Bearer 令牌脱敏', () => {
    // authorization 头与 Bearer 两条模式先后命中，均脱敏为 ***
    expect(redact('Authorization: Bearer abcdefgh12345678')).toBe('Authorization: *** ***');
  });

  it('api-key / authorization 头脱敏', () => {
    expect(redact('x-api-key: abcdef123456')).toContain('***');
    expect(redact('authorization"="verylongsecret99')).toContain('***');
  });

  it('cookie / jwt token 脱敏', () => {
    expect(redact('cookie"="sid1234567890')).toContain('***');
    expect(redact('jwt_token=abcdef12345678')).toContain('***');
  });

  it('URL 整体脱敏：query 中的 auth_key 随 URL 剥除（redactUrl 只留 origin+path）', () => {
    expect(redact('https://x.com/api?auth_key=secret123')).toBe('https://x.com/api');
  });

  it('普通文本原样保留', () => {
    expect(redact('普通日志内容，无敏感信息')).toBe('普通日志内容，无敏感信息');
  });

  it('redactUrl：URL 保留 origin + path，剥掉 query/hash', () => {
    expect(redactUrl('https://x.com/path/page?token=1&x=2#frag')).toBe('https://x.com/path/page');
  });

  it('redactUrl：非法 URL 回退到 ?/# 前截断', () => {
    expect(redactUrl('not-a-url?secret=1')).toBe('not-a-url');
  });
});
