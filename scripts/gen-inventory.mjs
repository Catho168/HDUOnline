/**
 * 盘点功能清单生成（第 203 轮巡检）：从 CHANGELOG.md 提取各轮功能条目，
 * 按轮次排序生成 docs/巡检盘点-功能清单.md，供 250 轮等里程碑盘点使用。
 * 第 204 轮：按功能域分组 + 顶部统计摘要。
 * 用法：npm run inventory
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');
const byRound = new Map();
const re = /^- (.+?)（第 (\d+) 轮[^）]*）：(.+)$/gm;
let m;
while ((m = re.exec(changelog)) !== null) {
  const name = m[1].trim();
  const round = Number(m[2]);
  const desc = m[3].trim();
  if (!byRound.has(round)) byRound.set(round, []);
  byRound.get(round).push({ name, desc });
}

/** 功能域判定（第 204 轮巡检；第 206 轮规则配置化）：按功能名/说明关键词归入六大模块。
 *  新模块只需在 MODULE_RULES 追加 [模块名, 正则] 即可。 */
const MODULE_RULES = [
  ['知识库 · 回收站', /回收站|勾选|批量还原|彻底删除|清空回收站/],
  ['学习统计', /标签|统计|热力图|成就|徽章|覆盖率|周报|月报|报表|趋势/],
  ['复习计划与今日待办', /复习|清单|顺延|改期|到期|待办|今日/],
  ['B 站学习助手', /B 站|字幕|速览|会话|多 P/],
  ['设置与通知', /设置|模型|渠道|主题|日志|提醒开关/],
];

function moduleOf(name, desc) {
  const text = `${name}${desc}`;
  for (const [mod, re] of MODULE_RULES) {
    if (re.test(text)) return mod;
  }
  return '播放页与知识库基础';
}

const rounds = [...byRound.keys()].sort((a, b) => a - b);
const now = new Date();
const pad2 = (n) => String(n).padStart(2, '0');
const generatedAt = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
// Markdown 表格转义（第 207 轮巡检）：功能名/说明含 | 时转义，防表格破版
const escCell = (value) => value.split('|').join('\\|');
const lines = ['# 巡检功能清单（自动生成）', '', `> 由 \`npm run inventory\` 从 CHANGELOG.md 生成，请勿手工编辑；里程碑盘点时重新生成。生成时间：${generatedAt}`, ''];
let total = 0;
for (const round of rounds) total += byRound.get(round).length;
lines.push(`共 ${rounds.length} 轮 · ${total} 条功能记录（第 ${rounds[0]}–${rounds[rounds.length - 1]} 轮）。`, '');
const byModule = new Map();
for (const round of rounds) {
  for (const entry of byRound.get(round)) {
    const mod = moduleOf(entry.name, entry.desc);
    if (!byModule.has(mod)) byModule.set(mod, []);
    byModule.get(mod).push(`- 第 ${round} 轮 · ${entry.name}：${entry.desc}`);
  }
}
lines.push('## 按功能域', '');
for (const [mod, items] of byModule) {
  lines.push(`### ${mod}（${items.length} 条）`, '', ...items, '');
}
lines.push('## 按轮次', '');
for (const round of rounds) {
  lines.push(`### 第 ${round} 轮（${byRound.get(round).length} 条）`, '', '| 功能 | 说明 |', '| --- | --- |');
  lines.push(...byRound.get(round).map((entry) => `| ${escCell(entry.name)} | ${escCell(entry.desc)} |`));
  lines.push('');
}
writeFileSync(resolve(root, 'docs/巡检盘点-功能清单.md'), `${lines.join('\n')}\n`);
console.log(`generated: ${rounds.length} rounds, ${total} entries, ${byModule.size} modules`);

