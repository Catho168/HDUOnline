/**
 * 截图链路（A6，§7 A6）。
 *
 * 三级降级：
 *  ① Offscreen 用隐藏 `<video crossOrigin='anonymous'>` 复现当前帧 + canvas 加水印 → PNG（首选）；
 *  ② 直链 CORS 不通时，回退到内容脚本的 captureStream/ImageCapture（在文内脚本侧实现）；
 *  ③ 再失败则只保存元数据（跳转链接），UI 明确提示。
 *
 * Offscreen 侧把 Blob 直接写入 IndexedDB（同一扩展源），SW 只负责协调与回执。
 */

import { AppError, toAppError, type SerializedAppError } from '@/core/shared/errors';
import { createLogger } from '@/core/shared/logger';
import type { OffscreenOutbound } from '@/core/shared/messages';
import { sendToOffscreen } from '@/core/shared/runtime';
import { uuid } from '@/core/shared/utils';

const log = createLogger('sw-shot');

interface PendingShot {
  resolve: (value: { id: string; width: number; height: number }) => void;
  reject: (err: unknown) => void;
}

const pending = new Map<string, PendingShot>();

export interface ShotRequest {
  courId: number;
  teclId: number;
  view: number;
  atSec: number;
  /** 新鲜直链（限时签名） */
  url: string;
  watermark: boolean;
  meta: { courseName: string; courLabel: string; anchorTime: number };
}

/** 请求 Offscreen 复现帧并落库；成功后返回截图 id */
export async function captureFrame(req: ShotRequest): Promise<{ id: string; width: number; height: number }> {
  const requestId = uuid();
  let entry: PendingShot | undefined;
  const promise = new Promise<{ id: string; width: number; height: number }>((resolve, reject) => {
    entry = { resolve, reject };
    pending.set(requestId, entry);
  });

  const timer = setTimeout(() => {
    if (pending.delete(requestId)) {
      entry?.reject(new AppError('ASR_NETWORK_FAILED', { userMessage: '截图超时，请重试', retryable: true }));
    }
  }, 30_000);

  try {
    await sendToOffscreen({
      type: 'OFFSCREEN_REQUEST',
      op: 'SHOT',
      payload: {
        type: 'OFFSCREEN_SHOT',
        requestId,
        courId: req.courId,
        teclId: req.teclId,
        view: req.view,
        atSec: req.atSec,
        url: req.url,
        watermark: req.watermark,
        meta: req.meta,
      },
    });
    return await promise;
  } catch (err) {
    // 下发失败 / 超时 / Offscreen 明确失败统一转换为 AppError
    pending.delete(requestId);
    throw err instanceof AppError ? err : toAppError(err, 'UNKNOWN');
  } finally {
    clearTimeout(timer);
    pending.delete(requestId);
  }
}

/** Offscreen → SW 的截图结果入口 */
export async function handleShotResult(payload: OffscreenOutbound): Promise<boolean> {
  if (payload.type !== 'OFFSCREEN_SHOT_RESULT') return false;
  const entry = pending.get(payload.requestId);
  pending.delete(payload.requestId);
  if (!entry) return true;
  if (payload.ok && payload.screenshotId) {
    entry.resolve({ id: payload.screenshotId, width: payload.width ?? 0, height: payload.height ?? 0 });
  } else {
    const err: SerializedAppError = payload.error ?? { code: 'UNKNOWN', userMessage: '截图失败', retryable: true };
    log.warn('截图失败', err.code);
    entry.reject(new AppError(err.code, { userMessage: err.userMessage, detail: err.detail, retryable: err.retryable }));
  }
  return true;
}
