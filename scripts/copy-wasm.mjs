/**
 * 复制 onnxruntime-web 的 WASM 运行时资源到 public/wasm/。
 *
 * 依据技术文档 §5.4：`env.backends.onnx.wasm.wasmPaths` 必须指向扩展内置资源，
 * 避免运行时外链 CDN 与扩展 CSP 冲突。
 *
 * 幂等：源文件不存在（例如未安装依赖）时静默跳过，不阻塞构建。
 */
import { createRequire } from 'node:module';
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
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
  // 只取运行时资源：.wasm 二进制 + ort-wasm-*.mjs 加载器（排除 source map）。
  // 第 47 轮 wasm 体积治理（路线 A，见 docs/wasm体积治理评估.md）：只保留 JSEP 变体。
  // 依据：本包运行时的两条 ORT 引用——主入口 ort.mjs（whisper.ts 的 import('onnxruntime-web')）
  // 与 transformers.js v3 的 ort.bundle.min.mjs——在构建期均已常量折叠为仅引用
  // ort-wasm-simd-threaded.jsep.*；jspi/asyncify/simd-threaded 三个变体在当前依赖图零引用，
  // 裁掉可减 57.78MB。ORT 升级若改变变体引用，需同步此处（缺失会在 ASR 初始化时显性报错）。
  const keepVariant = 'jsep';
  const wanted = entries.filter((name) => {
    if (name.endsWith('.map')) return false;
    const isRuntimeAsset = name.endsWith('.wasm') || (name.endsWith('.mjs') && name.startsWith('ort-wasm-'));
    return isRuntimeAsset && name.includes(`.${keepVariant}.`);
  });
  if (wanted.length === 0) {
    // ORT 升级可能改变变体文件命名：此时不清理、保留既有文件并显性告警，
    // 避免误删后连回退能力都没有（第 51 轮审计 P3-1）
    log(`警告：源目录无匹配资源（${sourceDist}），保留既有 public/wasm/ 内容；请核对 keepVariant 与 ORT/transformers 版本`);
    return;
  }

  await mkdir(targetDir, { recursive: true });
  // 先复制后差量清理（第 51 轮审计 P3-1）：避免「先清空后复制」在中途失败时留下
  // 空/残缺目录（连旧可用变体一起丢失）
  let copied = 0;
  for (const name of wanted) {
    await cp(join(sourceDist, name), join(targetDir, name));
    copied += 1;
  }
  const keep = new Set(wanted);
  for (const name of await readdir(targetDir)) {
    if (!keep.has(name)) await rm(join(targetDir, name), { force: true });
  }
  log(`已复制 ${copied} 个文件（仅 ${keepVariant} 变体）→ public/wasm/（来源：${sourceDist}）`);
}

main().catch((err) => {
  // 复制失败不应阻塞开发，只提示
  log(`复制失败（不影响功能构建，但 ASR 可能无法运行）：${err?.message ?? err}`);
});
