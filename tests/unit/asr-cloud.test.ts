/** 云端 ASR 适配层测试（§8：WAV 编码、multipart 字段、verbose_json/json 解析、错误分类、取消） */

import { describe, expect, it } from 'vitest';
import { encodeWavPcm16, testCloudAsr, transcribePcmCloud } from '@/core/asr/cloud';
import { AppError } from '@/core/shared/errors';

const CFG = { baseUrl: 'https://asr.example.com', apiKey: 'sk-test-not-a-real-key', model: 'test-model' };
/** 注入小超时与近零退避，让重试路径可测且不慢 */
const FAST = { timeouts: { connectMs: 80, totalMs: 200 }, retryDelayMs: 1 };

type MockFetch = typeof fetch & { calls: Array<[string, RequestInit]> };

function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response> | Response): MockFetch {
  const calls: Array<[string, RequestInit]> = [];
  const fn = (async (url: unknown, init?: RequestInit) => {
    const requestInit = init ?? ({} as RequestInit);
    calls.push([String(url), requestInit]);
    return impl(String(url), requestInit);
  }) as MockFetch;
  fn.calls = calls;
  return fn;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 非静音 PCM：恒定小幅值正弦，避免被静音检测跳过 */
function tonePcm(seconds: number, rate = 16_000, amplitude = 0.2): Float32Array {
  const pcm = new Float32Array(Math.floor(seconds * rate));
  for (let i = 0; i < pcm.length; i += 1) pcm[i] = amplitude * Math.sin((2 * Math.PI * 220 * i) / rate);
  return pcm;
}

async function appErrorOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    return err as AppError;
  }
  throw new Error('期望抛出 AppError');
}

// ───────────────────────── WAV 编码 ─────────────────────────

describe('encodeWavPcm16', () => {
  it('RIFF 头字段正确（16kHz / 16bit / mono），字节数 = n×2 + 44', () => {
    const pcm = new Float32Array(1000);
    pcm[0] = 0.5;
    pcm[1] = -0.5;
    const wav = encodeWavPcm16(pcm);

    expect(wav.byteLength).toBe(1000 * 2 + 44);
    const ascii = (offset: number, len: number) =>
      String.fromCharCode(...wav.slice(offset, offset + len));
    expect(ascii(0, 4)).toBe('RIFF');
    expect(ascii(8, 4)).toBe('WAVE');
    expect(ascii(12, 4)).toBe('fmt ');
    expect(ascii(36, 4)).toBe('data');

    const view = new DataView(wav.buffer);
    expect(view.getUint32(4, true)).toBe(36 + 2000); // RIFF 块大小
    expect(view.getUint16(20, true)).toBe(1); // PCM 编码
    expect(view.getUint16(22, true)).toBe(1); // 单声道
    expect(view.getUint32(24, true)).toBe(16_000); // 采样率
    expect(view.getUint32(28, true)).toBe(16_000 * 2); // 字节率
    expect(view.getUint16(34, true)).toBe(16); // 位深
    expect(view.getUint32(40, true)).toBe(2000); // 数据块大小
  });

  it('Float32 转 Int16 截断（正值 0x7fff、负值 0x8000 口径）并钳制超幅值', () => {
    const pcm = new Float32Array([0.5, -0.5, 2, -2]);
    const view = new DataView(encodeWavPcm16(pcm).buffer);
    expect(view.getInt16(44, true)).toBe(Math.floor(0.5 * 0x7fff));
    expect(view.getInt16(46, true)).toBe(-0x4000);
    expect(view.getInt16(48, true)).toBe(0x7fff);
    expect(view.getInt16(50, true)).toBe(-0x8000);
  });
});

// ───────────────────────── multipart 请求体 ─────────────────────────

describe('transcribePcmCloud 请求构造', () => {
  it('POST {base}/v1/audio/transcriptions，multipart 字段齐全', async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ text: '你好', segments: [] }));
    await transcribePcmCloud(tonePcm(1), CFG, { lang: 'zh', prompt: '本课程术语：矩阵', fetchImpl });

    expect(fetchImpl.calls).toHaveLength(1);
    const [url, init] = fetchImpl.calls[0]!;
    expect(url).toBe('https://asr.example.com/v1/audio/transcriptions');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${CFG.apiKey}`);

    const form = init.body as FormData;
    expect(form.get('model')).toBe('test-model');
    expect(form.get('language')).toBe('zh');
    expect(form.get('prompt')).toBe('本课程术语：矩阵');
    expect(form.get('response_format')).toBe('verbose_json');

    const file = form.get('file') as File;
    expect(file).toBeInstanceOf(Blob);
    expect(file.type).toBe('audio/wav');
    expect(file.name).toBe('audio.wav');
    expect(file.size).toBe(16_000 * 2 + 44); // 1 秒 16kHz 16-bit
  });

  it('language=auto 时不传 language 字段；prompt 缺省不传', async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ text: 'hi' }));
    await transcribePcmCloud(tonePcm(0.5), CFG, { lang: 'auto', fetchImpl });
    const form = fetchImpl.calls[0]![1].body as FormData;
    expect(form.get('language')).toBeNull();
    expect(form.get('prompt')).toBeNull();
  });

  it('请求前经 urlGuard：私网/云元数据地址直接拒绝，不发起 fetch', async () => {
    for (const baseUrl of ['http://127.0.0.1:11434', 'http://192.168.1.2:9000', 'http://169.254.169.254/latest']) {
      const fetchImpl = mockFetch(() => jsonResponse({ text: 'x' }));
      const err = await appErrorOf(
        transcribePcmCloud(tonePcm(0.5), { ...CFG, baseUrl }, { lang: 'auto', fetchImpl }),
      );
      expect(err.code).toBe('ASR_INFER_FAILED');
      expect(err.retryable).toBe(false);
      expect(fetchImpl.calls).toHaveLength(0);
    }
    // 显式 allowLocal 后放行环回
    const fetchImpl = mockFetch(() => jsonResponse({ text: 'x' }));
    await transcribePcmCloud(tonePcm(0.5), { ...CFG, baseUrl: 'http://127.0.0.1:9000' }, {
      lang: 'auto',
      allowLocalEndpoints: true,
      fetchImpl,
    });
    expect(fetchImpl.calls).toHaveLength(1);
  });
});

// ───────────────────────── 响应解析 ─────────────────────────

describe('transcribePcmCloud 响应解析', () => {
  it('verbose_json：segments 映射为带时间戳的 chunks', async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse({
        text: '第一段 第二段',
        segments: [
          { start: 0.0, end: 2.5, text: '第一段' },
          { start: 2.5, end: 4.0, text: '第二段' },
        ],
      }),
    );
    const { chunks } = await transcribePcmCloud(tonePcm(4), CFG, { lang: 'zh', fetchImpl });
    expect(chunks).toEqual([
      { text: '第一段', timestamp: [0, 2.5] },
      { text: '第二段', timestamp: [2.5, 4] },
    ]);
  });

  it('verbose_json 无 segments 但有 text：按整片粗粒度包装', async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ text: '整段文本' }));
    const { chunks } = await transcribePcmCloud(tonePcm(3), CFG, { lang: 'zh', fetchImpl });
    expect(chunks).toEqual([{ text: '整段文本', timestamp: [0, 3] }]);
  });

  it('端点不支持 verbose_json（400 且提及 response_format）→ 自动降级 json', async () => {
    const fetchImpl = mockFetch((_url, init) => {
      const format = (init.body as FormData).get('response_format');
      if (format === 'verbose_json') {
        return jsonResponse({ error: { message: 'unsupported response_format verbose_json' } }, 400);
      }
      return jsonResponse({ text: '纯文本结果' });
    });
    const { chunks } = await transcribePcmCloud(tonePcm(2), CFG, { lang: 'zh', fetchImpl, ...FAST });
    expect(fetchImpl.calls).toHaveLength(2);
    const secondForm = fetchImpl.calls[1]![1].body as FormData;
    expect(secondForm.get('response_format')).toBe('json');
    expect(chunks).toEqual([{ text: '纯文本结果', timestamp: [0, 2] }]);
  });
});

// ───────────────────────── 错误分类与重试 ─────────────────────────

describe('transcribePcmCloud 错误分类', () => {
  it('401 → ASR_AUTH_FAILED 不可重试，不重试', async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ error: { message: 'invalid api key' } }, 401));
    const err = await appErrorOf(transcribePcmCloud(tonePcm(1), CFG, { lang: 'zh', fetchImpl, ...FAST }));
    expect(err.code).toBe('ASR_AUTH_FAILED');
    expect(err.retryable).toBe(false);
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it('429 → 可重试，重试至上限后抛 ASR_NETWORK_FAILED', async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ error: { message: 'rate limit' } }, 429));
    const err = await appErrorOf(transcribePcmCloud(tonePcm(1), CFG, { lang: 'zh', fetchImpl, ...FAST }));
    expect(err.code).toBe('ASR_NETWORK_FAILED');
    expect(err.retryable).toBe(true);
    expect(fetchImpl.calls).toHaveLength(3); // 首次 + CLOUD_ASR_MAX_RETRIES 次
  });

  it('5xx → 可重试；限流后恢复成功则返回结果', async () => {
    let attempt = 0;
    const fetchImpl = mockFetch(() => {
      attempt += 1;
      return attempt <= 2 ? jsonResponse({ error: 'server error' }, 500) : jsonResponse({ text: 'ok' });
    });
    const { chunks } = await transcribePcmCloud(tonePcm(1), CFG, { lang: 'zh', fetchImpl, ...FAST });
    expect(chunks).toEqual([{ text: 'ok', timestamp: [0, 1] }]);
    expect(fetchImpl.calls).toHaveLength(3);
  });

  it('连接超时 → 可重试的 ASR_NETWORK_FAILED', async () => {
    // mock 必须响应 abort 信号（真实 fetch 会），否则总超时无法打断挂起的请求
    const fetchImpl = mockFetch(
      (_url, init) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const err = await appErrorOf(
      transcribePcmCloud(tonePcm(1), CFG, { lang: 'zh', fetchImpl, timeouts: { connectMs: 60, totalMs: 120 }, retryDelayMs: 1 }),
    );
    expect(err.code).toBe('ASR_NETWORK_FAILED');
    expect(err.retryable).toBe(true);
  });

  it('外部 AbortSignal → ASR_CANCELLED 且不重试', async () => {
    const fetchImpl = mockFetch(
      (_url, init) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 40);
    try {
      const err = await appErrorOf(
        transcribePcmCloud(tonePcm(1), CFG, { lang: 'zh', signal: controller.signal, fetchImpl, ...FAST }),
      );
      expect(err.code).toBe('ASR_CANCELLED');
      expect(fetchImpl.calls).toHaveLength(1);
    } finally {
      clearTimeout(timer);
    }
  });

  it('取消后不再发起后续请求', async () => {
    // 在途请求较慢：外部取消先触发，应直接 ASR_CANCELLED 而不是继续重试
    const fetchImpl = mockFetch(
      (_url, init) =>
        new Promise<Response>((resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          setTimeout(() => resolve(jsonResponse({ error: 'rate limit' }, 429)), 500);
        }),
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 40);
    try {
      const err = await appErrorOf(
        transcribePcmCloud(tonePcm(1), CFG, { lang: 'zh', signal: controller.signal, fetchImpl, ...FAST }),
      );
      expect(err.code).toBe('ASR_CANCELLED');
      expect(fetchImpl.calls).toHaveLength(1);
    } finally {
      clearTimeout(timer);
    }
  });
});

// ───────────────────────── 连接测试 ─────────────────────────

describe('testCloudAsr', () => {
  it('上传 0.5s 静音并返回 ok + model', async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ text: '', segments: [{ start: 0, end: 0.4, text: '静音' }] }));
    const result = await testCloudAsr(CFG, { fetchImpl });
    expect(result).toEqual({ ok: true, model: 'test-model' });
    const file = (fetchImpl.calls[0]![1].body as FormData).get('file') as File;
    expect(file.size).toBe(Math.floor(16_000 / 2) * 2 + 44);
  });

  it('空结果视为失败', async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ text: '  ' }));
    await expect(testCloudAsr(CFG, { fetchImpl })).rejects.toBeInstanceOf(AppError);
  });
});
