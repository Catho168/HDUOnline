/**
 * 产物体积审计 + 预算基线检查（第 246 轮巡检，工程域 / 性能视角）。
 *
 * 背景（本轮构建产物盘点）：build 总量 31.25MB 中 wasm 28.31MB（ASR 模型运行时，
 * web_accessible_resources 按需加载，不进任何 entry）占主导；其余 JS ≈ 2.9MB 分布在
 * background / content-scripts（HDU、B 站）/ asr-worker / dashboard / options / popup /
 * offscreen 各入口。wxt 0.21 对 MV3 content script 按 IIFE 单文件打包
 * （inlineDynamicImports）——本轮懒加载试点已验证动态 import 在 content script 里
 * 会被内联回主包、无 chunk 收益（详见巡检日志第 246 轮），故 JS 预算靠本脚本守门。
 *
 * 功能：
 *  1. 列出 .output/chrome-mv3 下各入口的「急加载闭包」体积（entry chunk + 静态 import
 *     链上的 chunks）与懒加载依赖（动态 import 的 chunks，单列不计入急加载）；
 *  2. 与 scripts/size-baseline.json 基线比较：增长超过 max(tolAbs, baseline×tolPct%)
 *     出警告；基线缺失条目按「新入口」警告；收缩仅提示不警告；
 *  3. --update-baseline 把当前数字写回基线；--strict 有警告时 exit 1（供 CI）；
 *     --tol-pct / --tol-abs 调阈值。独立于构建流程，可单跑：npm run size-check。
 *
 * 纯函数（parseChunkRefs / compareSizes / formatBytes）导出供 tests/unit/size-check.test.ts
 * 直接单测（阈值比较逻辑不依赖磁盘）；CLI 主流程仅在直接执行时运行。
 */
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(root, '.output', 'chrome-mv3');
const BASELINE_PATH = join(root, 'scripts', 'size-baseline.json');

/** 默认阈值：绝对 20KB 或相对 5%（取较大者，防小基线被百分比误伤） */
export const DEFAULT_TOL_ABS = 20 * 1024;
export const DEFAULT_TOL_PCT = 5;

/** 列出目录下的 .js 文件（相对 outDir 的 posix 路径） */
export async function listJsFiles(outDir) {
  const files = [];
  async function walk(dir) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, item.name);
      if (item.isDirectory()) await walk(full);
      else if (item.name.endsWith('.js')) files.push(relative(outDir, full).split(sep).join('/'));
    }
  }
  await walk(outDir);
  return files.sort();
}

/**
 * 从产物源码提取相对引用的 chunk 路径（静态 `from"./x.js"` / `import"./x.js"` /
 * 动态 `import("./x.js")`），返回按引用类型分组（eager/dynamic）的相对路径数组。
 * 非 JS 文本 / 无引用返回空数组，不抛错。
 */
export function parseChunkRefs(code) {
  const eager = new Set();
  const dynamic = new Set();
  const re = /(from|import)\s*(\(\s*)?["'](\.\/[^"']+)["']/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const kind = m[1];
    const target = m[3];
    if (kind === 'import' && m[2]) dynamic.add(target);
    else eager.add(target);
  }
  return { eager: [...eager], dynamic: [...dynamic] };
}

/** 字节数 → 人类可读（KB 保留 1 位小数；≥1MB 用 MB） */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '?';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * 基线比较（纯函数）：对每个当前入口，与基线（可能缺省）比较，产出问题列表：
 *  - growth：current > baseline + max(tolAbs, baseline×tolPct/100)（超预算，计警告）；
 *  - new：基线无此入口且体积 ≥1KB（需人工确认后登记，计警告）；
 *  - shrink：current < baseline（仅提示，不计警告）。
 */
export function compareSizes(current, baseline, tolPct = DEFAULT_TOL_PCT, tolAbs = DEFAULT_TOL_ABS) {
  const issues = [];
  for (const entry of Object.keys(current).sort()) {
    const cur = current[entry] ?? 0;
    const base = typeof baseline[entry] === 'number' && Number.isFinite(baseline[entry]) ? baseline[entry] : null;
    if (base == null) {
      if (cur >= 1024) issues.push({ entry, kind: 'new', baseline: null, current: cur, delta: cur, deltaPct: null });
      continue;
    }
    const delta = cur - base;
    const deltaPct = base > 0 ? (delta / base) * 100 : null;
    const slack = Math.max(tolAbs, (base * tolPct) / 100);
    if (delta > slack) issues.push({ entry, kind: 'growth', baseline: base, current: cur, delta, deltaPct });
    else if (delta < 0) issues.push({ entry, kind: 'shrink', baseline: base, current: cur, delta, deltaPct });
  }
  return issues;
}

/** CLI 主流程（直接执行时才跑；被测试 import 时不执行） */
async function main() {
  const argv = process.argv.slice(2);
  const strict = argv.includes('--strict');
  const updateBaseline = argv.includes('--update-baseline');
  const argOf = (name, fallback) => {
    const i = argv.indexOf(name);
    const v = i >= 0 ? Number(argv[i + 1]) : Number.NaN;
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  const tolPct = argOf('--tol-pct', DEFAULT_TOL_PCT);
  const tolAbs = argOf('--tol-abs', DEFAULT_TOL_ABS);

  const allFiles = await listJsFiles(OUT_DIR);
  const fileBytes = {};
  const fileRefs = {};
  for (const rel of allFiles) {
    const buf = await readFile(join(OUT_DIR, rel));
    fileBytes[rel] = buf.byteLength;
    fileRefs[rel] = parseChunkRefs(buf.toString('utf8'));
  }
  // wasm 运行时资源单列（不进 JS 预算）
  let wasmBytes = 0;
  try {
    for (const item of await readdir(join(OUT_DIR, 'wasm'), { withFileTypes: true })) {
      if (item.isFile()) wasmBytes += (await stat(join(OUT_DIR, 'wasm', item.name))).size;
    }
  } catch {
    /* 无 wasm 目录（如 e2e dev 构建形态）跳过 */
  }
  // html 入口：script src / modulepreload href 指向的 chunks 都按急加载根处理
  const htmlRoots = [];
  for (const item of await readdir(OUT_DIR, { withFileTypes: true })) {
    if (!item.isFile() || !item.name.endsWith('.html')) continue;
    htmlRoots.push(item.name);
    const html = await readFile(join(OUT_DIR, item.name), 'utf8');
    for (const m of html.matchAll(/(?:src|href)="(\/[^"]+\.js)"/g)) {
      const rel = m[1].replace(/^\//, '');
      if (rel in fileBytes) {
        fileRefs[item.name] = fileRefs[item.name] ?? { eager: [], dynamic: [] };
        fileRefs[item.name].eager.push(`./${rel}`);
      }
    }
  }

  // 引用路径解析：相对引用者所在目录 → 相对 outDir 的 posix 路径
  const resolveRef = (fromRel, ref) => {
    const target = join(dirname(join(OUT_DIR, fromRel)), ref);
    const rel = relative(OUT_DIR, target).split(sep).join('/');
    return rel in fileBytes ? rel : null;
  };
  const roots = [
    'background.js',
    'asr-worker.js',
    ...allFiles.filter((f) => f.startsWith('content-scripts/')),
    ...htmlRoots,
  ];
  const closures = {};
  for (const entry of roots) {
    if (!(entry in fileBytes) && !(entry in fileRefs)) continue;
    const seen = new Set();
    const queue = (fileRefs[entry]?.eager ?? [])
      .map((ref) => resolveRef(entry, ref))
      .filter((v) => v != null);
    if (entry in fileBytes && !entry.endsWith('.html')) queue.push(entry);
    let eagerBytes = 0;
    const dynamicPaths = [];
    while (queue.length > 0) {
      const cur = queue.pop();
      if (cur == null || seen.has(cur)) continue;
      seen.add(cur);
      eagerBytes += fileBytes[cur] ?? 0;
      for (const ref of fileRefs[cur]?.eager ?? []) {
        const next = resolveRef(cur, ref);
        if (next && !seen.has(next)) queue.push(next);
      }
      for (const ref of fileRefs[cur]?.dynamic ?? []) {
        const next = resolveRef(cur, ref);
        if (next && !dynamicPaths.includes(next)) dynamicPaths.push(next);
      }
    }
    closures[entry] = { eagerBytes, dynamicPaths };
  }

  const lines = [];
  lines.push('产物体积审计（scripts/size-check.mjs）');
  lines.push(`wasm 运行时资源（web_accessible，按需加载，不计 JS 预算）：${formatBytes(wasmBytes)}`);
  lines.push('');
  const currentSizes = {};
  for (const entry of Object.keys(closures).sort()) {
    const c = closures[entry];
    currentSizes[entry] = c.eagerBytes;
    const lazyNote = c.dynamicPaths.length > 0 ? `（懒加载 chunks：${c.dynamicPaths.join(', ')}）` : '';
    lines.push(`  ${entry.padEnd(34)} ${formatBytes(c.eagerBytes).padStart(10)}  ${lazyNote}`);
  }
  const jsTotal = Object.values(currentSizes).reduce((a, b) => a + b, 0);
  lines.push(`  ${'JS 急加载合计（入口口径，共享 chunk 不去重）'.padEnd(34)} ${formatBytes(jsTotal).padStart(10)}`);

  let baseline = {};
  if (!updateBaseline) {
    try {
      const parsed = JSON.parse(await readFile(BASELINE_PATH, 'utf8'));
      baseline = parsed.entries ?? {};
    } catch {
      lines.push('');
      lines.push(`⚠ 未找到基线 ${relative(root, BASELINE_PATH).split(sep).join('/')}（先跑 --update-baseline 生成）；本轮只列体积不比较。`);
    }
  }

  let warns = 0;
  if (!updateBaseline && Object.keys(baseline).length > 0) {
    const issues = compareSizes(currentSizes, baseline, tolPct, tolAbs);
    if (issues.length > 0) {
      lines.push('');
      lines.push(`与基线比较（阈值：绝对 ${Math.round(tolAbs / 1024)}KB 或相对 ${tolPct}% 取大者）：`);
      for (const issue of issues) {
        if (issue.kind === 'growth') {
          warns += 1;
          lines.push(`  ⚠ ${issue.entry}: ${formatBytes(issue.baseline ?? 0)} → ${formatBytes(issue.current)}（+${formatBytes(issue.delta)}，+${(issue.deltaPct ?? 0).toFixed(1)}%）超阈值`);
        } else if (issue.kind === 'new') {
          warns += 1;
          lines.push(`  ⚠ ${issue.entry}: 新入口 ${formatBytes(issue.current)}（基线缺失，请确认后 --update-baseline 登记）`);
        } else {
          lines.push(`  ℹ ${issue.entry}: ${formatBytes(issue.baseline ?? 0)} → ${formatBytes(issue.current)}（收缩 ${formatBytes(-issue.delta)}，仅提示）`);
        }
      }
    } else {
      lines.push('与基线比较：全部入口在阈值内 ✓');
    }
  }

  if (updateBaseline) {
    const payload = {
      generatedAt: new Date().toISOString(),
      wasmBytes,
      entries: currentSizes,
    };
    await writeFile(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    lines.push('');
    lines.push(`基线已更新：${relative(root, BASELINE_PATH).split(sep).join('/')}（${Object.keys(currentSizes).length} 个入口）`);
  }

  console.log(lines.join('\n'));
  if (strict && warns > 0) process.exitCode = 1;
}

const invokedDirectly = process.argv[1] != null && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) await main();
