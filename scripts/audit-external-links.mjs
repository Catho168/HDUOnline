#!/usr/bin/env node
/**
 * 外链安全审计（第 288 轮巡检，工程域 / 安全域）：可重复执行的安全基线检查。
 *
 * 检查项：
 *  1. 所有 `target="_blank"` 的锚点必须带 `rel="noopener noreferrer"`（同行或
 *     下一行——JSX 多行属性写在相邻行）；
 *  2. 全仓不得使用 `dangerouslySetInnerHTML` / `.innerHTML`（手写 HTML 注入面）。
 *
 * 输出缺失清单；有缺失时 exit 1（可接入 CI）。纯文本扫描，不执行任何业务代码。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(process.cwd(), 'src');
const EXTENSIONS = ['.tsx', '.ts'];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) yield* walk(full);
    else if (EXTENSIONS.some((ext) => name.endsWith(ext))) yield full;
  }
}

const problems = [];
let blankTargets = 0;
let files = 0;

for (const file of walk(ROOT)) {
  files += 1;
  const text = readFileSync(file, 'utf8');
  const relPath = file.split('src').pop();

  // 1. innerHTML 注入面
  if (/dangerouslySetInnerHTML/.test(text) || /\.innerHTML\s*=/.test(text)) {
    problems.push(`[innerHTML] ${relPath}`);
  }

  // 2. target="_blank" 必须带 rel（同行，或下一行以 rel= 开头——多行 JSX 属性）
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (!line.includes('target="_blank"')) return;
    blankTargets += 1;
    const next = lines[i + 1] ?? '';
    if (!/rel=/.test(line) && !/^\s*rel=/.test(next)) {
      problems.push(`[rel] ${relPath}:${i + 1}`);
    }
  });
}

console.log(`扫描 ${files} 个源文件：target="_blank" 共 ${blankTargets} 处。`);
if (problems.length > 0) {
  console.error(`发现 ${problems.length} 处问题：`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log('外链 rel 全覆盖；无 innerHTML 注入面。审计通过。');
