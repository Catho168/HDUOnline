/**
 * 字幕导出序列化（第 105 轮巡检）：B 站字幕面板把当前字幕一键导出为 TXT / SRT。
 * 纯函数、防御式：非数组/脏段落跳过（无有效段落返回空串，由调用方给提示），
 * 缺结束时间按 s+1 兜底；SRT 时间轴 HH:MM:SS,mmm（毫秒向下取整）。
 */

import type { TranscriptEntity } from '../shared/types';

interface CleanSeg {
  s: number;
  e: number;
  text: string;
}

/** 防御式清洗：只留 s 为有限非负数且文本非空的段落；e 非法时按 s+1 兜底 */
function cleanSegments(transcript: TranscriptEntity | null | undefined): CleanSeg[] {
  const raw = Array.isArray(transcript?.segments) ? transcript.segments : [];
  return raw
    .map((seg) => ({
      s: Number((seg as { s?: unknown })?.s),
      e: Number((seg as { e?: unknown })?.e),
      text: String((seg as { text?: unknown })?.text ?? ''),
    }))
    .filter((seg) => Number.isFinite(seg.s) && seg.s >= 0 && seg.text.trim().length > 0)
    .map((seg) => ({ ...seg, e: Number.isFinite(seg.e) && seg.e > seg.s ? seg.e : seg.s + 1 }));
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** SRT 时间轴：HH:MM:SS,mmm（毫秒由秒的小数部分向下取整） */
function srtTime(sec: number): string {
  const whole = Math.max(0, Math.floor(sec));
  const ms = Math.floor((sec - whole) * 1000);
  return `${pad(Math.floor(whole / 3600))}:${pad(Math.floor((whole % 3600) / 60))}:${pad(whole % 60)},${pad(ms, 3)}`;
}

/** 纯文本：每行「[mm:ss] 文本」（时长 ≥1h 时带时位，口径同 formatClock 的 h:mm:ss） */
export function buildSubtitleTxt(transcript: TranscriptEntity | null | undefined): string {
  const segs = cleanSegments(transcript);
  if (segs.length === 0) return '';
  const lines = segs.map((seg) => {
    const total = Math.floor(seg.s);
    const clock = total >= 3600
      ? `${Math.floor(total / 3600)}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`
      : `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
    return `[${clock}] ${seg.text}`;
  });
  return `${lines.join('\n')}\n`;
}

/** SRT：序号 + `HH:MM:SS,mmm --> HH:MM:SS,mmm` + 文本，空行分隔 */
export function buildSubtitleSrt(transcript: TranscriptEntity | null | undefined): string {
  const segs = cleanSegments(transcript);
  if (segs.length === 0) return '';
  const blocks = segs.map((seg, index) => `${index + 1}\n${srtTime(seg.s)} --> ${srtTime(seg.e)}\n${seg.text}`);
  return `${blocks.join('\n\n')}\n`;
}
