/**
 * 术语纠错（§5.5，机制借鉴 video-to-skill）。
 *
 * 词表形态：`{ "误听": "正字" }`，转写后做**确定性替换**（不经 LLM）。
 * 另外支持正则条目：键形如 `/pattern/flags` 时按正则替换（用于"数字+单位"等模式化误听）。
 *
 * 分层：内置通用 → 用户词典（chrome.storage.local）→ 课程级词典（IndexedDB kv）。
 * 版本号：所有生效条目排序后做 FNV-1a 哈希，写入 `transcripts.glossaryVersion`；
 * 词表变化后可用"重新应用纠错"重跑替换而无需重跑 ASR。
 */

import { ASR_PARAMS } from '../shared/constants';
import { loadSecrets, saveSecrets } from '../shared/settings';
import { getDb } from '../db';
import type { TranscriptSegment } from '../shared/types';

export type Glossary = Record<string, string>;

/**
 * 内置通用词表（附录 B 的整理版）。
 *
 * 整理口径（见《实现差异说明》）：剔除附录 B 中
 *  ① "误听与正字相同"的恒等条目（如 `"满秩": "满秩"`）；
 *  ② 文档自身注明"依赖上下文"的条目（如 `"项链"`、`"堆栈"`）——
 *     这类条目误替换风险高于收益，改为在真实转写样本上迭代后加入课程级词典。
 */
export const BUILTIN_GLOSSARY: Glossary = {
  // 线性代数：克拉默法则
  科拉莫法则: '克拉默法则',
  柯拉莫法则: '克拉默法则',
  克拉默定律: '克拉默法则',
  科拉默法则: '克拉默法则',
  // 线性代数：行列式
  行列势: '行列式',
  航列式: '行列式',
  行例式: '行列式',
  行列士: '行列式',
  // 线代/高数常见
  逆举证: '逆矩阵',
  增广举证: '增广矩阵',
  系数举证: '系数矩阵',
  特征直: '特征值',
  满志: '满秩',
  初等航变换: '初等行变换',
  // 数值符号（讲课时口头念出的符号名）
  西格玛: 'Σ',
  积分符号: '∫',
};

/** 供 UI 展示：内置词表条数与说明 */
export const BUILTIN_GLOSSARY_SIZE = Object.keys(BUILTIN_GLOSSARY).length;

interface CompiledEntry {
  pattern: RegExp;
  replacement: string;
}

interface CompiledGlossary {
  literal: Array<[string, string]>;
  regex: CompiledEntry[];
}

const compileCache = new WeakMap<Glossary, CompiledGlossary>();

function isRegexKey(key: string): boolean {
  return key.length > 2 && key.startsWith('/') && key.lastIndexOf('/') > 0;
}

function parseRegexKey(key: string): { pattern: RegExp; ok: boolean } {
  const lastSlash = key.lastIndexOf('/');
  const body = key.slice(1, lastSlash);
  const flags = key.slice(lastSlash + 1);
  try {
    // 只允许安全的 flags，避免 g/y 状态问题
    const safeFlags = [...new Set(flags.replace(/[^imsu]/g, ''))].join('');
    return { pattern: new RegExp(body, safeFlags), ok: true };
  } catch {
    return { pattern: /$^/, ok: false };
  }
}

function compile(glossary: Glossary): CompiledGlossary {
  const cached = compileCache.get(glossary);
  if (cached) return cached;
  const literal: Array<[string, string]> = [];
  const regex: CompiledEntry[] = [];
  // 长词优先，避免短词先命中导致长词失配
  const entries = Object.entries(glossary).filter(([k]) => k.length > 0);
  entries.sort((a, b) => b[0].length - a[0].length);
  for (const [key, value] of entries) {
    if (isRegexKey(key)) {
      const parsed = parseRegexKey(key);
      if (parsed.ok) regex.push({ pattern: parsed.pattern, replacement: value });
      continue;
    }
    if (key === value) continue; // 恒等条目直接忽略
    literal.push([key, value]);
  }
  const compiled = { literal, regex };
  compileCache.set(glossary, compiled);
  return compiled;
}

/** 对一个文本应用纠错 */
export function applyGlossaryToText(text: string, glossary: Glossary): string {
  if (!text) return text;
  const compiled = compile(glossary);
  let out = text;
  for (const [from, to] of compiled.literal) {
    if (out.includes(from)) out = out.split(from).join(to);
  }
  for (const entry of compiled.regex) {
    out = out.replace(entry.pattern, entry.replacement);
  }
  return out;
}

/** 对整段转写应用纠错（返回新数组，不改入参） */
export function applyGlossaryToSegments(
  segments: TranscriptSegment[],
  glossary: Glossary,
): TranscriptSegment[] {
  if (Object.keys(glossary).length === 0) return segments.map((s) => ({ ...s }));
  return segments.map((seg) => {
    const text = applyGlossaryToText(seg.text, glossary);
    return text === seg.text ? { ...seg } : { ...seg, text };
  });
}

/** 词表版本号：排序后 FNV-1a（跨上下文稳定，用于缓存失效判断） */
export function glossaryVersion(glossary: Glossary): number {
  const entries = Object.entries(glossary).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  let hash = 0x811c9dc5;
  for (const [k, v] of entries) {
    const str = `${k}\u0000${v}\u0001`;
    for (let i = 0; i < str.length; i += 1) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash >>> 0;
}

/** 取课程级词典（存 kv 表） */
export async function loadCourseGlossary(courId: number): Promise<Glossary> {
  const db = await getDb();
  const record = await db.get('kv', `glossary:course:${courId}`);
  const value = record?.value;
  return value && typeof value === 'object' ? (value as Glossary) : {};
}

export async function saveCourseGlossary(courId: number, dict: Glossary): Promise<void> {
  const db = await getDb();
  await db.put('kv', { key: `glossary:course:${courId}`, value: dict, updatedAt: Date.now() });
}

/** 取用户词典 */
export async function loadUserGlossary(): Promise<Glossary> {
  const secrets = await loadSecrets();
  return secrets.userGlossary ?? {};
}

export async function saveUserGlossary(dict: Glossary): Promise<void> {
  await saveSecrets({ userGlossary: dict });
}

/** 合并三层词表：内置 → 用户 → 课程（后者覆盖前者） */
export async function loadMergedGlossary(courId?: number): Promise<Glossary> {
  const merged: Glossary = { ...BUILTIN_GLOSSARY };
  try {
    Object.assign(merged, await loadUserGlossary());
  } catch {
    /* storage 不可用时只用内置 */
  }
  if (courId !== undefined) {
    try {
      Object.assign(merged, await loadCourseGlossary(courId));
    } catch {
      /* 忽略 */
    }
  }
  return merged;
}

/**
 * 生成 Whisper 的 initial_prompt 术语偏置（§5.3）。
 * 上限 200 词，只取字面词条（正则条目不适合作为偏置）。
 */
export function buildGlossaryPrompt(
  glossary: Glossary,
  limit: number = ASR_PARAMS.glossaryPromptLimit,
): string | undefined {
  const terms = Object.entries(glossary)
    .filter(([key]) => !isRegexKey(key))
    .map(([, value]) => value)
    .filter((value) => value.length > 0 && value.length <= 12 && /[\u4e00-\u9fa5A-Za-z]/.test(value));
  const unique = [...new Set(terms)].slice(0, limit);
  if (unique.length === 0) return undefined;
  return `本课程术语：${unique.join('、')}。`;
}
