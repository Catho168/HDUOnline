/** 网络地址安全校验（§1.3 规则 6）：协议白名单、私网/环回、元数据端点、日志脱敏。 */

import { describe, expect, it } from 'vitest';
import { assertUrlAllowed, checkUrl, redactUrl, toOriginPattern } from '@/core/shared/urlGuard';

describe('checkUrl：协议与主机', () => {
  it('默认拒绝环回/私网/链路本地/保留地址', () => {
    for (const url of [
      'http://127.0.0.1:11434/v1/chat/completions',
      'http://localhost:8080',
      'http://10.1.2.3/v1',
      'http://172.16.5.5/v1',
      'http://172.31.0.1/v1',
      'http://192.168.1.10/v1',
      'http://169.254.1.1/v1',
      'http://[::1]:11434/v1',
      'http://[fd00::1]/v1',
      'http://intranet.local/v1',
      'http://host.docker.internal:11434/v1',
    ]) {
      const result = checkUrl(url);
      expect(result.ok, url).toBe(false);
      expect(result.reason, url).toBe('private-address');
    }
  });

  it('显式允许后放行环回地址（但公网规则保持不变）', () => {
    expect(checkUrl('http://127.0.0.1:11434', { allowLocal: true }).ok).toBe(true);
    expect(checkUrl('http://localhost:11434', { allowLocal: true }).ok).toBe(true);
    expect(checkUrl('http://192.168.1.10/v1', { allowLocal: true }).ok).toBe(true);
    expect(checkUrl('http://10.1.2.3/v1', { allowLocal: true }).ok).toBe(true);
  });

  it('云元数据地址即使允许本地也被拒绝', () => {
    for (const url of [
      'http://169.254.169.254/latest/meta-data',
      'http://100.100.100.200/latest/meta-data',
      'http://metadata.google.internal/computeMetadata/v1',
      'http://[fd00:ec2::254]/latest/meta-data',
    ]) {
      const result = checkUrl(url, { allowLocal: true });
      expect(result.ok, url).toBe(false);
      expect(result.reason, url).toBe('metadata-endpoint');
    }
  });

  it('公网 http/https 地址通过', () => {
    expect(checkUrl('https://api.anthropic.com').ok).toBe(true);
    expect(checkUrl('https://hf-mirror.com/onnx-community/whisper-small').ok).toBe(true);
    expect(checkUrl('http://example.com/v1').ok).toBe(true);
  });

  it('非 http(s) 协议被拒绝', () => {
    for (const url of ['file:///etc/passwd', 'ftp://example.com', 'javascript:alert(1)', 'ws://example.com']) {
      const result = checkUrl(url);
      expect(result.ok, url).toBe(false);
      expect(result.reason, url).toBe('bad-protocol');
    }
  });

  it('非法 URL 与空主机', () => {
    expect(checkUrl('not a url')).toMatchObject({ ok: false, reason: 'bad-url' });
    expect(checkUrl('http://')).toMatchObject({ ok: false, reason: 'bad-url' });
  });

  it('自定义协议白名单（供测试/未来端点使用）', () => {
    expect(checkUrl('ws://example.com', { protocols: ['ws:', 'wss:'] }).ok).toBe(true);
  });

  it('assertUrlAllowed 抛出带原因的异常', () => {
    expect(() => assertUrlAllowed('http://127.0.0.1:11434')).toThrowError(/本地\/私网地址/);
    expect(() => assertUrlAllowed('https://api.example.com')).not.toThrow();
  });
});

describe('redactUrl / toOriginPattern', () => {
  it('redactUrl 去掉 query 与 hash（避免签名进日志）', () => {
    expect(redactUrl('https://vod.example.com/a/b.mp4?auth_key=placeholder-0-0-abc')).toBe(
      'https://vod.example.com/a/b.mp4',
    );
    expect(redactUrl('https://vod.example.com/a/b.mp4?auth_key=placeholder#t=10')).toBe(
      'https://vod.example.com/a/b.mp4',
    );
  });

  it('redactUrl 对非法 URL 做字符串截断兜底', () => {
    expect(redactUrl('not a url?x=1')).toBe('not a url');
    expect(redactUrl('not a url')).toBe('not a url');
  });

  it('toOriginPattern 生成 host 权限匹配串（端口不进入 match pattern）', () => {
    expect(toOriginPattern('https://api.deepseek.com/v1/chat')).toBe('https://api.deepseek.com/*');
    expect(toOriginPattern('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1/*');
    expect(toOriginPattern('nonsense')).toBeNull();
    expect(toOriginPattern('file:///tmp/x')).toBeNull();
  });
});
