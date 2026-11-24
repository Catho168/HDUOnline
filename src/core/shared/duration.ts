/**
 * 时长解析与格式化（纯函数，可单测）。
 *
 * 站外视频（如 B 站）的时长以 "mm:ss" / "hh:mm:ss" 文本展示，进度续看提示需要
 * 秒数 ↔ 文本互转；解析失败一律返回 null / 空串，不抛错。
 */

import { formatClock } from './utils';

/**
 * 把 "ss" / "mm:ss" / "hh:mm:ss" 文本解析为秒数。
 * 容忍全角冒号/全角数字与空白；位数不足或低位字段 ≥60（如 "12:75"）视为非法。
 * 非法/负值/空串返回 null。
 */
export function parseDurationSec(text: string): number | null {
  const normalized = (text ?? '')
    .trim()
    .replace(/：/g, ':')
    .replace(/[\uFF10-\uFF19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, '');
  if (!normalized) return null;
  const parts = normalized.split(':');
  if (parts.length === 0 || parts.length > 3) return null;
  let sec = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] ?? '';
    // 只接受无符号整数：负号、小数点与非数字一律视为非法
    if (!/^\d+$/.test(part)) return null;
    const value = Number(part);
    if (!Number.isSafeInteger(value)) return null;
    // 复合格式的低位字段（分/秒）不得 ≥60；最高位允许更大数值（如 "75:20" = 4520s）
    if (i > 0 && value >= 60) return null;
    sec = sec * 60 + value;
  }
  return sec;
}

/** 秒数 → "mm:ss"（≥1 小时用 "h:mm:ss"）；无效输入返回空串 */
export function formatSeconds(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '';
  return formatClock(Math.floor(sec));
}
