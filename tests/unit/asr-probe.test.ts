/**
 * MP4 音轨探测的回归测试。
 *
 * 背景：真实 47 分钟录播的 moov 约 2.4MB，固定“头 256KB + 尾 2MB”探测会失败，
 * 进而错误地触发整文件兜底（并被 400MB 护栏拒绝）。这里用 ffmpeg 生成两种
 * 典型布局（moov 在头 / moov 在尾），并把单次探测窗口调小，验证按
 * `appendBuffer()` 返回的下一段偏移迭代读取可以正确解析。
 *
 * 网络隔离：音频直链属不可信来源（生产路径在 fetch 前过 SSRF 防护），测试
 * 不应出现「变量 URL → 真实 fetch」的数据流。因此注入内存 fetch stub，按
 * Range 语义从磁盘 fixture 读字节返回——无 socket、无真实网络 I/O；
 * 占位 URL 使用 .invalid TLD（规范保证不可解析），仅用于通过防护校验。
 *
 * ffmpeg 不可用时跳过（不阻塞常规单测）。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probeAudioTrack } from '@/core/asr/mp4';

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const describeIfFfmpeg = hasFfmpeg ? describe : describe.skip;

describeIfFfmpeg('probeAudioTrack（分段迭代）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hdu-probe-'));
  const files: Record<'head' | 'tail', string> = {
    head: path.join(dir, 'head.mp4'),
    tail: path.join(dir, 'tail.mp4'),
  };

  beforeAll(() => {
    for (const [name, faststart] of [
      ['head', true],
      ['tail', false],
    ] as const) {
      const args = [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=64x48:r=30:d=10',
        '-f',
        'lavfi',
        '-i',
        'anullsrc=r=48000:cl=mono',
        '-t',
        '10',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '32k',
        '-y',
        ...(faststart ? ['-movflags', '+faststart'] : []),
        files[name],
      ];
      const result = spawnSync('ffmpeg', args, { stdio: 'ignore' });
      if (result.status !== 0) throw new Error(`ffmpeg 生成 ${name} 失败`);
    }
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** 内存 Range stub：按 Range 语义从磁盘 fixture 读字节，无真实网络 I/O */
  function makeRangeFetchStub(): typeof fetch {
    return (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const name = url.replace(/^.*\//, '').replace(/\.mp4.*$/, '') as 'head' | 'tail';
      const file = files[name];
      if (!file) return Promise.resolve(new Response(null, { status: 404 }));
      const size = fs.statSync(file).size;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const range = headers['Range'] ?? headers['range'] ?? '';
      const matched = range.match(/bytes=(\d+)-(\d*)/);
      if (!matched) {
        // 无 Range：按整文件 200 处理（probeAudioTrack 常规路径不会走到）
        const whole = new Uint8Array(fs.readFileSync(file));
        return Promise.resolve(
          new Response(whole, { status: 200, headers: { 'content-length': String(size) } }),
        );
      }
      const start = Number(matched[1] ?? 0);
      const endToken = matched[2];
      const end = endToken ? Math.min(Number(endToken), size - 1) : size - 1;
      const buf = fs.readFileSync(file);
      const slice = new Uint8Array(buf.subarray(start, end + 1));
      return Promise.resolve(
        new Response(slice, {
          status: 206,
          headers: {
            'content-range': `bytes ${start}-${end}/${size}`,
            'content-length': String(end - start + 1),
            'accept-ranges': 'bytes',
          },
        }),
      );
    };
  }

  /** 占位 URL：.invalid TLD 保证不可解析；stub 拦截后不会有真实请求发出 */
  const FIXTURE_URL_BASE = 'https://probe-fixture.invalid';

  for (const layout of ['head', 'tail'] as const) {
    it(`moov 在${layout === 'head' ? '头' : '尾'}部时可解析音轨样本`, async () => {
      const probe = await probeAudioTrack(`${FIXTURE_URL_BASE}/${layout}.mp4`, undefined, {
        // 故意小于 moov 体积，确保走“继续拉取下一段”的路径
        chunkBytes: 1024,
        fetchImpl: makeRangeFetchStub(),
      });
      const size = fs.statSync(files[layout]).size;
      expect(probe.fileSize).toBe(size);
      expect(probe.info.codec).toContain('mp4a');
      expect(probe.info.sampleRate).toBe(48000);
      expect(probe.info.durationSec).toBeGreaterThan(9.5);
      expect(probe.info.durationSec).toBeLessThan(10.5);
      expect(probe.samples.length).toBeGreaterThan(0);
      expect(probe.audioBytes).toBeGreaterThan(0);
      expect(probe.ranges.length).toBeGreaterThan(0);
      // AAC 的 AudioSpecificConfig 是 WebCodecs AudioDecoder.configure 的必需参数
      expect(probe.info.asc?.byteLength).toBeGreaterThan(0);
    });
  }
});
