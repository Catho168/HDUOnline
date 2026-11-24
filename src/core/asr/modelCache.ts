/**
 * 模型缓存（§5.4）：基于 OPFS 的自定义缓存，替代浏览器 Cache API。
 *
 * 为什么自建：`@huggingface/transformers` 支持 `env.useCustomCache + env.customCache`
 * （需实现 Web Cache API 的 `match` / `put`）。用它把"下载缓存"与"手动导入"
 * 统一落在一个可枚举、可统计、可清理的 OPFS 目录里，从而支持：
 *  - 下载进度（put 的第三个参数就是进度回调）；
 *  - 手动导入（国内推荐路径，直接写 OPFS）；
 *  - 存储占用展示与分类清理。
 *
 * 目录布局：
 *   models/<org>/<name>/<file...>        ← 手动导入的模型文件（按 remote 路径结构）
 *   cache/<host>/<org>/<name>/.../<file> ← 自动下载缓存（键即 remote URL）
 */

import { ASR_MODELS, type AsrModelTier } from '../shared/constants';
import { createLogger } from '../shared/logger';

const log = createLogger('model-cache');

const MODEL_DIR = 'models';
const CACHE_DIR = 'cache';
/** Windows 路径长度限制较严，超长时改用哈希目录名 */
const MAX_PATH_LEN = 180;

export interface ModelFileEntry {
  /** OPFS 内相对路径 */
  path: string;
  size: number;
}

export interface ModelCacheStatus {
  cached: boolean;
  bytes?: number;
  files?: number;
}

export type ProgressCallback = (data: { progress: number; loaded: number; total: number }) => void;

// ───────────────────────── OPFS 基础 ─────────────────────────

export function opfsAvailable(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function';
}

async function getRoot(): Promise<FileSystemDirectoryHandle> {
  if (!opfsAvailable()) throw new Error('OPFS 不可用');
  return navigator.storage.getDirectory();
}

async function getDir(
  root: FileSystemDirectoryHandle,
  parts: string[],
  create: boolean,
): Promise<FileSystemDirectoryHandle | null> {
  let current = root;
  for (const part of parts) {
    if (!part) continue;
    try {
      current = await current.getDirectoryHandle(part, { create });
    } catch {
      return null;
    }
  }
  return current;
}

/** 把任意字符串键安全化为路径片段（Windows 禁用字符 + 长度保护） */
function sanitizeSegment(segment: string): string {
  const cleaned = segment.replace(/[<>:"\\|?*\u0000-\u001f]/g, '_').replace(/^\.+$/, '_');
  return cleaned.length > 80 ? `${cleaned.slice(0, 64)}_${fnv1a(cleaned)}` : cleaned;
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

interface KeyLayout {
  /** 导入文件路径：models/<org>/<name>/<rest> */
  importPath: string[] | null;
  /** 下载缓存路径：cache/<host>/<org>/<name>/.../<file> */
  cachePath: string[];
  /** 相对 modelId 之后的路径（用于导入匹配） */
  modelRelative: string | null;
}

/**
 * 解析 cache key。
 * 形如 `https://hf-mirror.com/onnx-community/whisper-small/resolve/main/onnx/encoder_model_fp16.onnx`，
 * 或 transformers 传入的本地路径 `/models/onnx-community/whisper-small/...`。
 */
export function parseCacheKey(key: string): KeyLayout | null {
  let url: URL | null = null;
  let pathname = '';
  try {
    url = new URL(key);
    pathname = url.pathname;
  } catch {
    if (!key.startsWith('/')) return null;
    pathname = key;
  }
  const segments = pathname.split('/').filter(Boolean).map(sanitizeSegment);
  if (segments.length < 2) return null;

  // 本地模型路径（transformers 的 localModelPath，默认 `/models/`）：
  // `/models/<org>/<name>/<rest>` —— 直接对应手动导入目录，可一次命中。
  if (segments[0] === MODEL_DIR && segments.length >= 4) {
    const modelIdParts = segments.slice(1, 3);
    const rest = segments.slice(3);
    return {
      importPath: [MODEL_DIR, ...modelIdParts, ...rest],
      cachePath: [CACHE_DIR, '_local', ...modelIdParts, ...rest],
      modelRelative: rest.join('/'),
    };
  }

  // 去掉 resolve/<revision> 以得到"模型内的相对路径"
  const resolveIdx = segments.indexOf('resolve');
  let modelIdParts: string[];
  let rest: string[];
  if (resolveIdx > 0) {
    modelIdParts = segments.slice(0, resolveIdx);
    // resolve/<revision>/...
    rest = segments.slice(resolveIdx + 2);
  } else {
    modelIdParts = segments.slice(0, Math.min(2, segments.length));
    rest = segments.slice(modelIdParts.length);
  }
  if (modelIdParts.length === 0 || rest.length === 0) return null;

  const host = url?.host ? sanitizeSegment(url.host) : '_local';
  const cachePath = [CACHE_DIR, host, ...modelIdParts, ...rest];
  // 超长路径保护：用哈希替代中间层
  const joined = cachePath.join('/');
  const safeCachePath =
    joined.length > MAX_PATH_LEN
      ? [CACHE_DIR, host, fnv1a(joined), rest[rest.length - 1] as string]
      : cachePath;

  return {
    importPath: [MODEL_DIR, ...modelIdParts, ...rest],
    cachePath: safeCachePath,
    modelRelative: rest.join('/'),
  };
}

// ───────────────────────── 读写 ─────────────────────────

async function readFileByPath(parts: string[]): Promise<Response | undefined> {
  try {
    const root = await getRoot();
    const dir = await getDir(root, parts.slice(0, -1), false);
    if (!dir) return undefined;
    const name = parts[parts.length - 1] as string;
    const handle = await dir.getFileHandle(name);
    const file = await handle.getFile();
    return new Response(file, {
      headers: { 'content-type': guessMime(name), 'content-length': String(file.size) },
    });
  } catch {
    return undefined;
  }
}

async function writeFileByPath(parts: string[], data: Uint8Array): Promise<void> {
  const root = await getRoot();
  const dir = await getDir(root, parts.slice(0, -1), true);
  if (!dir) throw new Error('无法创建缓存目录');
  const name = parts[parts.length - 1] as string;
  const handle = await dir.getFileHandle(name, { create: true });
  // OPFS 的 writable 在部分环境不支持 keepExistingData，直接整体覆盖
  const writable = await handle.createWritable();
  await writable.write(data as unknown as BufferSource);
  await writable.close();
}

function guessMime(name: string): string {
  if (name.endsWith('.json')) return 'application/json';
  if (name.endsWith('.onnx')) return 'application/octet-stream';
  if (name.endsWith('.txt')) return 'text/plain';
  if (name.endsWith('.wasm')) return 'application/wasm';
  return 'application/octet-stream';
}

/** 把 Response 流式写入 OPFS（避免把 1GB+ 模型权重先整体堆在内存里） */
async function writeResponseByPath(
  parts: string[],
  response: Response,
  progress?: ProgressCallback,
): Promise<void> {
  const root = await getRoot();
  const dir = await getDir(root, parts.slice(0, -1), true);
  if (!dir) throw new Error('无法创建缓存目录');
  const name = parts[parts.length - 1] as string;
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  const total = Number(response.headers.get('content-length') ?? 0);
  let loaded = 0;
  try {
    const body = response.body;
    if (body) {
      const reader = body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          await writable.write(value as unknown as BufferSource);
          loaded += value.byteLength;
          if (progress && total > 0) {
            progress({ progress: Math.round((loaded / total) * 100), loaded, total });
          }
        }
      }
    } else {
      const buffer = new Uint8Array(await response.arrayBuffer());
      await writable.write(buffer as unknown as BufferSource);
      loaded = buffer.byteLength;
      if (progress && total > 0) {
        progress({ progress: 100, loaded, total });
      }
    }
    await writable.close();
  } catch (err) {
    // 写坏的文件必须删掉，否则下次 match 会把半截文件当成缓存命中
    try {
      await writable.abort();
    } catch {
      /* 忽略 */
    }
    try {
      await dir.removeEntry(name);
    } catch {
      /* 忽略 */
    }
    throw err;
  }
}

/** 实现 Web Cache API 的 match/put（供 env.customCache 使用） */
export function createOpfsCache() {
  return {
    async match(request: string | Request): Promise<Response | undefined> {
      const key = typeof request === 'string' ? request : request.url;
      const layout = parseCacheKey(key);
      if (!layout) return undefined;
      // 1) 手动导入优先
      if (layout.importPath) {
        const imported = await readFileByPath(layout.importPath);
        if (imported) return imported;
      }
      // 2) 下载缓存
      return readFileByPath(layout.cachePath);
    },

    /** 注意：第三个参数是 transformers.js 传入的进度回调（非 Cache API 标准） */
    async put(request: string | Request, response: Response, progress?: ProgressCallback): Promise<void> {
      const key = typeof request === 'string' ? request : request.url;
      const layout = parseCacheKey(key);
      if (!layout) return;
      try {
        await writeResponseByPath(layout.cachePath, response, progress);
      } catch (err) {
        // 写入失败不应中断推理（例如配额不足）
        log.warn('缓存写入失败', err);
      }
    },
  };
}

// ───────────────────────── 管理（状态 / 清理 / 导入） ─────────────────────────

async function walk(
  dir: FileSystemDirectoryHandle,
  prefix: string,
  out: ModelFileEntry[],
  depth = 0,
): Promise<void> {
  if (depth > 8) return;
  for await (const [name, handle] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'file') {
      try {
        const file = await (handle as FileSystemFileHandle).getFile();
        out.push({ path, size: file.size });
      } catch {
        /* 忽略单个文件错误 */
      }
    } else {
      await walk(handle as FileSystemDirectoryHandle, path, out, depth + 1);
    }
  }
}

/** 列出 OPFS 中的模型相关文件（导入 + 下载缓存） */
export async function listModelFiles(): Promise<ModelFileEntry[]> {
  if (!opfsAvailable()) return [];
  const out: ModelFileEntry[] = [];
  try {
    const root = await getRoot();
    for (const dirName of [MODEL_DIR, CACHE_DIR]) {
      const dir = await getDir(root, [dirName], false);
      if (dir) await walk(dir, dirName, out);
    }
  } catch (err) {
    log.warn('模型文件枚举失败', err);
  }
  return out;
}

/** 判断某档位模型是否已就绪（存在 config.json + 至少一个 .onnx + tokenizer 类文件） */
export async function checkModelCached(modelId: string): Promise<ModelCacheStatus> {
  const files = await listModelFiles();
  const related = files.filter((f) => f.path.includes(modelId));
  if (related.length === 0) return { cached: false, bytes: 0, files: 0 };
  const bytes = related.reduce((acc, f) => acc + f.size, 0);
  const hasOnnx = related.some((f) => f.path.endsWith('.onnx') || f.path.endsWith('.onnx_data'));
  const hasConfig = related.some((f) => f.path.endsWith('config.json'));
  const hasTokenizer = related.some((f) => f.path.endsWith('tokenizer.json') || f.path.endsWith('.json'));
  return { cached: hasOnnx && hasConfig && hasTokenizer, bytes, files: related.length };
}

/** 清空模型缓存（按 modelId 过滤；不传则全清） */
export async function clearModelCache(modelId?: string): Promise<void> {
  if (!opfsAvailable()) return;
  const root = await getRoot();
  if (!modelId) {
    for (const dirName of [MODEL_DIR, CACHE_DIR]) {
      try {
        await root.removeEntry(dirName, { recursive: true });
      } catch {
        /* 不存在则忽略 */
      }
    }
    return;
  }
  // 按 modelId 精确删除：遍历找到包含该 id 的叶子文件
  const files = await listModelFiles();
  for (const file of files) {
    if (!file.path.includes(modelId)) continue;
    const parts = file.path.split('/');
    try {
      const dir = await getDir(root, parts.slice(0, -1), false);
      await dir?.removeEntry(parts[parts.length - 1] as string);
    } catch {
      /* 忽略 */
    }
  }
}

/** 按档位判断模型是否就绪（供 SW / Options 调用） */
export async function checkTierCached(tier: AsrModelTier): Promise<ModelCacheStatus> {
  return checkModelCached(ASR_MODELS[tier].modelId);
}

/** 按档位清理模型缓存；不传档位则全清 */
export async function clearTierCache(tier?: AsrModelTier): Promise<void> {
  return clearModelCache(tier ? ASR_MODELS[tier].modelId : undefined);
}

/** 手动导入：把用户选择的文件写入 `models/<modelId>/<relativePath>`。
 * relativePath 由文件选择器给出的相对路径推导（保留 onnx/ 等子目录结构）。
 */
export async function importModelFile(
  modelId: string,
  relativePath: string,
  data: Uint8Array,
): Promise<string> {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  // 仅允许模型仓库内的相对路径，防止路径穿越
  const safeParts = normalized
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .map(sanitizeSegment);
  if (safeParts.length === 0) throw new Error('文件名无效');
  const full = [MODEL_DIR, ...modelId.split('/').map(sanitizeSegment), ...safeParts];
  await writeFileByPath(full, data);
  return full.join('/');
}
