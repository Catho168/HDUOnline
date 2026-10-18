/**
 * 复制 onnxruntime-web 的 WASM 运行时资源到 public/wasm/。
 *
 * 依据技术文档 §5.4：`env.backends.onnx.wasm.wasmPaths` 必须指向扩展内置资源，
 * 避免运行时外链 CDN 与扩展 CSP 冲突。
 *
 * 幂等：源文件不存在（例如未安装依赖）时静默跳过，不阻塞构建。
 */
import { createRequire } from 'node:module';
import { cp, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targetDir = join(root, 'public', 'wasm');

function log(msg) {
  process.stdout.write(`[copy-wasm] ${msg}\n`);
}

/**
 * 解析 onnxruntime-web 的 dist 目录。
 * onnxruntime-web 的 package.json `exports` 不暴露 `./package.json`，
 * 因此先解析主入口文件，再向上查找包根目录。
 */
async function resolveOrtDist() {
  const roots = [];
  // 1) 从主入口回溯（顶层或嵌套安装都能命中）
  for (const spec of ['onnxruntime-web', 'onnxruntime-web/wasm']) {
    try {
      let dir = dirname(require.resolve(spec));
      for (let i = 0; i < 4; i += 1) {
        if (await exists(join(dir, 'package.json'))) {
          roots.push(dir);
          break;
        }
        dir = dirname(dir);
      }
    } catch {
      /* 该 spec 不可解析 */
    }
  }
  // 2) 常规 node_modules 布局兜底
  roots.push(join(root, 'node_modules', 'onnxruntime-web'));
  const candidates = [...new Set(roots)].map((dir) => join(dir, 'dist'));
  for (const dir of candidates) {
    if (await exists(dir)) return dir;
  }
  return null;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const sourceDist = await resolveOrtDist();
  if (!sourceDist) {
    log('未找到 onnxruntime-web/dist，跳过（安装依赖后会自动执行）');
    return;
  }

  const entries = await readdir(sourceDist);
  // 只取运行时资源：.wasm 二进制 + ort-wasm-*.mjs 加载器（排除 source map）
  const wanted = entries.filter(
    (name) => (name.endsWith('.wasm') || (name.endsWith('.mjs') && name.startsWith('ort-wasm-'))) && !name.endsWith('.map'),
  );
  if (wanted.length === 0) {
    log(`源目录无匹配资源：${sourceDist}`);
    return;
  }

  await mkdir(targetDir, { recursive: true });
  let copied = 0;
  for (const name of wanted) {
    await cp(join(sourceDist, name), join(targetDir, name));
    copied += 1;
  }
  log(`已复制 ${copied} 个文件 → public/wasm/（来源：${sourceDist}）`);
}

main().catch((err) => {
  // 复制失败不应阻塞开发，只提示
  log(`复制失败（不影响功能构建，但 ASR 可能无法运行）：${err?.message ?? err}`);
});
