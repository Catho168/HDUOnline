/**
 * 端到端冒烟验证（本地 fixture + 真实 Chrome + 已构建扩展）。
 *
 * 用 CDP `Extensions.loadUnpacked` 加载 dev 构建，验证：
 *  1. 新版播放页 #/play-center 注入、课次识别、面板与胶囊；
 *  2. 学习中心接管、导航与课程墙/课次列表；
 *  3. 「站点原页面」与入口坞切换；
 *  4. 无重复注入。
 *
 * 用法：
 *   npm run e2e:build && npm run e2e
 *   CHROME_PATH=... npm run e2e
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXT_DIR = join(root, '.output', 'chrome-mv3-dev');
const PORT = 8788;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = new Set(process.argv.slice(2));
const SHOTS_DIR = join(root, 'tests', '.local');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

function findBrowser() {
  const found = CHROME_CANDIDATES.find((path) => existsSync(path));
  if (!found) throw new Error(`未找到浏览器，请用 CHROME_PATH 指定（候选：${CHROME_CANDIDATES.join(' / ')}）`);
  return found;
}

async function ensureMockServer() {
  try {
    const res = await fetch(`${BASE}/jy-application-resourcemanage/v1/currentuser`);
    if (res.ok) return null;
  } catch {
    /* 未启动 */
  }
  const child = spawn(process.execPath, [join(root, 'tests', 'fixtures', 'serve.mjs')], { stdio: 'ignore', detached: false });
  for (let i = 0; i < 20; i += 1) {
    await sleep(300);
    try {
      const res = await fetch(`${BASE}/jy-application-resourcemanage/v1/currentuser`);
      if (res.ok) return child;
    } catch {
      /* 继续等待 */
    }
  }
  throw new Error('模拟站点服务启动失败（tests/fixtures/serve.mjs）');
}

function createCdp(browserPath, profileDir) {
  const chrome = spawn(
    browserPath,
    [
      '--headless=new',
      '--enable-unsafe-extension-debugging',
      '--remote-debugging-pipe',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,OptimizationHints',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
  );
  const writeStream = chrome.stdio[3];
  const readStream = chrome.stdio[4];
  let buffer = '';
  let seq = 0;
  const pending = new Map();

  readStream.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\0')) >= 0) {
      const raw = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!raw.trim()) continue;
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        continue;
      }
      const key = message.sessionId ? `${message.sessionId}:${message.id}` : String(message.id);
      const resolver = pending.get(key);
      if (resolver) {
        pending.delete(key);
        if (message.error) resolver.reject(new Error(JSON.stringify(message.error)));
        else resolver.resolve(message.result);
      }
    }
  });

  const send = (method, params = {}, sessionId) => {
    const id = ++seq;
    const key = sessionId ? `${sessionId}:${id}` : String(id);
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolvePromise, rejectPromise) => {
      pending.set(key, { resolve: resolvePromise, reject: rejectPromise });
      writeStream.write(`${JSON.stringify(payload)}\0`);
      setTimeout(() => {
        if (pending.delete(key)) rejectPromise(new Error(`CDP 超时：${method}`));
      }, 25_000);
    });
  };

  return { chrome, send };
}

const checks = [];
function check(name, actual, expected = true) {
  const ok = typeof expected === 'boolean' ? Boolean(actual) === expected : actual === expected;
  checks.push({ name, ok, actual });
  process.stdout.write(`${ok ? '✔' : '✘'} ${name}${ok ? '' : `（实际：${JSON.stringify(actual)}）`}\n`);
}

async function main() {
  if (args.has('--build')) {
    process.stdout.write('· 构建 dev 版扩展（wxt build --mode development）…\n');
    const built = spawnSync('npx', ['wxt', 'build', '--mode', 'development'], { cwd: root, stdio: 'ignore', shell: true });
    if (built.status !== 0) throw new Error('dev 构建失败');
  }
  if (!existsSync(EXT_DIR)) {
    throw new Error(`未找到 dev 构建：${EXT_DIR}\n请先执行：npm run e2e:build（或加 --build）`);
  }

  const server = await ensureMockServer();
  const { chrome, send } = createCdp(findBrowser(), mkdtempSync(join(tmpdir(), 'hdu-e2e-')));

  try {
    const loaded = await send('Extensions.loadUnpacked', { path: EXT_DIR.replace(/\//g, '\\') });
    check('扩展加载成功', Boolean(loaded?.id));

    const playUrl = `${BASE}/play-center-sim.html#/play-center?teclId=9001&teclCode=TECL-9001&subjId=1573&target=video`;
    const { targetId } = await send('Target.createTarget', { url: playUrl });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Runtime.enable', {}, sessionId);
    await send('Page.enable', {}, sessionId);

    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (result.exceptionDetails) return `异常：${result.exceptionDetails.text}`;
      return result.result.value;
    };
    const shadowQuery = (selector) =>
      evaluate(`document.getElementById('hdu-assistant-host')?.shadowRoot?.querySelector('${selector}')?.textContent ?? ''`);
    const shadowExists = (selector) => evaluate(`!!document.getElementById('hdu-assistant-host')?.shadowRoot?.querySelector('${selector}')`);
    const clickByText = (selector, text) =>
      evaluate(`(() => {
        const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
        const el = [...(root?.querySelectorAll('${selector}') ?? [])].find((node) => node.textContent?.includes('${text}'));
        el?.click();
        return !!el;
      })()`);

    const shot = async (name) => {
      if (!args.has('--shots')) return;
      const result = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
      if (!result?.data) return;
      mkdirSync(SHOTS_DIR, { recursive: true });
      writeFileSync(join(SHOTS_DIR, `${name}.png`), Buffer.from(result.data, 'base64'));
    };

    await sleep(5000);
    check('播放页注入 Shadow 宿主', await shadowExists('.hdu-root'));
    check('仅注入一个宿主（无重复）', await evaluate("document.querySelectorAll('#hdu-assistant-host').length === 1"));
    check('播放页默认展开本节助手', await shadowExists('.hdu-panel'));
    check('顶部课次胶囊出现', await shadowExists('.hdu-capsule'));
    check('右下角入口坞出现', await shadowExists('.hdu-dock'));
    const dockText = String(await shadowQuery('.hdu-dock'));
    check('入口坞包含学习中心与本助手', dockText.includes('学习中心') && dockText.includes('本节助手'));

    const panelText = String(await shadowQuery('.hdu-panel'));
    check('面板显示课程名（来自站点接口）', panelText.includes('线性代数（模拟课程）'));
    check('面板显示课次时长 47:00', panelText.includes('47:00'));
    check('课次已识别（非待识别）', !panelText.includes('待识别课次') && (panelText.includes('上次播放记录') || panelText.includes('页面课次选中项') || panelText.includes('播放地址') || panelText.includes('站点接口')));
    check('面板包含速览/标注/大纲/问答/笔记/收藏/搜索', ['速览', '标注', '大纲', '问答', '笔记', '收藏', '搜索'].every((label) => panelText.includes(label)));
    await shot('panel');

    // ── 学习中心：从播放页入口坞打开 ──
    await clickByText('.hdu-dock-btn', '学习中心');
    await sleep(1200);
    check('打开学习中心覆盖层', await shadowExists('.hdu-center'));
    const centerText = String(await shadowQuery('.hdu-center'));
    check('学习中心含五个导航', ['总览', '我的课程', '课表与补看', '知识库', '学习统计'].every((label) => centerText.includes(label)));
    const centerStyle = await evaluate(`(() => {
      const el = document.getElementById('hdu-assistant-host')?.shadowRoot?.querySelector('.hdu-center');
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, paper: cs.getPropertyValue('--paper').trim() };
    })()`);
    check('学习中心为不透明覆盖层', Boolean(centerStyle) && centerStyle.bg !== 'rgba(0, 0, 0, 0)' && centerStyle.paper.length > 0);
    await shot('center-overview');

    // ── 列表页接管 + 课程墙同步 ──
    await send('Page.navigate', { url: `${BASE}/play-center-sim.html#/list-video` }, sessionId);
    await sleep(6500);
    check('列表页自动进入学习中心', await shadowExists('.hdu-center'));
    await clickByText('.hdu-nav-item', '我的课程');
    await sleep(1500);
    let coursesText = String(await shadowQuery('.hdu-center'));
    check('课程墙显示站点课程', coursesText.includes('线性代数（模拟课程）'));
    check('课程卡片显示课次数', coursesText.includes('3 节课') || coursesText.includes('节课'));
    const expanded = await clickByText('.hdu-course-card button', '展开课次');
    check('课程可展开课次', expanded);
    await sleep(1000);
    coursesText = String(await shadowQuery('.hdu-center'));
    check('展开后列出课次（第12节课）', coursesText.includes('第12节课'));
    check('课次显示完看度或状态', coursesText.includes('%') || coursesText.includes('已看完') || coursesText.includes('尚未'));
    const teacherText = String(
      await evaluate(
        `[...(document.getElementById('hdu-assistant-host')?.shadowRoot?.querySelectorAll('.hdu-course-teacher') ?? [])].map((el) => el.textContent).join('|')`,
      ),
    );
    check('课程卡片显示教师', teacherText.includes('模拟教师'));
    await shot('center-courses');

    // ── 本周课表（课程墙同步时一并拉取） ──
    await clickByText('.hdu-nav-item', '课表与补看');
    await sleep(1500);
    const scheduleText = String(await shadowQuery('.hdu-center'));
    check('课表页显示本周课表', scheduleText.includes('本周课表'));
    check('课表渲染本周课程', scheduleText.includes('线性代数（模拟课程）'));
    check('课表提供手动同步入口', scheduleText.includes('同步课表'));
    await shot('center-schedule');

    // ── 站点原页面 / 恢复 ──
    const suppressed = await clickByText('.hdu-topbar-actions .hdu-btn', '站点原页面');
    check('点击站点原页面', suppressed);
    await sleep(600);
    check('学习中心已隐藏', !(await shadowExists('.hdu-center')));
    check('入口坞仍在', await shadowExists('.hdu-dock'));
    await clickByText('.hdu-dock-btn', '学习中心');
    await sleep(800);
    check('可从入口坞恢复学习中心', await shadowExists('.hdu-center'));

    // ── 统计页 ──
    await clickByText('.hdu-nav-item', '学习统计');
    await sleep(1200);
    const statsText = String(await shadowQuery('.hdu-center'));
    check('统计页展示累计与口径', statsText.includes('累计有效学习') && statsText.includes('口径'));
    await shot('center-stats');

    // ── 扩展页面：Options / Dashboard / Popup ──
    const openExtPage = async (file, waitMs = 2200) => {
      const url = `chrome-extension://${loaded.id}/${file}`;
      const target = await send('Target.createTarget', { url });
      const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
      const sid = attached.sessionId;
      await send('Runtime.enable', {}, sid);
      await sleep(waitMs);
      const result = await send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true }, sid);
      const text = result?.result?.value ?? '';
      if (args.has('--debug')) {
        const html = await send('Runtime.evaluate', { expression: "document.getElementById('root')?.innerHTML.slice(0, 500) ?? '(no root)'", returnByValue: true }, sid);
        process.stdout.write(`[debug ${file}] text=${JSON.stringify(String(text).slice(0, 200))} html=${JSON.stringify(html?.result?.value ?? '')}\n`);
      }
      if (args.has('--shots')) {
        const png = await send('Page.captureScreenshot', { format: 'png' }, sid);
        if (png?.data) {
          mkdirSync(SHOTS_DIR, { recursive: true });
          writeFileSync(join(SHOTS_DIR, file.replace('.html', '.png')), Buffer.from(png.data, 'base64'));
        }
      }
      await send('Target.closeTarget', { targetId: target.targetId });
      return String(text);
    };

    const optionsText = await openExtPage('options.html');
    check('Options 页渲染设置分区', optionsText.includes('AI 服务') && optionsText.includes('转写与模型') && optionsText.includes('学习与界面'));
    const dashboardText = await openExtPage('dashboard.html', 2800);
    check('Dashboard 页渲染学习概览', dashboardText.includes('学习概览') && dashboardText.includes('知识库'));
    const popupText = await openExtPage('popup.html', 1800);
    check('Popup 页渲染助手概览', popupText.includes('智慧课堂助手') && popupText.includes('今日'));
  } finally {
    chrome.kill();
    server?.kill();
  }

  const failed = checks.filter((item) => !item.ok);
  process.stdout.write(`\n${checks.length - failed.length}/${checks.length} 项通过\n`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`E2E 失败：${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
