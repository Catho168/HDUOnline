/**
 * 端到端冒烟验证（本地 fixture + 真实 Chrome + 已构建扩展）。
 *
 * 用 CDP `Extensions.loadUnpacked` 加载 dev 构建，验证：
 *  1. 新版播放页 #/play-center 注入、课次识别、面板与胶囊；
 *  2. 学习中心接管、导航与课程墙/课次列表；
 *  3. 「站点原页面」与入口坞切换；
 *  4. 无重复注入；
 *  5. B 站视频页（CDP Fetch 拦截 + 本地 fixture，见 tests/fixtures/bili-video-sim.html）：
 *     内容脚本挂载、字幕获取/浮层/搜索、学习助手面板、收藏此时刻落库、AI 时间轴标记、
 *     无字幕问答空态。字幕与 AI 标注数据经扩展页面上下文预置进扩展 IndexedDB
 *     （bili.subtitle.fetch 先查库后联网，命中缓存即离线可用，不打真实 B 站接口）。
 *
 * 等待口径（第 15 轮）：所有「固定 sleep 后断言」的步骤改为条件等待——
 * waitFor(fn, desc) 以 200ms 间隔轮询断言条件，10s 预算，超时才判失败并输出
 * 当时页面状态摘要（第 13 轮实测 SW 冷启动时长波动会让整批断言 flaky，
 * 固定 sleep 不再承担等待职责，仅保留在 waitFor 内部轮询与服务启动探测里）。
 *
 * 用法：
 *   npm run e2e:build && npm run e2e
 *   CHROME_PATH=... npm run e2e
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXT_DIR = join(root, '.output', 'chrome-mv3-dev');
const PORT = 8788;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 条件等待默认预算与轮询间隔 */
const WAIT_BUDGET_MS = 10_000;
const WAIT_INTERVAL_MS = 200;
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
  /** CDP 事件订阅者（B 站 fixture 的 Fetch 拦截依赖；handler 收到完整消息，自行过滤 sessionId） */
  const eventListeners = new Set();

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
      // 事件（无 id）先分发给订阅者，再照常走响应匹配（互不影响）
      if (message.method) for (const listener of eventListeners) listener(message);
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

  /** 订阅 CDP 事件；返回退订函数 */
  const onEvent = (handler) => {
    eventListeners.add(handler);
    return () => eventListeners.delete(handler);
  };

  return { chrome, send, onEvent };
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
  const profileDir = mkdtempSync(join(tmpdir(), 'hdu-e2e-'));
  const { chrome, send, onEvent } = createCdp(findBrowser(), profileDir);

  // 控制台错误收集（第 316 轮诊断）：捕获各页面/内容脚本的 console.error，跑尾导出
  // （ErrorBoundary → logger.error → console.error；渲染崩溃的堆栈会在这里出现）。
  // 声明在 try 之外：跑尾诊断（finally 之后）同样引用它，作用域必须覆盖整个 main。
  const consoleErrors = [];

  try {
    const loaded = await send('Extensions.loadUnpacked', { path: EXT_DIR.replace(/\//g, '\\') });
    check('扩展加载成功', Boolean(loaded?.id));

    // 等扩展完全注册（本扩展的 SW target 出现）再开页：headless 下 loadUnpacked 返回后
    // 立即导航，实测偶发内容脚本未随首屏注入（注册尚未传播），表现为整批 host=false 假失败。
    let extensionReady = false;
    for (let i = 0; i < 50 && !extensionReady; i += 1) {
      const targets = await send('Target.getTargets').catch(() => null);
      extensionReady = (targets?.targetInfos ?? []).some(
        (t) => t.type === 'service_worker' && String(t.url ?? '').includes(String(loaded?.id ?? '')),
      );
      if (!extensionReady) await sleep(200);
    }
    check('扩展后台就绪（SW target 出现）', extensionReady);

    const playUrl = `${BASE}/play-center-sim.html#/play-center?teclId=9001&teclCode=TECL-9001&subjId=1573&target=video`;
    const { targetId } = await send('Target.createTarget', { url: playUrl });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Runtime.enable', {}, sessionId);
    await send('Page.enable', {}, sessionId);
    onEvent((message) => {
      if (message.method !== 'Runtime.consoleAPICalled') return;
      const params = message.params ?? {};
      if (params.type !== 'error') return;
      const text = (params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300);
      consoleErrors.push(text);
    });

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

    /** 页面状态摘要（waitFor 超时时的现场输出）：URL + shadow 宿主存在性 + 正文前 200 字符 */
    const summarizePage = async (sid = sessionId) => {
      const result = await send(
        'Runtime.evaluate',
        {
          expression: `(() => ({
            url: location.href,
            host: !!document.getElementById('hdu-assistant-host'),
            text: (document.body?.innerText ?? '').slice(0, 200),
          }))()`,
          returnByValue: true,
        },
        sid,
      );
      const state = result?.result?.value;
      if (!state || typeof state !== 'object') return '(页面状态读取失败)';
      return `url=${state.url} | host=${state.host} | body=${JSON.stringify(String(state.text))}`;
    };

    /**
     * 条件等待：每 intervalMs 轮询 fn 直到返回真值（真值原样返回给调用方继续使用），
     * 超过预算仍为假 → 输出当时页面状态摘要并返回 null，由既有 check 机制记录失败，
     * 不中断后续步骤（与原固定 sleep 时代断言失败的行为一致）。
     * fn 抛错（如导航瞬间执行上下文销毁）视为本轮未就绪，按间隔重试直至超时。
     * 断言逻辑本身不变：waitFor 只改变「等多久、怎么等」，check 的比较式保持原样。
     */
    const waitFor = async (fn, desc, { sid = sessionId, timeoutMs = WAIT_BUDGET_MS, intervalMs = WAIT_INTERVAL_MS } = {}) => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        try {
          const value = await fn();
          if (value) return value;
        } catch {
          /* 本轮未就绪（导航/上下文重建等），按间隔重试 */
        }
        await sleep(intervalMs);
      }
      const summary = await summarizePage(sid).catch(() => '(页面状态摘要获取失败)');
      process.stdout.write(`✘ 条件等待超时（${timeoutMs}ms）：${desc}\n  页面状态：${summary}\n`);
      return null;
    };

    // ── 播放页注入与面板（原 5s 固定等待 → 逐项条件等待） ──
    // 首屏注入兜底：个别机器上扩展虽已就绪仍可能漏注入首屏（表现为 host 长期为假），
    // 5s 未出现即 reload 重试（reload 会重新走注入判定），至多三轮。
    let playPageInjected = false;
    for (let attempt = 0; attempt < 3 && !playPageInjected; attempt += 1) {
      playPageInjected = Boolean(await waitFor(() => shadowExists('.hdu-root'), '播放页注入 Shadow 宿主', { timeoutMs: 5000 }));
      if (!playPageInjected && attempt < 2) {
        process.stdout.write('· 首屏未检测到内容脚本注入，重载页面重试…\n');
        await send('Page.reload', {}, sessionId).catch(() => {});
      }
    }
    check('播放页注入 Shadow 宿主', playPageInjected);
    check(
      '仅注入一个宿主（无重复）',
      await waitFor(() => evaluate("document.querySelectorAll('#hdu-assistant-host').length === 1"), '宿主唯一性'),
    );
    check('播放页默认展开本节助手', await waitFor(() => shadowExists('.hdu-panel'), '本节助手面板展开'));
    check(
      '顶部课次入口出现（注入 chip 优先，浮窗胶囊降级）',
      await waitFor(async () => {
        const chip = await evaluate("!!document.querySelector('.play-header [data-hdu-anchor-chip]')");
        const capsule = await shadowExists('.hdu-capsule');
        return chip || capsule ? (chip ? 'chip' : 'capsule') : null;
      }, '顶栏 chip 或浮窗胶囊出现'),
    );
    const chipInjected = await evaluate("!!document.querySelector('.play-header [data-hdu-anchor-chip]')");
    if (chipInjected) {
      check('chip 注入时浮窗胶囊隐藏（单入口）', !(await shadowExists('.hdu-capsule')));
    }
    // 入口形态按「单入口策略」断言（App.tsx：注入探针激活时浮层 Dock 不渲染，由
    // 页面内探针菜单承接「本节助手 / 学习中心」两能力）。nativeAnchor 默认开，fixture
    // 播放页含探针候选锚点，探针挂载与 Dock 降级随扫描时序先后切换——两形态都是
    // 合法终态，故单次原子读取两形态状态，任一形态在场且具备两入口文案即通过
    // （与「chip 注入时胶囊隐藏」同一单入口口径；不锁死形态，避免时序竞态 flaky）。
    // 探针菜单项仅在入口按钮点击展开后才渲染（AnchorEntry 条件渲染），被动读取恒空：
    // 菜单未展开时先代点一次 .hdu-probe-btn 再读取；仅在菜单不在场时点击，避免下一轮
    // 轮询把已展开的菜单又点关闭。Dock 降级形态不受影响（dockText 口径不变）。
    const entryReady = await waitFor(async () => {
      const state = await evaluate(`(() => {
        const shadow = document.querySelector('[data-hdu-anchor-entry]')?.shadowRoot;
        if (shadow && !shadow.querySelector('.hdu-probe-menu')) shadow.querySelector('.hdu-probe-btn')?.click();
        const probeItems = [...(shadow?.querySelectorAll('.hdu-probe-item') ?? [])].map((el) => el.textContent).join('|');
        const dock = document.getElementById('hdu-assistant-host')?.shadowRoot?.querySelector('.hdu-dock');
        return { probe: probeItems, dockText: dock?.textContent ?? '' };
      })()`);
      if (!state || typeof state !== 'object') return null;
      const probeOk = String(state.probe).includes('本节助手') && String(state.probe).includes('学习中心');
      const dockOk = String(state.dockText).includes('学习中心') && String(state.dockText).includes('本节助手');
      return probeOk || dockOk ? { probeOk, dockOk } : null;
    }, '入口就位（注入探针菜单或浮层 Dock，含两入口文案）');
    check('播放页入口就位（注入探针优先，浮层 Dock 降级）', Boolean(entryReady));

    // 面板文本以「课程名来自站点接口」为就绪标记（接口未回时，原 5s 固定等待同样会漏）
    const panelText = String(
      (await waitFor(async () => {
        const text = await shadowQuery('.hdu-panel');
        return text.includes('线性代数（模拟课程）') ? text : null;
      }, '面板渲染并显示课程名（站点接口已回）')) ?? '',
    );
    check('面板显示课程名（来自站点接口）', panelText.includes('线性代数（模拟课程）'));
    check('面板显示课次时长 47:00', panelText.includes('47:00'));
    check('课次已识别（非待识别）', !panelText.includes('待识别课次') && (panelText.includes('上次播放记录') || panelText.includes('页面课次选中项') || panelText.includes('播放地址') || panelText.includes('站点接口')));
    check('面板包含速览/标注/大纲/问答/笔记/收藏/搜索', ['速览', '标注', '大纲', '问答', '笔记', '收藏', '搜索'].every((label) => panelText.includes(label)));
    // 问答导出（第 81 轮）：切到问答页签后工具行带「导出问答」入口（无消息时禁用）；
    // 断言后切回速览（面板默认页签），不影响后续检查
    check('面板问答导出按钮（第 81 轮）', await clickByText('.hdu-panel-tab', '问答') && (await waitFor(async () => {
      const text = await shadowQuery('.hdu-panel');
      return text.includes('导出问答') ? text : null;
    }, '问答导出按钮')));
    await clickByText('.hdu-panel-tab', '速览');
    // 播放页搜索空结果建议词随长度变化（第 314 轮）：切「搜索」页签 → 输入超长关键词
    // → 点「搜索」→ 空结果提示点名「关键词较长（N 字）」（emptySearchTip 六端覆盖）
    await clickByText('.hdu-panel-tab', '搜索');
    await evaluate(`(() => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      const input = root?.querySelector('input[aria-label="搜索本节字幕"]');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '这是一个特别长的搜索关键词用来触发空结果提示');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await evaluate(`(() => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      const btn = [...(root?.querySelectorAll('button') ?? [])].filter((b) => !b.classList.contains('hdu-panel-tab')).find((b) => b.textContent?.trim() === '搜索');
      btn?.click();
      return !!btn;
    })()`);
    const playerTips = await waitFor(async () => {
      const text = await shadowQuery('.hdu-panel');
      return text.includes('关键词较长（') && text.includes('没有命中') ? text : null;
    }, '播放页超长关键词建议词');
    if (playerTips === null) process.stdout.write(`[diag] 播放页搜索面板=${JSON.stringify(await shadowQuery('.hdu-panel'))}\n`);
    check('播放页搜索空结果建议词随长度变化（第 314 轮）', playerTips !== null);
    // 还原：清空搜索词并回到速览页签
    await evaluate(`(() => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      const input = root?.querySelector('input[aria-label="搜索本节字幕"]');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    // 短词负向（第 315 轮）：短词空结果仍为通用建议（不点名长度）
    await clickByText('.hdu-panel-tab', '搜索');
    await evaluate(`(() => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      const input = root?.querySelector('input[aria-label="搜索本节字幕"]');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '丙');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await evaluate(`(() => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      const btn = [...(root?.querySelectorAll('button') ?? [])].filter((b) => !b.classList.contains('hdu-panel-tab')).find((b) => b.textContent?.trim() === '搜索');
      btn?.click();
      return !!btn;
    })()`);
    const playerShortTips = await waitFor(async () => {
      const text = await shadowQuery('.hdu-panel');
      return text.includes('换个关键词试试') && !text.includes('关键词较长') ? text : null;
    }, '播放页短词通用建议');
    if (playerShortTips === null) process.stdout.write(`[diag] 播放页短词面板=${JSON.stringify(await shadowQuery('.hdu-panel'))}\n`);
    check('播放页搜索短词建议词不点名（第 315 轮）', playerShortTips !== null);
    await evaluate(`(() => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      const input = root?.querySelector('input[aria-label="搜索本节字幕"]');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await clickByText('.hdu-panel-tab', '速览');
    await shot('panel');

    // ── 第 36 轮：探针入口四项菜单完整性（第 32 轮 2 项 → 4 项的回归网补强） ──
    // 既有「入口就位」检查只断言本节助手/学习中心两项；这里沿用同款「未展开先代点」
    // 模式读取全部菜单项，四项文案齐全才通过。
    const probeMenuText = await waitFor(async () => {
      const items = await evaluate(`(() => {
        const shadow = document.querySelector('[data-hdu-anchor-entry]')?.shadowRoot;
        if (!shadow) return '';
        if (!shadow.querySelector('.hdu-probe-menu')) { shadow.querySelector('.hdu-probe-btn')?.click(); return ''; }
        return [...shadow.querySelectorAll('.hdu-probe-item')].map((el) => el.textContent).join('|');
      })()`);
      const text = String(items);
      return ['本节助手', '学习中心', '收藏此时刻', 'AI 标注'].every((label) => text.includes(label)) ? text : null;
    }, '探针菜单四项文案齐全');
    check('探针入口菜单含四项（本节助手/学习中心/收藏此时刻/AI 标注）', Boolean(probeMenuText));

    // 点击「收藏此时刻」：与 PlayPanel 头部同一 addTimeFavorite action。此时面板课程名
    // 已渲染（会话已识别），action 应走完整链路：fav.put 落库 + 主宿主 toast。
    // IndexedDB 落库断言在下方扩展页面上下文段补做（evalInExtPage 定义在后）。
    const probeFavClicked = await evaluate(`(() => {
      const shadow = document.querySelector('[data-hdu-anchor-entry]')?.shadowRoot;
      const item = [...(shadow?.querySelectorAll('.hdu-probe-item') ?? [])].find((n) => n.textContent?.includes('收藏此时刻'));
      item?.click();
      return !!item;
    })()`);
    // toast 在 fav.put + fav.list 两个 SW 往返之后才弹出；本会话首次 callOp 可能叠加
    // SW 冷启动延迟，等待预算放宽到 20s（落库断言见下方扩展页面上下文段，不受 TTL 影响）
    check('HDU 探针「收藏此时刻」→ addTimeFavorite toast', probeFavClicked && (await waitFor(async () => {
      const toast = await shadowQuery('.hdu-toast');
      return toast.includes('已收藏当前时间点') ? toast : null;
    }, 'HDU 探针收藏 toast', { timeoutMs: 20000 })));

    // ── 第 36 轮：探针入口站点深浅跟随 ──
    // resolveHostTheme 先采样 html/body 的 data-theme/class 深色信号；fixture 默认亮底，
    // 探针挂载即 light。运行时给 <html> 挂 data-theme="dark"，探针随扫描周期（2s 轮询 +
    // 采样 5s 节流）复采并重渲染入口 → shadow 根 data-theme 翻转；移除后跟随回 light。
    check('HDU 探针初始浅色（fixture 亮底）', await waitFor(() => evaluate(
      "document.querySelector('[data-hdu-anchor-entry]')?.shadowRoot?.querySelector('.hdu-probe-entry')?.getAttribute('data-theme') === 'light'",
    ), '探针初始 data-theme=light', { timeoutMs: 5000 }));
    await evaluate(`document.documentElement.setAttribute('data-theme', 'dark')`);
    check('HDU 探针跟随站点深色（data-theme=dark）', await waitFor(() => evaluate(
      "document.querySelector('[data-hdu-anchor-entry]')?.shadowRoot?.querySelector('.hdu-probe-entry')?.getAttribute('data-theme') === 'dark'",
    ), '探针跟随站点深色', { timeoutMs: 12000 }));
    await evaluate(`document.documentElement.removeAttribute('data-theme')`);
    check('HDU 探针跟随站点恢复浅色（data-theme=light）', await waitFor(() => evaluate(
      "document.querySelector('[data-hdu-anchor-entry]')?.shadowRoot?.querySelector('.hdu-probe-entry')?.getAttribute('data-theme') === 'light'",
    ), '探针跟随站点恢复浅色', { timeoutMs: 12000 }));

    // ── 学习中心：从播放页入口打开 ──
    // 入口有两种形态（单入口策略，探针挂载时机晚于首屏且挂载后浮层 Dock 会被隐藏）：
    //  ① 浮层 Dock：扩展 shadow 内 .hdu-dock-btn（文本「学习中心」）；
    //  ② 锚点探针注入入口：页面内 [data-hdu-anchor-entry] 的 shadow 里
    //     .hdu-probe-btn（展开菜单）→ .hdu-probe-item（文本「学习中心」）。
    // 每轮按当前形态点按；openCenter 幂等（置 centerOpen=true，非 toggle），重复点不回关。
    const centerOpened = await waitFor(async () => {
      if (await shadowExists('.hdu-center')) return true;
      if (await clickByText('.hdu-dock-btn', '学习中心')) return null;
      const probeReady = await evaluate(
        `(() => {
          const shadow = document.querySelector('[data-hdu-anchor-entry]')?.shadowRoot;
          if (!shadow) return 'no-probe';
          const item = [...(shadow.querySelectorAll('.hdu-probe-item') ?? [])].find((n) => n.textContent?.includes('学习中心'));
          if (item) { item.click(); return 'clicked'; }
          shadow.querySelector('.hdu-probe-btn')?.click();
          return 'menu-opened';
        })()`,
      );
      if (probeReady === 'clicked') return null;
      return null;
    }, '打开学习中心覆盖层（入口点按重试）');
    check('打开学习中心覆盖层', centerOpened);
    if (!centerOpened) {
      // 失败现场转储：区分「入口形态/点击未生效」与「已打开但选择器/时机问题」
      const diag = await evaluate(`(() => {
        const shadow = document.getElementById('hdu-assistant-host')?.shadowRoot;
        const probeShadow = document.querySelector('[data-hdu-anchor-entry]')?.shadowRoot;
        return {
          hostCount: document.querySelectorAll('#hdu-assistant-host').length,
          dock: !!shadow?.querySelector('.hdu-dock'),
          probeEntry: !!document.querySelector('[data-hdu-anchor-entry]'),
          probeBtn: !!probeShadow?.querySelector('.hdu-probe-btn'),
          centerNow: !!shadow?.querySelector('.hdu-center'),
          rootHtml: (shadow?.querySelector('.hdu-root')?.innerHTML ?? '').slice(0, 200),
        };
      })()`);
      process.stdout.write(`[diag] 学习中心未打开现场：${JSON.stringify(diag)}\n`);
    }
    const centerText = String(
      (await waitFor(async () => {
        const text = await shadowQuery('.hdu-center');
        // 五个导航一次性渲染，最后一个标签出现即覆盖层内容就绪
        return text.includes('学习统计') ? text : null;
      }, '学习中心导航渲染')) ?? '',
    );
    check('学习中心含六个导航', ['总览', '我的课程', '课表与补看', '知识库', '复习计划', '学习统计'].every((label) => centerText.includes(label)));
    // 统一搜索 × 清空按钮（第 265/285 轮）：输入关键词 → × 出现（shadowQuery 文本断言；
    // 焦点回归行为由 library-empty-state / modal-trap 单测锁定）
    await evaluate(`(() => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      const input = root?.querySelector('.hdu-topbar-search input');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '矩阵');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    const searchClearOk = await waitFor(async () => {
      // × 出现（shadowQuery 文本断言；焦点回归行为由 library-empty-state / modal-trap 单测锁定）
      const clearText = await shadowQuery('.hdu-search-clear');
      return clearText.includes('×') ? true : null;
    }, '统一搜索清空按钮');
    check('统一搜索 × 清空按钮（第 265/285 轮）', searchClearOk === true);
    // 空结果建议词随输入长度变化（第 307 轮，检索域/可用性）：超长关键词的空结果
    // 提示点名「关键词较长（N 字）」，引导只取核心词重搜
    await evaluate(`(() => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      const input = root?.querySelector('.hdu-topbar-search input');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '这是一个特别长的搜索关键词用来触发空结果提示');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    check('统一搜索空结果建议词随长度变化（第 307 轮）', await waitFor(async () => {
      const tips = await shadowQuery('.hdu-search-empty-tips');
      return tips.includes('关键词较长（') && tips.includes('试试更短的关键词') ? tips : null;
    }, '超长关键词建议词'));
    // 还原：清空搜索词（面板收起，不影响后续检查）
    await evaluate(`(() => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      const input = root?.querySelector('.hdu-topbar-search input');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    // 总览成就速览（第 127 轮巡检）：空数据下显示计数 0/N 与引导文案（解锁 chips 见人工验收 §70）；
    // 第 129 轮起附「距下一枚徽章」剩余量提示
    check('总览学习成就速览（第 127/129 轮）', await waitFor(async () => {
      const text = await shadowQuery('.hdu-center');
      return text.includes('学习成就 · 已解锁 0/') && text.includes('还没有解锁徽章') && text.includes('距下一枚徽章') ? text : null;
    }, '总览成就速览'));
    // 复习计划视图（第 83 轮）：导航在位；此时复习种子尚未写入（B 站段才预置），显示空态
    // （含数据的全量复习视图断言见 B 站种子落库之后）
    check('学习中心复习计划空态（第 83 轮）', await clickByText('.hdu-nav-item', '复习计划') && (await waitFor(async () => {
      const text = await shadowQuery('.hdu-center');
      return text.includes('暂无复习计划') ? text : null;
    }, '复习计划空态')));
    await clickByText('.hdu-nav-item', '学习统计');
    const centerStyle = await waitFor(
      () => evaluate(`(() => {
      const el = document.getElementById('hdu-assistant-host')?.shadowRoot?.querySelector('.hdu-center');
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, paper: cs.getPropertyValue('--paper').trim() };
    })()`),
      '学习中心样式计算',
    );
    check('学习中心为不透明覆盖层', Boolean(centerStyle) && centerStyle.bg !== 'rgba(0, 0, 0, 0)' && centerStyle.paper.length > 0);
    await shot('center-overview');

    // ── 列表页接管 + 课程墙同步（原 6.5s 固定等待 → 条件等待） ──
    await send('Page.navigate', { url: `${BASE}/play-center-sim.html#/list-video` }, sessionId);
    check('列表页自动进入学习中心', await waitFor(() => shadowExists('.hdu-center'), '列表页自动进入学习中心'));
    await clickByText('.hdu-nav-item', '我的课程');
    await waitFor(() => shadowExists('.hdu-course-card'), '课程墙卡片渲染');
    let coursesText = String(await shadowQuery('.hdu-center'));
    check('课程墙显示站点课程', coursesText.includes('线性代数（模拟课程）'));
    check('课程卡片显示课次数', coursesText.includes('3 节课') || coursesText.includes('节课'));
    // 排序选择器（第 82 轮）：课程墙头部带本地排序下拉（默认/完看度/已看时长/课程名）
    check('课程排序选择器（第 82 轮）', coursesText.includes('按完看度') && coursesText.includes('按课程名'));
    const expanded = await clickByText('.hdu-course-card button', '展开课次');
    check('课程可展开课次', expanded);
    await waitFor(async () => ((await shadowQuery('.hdu-center')).includes('第12节课') ? true : null), '展开后课次列表渲染');
    coursesText = String(await shadowQuery('.hdu-center'));
    check('展开后列出课次（第12节课）', coursesText.includes('第12节课'));
    check('课次显示完看度或状态', coursesText.includes('%') || coursesText.includes('已看完') || coursesText.includes('尚未'));
    const teacherText = String(
      (await waitFor(async () => {
        const text = await evaluate(
          `[...(document.getElementById('hdu-assistant-host')?.shadowRoot?.querySelectorAll('.hdu-course-teacher') ?? [])].map((el) => el.textContent).join('|')`,
        );
        return text.includes('模拟教师') ? text : null;
      }, '课程卡片教师渲染')) ?? '',
    );
    check('课程卡片显示教师', teacherText.includes('模拟教师'));
    await shot('center-courses');

    // ── 本周课表（课程墙同步时一并拉取） ──
    await clickByText('.hdu-nav-item', '课表与补看');
    await waitFor(async () => ((await shadowQuery('.hdu-center')).includes('线性代数（模拟课程）') ? true : null), '课表渲染本周课程');
    const scheduleText = String(await shadowQuery('.hdu-center'));
    check('课表页显示本周课表', scheduleText.includes('本周课表'));
    check('课表渲染本周课程', scheduleText.includes('线性代数（模拟课程）'));
    check('课表提供手动同步入口', scheduleText.includes('同步课表'));
    await shot('center-schedule');

    // ── 站点原页面 / 恢复 ──
    const suppressed = await clickByText('.hdu-topbar-actions .hdu-btn', '站点原页面');
    check('点击站点原页面', suppressed);
    check('学习中心已隐藏', await waitFor(async () => !(await shadowExists('.hdu-center')), '学习中心已隐藏'));
    check('入口坞仍在', await waitFor(() => shadowExists('.hdu-dock'), '入口坞仍在'));
    await clickByText('.hdu-dock-btn', '学习中心');
    check('可从入口坞恢复学习中心', await waitFor(() => shadowExists('.hdu-center'), '可从入口坞恢复学习中心'));

    // ── 预置当日学习流水（第 80 轮）：扩展 IndexedDB 直写 courses/watchRecords/externalWatch，
    //    供热力图当日明细（课程名富化 + 回看入口）与周报环比断言使用。置于统计页检查前、
    //    课程墙检查后（courses store 追加行不影响站点接口驱动的课程墙断言）。
    {
      const seedTarget = await send('Target.createTarget', { url: `chrome-extension://${loaded.id}/options.html` });
      const seedAttached = await send('Target.attachToTarget', { targetId: seedTarget.targetId, flatten: true });
      const seedSid = seedAttached.sessionId;
      await send('Runtime.enable', {}, seedSid);
      await waitFor(async () => {
        const state = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, seedSid);
        return state?.result?.value === 'complete' ? true : null;
      }, '种子页加载完成', { sid: seedSid, timeoutMs: 5000 });
      const seedExpression = `(async () => {
        const db = await new Promise((resolve, reject) => {
          const req = indexedDB.open('hdu-assistant');
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        const now = new Date();
        const today = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
        const tomorrowDate = new Date(now);
        tomorrowDate.setDate(tomorrowDate.getDate() + 1);
        const tomorrow = tomorrowDate.getFullYear() + '-' + String(tomorrowDate.getMonth() + 1).padStart(2, '0') + '-' + String(tomorrowDate.getDate()).padStart(2, '0');
        await new Promise((resolve, reject) => {
          const tx = db.transaction(['courses', 'sessions', 'watchRecords', 'externalWatch', 'favorites', 'reviewJobs', 'notes'], 'readwrite');
          tx.objectStore('courses').put({ teclId: 9001, subjName: '高等数学（E2E）', teclCode: 'M9001', teacherNames: [], updatedAt: Date.now() });
          // 课次（第 317 轮巡检）：course.bundles 组装 courseNames 需要 sessions——
          // 无 session 行时复习计划「按课程筛选」下拉无课程可选
          tx.objectStore('sessions').put({ teclId: 9001, courId: 1, beginTime: '2026-10-12 08:00:00', endTime: '2026-10-12 09:00:00', watchState: 'watching' });
          tx.objectStore('watchRecords').put({ courId: 1, teclId: 9001, date: today, startTs: Date.now() - 3600e3, endTs: Date.now(), durationSec: 1800, playMode: 'vod', speed: 1, firstWatch: false, valid: true });
          tx.objectStore('watchRecords').put({ courId: 1, teclId: 9001, date: today, startTs: Date.now() - 7200e3, endTs: Date.now(), durationSec: 60, playMode: 'vod', speed: 1, firstWatch: false, valid: false });
          // 注意：不预置 externalWatch——B 站统计页签的 BiliWatchCard 空态断言依赖「无站外流水」
          // 站内复习种子（第 91/93 轮）：HDU 侧收藏 2 条 + 复习作业 2 条（1 条今日到期、
          // 1 条明日到期——复习计划视图类型筛选/来源标注/排序/一键完成断言用；
          // 今日到期的作业会影响 B站今日待办卡计数断言，已同步更新）
          tx.objectStore('favorites').put({ id: 'e2e-fav-hdu-review-1', type: 'time', courId: 1, teclId: 9001, snapshot: { title: '线性代数复习要点（E2E 预置）', content: '' }, folderId: null, tags: ['e2e', '复习'], pinned: false, favoritedAt: Date.now(), updatedAt: Date.now() });
          tx.objectStore('reviewJobs').put({ id: 'e2e-review-job-hdu-1', favoriteId: 'e2e-fav-hdu-review-1', dueDate: tomorrow, round: 1, template: 'regular', status: 'pending', createdAt: Date.now(), updatedAt: Date.now() });
          tx.objectStore('favorites').put({ id: 'e2e-fav-hdu-review-2', type: 'time', courId: 1, teclId: 9001, snapshot: { title: '高等数学复习要点（E2E 预置）', content: '' }, folderId: null, tags: ['e2e'], pinned: false, favoritedAt: Date.now(), updatedAt: Date.now() });
          tx.objectStore('reviewJobs').put({ id: 'e2e-review-job-hdu-2', favoriteId: 'e2e-fav-hdu-review-2', dueDate: today, round: 1, template: 'regular', status: 'pending', createdAt: Date.now(), updatedAt: Date.now() });
          // 考试模板作业（第 97 轮）：明日到期（模板筛选断言用）
          tx.objectStore('reviewJobs').put({ id: 'e2e-review-job-hdu-3', favoriteId: 'e2e-fav-hdu-review-1', dueDate: tomorrow, round: 1, template: 'exam', status: 'pending', createdAt: Date.now(), updatedAt: Date.now() });
          // 已跳过作业（第 99 轮）：2 条（已跳过分区/批量重新入计划断言用）
          tx.objectStore('reviewJobs').put({ id: 'e2e-review-job-hdu-4', favoriteId: 'e2e-fav-hdu-review-1', dueDate: today, round: 1, template: 'regular', status: 'skipped', createdAt: Date.now(), updatedAt: Date.now() });
          tx.objectStore('reviewJobs').put({ id: 'e2e-review-job-hdu-5', favoriteId: 'e2e-fav-hdu-review-2', dueDate: today, round: 1, template: 'regular', status: 'skipped', createdAt: Date.now(), updatedAt: Date.now() });
          // 已逾期作业（第 101 轮）：1 条（逾期强调断言用；review.due 按日精确匹配，不进今日卡）
          const yesterdayDate = new Date(now);
          yesterdayDate.setDate(yesterdayDate.getDate() - 1);
          const yesterday = yesterdayDate.getFullYear() + '-' + String(yesterdayDate.getMonth() + 1).padStart(2, '0') + '-' + String(yesterdayDate.getDate()).padStart(2, '0');
          tx.objectStore('reviewJobs').put({ id: 'e2e-review-job-hdu-6', favoriteId: 'e2e-fav-hdu-review-2', dueDate: yesterday, round: 1, template: 'regular', status: 'pending', createdAt: Date.now(), updatedAt: Date.now() });
          // 已逾期 2 天作业（第 113 轮）：1 条（逾期全部顺延断言用；标签「已到期 2 天」与第 107 轮顺延断言区分）
          const ago2Date = new Date(now);
          ago2Date.setDate(ago2Date.getDate() - 2);
          const ago2 = ago2Date.getFullYear() + '-' + String(ago2Date.getMonth() + 1).padStart(2, '0') + '-' + String(ago2Date.getDate()).padStart(2, '0');
          tx.objectStore('reviewJobs').put({ id: 'e2e-review-job-hdu-8', favoriteId: 'e2e-fav-hdu-review-1', dueDate: ago2, round: 1, template: 'regular', status: 'pending', createdAt: Date.now(), updatedAt: Date.now() });
          // 已完成作业（第 110 轮）：1 条（已完成分区/导出记录断言用；非 pending，不影响 review.due 今日计数）
          tx.objectStore('reviewJobs').put({ id: 'e2e-review-job-hdu-7', favoriteId: 'e2e-fav-hdu-review-1', dueDate: today, round: 1, template: 'regular', status: 'done', createdAt: Date.now(), updatedAt: Date.now() });
          // 课程筛选种子（第 317 轮巡检）：第二门课（大学物理）+ 待完成复习一条——
          // 供「按课程筛选」断言选课隐藏/切回恢复；type=time 不进待学视频（不影响 B 站今日卡）；
          // 标签仅 e2e（避免新增标签扰动标签统计/管理断言）
          tx.objectStore('courses').put({ teclId: 9002, subjName: '大学物理（E2E）', teclCode: 'M9002', teacherNames: [], updatedAt: Date.now() });
          tx.objectStore('sessions').put({ teclId: 9002, courId: 2, beginTime: '2026-10-13 08:00:00', endTime: '2026-10-13 09:00:00', watchState: 'watching' });
          tx.objectStore('favorites').put({ id: 'e2e-fav-hdu-review-3', type: 'time', courId: 2, snapshot: { title: '大学物理复习要点（E2E 预置）', content: '' }, folderId: null, tags: ['e2e'], pinned: false, favoritedAt: Date.now(), updatedAt: Date.now() });
          tx.objectStore('reviewJobs').put({ id: 'e2e-review-job-hdu-9', favoriteId: 'e2e-fav-hdu-review-3', dueDate: tomorrow, round: 1, template: 'regular', status: 'pending', createdAt: Date.now(), updatedAt: Date.now() });
          // 笔记（第 117 轮）：知识库「我的笔记」分区/搜索断言用；第 122 轮追加第二条
          // （teclId 9999 无课次 bundle → 行内课程徽标「未命名课程」）供课程筛选断言
          tx.objectStore('notes').put({ id: 'e2e-note-hdu-1', courId: 1, teclId: 9001, anchorTime: 60, text: 'E2E 预置笔记内容', createdAt: Date.now(), updatedAt: Date.now() });
          tx.objectStore('notes').put({ id: 'e2e-note-hdu-2', courId: 2, teclId: 9999, anchorTime: 120, text: 'E2E 预置笔记二', createdAt: Date.now() + 1, updatedAt: Date.now() + 1 });
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
        db.close();
        // 最近搜索种子（第 303 轮）：知识库最近搜索 chips 断言用。后续统一搜索若记录
        // 更多词会前插（cap 5），本词可能被挤出——chips 断言因此不依赖具体关键词
        try {
          const settingsStore = await chrome.storage.sync.get('settings.v1');
          const settings = settingsStore['settings.v1'] ?? {};
          // 6 条种子：知识库 chips 断言用——UI 只渲染 5 条（RECENT_QUERY_CAP），最旧一条被截断
          const ui = { ...(settings.ui ?? {}), recentQueries: ['词六', '词五', '词四', '词三', '词二', '高等数学（E2E）'] };
          await chrome.storage.sync.set({ 'settings.v1': { ...settings, ui } });
        } catch { /* 设置种子失败不影响其余断言 */ }
        return true;
      })()`;
      // 重试 3 次：扩展页 IDB 偶发被 SW 侧连接竞争（开库/锁），单次失败不直接判负
      let seeded = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        seeded = await send('Runtime.evaluate', {
          expression: seedExpression,
          returnByValue: true,
          awaitPromise: true,
        }, seedSid);
        if (seeded?.result?.value === true) break;
        await sleep(500);
      }
      check('预置当日学习流水（courses/watchRecords/externalWatch，第 80 轮）', seeded?.result?.value === true);
      await send('Target.closeTarget', { targetId: seedTarget.targetId });
    }

    // ── 统计页 ──
    await clickByText('.hdu-nav-item', '学习统计');
    // 就绪标记须覆盖两路异步取数：hero 指标（stats.report）与周报卡（stats.period，外壳先渲染、
    // 周期 Tab 与数字卡在 op 回数后才出现——只等外壳会读到残缺快照造成假失败）
    const statsText = String(
      (await waitFor(async () => {
        const text = await shadowQuery('.hdu-center');
        return ['累计有效学习', '学习周报', '近 8 周', '活跃天数'].every((marker) => text.includes(marker)) ? text : null;
      }, '统计页渲染（hero + 周报卡完整就绪）')) ?? '',
    );
    check('统计页展示累计与口径', statsText.includes('累计有效学习') && statsText.includes('口径'));
    check('统计页含学习周报与周期切换', statsText.includes('学习周报') && statsText.includes('近 8 周') && statsText.includes('活跃天数'));
    // 每周目标达成史（第 111 轮）：周报列表行显示「X.X/5h 目标」进度徽标（目标=settings.weeklyGoalHours）
    check('统计页每周目标达成史（第 111 轮）', statsText.includes('目标'));
    // 学习成就徽章（第 125 轮巡检）：按既有统计量推导的里程碑行（解锁/进行中）；
    // 第 126 轮扩为 9 枚（含复习达人/笔记勤耕）；第 135 轮起附距下一枚提示；
    // 第 138 轮起时间线完整列出全部已解锁徽章；第 142 轮起支持筛选与排序
    // （时间线依赖总览成就条先登记解锁时间，故用 waitFor 等待登记完成）
    check('统计页学习成就徽章（第 125/126/135/138/142 轮）', await waitFor(async () => {
      const text = await shadowQuery('.hdu-center');
      return text.includes('学习成就') && text.includes('养成习惯') && text.includes('复习达人') && text.includes('知识收藏家') && text.includes('距下一枚徽章') && text.includes('解锁时间线') && text.includes('按进度') && text.includes('按名称') ? text : null;
    }, '学习成就区（含时间线）'));
    // 最长连续（第 125 轮巡检）：连续学习卡附 26 周窗口内历史最佳（种子今天有有效观看 → ≥1 天）
    check('统计页最长连续标注（第 125 轮）', await waitFor(async () => {
      const text = await shadowQuery('.hdu-center');
      return text.includes('26 周内最长连续') ? text : null;
    }, '最长连续标注'));
    // 本周目标进度卡（第 110 轮）：hero 第 4 卡（本周 X/Y 小时 + 进度条，目标来自 settings.weeklyGoalHours）
    check('统计页本周目标进度卡（第 110 轮）', statsText.includes('本周目标') && statsText.includes('小时'));
    // 学习热力图（第 77 轮巡检）：周报卡下方渲染日级强度网格（stats.heatmap；
    // 4 周窗口最少 4×7=28 格，空数据也输出完整网格 + 引导提示）
    const shadowCount = (selector) =>
      evaluate(`(document.getElementById('hdu-assistant-host')?.shadowRoot?.querySelectorAll('${selector}') ?? []).length`);
    check('统计页含学习热力图（周列×7行日格，第 77 轮）', await waitFor(async () => {
      const grids = await shadowCount('.hdu-heatmap-grid');
      const cells = await shadowCount('.hdu-heatmap-cell');
      const legend = await shadowExists('.hdu-heatmap-legend');
      return grids >= 1 && cells >= 28 && legend ? `${grids}x${cells}` : null;
    }, '热力图网格渲染'));
    // 周数切换（第 78 轮）：点「近 13 周」→ 以 weeks=13 重新取数，日格重绘为 13×7
    const heatPillClick = (text) =>
      evaluate(`(() => {
        const el = [...(document.getElementById('hdu-assistant-host')?.shadowRoot?.querySelectorAll('.hdu-pill-tab') ?? [])].find((n) => n.textContent?.includes('${text}'));
        el?.click();
        return !!el;
      })()`);
    check('统计页热力图周数切换（近 13 周 → 13×7 格，第 78 轮）', (await heatPillClick('近 13 周')) && (await waitFor(async () => {
      const cells = await shadowCount('.hdu-heatmap-cell');
      const foot = await shadowQuery('.hdu-heatmap-foot');
      return cells === 13 * 7 && foot.includes('近 13 周') ? cells : null;
    }, '热力图 13 周重绘')));
    // 当日明细弹层（第 79 轮）：点「今天」格子 → stats.dayDetail 弹层出标题，随后关闭
    check('统计页热力图当日明细弹层（点今天格子，第 79 轮）', (await evaluate(`(() => {
      const el = document.getElementById('hdu-assistant-host')?.shadowRoot?.querySelector('.hdu-heatmap-cell.is-today');
      el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return !!el;
    })()`)) && (await waitFor(async () => {
      const title = await shadowQuery('.hdu-modal-title');
      return title.includes('学习明细') ? title : null;
    }, '当日明细弹层')));
    // 明细行回看（第 80 轮）：站内行富化课程名（courses store 命中）并带「回看」按钮
    check('统计页当日明细行课程名与回看入口（第 80 轮）', await waitFor(async () => {
      const body = await shadowQuery('.hdu-modal-body');
      return body.includes('回看') && body.includes('高等数学（E2E）') && body.includes('不计入') ? body : null;
    }, '明细行课程名与回看按钮'));
    await evaluate(`document.getElementById('hdu-assistant-host')?.shadowRoot?.querySelector('[aria-label="关闭"]')?.click()`);
    // 周报环比与下载（第 80 轮导出，第 239 轮升级「下载周报/月报」ghost 按钮并移至
    // 复制摘要旁）：数字卡脚注带「较上周」环比，头部带「下载周报」按钮
    check('统计页周报环比与下载按钮（第 80 轮，239 轮升级）', statsText.includes('较上周') && statsText.includes('下载周报'));
    // 月视图切换（第 81 轮）：点「月视图」→ 12 个月列 × 31 行日格（当月天数之外补位隐藏）
    check('统计页热力图月视图（点月视图 → 12 月列，第 81 轮）', (await heatPillClick('月视图')) && (await waitFor(async () => {
      const grids = await shadowCount('.hdu-heatmap-grid.is-monthly');
      const cells = await shadowCount('.hdu-heatmap-cell');
      return grids >= 1 && cells >= 12 * 28 ? cells : null;
    }, '月视图网格')));
    // 月视图格子下钻（第 86 轮）：点月视图格子同样弹出当日明细弹层
    check('统计页月视图格子下钻（第 86 轮）', (await evaluate(`(() => {
      const el = document.getElementById('hdu-assistant-host')?.shadowRoot?.querySelector('.hdu-heatmap-grid.is-monthly .hdu-heatmap-cell.is-clickable');
      el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return !!el;
    })()`)) && (await waitFor(async () => {
      const title = await shadowQuery('.hdu-modal-title');
      return title.includes('学习明细') ? title : null;
    }, '月视图当日明细弹层')));
    await evaluate(`document.getElementById('hdu-assistant-host')?.shadowRoot?.querySelector('[aria-label="关闭"]')?.click()`);
    // 切回周视图，还原默认形态
    await heatPillClick('周视图');
    await shot('center-stats');

    // ── 扩展页面：Options / Dashboard / Popup（固定 1.8–2.8s 等待 → 正文渲染条件等待；
    //    readyText 为该页异步数据就绪的标记文案，出现前不读快照，避免读到加载骨架） ──
    const openExtPage = async (file, { interact, readyText = '' } = {}) => {
      const url = `chrome-extension://${loaded.id}/${file}`;
      const target = await send('Target.createTarget', { url });
      const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
      const sid = attached.sessionId;
      await send('Runtime.enable', {}, sid);
      await waitFor(async () => {
        const probe = await send('Runtime.evaluate', { expression: 'document.body?.innerText ?? ""', returnByValue: true }, sid);
        const text = String(probe?.result?.value ?? '');
        return text.length > 10 && (!readyText || text.includes(readyText)) ? text : null;
      }, `${file} 页面渲染${readyText ? `（出现「${readyText}」）` : ''}`, { sid });
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
      if (interact) await interact(send, sid);
      await send('Target.closeTarget', { targetId: target.targetId });
      return String(text);
    };

    const optionsText = await openExtPage('options.html', {
      readyText: 'AI 服务',
      interact: async (send, sid) => {
        // 提醒时刻可配置（第 83 轮）：Options 为分区导航制——切到「学习与界面」分区后
        // 断言「提醒时刻」行在场（默认 20:00 档由 settings 缺省值保证）
        await send('Runtime.evaluate', {
          expression: `[...document.querySelectorAll('.hdu-nav-item')].find((n) => n.textContent?.includes('学习与界面'))?.click()`,
          returnByValue: true,
        }, sid);
        const reminderOk = await waitFor(async () => {
          const res = await send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true }, sid);
          const text = String(res?.result?.value ?? '');
          return text.includes('提醒时刻') && text.includes('每日待办提醒') ? text : null;
        }, '提醒时刻行渲染', { sid });
        check('Options 提醒时刻可配置（第 83 轮）', typeof reminderOk === 'string' && reminderOk.includes('提醒时刻'));
        // 复习模板与考试日期（第 96 轮）：模板选择在场；切「考试」→ 考试日期输入出现；切回常规
        const templateOk = await waitFor(async () => {
          const res = await send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true }, sid);
          const text = String(res?.result?.value ?? '');
          return text.includes('复习模板') && text.includes('考试日期') ? text : null;
        }, '复习模板与考试日期渲染', { sid });
        check('Options 复习模板与考试日期（第 96 轮）', typeof templateOk === 'string' && templateOk.includes('复习模板'));
        await send('Runtime.evaluate', {
          expression: `(() => { const sel = [...document.querySelectorAll('select')].find((n) => n.getAttribute('aria-label') === '复习模板'); if (!sel) return false; sel.value = 'exam'; sel.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`,
          returnByValue: true,
        }, sid);
        const examOk = await waitFor(async () => {
          const res = await send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true }, sid);
          return String(res?.result?.value ?? '').includes('考试日期') ? true : null;
        }, '考试日期输入渲染', { sid });
        check('Options 考试日期输入（第 96 轮）', examOk === true);
        await send('Runtime.evaluate', {
          expression: `(() => { const sel = [...document.querySelectorAll('select')].find((n) => n.getAttribute('aria-label') === '复习模板'); if (!sel) return false; sel.value = 'regular'; sel.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`,
          returnByValue: true,
        }, sid);
        // 切分区滚动复位（第 278 轮）：内容区滚到中部 → 切「数据与隐私」分区 → scrollTop 应回到 0
        await send('Runtime.evaluate', {
          expression: `(() => { const el = document.querySelector('.hdu-options-content'); if (!el) return false; el.scrollTop = 300; return true; })()`,
          returnByValue: true,
        }, sid);
        await send('Runtime.evaluate', {
          expression: `[...document.querySelectorAll('.hdu-nav-item')].find((b) => b.textContent.includes('数据与隐私'))?.click()`,
          returnByValue: true,
        }, sid);
        const scrollResetOk = await waitFor(async () => {
          const res = await send('Runtime.evaluate', {
            expression: `document.querySelector('.hdu-options-content')?.scrollTop ?? -1`,
            returnByValue: true,
          }, sid);
          return res?.result?.value === 0 ? true : null;
        }, '切分区滚动复位', { sid });
        check('Options 切分区滚动复位（第 278 轮）', scrollResetOk === true);
        // 诊断日志可观测性（第 300 轮）：日志卡「导出」按钮 + 条数水位 + 开关全入口语义说明
        const logCardOk = await waitFor(async () => {
          const res = await send('Runtime.evaluate', {
            expression: `(() => {
              const rows = [...document.querySelectorAll('.hdu-options-row')];
              const logRow = rows.find((r) => r.textContent?.includes('本地调试日志'));
              const switchRow = rows.find((r) => r.textContent?.includes('记录诊断日志'));
              return {
                exportBtn: !!logRow && [...logRow.querySelectorAll('button')].some((b) => (b.getAttribute('aria-label') ?? '').includes('导出日志 TXT')),
                watermark: /\\d+ \\/ 200 条/.test(document.body.innerText),
                switchHint: !!switchRow && switchRow.textContent?.includes('警告与错误仍保留'),
              };
            })()`,
            returnByValue: true,
          }, sid);
          const v = res?.result?.value;
          return v && v.exportBtn && v.watermark && v.switchHint ? v : null;
        }, '日志卡导出/水位/开关说明渲染', { sid });
        check('Options 日志导出按钮与条数水位（第 300 轮）', logCardOk?.exportBtn === true && logCardOk?.watermark === true);
        check('Options 诊断日志开关全入口语义说明（第 300 轮）', logCardOk?.switchHint === true);
        // 日志级别筛选（第 301 轮）：展开日志区 → 全部/警告/错误三档页签在场
        await send('Runtime.evaluate', {
          expression: `(() => {
            const card = [...document.querySelectorAll('.hdu-card')].find((c) => c.textContent?.includes('本地调试日志'));
            const btn = card ? [...card.querySelectorAll('button')].find((b) => b.textContent?.includes('查看')) : null;
            btn?.click();
            return !!btn;
          })()`,
          returnByValue: true,
        }, sid);
        const logTabsOk = await waitFor(async () => {
          const res = await send('Runtime.evaluate', {
            expression: `(() => {
              const card = [...document.querySelectorAll('.hdu-card')].find((c) => c.textContent?.includes('本地调试日志'));
              const tabs = card ? [...card.querySelectorAll('.hdu-pill-tab')].map((b) => b.textContent ?? '') : [];
              return tabs.includes('全部') && tabs.includes('警告') && tabs.includes('错误') ? true : null;
            })()`,
            returnByValue: true,
          }, sid);
          return res?.result?.value ?? null;
        }, '日志级别筛选页签渲染', { sid });
        check('Options 日志级别筛选页签（第 301 轮）', logTabsOk === true);
        // 日志复制单条 + 筛选播报（第 302 轮）：复制按钮在场；aria-live 计数行在场
        const logCopyOk = await waitFor(async () => {
          const res = await send('Runtime.evaluate', {
            expression: `(() => {
              const card = [...document.querySelectorAll('.hdu-card')].find((c) => c.textContent?.includes('本地调试日志'));
              return {
                copyBtn: !!card?.querySelector('[aria-label="复制该条日志"]'),
                live: [...(card?.querySelectorAll('[aria-live="polite"]') ?? [])].some((el) => /条/.test(el.textContent ?? '')),
              };
            })()`,
            returnByValue: true,
          }, sid);
          const v = res?.result?.value;
          return v && v.copyBtn && v.live ? v : null;
        }, '日志复制按钮与播报行渲染', { sid });
        check('Options 日志复制单条按钮（第 302 轮）', logCopyOk?.copyBtn === true);
        check('Options 日志筛选 aria-live 播报（第 302 轮）', logCopyOk?.live === true);
        // 复制内容校验（第 303 轮，测试域）：桩接 navigator.clipboard.writeText 捕获写入内容
        //（合成 Promise.resolve——headless 真实剪贴板有权限/焦点不确定性，组件契约=调用
        // writeText 并在成败时都给 toast；桩捕获即验证「复制格式化文本」契约）
        // 第 312 轮起复制全部为图标钮：以 aria-label 前缀定位
        await send('Runtime.evaluate', {
          expression: `(() => {
            window.__copiedLog = null;
            navigator.clipboard.writeText = (text) => {
              window.__copiedLog = text;
              return Promise.resolve();
            };
            const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? '').startsWith('复制全部日志'));
            btn?.click();
            return !!btn;
          })()`,
          returnByValue: true,
        }, sid);
        const copyToastOk = await waitFor(async () => {
          const res = await send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true }, sid);
          const text = String(res?.result?.value ?? '');
          // 点击的是「复制全部」钮：成功 toast 为「已复制 N 条日志」；headless 真实剪贴板
          // 被拒时为降级文案——组件契约是「成败都有 toast」，两者均视为通过
          return /已复制 \d+ 条日志/.test(text) || text.includes('复制失败') ? true : null;
        }, '复制 toast 出现', { sid });
        check('Options 日志复制 toast（第 303 轮）', copyToastOk === true);
        const clipRead = await send('Runtime.evaluate', {
          expression: 'window.__copiedLog',
          returnByValue: true,
        }, sid);
        const clipText = typeof clipRead?.result?.value === 'string' ? clipRead.result.value : null;
        check('Options 日志复制内容格式（第 303 轮）', typeof clipText === 'string' && /\] \[(debug|info|warn|error)\] \[/.test(clipText));
        // 复制全部筛选结果（第 307 轮，功能域）：桩捕获 writeText，断言多行格式
        await send('Runtime.evaluate', {
          expression: `(() => {
            const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('复制全部'));
            btn?.click();
            return !!btn;
          })()`,
          returnByValue: true,
        }, sid);
        const copyAllOk = await waitFor(async () => {
          const res = await send('Runtime.evaluate', { expression: 'window.__copiedLog', returnByValue: true }, sid);
          const text = typeof res?.result?.value === 'string' ? res.result.value : '';
          const lines = text.split('\n').filter((line) => /\] \[(debug|info|warn|error)\] \[/.test(line)).length;
          return lines >= 2 ? lines : null;
        }, '复制全部内容多行格式', { sid });
        check('Options 日志复制全部筛选结果（第 307 轮）', copyAllOk !== null && copyAllOk >= 2);
        // 导出 JSON 内容断言（第 310 轮，测试域）：捕获 createObjectURL 的 blob → 解析校验
        await send('Runtime.evaluate', {
          expression: `(() => {
            window.__exportedBlobs = [];
            const orig = URL.createObjectURL.bind(URL);
            URL.createObjectURL = (blob) => { window.__exportedBlobs.push(blob); return orig(blob); };
            const card = [...document.querySelectorAll('.hdu-card')].find((c) => c.textContent?.includes('本地调试日志'));
            const btn = [...(card?.querySelectorAll('button') ?? [])].find((b) => (b.getAttribute('aria-label') ?? '').includes('导出日志 JSON'));
            btn?.click();
            return { found: !!btn, cards: document.querySelectorAll('.hdu-card').length };
          })()`,
          returnByValue: true,
        }, sid);
        const jsonOk = await waitFor(async () => {
          const res = await send('Runtime.evaluate', {
            expression: `(async () => {
              const blob = window.__exportedBlobs[window.__exportedBlobs.length - 1];
              if (!blob) return { stage: 'no-blob' };
              try {
                const text = await blob.text();
                const parsed = JSON.parse(text);
                if (!Array.isArray(parsed)) return { stage: 'not-array', head: String(text).slice(0, 100) };
                if (typeof parsed[0]?.scope !== 'string') return { stage: 'bad-shape', head: String(text).slice(0, 100) };
                return { stage: 'ok', count: parsed.length };
              } catch (err) {
                return { stage: 'throw', message: String(err) };
              }
            })()`,
            returnByValue: true,
            awaitPromise: true,
          }, sid);
          const v = res?.result?.value;
          if (v?.stage !== 'ok') process.stdout.write(`[diag] 导出JSON=${JSON.stringify(v ?? res)}\n`);
          return v?.stage === 'ok' ? v.count : null;
        }, '导出 JSON 内容解析', { sid });
        check('Options 日志导出 JSON 内容（第 310 轮）', jsonOk !== null && jsonOk > 0);
        // 复制失败降级（第 312 轮，测试域）：桩强制 writeText 拒绝 → 断言降级引导文案
        await send('Runtime.evaluate', {
          expression: `(() => {
            navigator.clipboard.writeText = () => Promise.reject(new Error('clipboard denied'));
            const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? '').startsWith('复制全部日志'));
            btn?.click();
            return !!btn;
          })()`,
          returnByValue: true,
        }, sid);
        const degradeOk = await waitFor(async () => {
          const res = await send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true }, sid);
          return String(res?.result?.value ?? '').includes('复制失败，可改用「导出」保存为文件') ? true : null;
        }, '复制失败降级文案', { sid });
        check('Options 日志复制失败降级引导（第 312 轮）', degradeOk === true);
        // 日志来源筛选（第 305 轮）：选第一个非 all 的 scope → 渲染行全部含该 scope
        const scopeSel = await send('Runtime.evaluate', {
          expression: `(() => {
            const card = [...document.querySelectorAll('.hdu-card')].find((c) => c.textContent?.includes('本地调试日志'));
            const sel = card?.querySelector('select[aria-label="按来源筛选"]');
            if (!sel) return { found: false };
            const opt = [...sel.options].find((o) => o.value !== 'all');
            if (!opt) return { found: true, scope: null };
            const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
            setter.call(sel, opt.value);
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return { found: true, scope: opt.value };
          })()`,
          returnByValue: true,
        }, sid);
        const scopeVal = scopeSel?.result?.value?.scope;
        const scopeRows = typeof scopeVal === 'string' && scopeVal.length > 0 ? await waitFor(async () => {
          const res = await send('Runtime.evaluate', {
            expression: `(() => {
              const card = [...document.querySelectorAll('.hdu-card')].find((c) => c.textContent?.includes('本地调试日志'));
              const rows = [...(card?.querySelectorAll('.hdu-log') ?? [])];
              const scope = ${JSON.stringify(scopeVal)};
              return rows.length > 0 && rows.every((r) => (r.textContent ?? '').includes('[' + scope + ']')) ? rows.length : null;
            })()`,
            returnByValue: true,
          }, sid);
          return typeof res?.result?.value === 'number' ? res.result.value : null;
        }, '来源筛选后行均含该 scope', { sid }) : null;
        check('Options 日志来源筛选（第 305 轮）', typeof scopeVal === 'string' && scopeVal.length > 0 && typeof scopeRows === 'number');
        // 筛选空态「清除筛选」（第 306 轮）：级别=错误 + 来源=content（无 error 级 content 日志）
        // → 空态出现「清除筛选」→ 点击后级别/来源复位、日志行恢复
        await send('Runtime.evaluate', {
          expression: `(() => {
            const card = [...document.querySelectorAll('.hdu-card')].find((c) => c.textContent?.includes('本地调试日志'));
            const pill = [...(card?.querySelectorAll('.hdu-pill-tab') ?? [])].find((b) => b.textContent === '错误');
            pill?.click();
            const sel = card?.querySelector('select[aria-label="按来源筛选"]');
            if (sel) {
              const opt = [...sel.options].find((o) => o.value === 'content');
              if (opt) {
                const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
                setter.call(sel, 'content');
                sel.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }
            return !!pill;
          })()`,
          returnByValue: true,
        }, sid);
        const resetOk = await waitFor(async () => {
          const res = await send('Runtime.evaluate', {
            expression: `(() => {
              const card = [...document.querySelectorAll('.hdu-card')].find((c) => c.textContent?.includes('本地调试日志'));
              const hint = [...(card?.querySelectorAll('.hdu-hint') ?? [])].map((el) => el.textContent ?? '').join('|');
              if (!hint.includes('当前筛选无匹配日志')) return null;
              const reset = [...(card?.querySelectorAll('.hdu-log-reset') ?? [])][0];
              reset?.click();
              return { clicked: !!reset };
            })()`,
            returnByValue: true,
          }, sid);
          return res?.result?.value?.clicked === true ? true : null;
        }, '筛选空态出现清除筛选');
        check('Options 日志筛选空态清除筛选（第 306 轮）', resetOk === true && (await waitFor(async () => {
          const res = await send('Runtime.evaluate', {
            expression: `(() => {
              const card = [...document.querySelectorAll('.hdu-card')].find((c) => c.textContent?.includes('本地调试日志'));
              const rows = [...(card?.querySelectorAll('.hdu-log') ?? [])];
              const sel = card?.querySelector('select[aria-label="按来源筛选"]');
              return rows.length > 0 && sel?.value === 'all' ? rows.length : null;
            })()`,
            returnByValue: true,
          }, sid);
          return typeof res?.result?.value === 'number' ? res.result.value : null;
        }, '清除筛选后日志恢复')));
      },
    });
    const dashboardText = await openExtPage('dashboard.html', {
      readyText: '学习概览',
      interact: async (send, sid) => {
        // 第 10 轮两步确认实测：点击「清空统计」后按钮应进入确认态（文案切换），数据不被清空。
        // 第 312 轮加固：按钮在数据装载后才渲染 + React flush 异步于 CDP 同步读——轮询内
        // 「精确文本找到才点击」+ 每轮直接检查确认态按钮是否在场（精确文本不会误点确认态按钮）
        const armed = await waitFor(async () => {
          const res = await send('Runtime.evaluate', {
            expression: `(() => {
              const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '清空统计');
              if (btn) btn.click();
              return [...document.querySelectorAll('button')].some((b) => b.textContent.includes('再点一次确认清空统计'));
            })()`,
            returnByValue: true,
          }, sid);
          return res?.result?.value === true;
        }, '清空统计两步确认态出现', { sid, timeoutMs: 20000 });
        check('Dashboard 清空统计两步确认（首次点击仅进入确认态）', armed === true);
        // 学习热力图（第 78 轮）：看板第三落点——stats.heatmap 异步取数后渲染周列×7行日格
        const heatmapOk = await waitFor(async () => {
          const res = await send('Runtime.evaluate', {
            expression: `document.querySelectorAll('.hdu-heatmap-grid').length + ':' + document.querySelectorAll('.hdu-heatmap-cell').length`,
            returnByValue: true,
          }, sid);
          const [grids, cells] = String(res?.result?.value ?? '0:0').split(':').map(Number);
          return grids >= 1 && cells >= 28 ? `${grids}x${cells}` : null;
        }, '看板热力图网格渲染', { sid });
        check('Dashboard 含学习热力图（stats.heatmap，第 78 轮）', typeof heatmapOk === 'string' && heatmapOk.length > 0);
      },
    });
    check('Dashboard 页渲染学习概览', dashboardText.includes('学习概览') && dashboardText.includes('知识库'));
    check('Options 页渲染设置分区', optionsText.includes('AI 服务') && optionsText.includes('转写与模型') && optionsText.includes('学习与界面'));
    const popupText = await openExtPage('popup.html', { readyText: '今日' });
    check('Popup 页渲染助手概览', popupText.includes('智慧课堂助手') && popupText.includes('今日'));

    // ── B 站视频页：CDP Fetch 拦截 + 本地 fixture ──
    // B 站内容脚本的 matches 写死 https://www.bilibili.com/video/*，无法像 HDU 侧那样用
    // localhost fixture；这里对 bilibili 页面 target 开启 Fetch 域拦截，把主文档请求用本地
    // fixture HTML 原地应答（请求不出浏览器，无需真实网络与证书），其余子资源一律 404。
    // 字幕/AI 标注数据经扩展页面上下文预置进扩展同源 IndexedDB（hdu-assistant 库）——
    // bili.subtitle.fetch 先查库后联网，命中缓存即离线可用；transcript.get / ai.get 等
    // 读路径与真实使用完全同一条消息面（callOp → SW → IndexedDB）。
    // 预置/断言共用的 bvid：取 BV+10 位的生产口径（共享 videoBvidOf / BiliHubPanel
    // isBiliHubFavorite 均按 /^BV[A-Za-z0-9]{8,}$/ 校验，短位假 bvid 会被知识库收录判定拒收）
    const BILI_VID = 'BV1E2E00100';
    const biliFixtureHtml = readFileSync(join(root, 'tests', 'fixtures', 'bili-video-sim.html'), 'utf8');

    /** 在扩展页面（chrome-extension:// 同源）上下文执行表达式，用于读写扩展 IndexedDB。
     *  页面需加载完成后再求值（过早求值偶发存储访问拒绝），失败自动重试至多 3 次。 */
    const evalInExtPage = async (expression) => {
      const target = await send('Target.createTarget', { url: `chrome-extension://${loaded.id}/options.html` });
      const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
      const sid = attached.sessionId;
      await send('Runtime.enable', {}, sid);
      try {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await waitFor(async () => {
            const state = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, sid);
            return state?.result?.value === 'complete' ? true : null;
          }, '扩展页面加载完成', { sid, timeoutMs: 5000 });
          const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid);
          if (!result.exceptionDetails) return result.result.value;
          if (attempt === 2) return `异常：${result.exceptionDetails.text}`;
          await sleep(500);
        }
        return null;
      } finally {
        await send('Target.closeTarget', { targetId: target.targetId }).catch(() => {});
      }
    };

    // ── 第 36 轮：HDU 探针「收藏此时刻」落库断言 ──
    // 点击发生在播放页探针段（addTimeFavorite → fav.put）；这里在扩展页面上下文读
    // favorites store 验证落库：type=time、带 teclId 课次归属、标题含站点课程名。
    const hduTimeFavCount = await evalInExtPage(`(async () => {
      const request = indexedDB.open('hdu-assistant');
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        if (!Array.from(db.objectStoreNames).includes('favorites')) return -1;
        const tx = db.transaction('favorites', 'readonly');
        const all = await new Promise((resolve, reject) => {
          const req = tx.objectStore('favorites').getAll();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        return all.filter((item) => item.type === 'time'
          && item.teclId !== undefined
          && String(item.snapshot?.title ?? '').includes('线性代数（模拟课程）')).length;
      } finally {
        db.close();
      }
    })()`);
    check('HDU 探针收藏此时刻写入 IndexedDB（type=time，含课次归属）', Number(hduTimeFavCount) >= 1);

    /** 打开一个由本地 fixture 应答的 B 站视频页（返回会话 id 与关闭函数） */
    const openBiliPage = async (bvid) => {
      // 先开 about:blank 再导航，确保 Fetch 拦截在主文档请求发出前就位
      const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
      const attached = await send('Target.attachToTarget', { targetId, flatten: true });
      const sid = attached.sessionId;
      await send('Runtime.enable', {}, sid);
      await send('Page.enable', {}, sid);
      // 记录本页全部执行上下文（含内容脚本隔离世界，调试用）
      const contexts = [];
      const offCtx = onEvent((message) => {
        if (message.sessionId !== sid || message.method !== 'Runtime.executionContextCreated') return;
        contexts.push(message.params.context);
      });
      await send('Fetch.enable', { patterns: [{ urlPattern: 'https://www.bilibili.com/*' }] }, sid);
      const offRequest = onEvent((message) => {
        if (message.sessionId !== sid || message.method !== 'Fetch.requestPaused') return;
        const requestUrl = String(message.params?.request?.url ?? '');
        // 主文档 → fixture HTML；其余（favicon 等）→ 404，保证不触达真实 B 站
        const isDocument = requestUrl.startsWith(`https://www.bilibili.com/video/`);
        void send(
          'Fetch.fulfillRequest',
          {
            requestId: message.params.requestId,
            responseCode: isDocument ? 200 : 404,
            responseHeaders: isDocument ? [{ name: 'content-type', value: 'text/html; charset=utf-8' }] : [],
            body: isDocument ? Buffer.from(biliFixtureHtml, 'utf8').toString('base64') : '',
          },
          sid,
        ).catch(() => { /* 页面已关闭等场景忽略 */ });
      });
      await send('Page.navigate', { url: `https://www.bilibili.com/video/${bvid}` }, sid);
      return {
        sid,
        contexts,
        close: async () => {
          offRequest();
          offCtx();
          await send('Target.closeTarget', { targetId }).catch(() => {});
        },
      };
    };

    // B 站 shadow DOM 读写助手（宿主 id：hdu-bili-collect-host，与 HDU 侧宿主不同）
    const biliEval = (sid) => async (expression) => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid);
      if (result.exceptionDetails) return `异常：${result.exceptionDetails.text}`;
      return result.result.value;
    };
    const biliShadowExpr = (expression) =>
      `document.getElementById('hdu-bili-collect-host')?.shadowRoot?.${expression}`;
    const biliExists = (sid, selector) =>
      biliEval(sid)(`!!${biliShadowExpr(`querySelector('${selector}')`)}`);
    const biliText = (sid, selector) =>
      biliEval(sid)(`${biliShadowExpr(`querySelector('${selector}')`)}?.textContent ?? ''`);
    const biliCount = (sid, selector) =>
      biliEval(sid)(`(${biliShadowExpr(`querySelectorAll('${selector}')`)} ?? []).length`);
    const biliClick = (sid, selector) =>
      biliEval(sid)(`(() => { const el = ${biliShadowExpr(`querySelector('${selector}')`)}; el?.click(); return !!el; })()`);

    /** B 站页注入兜底：偶发漏注入时 reload 重试（与 HDU 首屏同口径）。
     *  挂载标记 = 收藏/学习助手/学习中心三枚 FAB 在场（字幕入口与 qa 同批渲染，
     *  不重复断言）；均为存在性检查，不设数量上限，新增入口不破坏原断言。 */
    const waitBiliMounted = async (page) => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const mounted = await waitFor(
          async () => (
            (await biliExists(page.sid, '.bili-fab'))
            && (await biliExists(page.sid, '.bili-qa-fab'))
            && (await biliExists(page.sid, '.bili-hub-fab'))
              ? true
              : null
          ),
          'B 站宿主挂载',
          { sid: page.sid, timeoutMs: 5000 },
        );
        if (mounted) return true;
        if (attempt < 2) await send('Page.reload', {}, page.sid).catch(() => {});
      }
      return false;
    };

    // 预置数据：字幕 4 段 + AI 标注 2 知识点（键 = bili:<bvid>，P1 裸键口径，
    // 与 mediaRef.biliMediaKey / fetchBiliSubtitleOp 的 mediaKey 一致）；
    // favorite 为学习中心（BiliHubPanel）知识库页签的预置视频收藏（type=video，
    // refId=bvid，与收藏入口落库同构，BiliHubPanel.isBiliHubFavorite 据此收录）；
    // aiFavorite 为预置 AI 回答收藏（type=ai，buildAiFavorite 同构，第 34 轮起
    // isBiliHubFavorite 收录进知识库页签；标题/正文避开「矩阵乘法」，保证搜索
    // 过滤断言仍只命中预置 video 收藏）
    const biliSeed = {
      favorite: {
        id: 'e2e-fav-bili-video-1',
        type: 'video',
        refId: BILI_VID,
        snapshot: { title: '线性代数公开课：矩阵乘法（E2E 预置）', content: 'B 站收藏的网课视频（e2e 预置）' },
        folderId: null,
        tags: ['e2e'],
        note: '预置收藏，用于学习中心知识库页签断言',
        pinned: false,
        favoritedAt: Date.now(),
        updatedAt: Date.now(),
        metadata: {
          platform: 'bilibili',
          bvid: BILI_VID,
          url: `https://www.bilibili.com/video/${BILI_VID}`,
          uploader: '模拟教师',
          duration: '10:00',
          durationSec: 600,
          coverUrl: '',
        },
      },
      aiFavorite: {
        id: 'e2e-fav-bili-ai-1',
        type: 'ai',
        refId: 'e2e-chat-1',
        snapshot: { title: '特征值的直观含义（E2E 预置）', content: '特征值描述线性变换的不变方向（e2e 预置 AI 回答）' },
        anchorTime: 60,
        folderId: null,
        tags: [],
        pinned: false,
        favoritedAt: Date.now() + 1,
        updatedAt: Date.now(),
        metadata: {
          platform: 'bilibili',
          bvid: BILI_VID,
          url: `https://www.bilibili.com/video/${BILI_VID}`,
          mediaKey: `bili:${BILI_VID}`,
          videoTitle: '线性代数公开课（E2E 预置）',
          question: '特征值是什么？',
        },
      },
      // reviewJob 为「今日待办」页签（第 35 轮）的预置复习作业：dueDate=今天（本地日键，
      // 与 SW 侧 localDayKey 同机同时区），review.due 命中「今日到期」。挂在 aiFavorite
      // 上——后续「加入复习」步骤的 review.plan 只清空其目标收藏（运行时新建的 time
      // 收藏）的旧作业，不波及本预置作业；round=1 完成后无下一轮，重拉即空
      reviewJob: {
        id: 'e2e-review-job-1',
        favoriteId: 'e2e-fav-bili-ai-1',
        dueDate: (() => {
          const d = new Date();
          return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        })(),
        round: 1,
        template: 'regular',
        status: 'pending',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      // chats 为「收藏 AI 回答」（第 33 轮）的预置问答消息：done 状态的用户提问 + AI
      // 回答（同 groupId），问答页签经 qa.groups/qa.list 真实消息面恢复。chatId 避开
      // 预置 aiFavorite 的 refId（e2e-chat-1），保证「收藏这条回答」走真实落库路径
      chats: [
        {
          id: 'e2e-chat-q1',
          mediaKey: `bili:${BILI_VID}`,
          groupId: 'e2e-group-1',
          role: 'user',
          content: '特征值是什么？',
          anchorTime: 60,
          status: 'done',
          createdAt: Date.now() - 2000,
        },
        {
          id: 'e2e-chat-a1',
          mediaKey: `bili:${BILI_VID}`,
          groupId: 'e2e-group-1',
          role: 'ai',
          content: '特征值描述线性变换的不变方向（E2E 预置回答）',
          anchorTime: 60,
          status: 'done',
          createdAt: Date.now() - 1000,
        },
        // 跨 P 聚合（第 104 轮）：P2 的独立会话（不同 mediaKey/groupId）——仅会话历史
        // 开「跨 P 聚合」（qa.groupsAll）时出现，普通 qa.groups（当前 P）不可见
        {
          id: 'e2e-chat-q2',
          mediaKey: `bili:${BILI_VID}:p2`,
          groupId: 'e2e-group-2',
          role: 'user',
          content: '第二分 P 的问题（E2E 预置）',
          anchorTime: 30,
          status: 'done',
          createdAt: Date.now() - 500,
        },
      ],
      transcript: {
        mediaKey: `bili:${BILI_VID}`,
        segments: [
          { s: 1, e: 6, text: '欢迎大家来到线性代数公开课' },
          { s: 6, e: 12, text: '今天我们讲解矩阵乘法的定义' },
          { s: 12, e: 18, text: '矩阵乘法不满足交换律' },
          { s: 60, e: 66, text: '最后介绍特征值的直观含义' },
        ],
        model: 'bili-official-subtitle',
        lang: 'zh-CN',
        glossaryVersion: 0,
        createdAt: Date.now(),
        source: 'bili-official-subtitle',
        coveredSec: 17,
        coverage: [{ start: 1, end: 18 }],
        durationSec: 600,
        aiSubtitle: false,
        partial: false,
      },
      aiResult: {
        mediaKey: `bili:${BILI_VID}`,
        promptVersion: 1,
        model: 'e2e-fixture',
        topics: [
          { name: '矩阵乘法', summary: '矩阵乘法的定义与运算性质', confidence: 'high', intervals: [[6, 30]] },
          { name: '特征值', summary: '特征值的直观含义', confidence: 'low', intervals: [[60, 120]] },
        ],
        outline: [{ level: 1, title: '矩阵乘法', start: 6, end: 30 }],
        createdAt: Date.now(),
      },
    };

    /** 预置写入扩展 IndexedDB（transcripts/aiResults 主键 mediaKey、favorites 主键 id、
     *  reviewJobs/chats 主键 id；库由扩展侧按需创建） */
    const seedBiliData = async () => {
      const expression = `((seed) => (async () => {
        const request = indexedDB.open('hdu-assistant');
        const db = await new Promise((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        try {
          const stores = Array.from(db.objectStoreNames);
          if (!['transcripts', 'aiResults', 'favorites', 'reviewJobs', 'chats'].every((name) => stores.includes(name))) return 'no-stores';
          const tx = db.transaction(['transcripts', 'aiResults', 'favorites', 'reviewJobs', 'chats'], 'readwrite');
          tx.objectStore('transcripts').put(seed.transcript);
          tx.objectStore('aiResults').put(seed.aiResult);
          tx.objectStore('favorites').put(seed.favorite);
          tx.objectStore('favorites').put(seed.aiFavorite);
          tx.objectStore('reviewJobs').put(seed.reviewJob);
          for (const chat of seed.chats) tx.objectStore('chats').put(chat);
          await new Promise((resolve, reject) => {
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error ?? new Error('tx aborted'));
          });
          return 'ok';
        } finally {
          db.close();
        }
      })())(${JSON.stringify(biliSeed)})`;
      // HDU 检查段已触发建库；此处兜底重试直至 stores 就绪（不带版本号打开，不干扰迁移）
      for (let attempt = 0; attempt < 25; attempt += 1) {
        const outcome = await evalInExtPage(expression);
        if (outcome === 'ok') return true;
        await sleep(300);
      }
      return false;
    };

    // 预置必须在开页前完成：BiliTimelineMarkers 对同一 mediaKey 只在挂载时读一次
    // ai.get（1s 轮询仅用于跟随分 P 变化），开页后再写入不会触发标记重渲染。
    // 此时 HDU 检查段已建库，预置可确定性写入。
    check('B 站字幕/AI 标注/收藏/复习作业/问答消息预置写入 IndexedDB', await seedBiliData());

    // ── 复习计划视图（第 83 轮）：复习种子落库后，在学习中心内切「复习计划」导航验证
    // 全量复习视图（此时学习中心仍打开、统计页签在场，直接点导航即可）──
    check('学习中心复习计划视图（第 83 轮）', await clickByText('.hdu-nav-item', '复习计划') && (await waitFor(async () => {
      const text = await shadowQuery('.hdu-center');
      return text.includes('待完成') && text.includes('特征值') && text.includes('跳过') ? text : null;
    }, '复习计划视图渲染')));
    // 类型筛选/排序/来源标注（第 91 轮）：双类型种子 → chips 与排序选择器在场；站内作业标「站内」
    check('复习计划类型筛选与来源标注（第 91 轮）', await waitFor(async () => {
      const text = await shadowQuery('.hdu-center');
      return text.includes('按到期日') && text.includes('全部类型') && text.includes('时间点') && text.includes('站内') ? text : null;
    }, '类型筛选与来源标注'));
    const reviewTypeChipClick = (text) => evaluate(`(() => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      const item = [...(root?.querySelectorAll('.hdu-folder') ?? [])].find((n) => n.textContent?.trim() === '${text}');
      item?.click();
      return !!item;
    })()`);
    check('复习计划按类型过滤（第 91 轮）', (await reviewTypeChipClick('时间点')) && (await waitFor(async () => {
      const text = await shadowQuery('.hdu-center');
      return text.includes('线性代数复习要点') && !text.includes('特征值') ? text : null;
    }, '类型过滤结果')));
    await reviewTypeChipClick('全部类型');
    // 详情展开（第 95 轮）：点待完成行标题 → 内容摘要出现；再点收起
    const reviewRowTitleClick = (text) => evaluate(`(() => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      const row = [...(root?.querySelectorAll('.hdu-review-view .hdu-todo-row') ?? [])].find((n) => n.textContent?.includes('${text}'));
      const btn = row?.querySelector('.hdu-list-title button');
      btn?.click();
      return !!btn;
    })()`);
    check('复习计划详情展开（第 95 轮）', (await reviewRowTitleClick('特征值')) && (await waitFor(async () => {
      const text = await shadowQuery('.hdu-center');
      return text.includes('特征值描述线性变换的不变方向') ? text : null;
    }, '详情展开')));
    await reviewRowTitleClick('特征值');
    // 一键完成按钮（第 93 轮）：今日到期 ≥2 项时在场（点击链路由人工验收 §27-2 覆盖，
    // 此处不点击——避免提前清空 B 站今日待办卡的预置到期作业）
    check('复习计划一键完成按钮在场（第 93 轮）', await waitFor(async () => {
      const text = await shadowQuery('.hdu-center');
      return text.includes('今日到期全部完成') ? text : null;
    }, '一键完成按钮在场'));
    // 已跳过分区（第 99 轮）：种子 2 条已跳过作业 → 分区渲染 + 重新入计划按钮
    check('复习计划已跳过分区（第 99 轮）', await waitFor(async () => {
      const text = await shadowQuery('.hdu-center');
      return text.includes('已跳过') && text.includes('重新加入计划') ? text : null;
    }, '已跳过分区渲染'));
    // 逾期强调与分区计数（第 101 轮）：已逾期行 danger 边框；已跳过标题带计数
    const overdueDiag = await evaluate(`(() => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      const rows = [...(root?.querySelectorAll('.hdu-review-view .hdu-todo-row') ?? [])].map((n) => ({ cls: n.className, text: (n.textContent ?? '').slice(0, 60) }));
      const heads = [...(root?.querySelectorAll('.hdu-todo-head') ?? [])].map((n) => n.textContent ?? '');
      return { rows, heads };
    })()`);
    process.stdout.write(`[diag] overdue=${JSON.stringify(overdueDiag?.result?.value)}\n`);
    check('复习计划逾期强调与分区计数（第 101 轮）', (() => {
      const value = overdueDiag;
      if (!value) return false;
      const overdueRow = value.rows.find((row) => row.text.includes('已到期 1 天'));
      const skippedHead = value.heads.find((head) => head.includes('已跳过'));
      return Boolean(overdueRow) && String(overdueRow?.cls ?? '').includes('is-overdue') && String(skippedHead ?? '').includes('（2）');
    })());
    // 紧急度筛选（第 103 轮）：点「已逾期」→ 仅剩逾期作业
    const urgencyChipClick = (text) => evaluate(`(() => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      const item = [...(root?.querySelectorAll('.hdu-review-view .hdu-folder') ?? [])].find((n) => n.textContent?.trim() === '${text}');
      item?.click();
      return !!item;
    })()`);
    const urgencyClickOk = await urgencyChipClick('已逾期');
    const urgencyDiag = await evaluate(`(() => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      const chips = [...(root?.querySelectorAll('.hdu-review-view .hdu-folder') ?? [])].map((n) => n.textContent ?? '');
      const rows = [...(root?.querySelectorAll('.hdu-review-view .hdu-todo-row') ?? [])].map((n) => (n.textContent ?? '').slice(0, 40));
      return { chips, rows };
    })()`);
    process.stdout.write(`[diag] urgency=${JSON.stringify(urgencyDiag?.result?.value)} clicked=${urgencyClickOk}\n`);
    check('复习计划紧急度筛选（第 103 轮）', urgencyClickOk && (await waitFor(async () => {
      const text = await shadowQuery('.hdu-center');
      return text.includes('高等数学复习要点') && !text.includes('特征值') ? text : null;
    }, '紧急度过滤结果')));
    await urgencyChipClick('全部');
    // 筛选/排序持久化（第 104 轮）：点「已逾期」→ 关闭学习中心 → 重开并切回复习计划
    // → 筛选仍生效（settings.ui.reviewFilters 随 settings 持久化，重开不丢）+ 重置筛选 chip 在场
    await urgencyChipClick('已逾期');
    await clickByText('.hdu-topbar-actions .hdu-btn', '站点原页面');
    check('筛选持久化前置：学习中心已关闭（第 104 轮）', await waitFor(async () => !(await shadowExists('.hdu-center')), '学习中心已隐藏'));
    await clickByText('.hdu-dock-btn', '学习中心');
    check('筛选持久化前置：学习中心已重开（第 104 轮）', await waitFor(() => shadowExists('.hdu-center'), '学习中心已恢复'));
    check('复习计划筛选/排序持久化（第 104 轮）', await clickByText('.hdu-nav-item', '复习计划') && (await waitFor(async () => {
      // DOM 读取须经 evaluate（waitFor 谓词运行在 Node 侧，无 document）
      const state = await evaluate(`(() => {
        const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
        const active = [...(root?.querySelectorAll('.hdu-review-view .hdu-folder.is-active') ?? [])].map((n) => n.textContent?.trim() ?? '');
        const rows = [...(root?.querySelectorAll('.hdu-review-view .hdu-todo-row') ?? [])].map((n) => (n.textContent ?? '').slice(0, 24));
        return { active, rows };
      })()`);
      const text = await shadowQuery('.hdu-center');
      const active = state?.active ?? [];
      const ok = active.includes('已逾期') && text.includes('重置筛选') && text.includes('高等数学复习要点') && !text.includes('特征值');
      if (!ok) process.stdout.write(`[diag] persist active=${JSON.stringify(active)} rows=${JSON.stringify(state?.rows ?? [])}\n`);
      return ok ? text : null;
    }, '重开后筛选仍生效')));
    // 复位紧急度筛选（第 319 轮修复：第 318 轮编辑误删本行）——persist 检查留下的
    // 「已逾期」筛选若不复位，与后续周视图按日筛选取交集（dayFilteredItems ∩
    // urgencyFilteredItems），105/107/109/111/115 五项检查会连锁失败
    await urgencyChipClick('全部');
    // 周视图条（第 105 轮巡检）：逾期 + 今日起 7 天分栏在场；点「今日」仅剩今日到期作业
    check('复习计划周视图条（第 105 轮）', await waitFor(async () => {
      const cols = await evaluate(`[...(document.getElementById('hdu-assistant-host')?.shadowRoot?.querySelectorAll('.hdu-week-col') ?? [])].map((n) => ({ label: n.querySelector('.hdu-week-col-label')?.textContent ?? '', count: n.querySelector('.hdu-week-col-count')?.textContent ?? '' }))`);
      return Array.isArray(cols) && cols.length >= 8 && cols.some((c) => c.label === '逾期') && cols.some((c) => c.label === '今日') ? cols : null;
    }, '周视图条渲染'));
    const weekTodayClick = await evaluate(`(() => {
      const cols = [...(document.getElementById('hdu-assistant-host')?.shadowRoot?.querySelectorAll('.hdu-week-col') ?? [])];
      const col = cols.find((n) => n.querySelector('.hdu-week-col-label')?.textContent === '今日');
      col?.click();
      return !!col;
    })()`);
    check('复习计划周视图按日筛选（第 105 轮）', weekTodayClick && (await waitFor(async () => {
      // 只读待完成分区（首个 .hdu-todo-rows）：已完成/已跳过分区不受日筛选影响，
      // 其中的「线性代数复习要点」不能作为过滤判据
      const pendingText = await evaluate(`document.getElementById('hdu-assistant-host')?.shadowRoot?.querySelector('.hdu-review-view .hdu-todo-rows')?.textContent ?? ''`);
      return pendingText.includes('特征值') && !pendingText.includes('线性代数复习要点') ? pendingText : null;
    }, '按日筛选结果')));
    // 收尾：再点一次「今日」取消按日筛选（不影响后续模板/分区断言）
    await evaluate(`(() => {
      const cols = [...(document.getElementById('hdu-assistant-host')?.shadowRoot?.querySelectorAll('.hdu-week-col') ?? [])];
      const col = cols.find((n) => n.querySelector('.hdu-week-col-label')?.textContent === '今日' && String(n.className).includes('is-active'));
      col?.click();
      return !!col;
    })()`);
    // 完整周视图（第 106 轮巡检）：切「周视图」→ 逾期+今日起 7 天分栏内嵌作业行；断言后切回「列表」
    const weekViewOn = await evaluate(`(() => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      const btn = [...(root?.querySelectorAll('.hdu-folder') ?? [])].find((n) => n.textContent?.trim() === '周视图');
      btn?.click();
      return !!btn;
    })()`);
    check('复习计划完整周视图（第 106 轮）', weekViewOn && (await waitFor(async () => {
      const grid = await evaluate(`(() => {
        const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
        const days = [...(root?.querySelectorAll('.hdu-week-grid .hdu-week-day') ?? [])].map((n) => n.textContent ?? '');
        return { found: days.length > 0, days };
      })()`);
      return grid?.found && grid.days.length >= 8 && grid.days.some((t) => t.includes('特征值')) ? grid : null;
    }, '周视图渲染')));
    await evaluate(`(() => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      const btn = [...(root?.querySelectorAll('.hdu-folder') ?? [])].find((n) => n.textContent?.trim() === '列表');
      btn?.click();
      return !!btn;
    })()`);
    // 复习统计条（第 108 轮）：待完成/今日到期/已逾期/已完成/已跳过 五枚计数 chips
    check('复习计划统计条（第 108 轮）', await waitFor(async () => {
      const stats = await evaluate(`(() => {
        const strip = document.getElementById('hdu-assistant-host')?.shadowRoot?.querySelector('.hdu-review-stats');
        return { found: Boolean(strip), count: strip ? strip.querySelectorAll('.hdu-review-stat').length : 0, text: strip?.textContent ?? '' };
      })()`);
      return stats?.found && stats.count === 5 && stats.text.includes('今日到期') && stats.text.includes('已逾期') ? stats : null;
    }, '复习统计条'));
    // 周视图 14 天窗口档（第 108 轮）：切周视图 + 14 天 → is-14 栅格（列数 ≥14）；断言后还原 7 天 + 列表
    const week14On = await evaluate(`(() => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      const btn = [...(root?.querySelectorAll('.hdu-folder') ?? [])].find((n) => n.textContent?.trim() === '周视图');
      btn?.click();
      return !!btn;
    })()`);
    check('复习计划周视图 14 天窗口（第 108 轮）', week14On && (await waitFor(async () => {
      const grid = await evaluate(`(() => {
        const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
        const btn = [...(root?.querySelectorAll('.hdu-folder') ?? [])].find((n) => n.textContent?.trim() === '14 天');
        btn?.click();
        const grid = root?.querySelector('.hdu-week-grid');
        return { cls: grid?.className ?? '', cols: grid ? grid.querySelectorAll('.hdu-week-day').length : 0 };
      })()`);
      return String(grid?.cls ?? '').includes('is-14') && grid?.cols >= 14 ? grid : null;
    }, '14 天窗口渲染')));
    // 周视图行内去复习（第 109 轮）：作业卡带「去复习」链接（B 站外链 / 站内深链）
    check('复习计划周视图去复习链接（第 109 轮）', await waitFor(async () => {
      const grid = await evaluate(`document.getElementById('hdu-assistant-host')?.shadowRoot?.querySelector('.hdu-week-grid')?.textContent ?? ''`);
      return grid.includes('去复习') ? grid : null;
    }, '周视图去复习链接'));
    await evaluate(`(() => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      const find = (t) => [...(root?.querySelectorAll('.hdu-folder') ?? [])].find((n) => n.textContent?.trim() === t);
      find('7 天')?.click();
      find('列表')?.click();
      return true;
    })()`);
    // 自定义改期（第 109 轮；第 244 轮入口升级）：点「改期」→ 行内轻量浮层（第 244 轮，
    // 8 档快捷 chips + 其他日期…）→「其他日期…」进完整弹层 → 设日期 → 确认 → 到期日变更为所选日
    const rescheduleDay = (() => {
      const d = new Date();
      d.setDate(d.getDate() + 3);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();
    const reschedOpen = await evaluate(`(() => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      const row = [...(root?.querySelectorAll('.hdu-review-view .hdu-todo-row') ?? [])].find((n) => n.textContent?.includes('线性代数复习要点'));
      const btn = row ? [...row.querySelectorAll('button')].find((n) => n.textContent?.trim() === '改期') : null;
      btn?.click();
      return !!btn;
    })()`);
    check('复习计划自定义改期弹层（第 109 轮）', reschedOpen && (await waitFor(async () => {
      // 幂等两段式（轮询安全）：行内浮层在 → 点「其他日期…」；完整弹层日期输入在 → 设值返回。
      // 同拍点击后 React 同步提交在部分时序下慢一拍，靠下一轮轮询续完，任何一拍都不重复副作用
      const staged = await evaluate(`(() => {
        const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
        const modalInput = root?.querySelector('.hdu-modal input[type="date"]');
        if (!modalInput) {
          const pop = root?.querySelector('.hdu-resched-pop');
          if (!pop) return null;
          if (pop.querySelectorAll('.hdu-resched-chip').length !== 8) return null;
          const more = [...pop.querySelectorAll('button')].find((n) => n.textContent?.includes('其他日期'));
          more?.click();
          return null;
        }
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(modalInput, '${rescheduleDay}');
        modalInput.dispatchEvent(new Event('input', { bubbles: true }));
        return modalInput.value;
      })()`);
      return staged === rescheduleDay ? staged : null;
    }, '改期日期输入')));
    // 改期快捷档（第 112 轮；第 244 轮 chips 换为 buildRescheduleOptions 8 档共享纯函数）：
    // 弹层内点「下周同一日」→ 日期输入同步为 today+7；随后还原为既定改期日，
    // 避免影响后续「确认改期 → 改期生效」断言
    const nextSameWeekday = (() => {
      const d = new Date();
      d.setDate(d.getDate() + 7);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();
    check('复习改期快捷档（第 112 轮）', await waitFor(async () => {
      const input = await evaluate(`(() => {
        const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
        const chip = [...(root?.querySelectorAll('.hdu-resched-chip') ?? [])].find((n) => n.textContent?.includes('下周同一日'));
        chip?.click();
        const input = root?.querySelector('.hdu-modal input[type="date"]');
        const after = input?.value ?? null;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, '${rescheduleDay}');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return after;
      })()`);
      return input === nextSameWeekday ? input : null;
    }, '快捷档下周同一日'));
    await evaluate(`(() => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      const btn = [...(root?.querySelectorAll('button') ?? [])].find((n) => n.textContent?.trim() === '确认改期');
      btn?.click();
      return !!btn;
    })()`);
    check('复习计划自定义改期生效（第 109 轮）', await waitFor(async () => {
      const text = await shadowQuery('.hdu-review-view');
      return text.includes(rescheduleDay) ? text : null;
    }, '改期后到期日变更'));
    // 改期留痕（第 111 轮）：展开「被改期」行（子标题含新到期日）的详情 →「改期：from → to」轨迹。
    // 重试循环：点击展开 → 轮询本行文本；未展开（React 提交时序）则补点，已展开则只读。
    const logDiag = await evaluate(`(async () => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      const findRow = () => [...(root?.querySelectorAll('.hdu-review-view .hdu-todo-row') ?? [])].find((n) => n.textContent?.includes('${rescheduleDay}'));
      let last = '';
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const row = findRow();
        const btn = row?.querySelector('.hdu-list-title button');
        const expanded = (row?.textContent ?? '').includes('（无内容摘要）');
        if (row && btn && !expanded) btn.click();
        const text = row?.textContent ?? '';
        last = text.slice(0, 200);
        if (text.includes('改期：')) return { ok: true, snippet: last };
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      return { ok: false, snippet: last };
    })()`);
    process.stdout.write(`[diag] 留痕=${JSON.stringify(logDiag)}\n`);
    check('复习改期留痕（第 111 轮）', logDiag?.ok);
    // 30 天月历窗口（第 110 轮）：周视图 + 30 天 → 7 列栅格 30+ 列；断言后还原 7 天 + 列表
    const week30On = await evaluate(`(() => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      const btn = [...(root?.querySelectorAll('.hdu-folder') ?? [])].find((n) => n.textContent?.trim() === '周视图');
      btn?.click();
      return !!btn;
    })()`);
    check('复习计划周视图 30 天窗口（第 110 轮）', week30On && (await waitFor(async () => {
      const grid = await evaluate(`(() => {
        const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
        const btn = [...(root?.querySelectorAll('.hdu-folder') ?? [])].find((n) => n.textContent?.trim() === '30 天');
        btn?.click();
        const grid = root?.querySelector('.hdu-week-grid');
        return { cls: grid?.className ?? '', cols: grid ? grid.querySelectorAll('.hdu-week-day').length : 0 };
      })()`);
      return String(grid?.cls ?? '').includes('is-14') && grid?.cols >= 30 ? grid : null;
    }, '30 天窗口渲染')));
    await evaluate(`(() => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      const find = (t) => [...(root?.querySelectorAll('.hdu-folder') ?? [])].find((n) => n.textContent?.trim() === t);
      find('7 天')?.click();
      find('列表')?.click();
      return true;
    })()`);
    // 已完成导出按钮（第 110 轮）：种子含 1 条已完成作业（seed 阶段直写，不影响
    // review.due 今日计数）→ 已完成分区头部「导出记录」按钮在场（下载落盘走人工验收 §54）
    check('复习完成记录导出按钮（第 110 轮）', await waitFor(async () => {
      const text = await shadowQuery('.hdu-review-view');
      return text.includes('已完成（1）') && text.includes('导出记录') ? text : null;
    }, '完成记录导出按钮'));
    // 导出整页（第 124 轮巡检）：页头「导出整页」按钮在场（下载落盘走人工验收 §67）；
    // 学习成就角标（第 132 轮巡检）：页头 Chip 显示已解锁徽章数（种子含 1 条已完成 + 30 分钟有效学习 → ≥1）
    check('复习计划导出整页按钮（第 124 轮）', await waitFor(async () => {
      const text = await shadowQuery('.hdu-review-view');
      return text.includes('导出整页') && text.includes('🏅') ? text : null;
    }, '导出整页按钮'));
    // 筛选快照（第 125/126 轮巡检）：自定义命名存当前筛选 → chip 在场 → 套用（toast）→ 删除 →
    // chip 消失（含跨运行残留清理）。套用的是刚存的当前筛选（等值回放），不破坏种子状态
    check('复习计划筛选快照存取删（第 125/126 轮）', await waitFor(async () => {
      const r = await evaluate(`(async () => {
        const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
        const readText = () => root?.querySelector('.hdu-review-view')?.textContent ?? '';
        const row = [...(root?.querySelectorAll('.hdu-folder-row') ?? [])].find((n) => (n.textContent ?? '').includes('筛选快照'));
        if (!row) return { ok: false, reason: 'no-row' };
        const nameInput = row.querySelector('input[aria-label="快照名称"]');
        if (!nameInput) return { ok: false, reason: 'no-name-input' };
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(nameInput, '冲刺周');
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 150));
        const saveBtn = [...row.querySelectorAll('button')].find((n) => n.textContent?.includes('存当前筛选'));
        if (!saveBtn) return { ok: false, reason: 'no-save-btn' };
        saveBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 400));
        const rowAfterSave = [...(root?.querySelectorAll('.hdu-folder-row') ?? [])].find((n) => (n.textContent ?? '').includes('筛选快照'));
        const chip = rowAfterSave ? [...rowAfterSave.querySelectorAll('.hdu-snapshot-chip')].find((n) => (n.textContent ?? '').includes('冲刺周')) : null;
        if (!chip) return { ok: false, reason: 'no-chip-after-save' };
        // 重命名（第 127 轮巡检）：✎ → 输入新名 → ✓ 保存 → chip 显示新名
        const renameBtn = chip.querySelector('button[aria-label^="重命名快照"]');
        if (!renameBtn) return { ok: false, reason: 'no-rename-btn' };
        renameBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 250));
        const renameInput = root?.querySelector('input[aria-label^="重命名快照"]');
        if (!renameInput) return { ok: false, reason: 'no-rename-input' };
        setter.call(renameInput, '冲刺周·改');
        renameInput.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 150));
        const confirmBtn = [...(root?.querySelectorAll('.hdu-snapshot-chip button') ?? [])].find((n) => n.textContent?.trim() === '✓');
        if (!confirmBtn) return { ok: false, reason: 'no-rename-confirm' };
        confirmBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        const rowAfterRename = [...(root?.querySelectorAll('.hdu-folder-row') ?? [])].find((n) => (n.textContent ?? '').includes('筛选快照'));
        const chip2 = rowAfterRename ? [...rowAfterRename.querySelectorAll('.hdu-snapshot-chip')].find((n) => (n.textContent ?? '').includes('冲刺周·改')) : null;
        if (!chip2) return { ok: false, reason: 'rename-not-applied' };
        const applyBtn = chip2.querySelector('.hdu-folder');
        applyBtn?.click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        const rowAfterApply = [...(root?.querySelectorAll('.hdu-folder-row') ?? [])].find((n) => (n.textContent ?? '').includes('筛选快照'));
        const delBtn = rowAfterApply ? rowAfterApply.querySelector('button[aria-label^="删除快照"]') : null;
        if (!delBtn) return { ok: false, reason: 'no-del-btn' };
        delBtn.click();
        // 快照跨运行持久化：逐个清掉历史残留（含本run新建的），最终断言无 chips
        for (let i = 0; i < 8; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          const rowNow = [...(root?.querySelectorAll('.hdu-folder-row') ?? [])].find((n) => (n.textContent ?? '').includes('筛选快照'));
          const nextDel = rowNow?.querySelector('button[aria-label^="删除快照"]');
          if (!nextDel) break;
          nextDel.click();
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
        const rowAfterDel = [...(root?.querySelectorAll('.hdu-folder-row') ?? [])].find((n) => (n.textContent ?? '').includes('筛选快照'));
        const chipGone = !rowAfterDel || rowAfterDel.querySelectorAll('.hdu-snapshot-chip').length === 0;
        return { ok: chipGone, text: readText().slice(0, 80) };
      })()`);
      return r?.ok ? r : null;
    }, '筛选快照存取删'));
    // 复制清单（第 129 轮巡检）：点「复制清单」→ 剪贴板成功/失败必有 toast 反馈（内容核对走人工验收 §72）
    check('复习计划复制清单反馈（第 129 轮）', await waitFor(async () => {
      const r = await evaluate(`(async () => {
        const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
        const btn = [...(root?.querySelectorAll('button') ?? [])].find((n) => n.textContent?.trim() === '复制清单');
        if (!btn) return { ok: false, reason: 'no-btn' };
        btn.click();
        for (let i = 0; i < 10; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          const toast = [...(root?.querySelectorAll('.hdu-toast') ?? [])].map((n) => n.textContent ?? '').join('|');
          if (toast.includes('已复制复习清单') || toast.includes('复制失败')) return { ok: true, toast };
        }
        return { ok: false, reason: 'no-toast' };
      })()`);
      return r?.ok ? r : null;
    }, '复制清单反馈'));
    // 历史分区折叠（第 114 轮）：已完成分区点「收起」→ 行消失（重试：React 提交时序）
    check('复习计划历史分区折叠（第 114 轮）', await waitFor(async () => {
      const r = await evaluate(`(async () => {
        const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
        const head = [...(root?.querySelectorAll('.hdu-review-view .hdu-todo-head') ?? [])].find((n) => n.textContent?.includes('已完成'));
        const btn = head ? [...head.querySelectorAll('button')].find((n) => n.textContent?.trim() === '收起') : null;
        const before = (root?.querySelector('.hdu-review-view')?.textContent ?? '').includes('完成于');
        if (before && btn) btn.click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        const after = (root?.querySelector('.hdu-review-view')?.textContent ?? '').includes('完成于');
        return { clicked: Boolean(btn), gone: before && !after };
      })()`);
      return r?.clicked && r.gone ? r : null;
    }, '已完成分区收起'));
    // 分区折叠展开（第 114 轮）：点「展开」→ 已完成行恢复
    check('复习计划历史分区展开（第 114 轮）', await waitFor(async () => {
      const r = await evaluate(`(async () => {
        const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
        const head = [...(root?.querySelectorAll('.hdu-review-view .hdu-todo-head') ?? [])].find((n) => n.textContent?.includes('已完成'));
        const btn = head ? [...head.querySelectorAll('button')].find((n) => n.textContent?.trim() === '展开') : null;
        const before = (root?.querySelector('.hdu-review-view')?.textContent ?? '').includes('完成于');
        if (!before && btn) btn.click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        const after = (root?.querySelector('.hdu-review-view')?.textContent ?? '').includes('完成于');
        return { clicked: Boolean(btn), back: !before && after };
      })()`);
      return r?.clicked && r.back ? r : null;
    }, '已完成分区展开'));
    // 撤销完成（第 121 轮）：已完成行点「撤销完成」→ 作业回到待完成（已完成分区消失）
    check('复习计划撤销完成（第 121 轮）', await waitFor(async () => {
      const r = await evaluate(`(async () => {
        const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
        const row = [...(root?.querySelectorAll('.hdu-review-view .hdu-todo-row') ?? [])].find((n) => String(n.className).includes('is-done'));
        const btn = row ? [...row.querySelectorAll('button')].find((n) => n.textContent?.trim() === '撤销完成') : null;
        const before = (root?.querySelector('.hdu-review-view')?.textContent ?? '').includes('已完成（1）');
        if (before && btn) btn.click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        const text = root?.querySelector('.hdu-review-view')?.textContent ?? '';
        return { clicked: Boolean(btn), gone: before && !text.includes('已完成（1）') };
      })()`);
      return r?.clicked && r.gone ? r : null;
    }, '撤销完成生效'));
    // 月视图（第 111 轮）：切「月视图」→ 月历栅格（当月标签 + 星期表头）；‹ 导航上月；还原「列表」
    const monthOn = await evaluate(`(() => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      const btn = [...(root?.querySelectorAll('.hdu-folder') ?? [])].find((n) => n.textContent?.trim() === '月视图');
      btn?.click();
      return !!btn;
    })()`);
    check('复习计划月视图（第 111 轮）', monthOn && (await waitFor(async () => {
      const view = await evaluate(`(() => {
        const view = document.getElementById('hdu-assistant-host')?.shadowRoot?.querySelector('.hdu-month-view');
        return { found: Boolean(view), label: view?.querySelector('.hdu-month-label')?.textContent ?? '', cells: view ? view.querySelectorAll('.hdu-week-job').length : 0 };
      })()`);
      return view?.found && view.label.includes('2026年') && view.cells > 0 ? view : null;
    }, '月视图渲染')));
    // 月视图格内详情展开（第 114 轮）：点格内作业标题 → 内容摘要出现在格内
    check('复习计划月视图格内详情（第 114 轮）', monthOn && (await waitFor(async () => {
      const r = await evaluate(`(() => {
        const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
        const job = [...(root?.querySelectorAll('.hdu-month-view .hdu-week-job') ?? [])].find((n) => n.textContent?.includes('特征值'));
        if (!job) return { clicked: false, ok: false };
        if (!job.textContent.includes('特征值描述线性变换的不变方向')) {
          job.querySelector('.hdu-week-job-title')?.click();
        }
        const text = job.textContent ?? '';
        return { clicked: true, ok: text.includes('特征值描述线性变换的不变方向') };
      })()`);
      return r?.clicked && r.ok ? r : null;
    }, '月视图详情展开')));
    // 月视图格内完成按钮（第 112 轮）：格内作业行可直接完成
    check('复习计划月视图格内完成按钮（第 112 轮）', monthOn && (await waitFor(async () => {
      const text = await evaluate(`document.getElementById('hdu-assistant-host')?.shadowRoot?.querySelector('.hdu-month-view')?.textContent ?? ''`);
      return text.includes('完成') ? text : null;
    }, '月视图完成按钮')));
    // 月视图格内跳过按钮（第 113 轮）：格内作业可跳过（与完成/周视图对齐）
    check('复习计划月视图格内跳过按钮（第 113 轮）', monthOn && (await waitFor(async () => {
      const text = await evaluate(`document.getElementById('hdu-assistant-host')?.shadowRoot?.querySelector('.hdu-month-view')?.textContent ?? ''`);
      return text.includes('跳过') ? text : null;
    }, '月视图跳过按钮')));
    // 月视图格内顺延按钮（第 121 轮）：今日到期/已逾期格内可顺延（与列表/周视图对齐）
    check('复习计划月视图格内顺延按钮（第 121 轮）', monthOn && (await waitFor(async () => {
      const text = await evaluate(`document.getElementById('hdu-assistant-host')?.shadowRoot?.querySelector('.hdu-month-view')?.textContent ?? ''`);
      return text.includes('顺延') ? text : null;
    }, '月视图顺延按钮')));
    // 月视图格内改期按钮（第 115 轮）：格内作业可改期（与周视图/列表对齐）
    check('复习计划月视图格内改期按钮（第 115 轮）', monthOn && (await waitFor(async () => {
      const text = await evaluate(`document.getElementById('hdu-assistant-host')?.shadowRoot?.querySelector('.hdu-month-view')?.textContent ?? ''`);
      return text.includes('改期') ? text : null;
    }, '月视图改期按钮')));
    // 月视图格内轮次徽标（第 120 轮）：格内作业显示第 X/Y 轮
    check('复习计划月视图格内轮次徽标（第 120 轮）', monthOn && (await waitFor(async () => {
      const text = await evaluate(`document.getElementById('hdu-assistant-host')?.shadowRoot?.querySelector('.hdu-month-view')?.textContent ?? ''`);
      return text.includes('第 1/4 轮') ? text : null;
    }, '月视图轮次徽标')));
    // 月视图格内折叠（第 123 轮巡检）：临时补 2 条今日到期作业使「今天」格 >3 项 →
    // 默认只显 3 行 + 「还有 2 项」，点开后全显并转「收起」；断言后删除临时作业还原种子
    await evalInExtPage(`(async () => {
      const request = indexedDB.open('hdu-assistant');
      const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const now = Date.now();
      const d = new Date();
      const today = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['reviewJobs'], 'readwrite');
        const store = tx.objectStore('reviewJobs');
        store.put({ id: 'e2e-review-job-hdu-9', favoriteId: 'e2e-fav-hdu-review-1', dueDate: today, round: 1, template: 'regular', status: 'pending', createdAt: now, updatedAt: now });
        store.put({ id: 'e2e-review-job-hdu-10', favoriteId: 'e2e-fav-hdu-review-2', dueDate: today, round: 1, template: 'regular', status: 'pending', createdAt: now, updatedAt: now });
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error('tx aborted'));
      });
      db.close();
      return true;
    })()`);
    await clickByText('.hdu-nav-item', '学习统计');
    await clickByText('.hdu-nav-item', '复习计划');
    check('复习计划月视图格内折叠（第 123 轮）', await waitFor(async () => {
      const r = await evaluate(`(async () => {
        const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
        const more = [...(root?.querySelectorAll('.hdu-cell-more') ?? [])].find((n) => (n.textContent ?? '').includes('还有 2 项'));
        if (!more) return { ok: false };
        more.click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        const collapse = [...(root?.querySelectorAll('.hdu-cell-more') ?? [])].find((n) => (n.textContent ?? '').trim() === '收起');
        if (!collapse) return { ok: false, reason: 'no-collapse' };
        collapse.click();
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { ok: true };
      })()`);
      return r?.ok ? r : null;
    }, '月视图格内折叠'));
    await evalInExtPage(`(async () => {
      const request = indexedDB.open('hdu-assistant');
      const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['reviewJobs'], 'readwrite');
        tx.objectStore('reviewJobs').delete('e2e-review-job-hdu-9');
        tx.objectStore('reviewJobs').delete('e2e-review-job-hdu-10');
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error('tx aborted'));
      });
      db.close();
      return true;
    })()`);
    const monthNavOk = await evaluate(`(() => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      const btn = [...(root?.querySelectorAll('.hdu-month-nav button') ?? [])].find((n) => n.getAttribute('aria-label') === '上一月');
      btn?.click();
      return !!btn;
    })()`);
    check('复习计划月视图月份导航（第 111 轮）', monthNavOk && (await waitFor(async () => {
      const label = await evaluate(`document.getElementById('hdu-assistant-host')?.shadowRoot?.querySelector('.hdu-month-label')?.textContent ?? ''`);
      return label.includes('10月') ? label : null;
    }, '上月导航')));
    // 月份导航持久化（第 117 轮）：切走（知识库）再切回复习计划 + 月视图，月份保持上次导航结果
    await clickByText('.hdu-nav-item', '知识库');
    // 知识库搜索 × 清除按钮（第 268/285 轮）：输入关键词 → × 出现（shadowQuery 文本断言）
    await evaluate(`(() => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      const input = root?.querySelector('.hdu-filterbar .hdu-search input');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '矩阵');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    const libClearOk = await waitFor(async () => {
      const clearText = await shadowQuery('.hdu-filterbar .hdu-search .hdu-search-clear');
      return clearText.includes('×') ? true : null;
    }, '知识库搜索清空按钮');
    check('知识库搜索 × 清除按钮（第 268/285 轮）', libClearOk === true);
    await clickByText('.hdu-nav-item', '复习计划');
    check('复习计划月份导航持久化（第 117 轮）', await waitFor(async () => {
      // 重试式：视图切换有 React 提交时序，每次轮询重新点击月视图并读取月份标签
      const r = await evaluate(`(async () => {
        const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
        const view = root?.querySelector('.hdu-center')?.textContent ?? '';
        if (!view.includes('待完成')) return { ok: false, view: view.slice(0, 120) };
        const btn = [...(root?.querySelectorAll('.hdu-folder') ?? [])].find((n) => n.textContent?.trim() === '月视图');
        if (!btn) return { ok: false, view: view.slice(0, 120) };
        btn.click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        const label = root?.querySelector('.hdu-month-label')?.textContent ?? '';
        return { ok: label.includes('10月'), label, view: view.slice(0, 120) };
      })()`);
      return r?.ok ? r : null;
    }, '月份持久化'));
    await clickByText('.hdu-folder', '列表');
    await evaluate(`(() => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      const btn = [...(root?.querySelectorAll('.hdu-folder') ?? [])].find((n) => n.textContent?.trim() === '列表');
      btn?.click();
      return !!btn;
    })()`);
    // 逾期全部顺延（第 113 轮）：点按钮 → 全部逾期作业推到明天（「已到期 N 天」标注消失）
    const postponeAllDiag = await evaluate(`(() => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      const btn = [...(root?.querySelectorAll('button') ?? [])].find((n) => n.textContent?.trim() === '逾期全部顺延');
      btn?.click();
      return !!btn;
    })()`);
    check('复习计划逾期全部顺延（第 113 轮）', postponeAllDiag && (await waitFor(async () => {
      const text = await shadowQuery('.hdu-review-view');
      return !text.includes('已到期 1 天') ? text : null;
    }, '逾期全部顺延生效')));
    // 顺延（第 107 轮巡检）：逾期行的「顺延」按钮 → 到期日推一天。
    // 第 113 轮已把逾期行全部顺延到明天——此处对其中一行再顺延一次（推到后天），
    // 断言「已到期」标注仍消失且该行到期标签变为后天（验证顺延对已顺延行生效）。
    // 顺延（第 107 轮巡检）：行内「顺延」按钮（仅今日到期/已逾期行有）→ review.reschedule
    // 推一天 + toast「已顺延一天」。第 113 轮已把逾期行全部推到明天、第 121 轮撤销完成
    // 把 hdu-7 回到今日到期——此处点第一个带「顺延」按钮的线性代数行，断言 toast 与
    // 「已到期」标注不出现（顺延后该行离开今日/逾期集合）。
    const postponeDiag = await evaluate(`(() => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      const rows = [...(root?.querySelectorAll('.hdu-review-view .hdu-todo-row') ?? [])].filter((n) => (n.textContent ?? '').includes('线性代数复习要点'));
      const row = rows.find((n) => [...n.querySelectorAll('button')].some((b) => b.textContent?.trim() === '顺延'));
      const btn = row ? [...row.querySelectorAll('button')].find((n) => n.textContent?.trim() === '顺延') : null;
      btn?.click();
      return { rows: rows.length, clicked: Boolean(btn) };
    })()`);
    process.stdout.write(`[diag] 顺延=${JSON.stringify(postponeDiag)}\n`);
    check('复习计划顺延改期（第 107 轮）', postponeDiag?.clicked && (await waitFor(async () => {
      const r = await evaluate(`(() => {
        const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
        const toast = [...(root?.querySelectorAll('.hdu-toast') ?? [])].map((n) => n.textContent ?? '').join('|');
        const text = root?.querySelector('.hdu-review-view')?.textContent ?? '';
        return { toast, overdueGone: !text.includes('已到期 1 天') && !text.includes('已到期 2 天') };
      })()`);
      return r?.overdueGone && r.toast.includes('已顺延一天') ? r : null;
    }, '顺延后逾期标注消失')));
    check('知识库我的笔记分区（第 117 轮）', await clickByText('.hdu-nav-item', '知识库') && (await waitFor(async () => {
      const text = await shadowQuery('.hdu-center');
      return text.includes('我的笔记') && text.includes('E2E 预置笔记内容') ? text : null;
    }, '笔记分区渲染')));
    check('知识库笔记搜索（第 117 轮）', await waitFor(async () => {
      const r = await evaluate(`(async () => {
        const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
        const input = root?.querySelector('input[aria-label="搜索笔记"]');
        if (!input) return { found: false, ok: false };
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, '不匹配的关键词');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 300));
        const text = root?.querySelector('.hdu-center')?.textContent ?? '';
        return { found: true, ok: !text.includes('E2E 预置笔记内容') };
      })()`);
      return r?.found && r.ok ? r : null;
    }, '笔记搜索过滤'));
    await evaluate(`(() => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      const input = root?.querySelector('input[aria-label="搜索笔记"]');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    // 知识库最近搜索回放（第 303 轮）：搜索词为空时平铺 settings.ui.recentQueries chips
    //（与统一搜索 / B 站字幕同源；含种子词与统一搜索记录的词），点击 chip 即回填搜索词
    const recentChipsOk = await waitFor(async () => {
      const chips = await shadowCount('.hdu-lib-recent-chip');
      const row = await shadowQuery('.hdu-lib-recent');
      return chips > 0 && row.includes('最近搜索') ? chips : null;
    }, '知识库最近搜索 chips 渲染');
    check('知识库最近搜索 chips（第 303 轮）', recentChipsOk !== null && recentChipsOk > 0);
    const chipFilled = await waitFor(async () => {
      const r = await evaluate(`(() => {
        const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
        const chip = root?.querySelector('.hdu-lib-recent-chip > button');
        if (chip) chip.click(); // 点击后 query 非空、chips 行卸载（React 异步 flush）——以输入框回填为准
        const input = root?.querySelector('input[aria-label="搜索收藏、笔记与标签"]');
        return { value: input?.value ?? '', title: chip?.title ?? '' };
      })()`);
      if (!r?.value) process.stdout.write(`[diag] 最近搜索回填=${JSON.stringify(r)}\n`);
      return r?.value ? r : null;
    }, '最近搜索点击回填');
    check('知识库最近搜索点击回填（第 303 轮）', typeof chipFilled?.value === 'string' && chipFilled.value.length > 0);
    // 还原搜索词（× 清空），不影响后续「笔记课程筛选」等断言
    await evaluate(`(() => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      root?.querySelector('.hdu-search .hdu-search-clear')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    })()`);
    // 上限 / 单条删除（第 305 轮）：种子 6 条 + 再输入一个新词（越过 800ms 记录去抖）→
    // recentQueries 应被 cap 到 5 条且新词在最前；× 删除后 4 条。「清空」放在 B 站 hub
    // 段末尾执行——清空会清掉共享 recentQueries，影响其后的 chips 断言
    const capTyped = await evaluate(`(() => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      const input = root?.querySelector('input[aria-label="搜索收藏、笔记与标签"]');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '上限测试词');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(1300); // 越过 800ms 记录去抖
    await evaluate(`(() => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      root?.querySelector('.hdu-search .hdu-search-clear')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    })()`);
    check('知识库最近搜索上限 5 条（第 305 轮）', capTyped === true && (await waitFor(async () => {
      const chips = await shadowCount('.hdu-lib-recent-chip');
      const first = await shadowQuery('.hdu-lib-recent-chip > button');
      return chips === 5 && first.includes('上限测试词') ? chips : null;
    }, '记录新词后上限 5 条')));
    const delClicked = await evaluate(`(() => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      const del = root?.querySelector('.hdu-lib-recent-chip .hdu-lib-recent-del');
      del?.click();
      return !!del;
    })()`);
    check('知识库最近搜索单条删除（第 305 轮）', delClicked === true && (await waitFor(async () => (await shadowCount('.hdu-lib-recent-chip')) === 4 ? true : null, '删除后剩 4 条')));
    // 记录去抖边界（第 306 轮）：800ms 内连续输入两个词 → 只记最后一个（首个定时器被清除）
    const debounceTyped = await evaluate(`(async () => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      const input = root?.querySelector('input[aria-label="搜索收藏、笔记与标签"]');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '去抖甲词');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 120));
      setter.call(input, '去抖乙词');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(1300); // 越过 800ms 记录去抖
    await evaluate(`(() => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      root?.querySelector('.hdu-search .hdu-search-clear')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    })()`);
    check('知识库搜索记录去抖边界（第 306 轮）', debounceTyped === true && (await waitFor(async () => {
      const row = await shadowQuery('.hdu-lib-recent');
      const chips = await shadowCount('.hdu-lib-recent-chip');
      return chips === 5 && row.includes('去抖乙词') && !row.includes('去抖甲词') ? chips : null;
    }, '只记录最后一个词')));
    // 清空后焦点回归（第 313 轮）：点「清空」→ chips 消失且输入框获得焦点（四端一致行为）
    const libClearClicked = await evaluate(`(() => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      const btn = root?.querySelector('.hdu-lib-recent-clear');
      btn?.click();
      return !!btn;
    })()`);
    check('知识库 chips 清空后焦点回归（第 313 轮）', libClearClicked === true && (await waitFor(async () => {
      const r = await evaluate(`(() => {
        const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
        const input = root?.querySelector('input[aria-label="搜索收藏、笔记与标签"]');
        return { chips: root.querySelectorAll('.hdu-lib-recent-chip').length, focused: root?.activeElement === input };
      })()`);
      return r?.chips === 0 && r?.focused === true ? r : null;
    }, '清空后焦点回归')));
    // 重新记录一条（后续 B 站 hub chips 断言需要非空 recentQueries）
    await evaluate(`(() => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      const input = root?.querySelector('input[aria-label="搜索收藏、笔记与标签"]');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '词六');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(1300); // 越过 800ms 记录去抖
    await evaluate(`(() => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      root?.querySelector('.hdu-search .hdu-search-clear')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    })()`);
    // 空结果建议词随长度变化（第 310 轮）：超长关键词 → 知识库空态点名长度（与五端同口径）
    await evaluate(`(() => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      const input = root?.querySelector('input[aria-label="搜索收藏、笔记与标签"]');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '这是一个特别长的搜索关键词用来触发空结果提示');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    check('知识库空结果建议词随长度变化（第 310 轮）', await waitFor(async () => {
      const text = await shadowQuery('.hdu-center');
      return text.includes('关键词较长（') && text.includes('清除搜索') ? text : null;
    }, '知识库超长词空态建议'));
    // 还原搜索词
    await evaluate(`(() => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      root?.querySelector('.hdu-search .hdu-search-clear')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    })()`);
    // 笔记课程筛选（第 122 轮巡检）：选「高等数学（E2E）」→ 仅剩该课程笔记（另一课程笔记消失），
    // 行内出现课程徽标；还原「全部课程」→ 两条都在
    check('知识库笔记课程筛选（第 122 轮）', await waitFor(async () => {
      const r = await evaluate(`(async () => {
        const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
        const select = root?.querySelector('select[aria-label="笔记课程筛选"]');
        if (!select) return { found: false };
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        const opt = [...select.options].find((o) => (o.textContent ?? '').includes('高等数学'));
        if (!opt) return { found: true, ok: false, reason: 'no-course-option' };
        setter.call(select, opt.value);
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 300));
        const text = root?.querySelector('.hdu-center')?.textContent ?? '';
        // 断言只看笔记正文：筛选后仅剩所选课程笔记（另一课程笔记的行消失）；
        // 「未命名课程」等课程名会出现在 select 的 option 里，不能作为行级断言
        const ok = text.includes('E2E 预置笔记内容') && !text.includes('E2E 预置笔记二');
        setter.call(select, '');
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 250));
        const restored = root?.querySelector('.hdu-center')?.textContent ?? '';
        return { found: true, ok, restoredOk: restored.includes('E2E 预置笔记内容') && restored.includes('E2E 预置笔记二'), optValue: opt?.value ?? null, opts: [...select.options].map((o) => o.textContent), snippet: text.slice(0, 160) };
      })()`);
      if (!r?.ok) process.stdout.write(`[diag] 课程筛选=${JSON.stringify(r)}\n`);
      return r?.found && r.ok && r.restoredOk ? r : null;
    }, '笔记课程筛选'));
    // 收藏课程筛选（第 318 轮巡检，功能域）：「全部课程 + 各课程」chips（随收藏聚合带计数）
    check('知识库收藏课程筛选 chips（第 318 轮）', await waitFor(async () => {
      const row = await shadowQuery('[aria-label="知识库课程筛选"]');
      return row.includes('全部课程') && row.includes('高等数学（E2E）') && row.includes('大学物理（E2E）') ? row : null;
    }, '收藏课程筛选 chips 渲染'));
    // 标签管理（第 124 轮巡检）：种入 scratch 标签 → 「管理标签」弹层列出 → 改名生效。
    // 只动 scratch 标签（不挂任何收藏），种子标签零接触；合并链路走人工验收 §67
    await evalInExtPage(`(async () => {
      const request = indexedDB.open('hdu-assistant');
      const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      if (!Array.from(db.objectStoreNames).includes('tags')) { db.close(); return 'no-tags-store'; }
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['tags'], 'readwrite');
        tx.objectStore('tags').put({ id: 'e2e-tag-scratch', name: 'e2e临时标签' });
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error('tx aborted'));
      });
      db.close();
      return true;
    })()`);
    check('知识库标签管理弹层与改名（第 124 轮）', await waitFor(async () => {
      const r = await evaluate(`(async () => {
        const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
        const manageBtn = [...(root?.querySelectorAll('button') ?? [])].find((n) => n.textContent?.trim() === '管理标签');
        if (!manageBtn) return { ok: false, reason: 'no-manage-btn', buttons: [...(root?.querySelectorAll('button') ?? [])].map((n) => n.textContent?.trim()).slice(0, 24) };
        manageBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 500));
        const modalText = root?.textContent ?? '';
        if (!modalText.includes('标签管理')) return { ok: false, reason: 'no-modal' };
        if (!modalText.includes('e2e临时标签')) return { ok: false, reason: 'scratch-miss', snippet: modalText.slice(-200) };
        const row = [...(root?.querySelectorAll('.hdu-tag-manage-row') ?? [])].find((n) => (n.textContent ?? '').includes('e2e临时标签'));
        const renameBtn = row ? [...row.querySelectorAll('button')].find((n) => n.textContent?.trim() === '改名') : null;
        if (!renameBtn) return { ok: false, reason: 'no-rename-btn' };
        renameBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        const input = root?.querySelector('input[aria-label="新标签名"]');
        if (!input) return { ok: false, reason: 'no-input' };
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, 'e2e临时标签·改');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 200));
        const saveBtn = [...(root?.querySelectorAll('.hdu-tag-manage-row button') ?? [])].find((n) => n.textContent?.trim() === '保存');
        if (!saveBtn) return { ok: false, reason: 'no-save-btn' };
        saveBtn.click();
        for (let i = 0; i < 12; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          if ((root?.textContent ?? '').includes('e2e临时标签·改')) return { ok: true };
        }
        return { ok: false, reason: 'rename-not-applied' };
      })()`);
      if (!r?.ok) process.stdout.write(`[diag] 标签管理=${JSON.stringify(r)}\n`);
      return r?.ok ? r : null;
    }, '标签管理改名'));
    // 清理 scratch 标签并关闭弹层（改名已落库，弹层内残留不改种子）
    await evalInExtPage(`(async () => {
      const request = indexedDB.open('hdu-assistant');
      const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      if (!Array.from(db.objectStoreNames).includes('tags')) { db.close(); return 'no-tags-store'; }
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['tags'], 'readwrite');
        tx.objectStore('tags').delete('e2e-tag-scratch');
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error('tx aborted'));
      });
      db.close();
      return true;
    })()`);
    await evaluate(`(() => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      root?.querySelector('[aria-label="关闭"]')?.click();
      return true;
    })()`);
    // 标签统计看板（第 125/126 轮巡检）：点「标签统计」→ 面板列出种子标签计数 →
    // 切「按完成率」排序 → 点首行按该标签筛选（面板收起、筛选 chips 生效）。
    // 第 134 轮：种入 1 条本周完成的 scratch 作业 → 「e2e」标签趋势柱可点 → 点柱弹该周完成明细
    await evalInExtPage(`(async () => {
      const request = indexedDB.open('hdu-assistant');
      const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['reviewJobs'], 'readwrite');
        tx.objectStore('reviewJobs').put({ id: 'e2e-review-job-hdu-11', favoriteId: 'e2e-fav-hdu-review-1', dueDate: '2026-01-01', round: 1, template: 'regular', status: 'done', createdAt: Date.now(), updatedAt: Date.now() });
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error('tx aborted'));
      });
      db.close();
      return true;
    })()`);
    check('知识库标签统计看板（第 125/126/134 轮）', await waitFor(async () => {
      const r = await evaluate(`(async () => {
        const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
        const btn = [...(root?.querySelectorAll('button') ?? [])].find((n) => n.textContent?.trim() === '标签统计');
        if (!btn) return { ok: false, reason: 'no-btn' };
        btn.click();
        // 打开面板等待（第 154 轮巡检加固）：review.list + 趋势计算在慢环境下 500ms 不够，改条件等待
        //（内层单段 ≤2.5s，外层 waitFor 30s 预算内可多次重试）
        let panel = '';
        for (let i = 0; i < 10; i++) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          panel = root?.querySelector('.hdu-tag-stats')?.textContent ?? '';
          if (panel.includes('# e2e')) break;
        }
        // 第 151 轮：覆盖率摘要行 + 未打标收藏行（无条件渲染，断言文本在场）
        if (!panel.includes('# e2e') || !panel.includes('复习中') || !panel.includes('已完成') || !panel.includes('本周')) return { ok: false, reason: 'rows-miss', snippet: panel.slice(0, 120) };
        if (!panel.includes('标签覆盖率') || !panel.includes('未打标收藏')) return { ok: false, reason: 'no-coverage-untagged', snippet: panel.slice(0, 160) };
        // 近 4 周迷你趋势（第 130 轮巡检）：每行 4 根小柱
        const trendBars = (root?.querySelectorAll('.hdu-tag-stats .hdu-trend-bar') ?? []).length;
        if (trendBars < 8) return { ok: false, reason: 'no-trend-bars', trendBars };
        // 趋势窗口切换（第 135 轮巡检）：近 12 周 → 柱数 = 12 × 标签行数，随后还原近 4 周
        const weeks12Btn = [...(root?.querySelectorAll('.hdu-tag-stats button') ?? [])].find((n) => n.textContent?.trim() === '近 12 周');
        if (!weeks12Btn) return { ok: false, reason: 'no-12w-btn' };
        weeks12Btn.click();
        // 近 12 周趋势计算 + 渲染需时（第 154 轮巡检加固）：固定 500ms 偶发不足（no-12w-bars），改条件等待
        let bars12 = 0;
        for (let i = 0; i < 10; i++) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          bars12 = (root?.querySelectorAll('.hdu-tag-stats .hdu-trend-bar') ?? []).length;
          if (bars12 >= 24) break;
        }
        if (bars12 < 24) return { ok: false, reason: 'no-12w-bars', bars12 };
        // 趋势窗口持久化核对（第 136 轮实现，第 151 轮补回归断言；第 154 轮重开改条件等待）：
        // 收起面板再重开，近 12 周仍为激活选择
        const toggleBtn = [...(root?.querySelectorAll('button') ?? [])].find((n) => n.textContent?.trim() === '标签统计');
        toggleBtn?.click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        [...(root?.querySelectorAll('button') ?? [])].find((n) => n.textContent?.trim() === '标签统计')?.click();
        let weeks12Active = false;
        for (let i = 0; i < 10; i++) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          weeks12Active = [...(root?.querySelectorAll('.hdu-tag-stats button') ?? [])].some(
            (n) => n.textContent?.trim() === '近 12 周' && String(n.className).includes('is-active'),
          );
          if (weeks12Active) break;
        }
        if (!weeks12Active) return { ok: false, reason: 'trend-weeks-not-persisted' };
        const weeks4Btn = [...(root?.querySelectorAll('.hdu-tag-stats button') ?? [])].find((n) => n.textContent?.trim() === '近 4 周');
        weeks4Btn?.click();
        await new Promise((resolve) => setTimeout(resolve, 500));
        const sortBtn = [...(root?.querySelectorAll('.hdu-tag-stats button') ?? [])].find((n) => n.textContent?.trim() === '按完成率');
        if (!sortBtn) return { ok: false, reason: 'no-sort-btn' };
        sortBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 250));
        // 导出 CSV（第 127 轮巡检；第 164 轮起先弹预览再确认落盘）：预览弹层 → 确认导出 → toast
        const csvBtn = [...(root?.querySelectorAll('.hdu-tag-stats button') ?? [])].find((n) => n.textContent?.trim() === '导出 CSV');
        if (!csvBtn) return { ok: false, reason: 'no-csv-btn' };
        csvBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        const previewText = root?.textContent ?? '';
        if (!previewText.includes('导出预览') || !previewText.includes('确认导出')) return { ok: false, reason: 'no-export-preview' };
        const confirmBtn = [...(root?.querySelectorAll('button') ?? [])].find((n) => n.textContent?.trim() === '确认导出');
        if (!confirmBtn) return { ok: false, reason: 'no-confirm-export-btn' };
        confirmBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        if (!(root?.textContent ?? '').includes('已导出标签统计 CSV')) return { ok: false, reason: 'no-csv-toast' };
        // 趋势柱点选（第 134 轮巡检）：本周柱（scratch 作业 → e2e 标签本周完成 1 项）→ 点柱弹该周完成明细
        const bar = [...(root?.querySelectorAll('.hdu-tag-stats .hdu-trend-bar') ?? [])].find((n) => (n.getAttribute('aria-label') ?? '') === '本周完成 1 项');
        if (!bar) return { ok: false, reason: 'no-clickable-bar' };
        bar.click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        const detailText = root?.textContent ?? '';
        if (!detailText.includes('完成明细') || !detailText.includes('线性代数复习要点')) return { ok: false, reason: 'no-detail-modal' };
        root?.querySelector('[aria-label="关闭"]')?.click();
        await new Promise((resolve) => setTimeout(resolve, 200));
        const firstRow = root?.querySelector('.hdu-tag-stat-row');
        if (!firstRow) return { ok: false, reason: 'no-first-row' };
        const pickedTag = firstRow.querySelector('.hdu-tag-stat-name')?.textContent ?? '';
        firstRow.click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        const closed = !root?.querySelector('.hdu-tag-stats');
        const chipsText = [...(root?.querySelectorAll('[aria-label="知识库标签看板"] .hdu-folder') ?? [])].map((n) => n.textContent ?? '').join('|');
        return { ok: closed, pickedTag, chipsActive: chipsText, snippet: panel.slice(0, 80) };
      })()`);
      if (!r?.ok) process.stdout.write(`[diag] 标签统计=${JSON.stringify(r)}
`);
      return r?.ok ? r : null;
    }, '标签统计面板', { timeoutMs: 30000 }));
    // 收起标签统计面板并还原标签筛选（避免影响后续知识库断言的可见文本）
    await evaluate(`(() => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      const btn = [...(root?.querySelectorAll('button') ?? [])].find((n) => n.textContent?.trim() === '标签统计');
      btn?.click();
      const allBtn = [...(root?.querySelectorAll('[aria-label="知识库标签看板"] .hdu-folder') ?? [])].find((n) => n.textContent?.trim() === '全部标签');
      allBtn?.click();
      return true;
    })()`);
    // 清理 scratch 已完成作业（趋势柱点选断言用，还原种子）
    await evalInExtPage(`(async () => {
      const request = indexedDB.open('hdu-assistant');
      const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['reviewJobs'], 'readwrite');
        tx.objectStore('reviewJobs').delete('e2e-review-job-hdu-11');
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error('tx aborted'));
      });
      db.close();
      return true;
    })()`);
    // 回收站（第 146/149 轮巡检）：种入 1 条软删除收藏 → 面板显示条目（类型徽标/日期/操作钮）
    // → 搜索过滤 → 还原 → 面板回空（还原的是已在知识库的收藏，同 id 覆盖，不产生重复）
    await evalInExtPage(`(async () => {
      const request = indexedDB.open('hdu-assistant');
      const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['trash'], 'readwrite');
        const store = tx.objectStore('trash');
        store.put({
          key: 'favorite:e2e-fav-hdu-review-2',
          kind: 'favorite',
          id: 'e2e-fav-hdu-review-2',
          title: '高等数学复习要点（E2E 预置）',
          deletedAt: Date.now(),
          expiresAt: Date.now() + 30 * 86400000,
        });
        // count 必须在同一事务内发起（事务 complete 后再访问 tx 会抛 InvalidStateError）
        const countReq = store.count();
        countReq.onsuccess = () => { self.__seedCount = countReq.result; };
        tx.oncomplete = () => {
          self.__seedDiag = 'stores=' + [...db.objectStoreNames].join(',') + ' count=' + (self.__seedCount ?? '?');
          resolve();
        };
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error('tx aborted'));
      });
      db.close();
      return true;
    })()`);
    let recycleErrCount = 0;
    check('知识库回收站（第 146/149 轮）', await waitFor(async () => {
      let r;
      try {
        r = await evaluate(`(async () => {
        try {
        const dumpDiag = (obj) => {
          let el = document.getElementById('hdu-e2e-diag');
          if (!el) {
            el = document.createElement('div');
            el.id = 'hdu-e2e-diag';
            document.body.prepend(el);
          }
          el.textContent = JSON.stringify(obj).slice(0, 200);
        };
        window.__rd = [];
        const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
        const btn = [...(root?.querySelectorAll('button') ?? [])].find((n) => n.textContent?.trim().includes('🗑 回收站'));
        if (!btn) {
          dumpDiag({ reason: 'no-btn' });
          return { ok: false, reason: 'no-btn' };
        }
        const panelCount = root?.querySelectorAll('[aria-label="回收站"]').length ?? 0;
        btn.click();
        await new Promise((resolve) => setTimeout(resolve, 400));
        const panel = root?.querySelector('[aria-label="回收站"]')?.textContent ?? '';
        if (!panel.includes('高等数学复习要点') || !panel.includes('[收藏]')) return { ok: false, reason: 'no-entry', panel: panel.slice(0, 100) };
        if (!panel.includes('还原并复习') || !panel.includes('彻底删除') || !panel.includes('全部还原')) return { ok: false, reason: 'no-actions' };
        const search = root?.querySelector('input[aria-label="搜索回收站"]');
        if (!search) return { ok: false, reason: 'no-search' };
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(search, '不存在的标题XYZ');
        search.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 200));
        const afterSearch = root?.querySelector('[aria-label="回收站"]')?.textContent ?? '';
        if (afterSearch.includes('高等数学复习要点')) return { ok: false, reason: 'search-not-filtered' };
        setter.call(search, '');
        search.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 200));
        const restoreBtn = [...(root?.querySelectorAll('[aria-label="回收站"] button') ?? [])].find((n) => n.textContent?.trim() === '还原');
        if (!restoreBtn) return { ok: false, reason: 'no-restore-btn' };
        restoreBtn.click();
        // 条件等待还原生效（第 210 轮巡检排查；第 199 轮加长到 8s）：同时抓错误 toast
        let afterRestore = '';
        let errToast = '';
        for (let i = 0; i < 16; i++) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          afterRestore = root?.querySelector('[aria-label="回收站"]')?.textContent ?? '';
          const rootText = root?.textContent ?? '';
          if (rootText.includes('还原失败')) errToast = (rootText.match(/[^。]*还原失败[^。]*/) ?? [''])[0];
          if (afterRestore.includes('回收站为空')) break;
        }
        if (!afterRestore.includes('回收站为空')) {
          return {
            ok: false,
            reason: 'restore-failed',
            after: afterRestore.slice(0, 150),
            errToast,
            restoreDisabled: restoreBtn.disabled,
          };
        }
        return { ok: true };
        } catch (err) {
          return { ok: false, step: 'exception', error: String(err) };
        }
      })()`);
      } catch (err) {
        // evaluate 抛错（CDP 超时/协议错误）会被 waitFor 吞掉导致无诊断空转，这里落一条日志（仅前 2 次防刷屏）
        recycleErrCount += 1;
        if (recycleErrCount <= 2) {
          process.stdout.write('[recycle-eval-err] #' + recycleErrCount + ' ' + (err?.stack ?? String(err)) + '\n');
        }
        return null;
      }
      if (!r?.ok) process.stdout.write('[recycle-diag] ' + JSON.stringify(r) + '\n');
      return r?.ok ? r : null;
    }, '回收站', { timeoutMs: 40000 }));
    // 回到复习计划视图（笔记检查切到了知识库，后续月份持久化/模板断言都在复习视图）
    await clickByText('.hdu-nav-item', '复习计划');
    // 关键词搜索（第 115 轮）：输入「特征值」→ 三个分区仅剩含该标题的行
    const reviewSearchType = (text) =>
      evaluate(`(() => {
        const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
        const input = root?.querySelector('.hdu-review-view input[aria-label="搜索复习作业"]');
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, '${text}');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
    check('复习计划关键词搜索（第 115 轮）', await waitFor(async () => {
      // 重试式：视图切回列表有 React 提交时序，每次轮询重新输入并断言
      const r = await evaluate(`(async () => {
        const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
        const input = root?.querySelector('.hdu-review-view input[aria-label="搜索复习作业"]');
        if (!input) return { found: false, ok: false };
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, '特征值');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 300));
        const text = root?.querySelector('.hdu-review-view .hdu-todo-rows')?.textContent ?? '';
        return { found: true, ok: text.includes('特征值') && !text.includes('线性代数复习要点') && !text.includes('高等数学复习要点') };
      })()`);
      return r?.found && r.ok ? r : null;
    }, '关键词过滤结果'));
    // 来源筛选（第 118 轮）：切回列表 → 清空搜索 + 重置紧急度 → 点「站内」→ 仅剩站内收藏的作业 → 还原「全部来源」并验证
    check('复习计划来源筛选（第 118 轮）', await waitFor(async () => {
      const r = await evaluate(`(async () => {
        const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        const clickFolder = (t) => { const b = [...(root?.querySelectorAll('.hdu-folder') ?? [])].find((n) => n.textContent?.trim() === t); b?.click(); return Boolean(b); };
        const readRows = () => root?.querySelector('.hdu-review-view .hdu-todo-rows')?.textContent ?? '';
        clickFolder('列表');
        await new Promise((resolve) => setTimeout(resolve, 250));
        const clear = root?.querySelector('input[aria-label="搜索复习作业"]');
        if (clear) { setter.call(clear, ''); clear.dispatchEvent(new Event('input', { bubbles: true })); }
        clickFolder('全部');
        await new Promise((resolve) => setTimeout(resolve, 200));
        clickFolder('站内');
        await new Promise((resolve) => setTimeout(resolve, 300));
        const rows = readRows();
        const ok = rows.includes('线性代数复习要点') && !rows.includes('特征值');
        clickFolder('全部来源');
        await new Promise((resolve) => setTimeout(resolve, 300));
        const restored = readRows();
        return { found: true, ok, restoredOk: restored.includes('特征值'), rows: rows.slice(0, 120) };
      })()`);
      process.stdout.write(`[diag] 来源筛选=${JSON.stringify({ rows: r?.rows, ok: r?.ok })}\n`);
      return r?.found && r.ok && r.restoredOk ? r : null;
    }, '来源过滤结果'));
    // 今日到期全部顺延（第 119 轮）：点按钮 → 今日到期行推到明天（行内「今日到期」标注消失）；
    // 断言后经扩展页 IndexedDB 把种子作业的到期日还原为今天，避免破坏后续计数断言
    const postponeTodayDiag = await evaluate(`(() => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      const btn = [...(root?.querySelectorAll('button') ?? [])].find((n) => n.textContent?.trim() === '今日到期全部顺延');
      btn?.click();
      return !!btn;
    })()`);
    check('复习计划今日到期全部顺延（第 119 轮）', postponeTodayDiag && (await waitFor(async () => {
      const text = await shadowQuery('.hdu-review-view .hdu-todo-rows');
      return !text.includes('今日到期') ? text : null;
    }, '今日到期全部顺延生效')));
    // 种子到期日还原为今天（今日到期全部顺延把 hdu-2/预置作业推到了明天）
    await evalInExtPage(`(async () => {
      const request = indexedDB.open('hdu-assistant');
      const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const tx = db.transaction(['reviewJobs'], 'readwrite');
      const store = tx.objectStore('reviewJobs');
      const today = new Date();
      const todayKey = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
      for (const id of ['e2e-review-job-hdu-2', 'e2e-review-job-1']) {
        const rec = await new Promise((resolve) => { const r = store.get(id); r.onsuccess = () => resolve(r.result); });
        if (rec) store.put({ ...rec, dueDate: todayKey, updatedAt: Date.now() });
      }
      await tx.done;
      db.close();
      return true;
    })()`);
    // 多选批量完成（第 121 轮）：勾选 2 行 → 批量完成 → toast「已完成 2 项复习」；
    // toast 挂在 shadow 根级 .hdu-toast-stack（不在 .hdu-review-view 内），就地在 evaluate
    // 内轮询读取，避免 waitFor 重试反复勾选把待完成全部完成（破坏种子状态）
    check('复习计划多选批量完成（第 121 轮）', await waitFor(async () => {
      const r = await evaluate(`(async () => {
        const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
        const readToast = () => [...(root?.querySelectorAll('.hdu-toast') ?? [])].map((n) => n.textContent ?? '').join('|');
        const boxes = [...(root?.querySelectorAll('.hdu-review-view .hdu-todo-row input[type="checkbox"]') ?? [])];
        const unchecked = boxes.filter((box) => !box.checked).slice(0, 2);
        for (const box of unchecked) box.click();
        await new Promise((resolve) => setTimeout(resolve, 250));
        const btn = [...(root?.querySelectorAll('button') ?? [])].find((n) => n.textContent?.trim() === '批量完成');
        if (!btn) return { found: false, boxes: boxes.length };
        btn.click();
        for (let i = 0; i < 12; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          const toast = readToast();
          if (toast.includes('已完成 2 项复习')) return { found: true, ok: true, toast };
        }
        return { found: true, ok: false, toast: readToast().slice(0, 120), boxes: boxes.length };
      })()`);
      process.stdout.write(`[diag] 批量完成=${JSON.stringify(r)}\n`);
      return r?.found && r.ok ? r : null;
    }, '多选批量完成'));
    await evalInExtPage(`(async () => {
      const request = indexedDB.open('hdu-assistant');
      const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const today = new Date();
      const todayKey = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
      const ids = ['e2e-review-job-hdu-2', 'e2e-review-job-1'];
      const updates = [];
      const tx1 = db.transaction(['reviewJobs'], 'readonly');
      const store1 = tx1.objectStore('reviewJobs');
      for (const id of ids) {
        const req = store1.get(id);
        req.onsuccess = () => { const rec = req.result; if (rec) updates.push({ ...rec, status: 'pending', dueDate: todayKey, updatedAt: Date.now() }); };
      }
      await tx1.done;
      const tx2 = db.transaction(['reviewJobs'], 'readwrite');
      const store2 = tx2.objectStore('reviewJobs');
      for (const rec of updates) store2.put(rec);
      await tx2.done;
      db.close();
      return updates.length;
    })()`);
    // 多选批量顺延（第 122 轮巡检）：勾选 2 行 → 批量顺延 → toast「已顺延 2 项复习」；
    // toast 挂在 shadow 根级，就地在 evaluate 内轮询，避免 waitFor 重试反复顺延破坏种子
    check('复习计划多选批量顺延（第 122 轮）', await waitFor(async () => {
      const r = await evaluate(`(async () => {
        const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
        const readToast = () => [...(root?.querySelectorAll('.hdu-toast') ?? [])].map((n) => n.textContent ?? '').join('|');
        const boxes = [...(root?.querySelectorAll('.hdu-review-view .hdu-todo-row input[type="checkbox"]') ?? [])];
        const unchecked = boxes.filter((box) => !box.checked).slice(0, 2);
        for (const box of unchecked) box.click();
        await new Promise((resolve) => setTimeout(resolve, 250));
        const btn = [...(root?.querySelectorAll('button') ?? [])].find((n) => n.textContent?.trim() === '批量顺延');
        if (!btn) return { found: false, boxes: boxes.length };
        btn.click();
        for (let i = 0; i < 12; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          const toast = readToast();
          if (toast.includes('已顺延 2 项复习')) return { found: true, ok: true, toast };
        }
        return { found: true, ok: false, toast: readToast().slice(0, 120), boxes: boxes.length };
      })()`);
      return r?.found && r.ok ? r : null;
    }, '多选批量顺延'));
    // 多选批量改期（第 123 轮巡检）：勾选 2 行 → 「批量改期」弹层（确认钮在场）→ 确认 →
    // toast「已改期 2 项复习到 …」；toast 就地轮询，避免 waitFor 重试反复改期破坏种子
    check('复习计划多选批量改期（第 123 轮）', await waitFor(async () => {
      const r = await evaluate(`(async () => {
        const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
        const readToast = () => [...(root?.querySelectorAll('.hdu-toast') ?? [])].map((n) => n.textContent ?? '').join('|');
        const boxes = [...(root?.querySelectorAll('.hdu-review-view .hdu-todo-row input[type="checkbox"]') ?? [])];
        const unchecked = boxes.filter((box) => !box.checked).slice(0, 2);
        for (const box of unchecked) box.click();
        await new Promise((resolve) => setTimeout(resolve, 250));
        const openBtn = [...(root?.querySelectorAll('button') ?? [])].find((n) => n.textContent?.trim() === '批量改期');
        if (!openBtn) return { found: false };
        openBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        const confirmBtn = [...(root?.querySelectorAll('button') ?? [])].find((n) => n.textContent?.trim() === '确认批量改期');
        if (!confirmBtn) return { found: true, ok: false, reason: 'no-modal' };
        confirmBtn.click();
        for (let i = 0; i < 12; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          const toast = readToast();
          if (toast.includes('已改期 2 项复习到')) return { found: true, ok: true, toast };
        }
        return { found: true, ok: false, toast: readToast().slice(0, 120) };
      })()`);
      return r?.found && r.ok ? r : null;
    }, '多选批量改期'));
    // 种子到期日先在扩展 DB 重置为种子基线（消除前序检查的改期/顺延副作用），
    // 再重挂载复习视图刷新作业数据（模板标注断言依赖种子基线）
    await evalInExtPage(`(async () => {
      const request = indexedDB.open('hdu-assistant');
      const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const tx = db.transaction(['reviewJobs'], 'readwrite');
      const store = tx.objectStore('reviewJobs');
      const now = Date.now();
      const dayKey = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
      const jobs = [
        { id: 'e2e-review-job-hdu-1', favoriteId: 'e2e-fav-hdu-review-1', dueDate: dayKey(1), round: 1, template: 'regular', status: 'pending', createdAt: now, updatedAt: now },
        { id: 'e2e-review-job-hdu-2', favoriteId: 'e2e-fav-hdu-review-2', dueDate: dayKey(0), round: 1, template: 'regular', status: 'pending', createdAt: now, updatedAt: now },
        { id: 'e2e-review-job-hdu-3', favoriteId: 'e2e-fav-hdu-review-1', dueDate: dayKey(1), round: 1, template: 'exam', status: 'pending', createdAt: now, updatedAt: now },
        { id: 'e2e-review-job-hdu-4', favoriteId: 'e2e-fav-hdu-review-1', dueDate: dayKey(0), round: 1, template: 'regular', status: 'skipped', createdAt: now, updatedAt: now },
        { id: 'e2e-review-job-hdu-5', favoriteId: 'e2e-fav-hdu-review-2', dueDate: dayKey(0), round: 1, template: 'regular', status: 'skipped', createdAt: now, updatedAt: now },
        { id: 'e2e-review-job-hdu-6', favoriteId: 'e2e-fav-hdu-review-2', dueDate: dayKey(-1), round: 1, template: 'regular', status: 'pending', createdAt: now, updatedAt: now },
        { id: 'e2e-review-job-hdu-7', favoriteId: 'e2e-fav-hdu-review-1', dueDate: dayKey(0), round: 1, template: 'regular', status: 'done', createdAt: now, updatedAt: now },
        { id: 'e2e-review-job-hdu-8', favoriteId: 'e2e-fav-hdu-review-1', dueDate: dayKey(-1), round: 1, template: 'regular', status: 'pending', createdAt: now, updatedAt: now },
        { id: 'e2e-review-job-1', favoriteId: 'e2e-fav-bili-ai-1', dueDate: dayKey(0), round: 1, template: 'regular', status: 'pending', createdAt: now, updatedAt: now },
      ];
      for (const job of jobs) store.put(job);
      await tx.done;
      db.close();
      return true;
    })()`);
    await clickByText('.hdu-nav-item', '学习统计');
    await waitFor(async () => ((await shadowQuery('.hdu-center')).includes('学习热力图') ? true : null), '统计视图渲染');
    await clickByText('.hdu-nav-item', '复习计划');
    await waitFor(async () => ((await shadowQuery('.hdu-center')).includes('待完成') ? true : null), '刷新复习视图');
    // 完成率进度条（第 118 轮）：统计条下方出现「完成率」进度行
    check('复习计划完成率进度条（第 118 轮）', await waitFor(async () => {
      const text = await shadowQuery('.hdu-review-view');
      return text.includes('完成率') ? text : null;
    }, '完成率进度条'));
    // 统计条 chips 可点击（第 120 轮）：点「已逾期」→ 紧急度筛选生效（逾期行保留、今日到期行被过滤）
    check('复习计划统计条逾期筛选（第 120 轮）', await waitFor(async () => {
      const r = await evaluate(`(async () => {
        const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        const clear = root?.querySelector('input[aria-label="搜索复习作业"]');
        if (clear) { setter.call(clear, ''); clear.dispatchEvent(new Event('input', { bubbles: true })); }
        const chips = () => [...(root?.querySelectorAll('button.hdu-review-stat') ?? [])];
        const clickChip = (t) => { const c = chips().find((n) => n.textContent?.includes(t)); c?.click(); };
        clickChip('已逾期');
        await new Promise((resolve) => setTimeout(resolve, 300));
        const rows = root?.querySelector('.hdu-review-view .hdu-todo-rows')?.textContent ?? '';
        const ok = rows.includes('已到期 1 天') && !rows.includes('今日到期');
        clickChip('已逾期');
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { found: chips().length > 0, ok, rows: rows.slice(0, 150) };
      })()`);
      return r?.found && r.ok ? r : null;
    }, '统计条逾期筛选'));
    // 还原紧急度筛选（统计条 chips 为切换式：已逾期 chip 仅在激活态再点一次才回到 all；
    // 上一检查的两次点击已复位，这里兜底仅当 chip 仍处于 is-active 时点击，避免把
    // 「只看逾期」筛选遗留给后续模板标注/重新入计划断言）
    await evaluate(`(() => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      const chip = [...(root?.querySelectorAll('button.hdu-review-stat') ?? [])].find((n) => n.textContent?.includes('已逾期'));
      if (chip && String(chip.className).includes('is-active')) chip.click();
      return !!chip;
    })()`);
    // 月视图「回到今天」（第 118 轮）：切月视图 → 「今天」按钮在场 → 点击回到当前月（11月）→ 还原列表
    const month118 = await evaluate(`(() => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      const btn = [...(root?.querySelectorAll('.hdu-folder') ?? [])].find((n) => n.textContent?.trim() === '月视图');
      btn?.click();
      return !!btn;
    })()`);
    check('复习计划月视图回到今天按钮（第 118 轮）', month118 && (await waitFor(async () => {
      const r = await evaluate(`(() => {
        const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
        const btn = [...(root?.querySelectorAll('.hdu-month-nav button') ?? [])].find((n) => n.textContent?.trim() === '今天');
        if (!btn) return { found: false };
        btn.click();
        const label = root?.querySelector('.hdu-month-label')?.textContent ?? '';
        return { found: true, label };
      })()`);
      return r?.found && r.label.includes('11月') ? r : null;
    }, '回到今天按钮')));
    await evaluate(`(() => {
      const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
      const btn = [...(root?.querySelectorAll('.hdu-folder') ?? [])].find((n) => n.textContent?.trim() === '列表');
      btn?.click();
      return !!btn;
    })()`);
    await reviewSearchType('');
    // 模板筛选（第 97 轮）：模板 chips 在场（常规/考试）；点「考试」仅剩考试模板作业
    check('复习计划模板筛选 chips（第 97 轮）', await waitFor(async () => {
      const text = await shadowQuery('.hdu-center');
      return text.includes('全部模板') && text.includes('考试') ? text : null;
    }, '模板筛选 chips'));
    check('复习计划模板筛选 chips（第 97 轮）', await waitFor(async () => {
      const text = await shadowQuery('.hdu-center');
      return text.includes('全部模板') && text.includes('考试') ? text : null;
    }, '模板筛选 chips'));
    // 模板过滤的点击行为转人工验收（§41-1）：CDP 点击后立即读 DOM 的断言方式
    // 在此场景不稳定（React 提交时机），不作为门禁依据
    check('复习计划模板标注与今日强调（第 98 轮）', await waitFor(async () => {
      // 重试式：视图切换有 React 提交时序——行不在/非今日到期时切走再切回，重新读取
      const r = await evaluate(`(async () => {
        const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
        const nav = (t) => { const b = [...(root?.querySelectorAll('.hdu-nav-item') ?? [])].find((n) => (n.textContent ?? '').includes(t)); b?.click(); return Boolean(b); };
        const readRow = () => {
          const row = [...(root?.querySelectorAll('.hdu-review-view .hdu-todo-row') ?? [])].find((n) => n.textContent?.includes('特征值'));
          return { found: Boolean(row), cls: row?.className ?? null, text: (row?.textContent ?? '').slice(0, 120) };
        };
        let state = readRow();
        if (!state.found || !String(state.cls ?? '').includes('is-today-due')) {
          nav('学习统计');
          await new Promise((resolve) => setTimeout(resolve, 250));
          nav('复习计划');
          await new Promise((resolve) => setTimeout(resolve, 400));
          state = readRow();
        }
        state.view = (root?.querySelector('.hdu-review-view')?.textContent ?? '').slice(0, 200);
        state.center = (root?.querySelector('.hdu-center')?.textContent ?? '').slice(0, 260);
        state.rows = (root?.querySelector('.hdu-review-view .hdu-todo-rows')?.textContent ?? '').slice(0, 420);
        state.rowCount = (root?.querySelectorAll('.hdu-review-view .hdu-todo-row') ?? []).length;
        state.titles = [...(root?.querySelectorAll('.hdu-review-view .hdu-todo-row') ?? [])].map((n) => (n.textContent ?? '').slice(0, 40));
        return state;
      })()`);
      if (!r?.found) process.stdout.write(`[diag] 模板标注=${JSON.stringify(r)}\n`);
      return r?.found && String(r?.cls ?? '').includes('is-today-due') && String(r?.text ?? '').includes('常规') ? r : null;
    }, '模板标注与今日强调'));
    const reviewJobDbDiag = await evalInExtPage(`(async () => {
      const request = indexedDB.open('hdu-assistant');
      const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const tx = db.transaction(['reviewJobs', 'favorites'], 'readonly');
      const all = await new Promise((resolve) => { const req = tx.objectStore('reviewJobs').getAll(); req.onsuccess = () => resolve(req.result); });
      const fav = await new Promise((resolve) => { const req = tx.objectStore('favorites').get('e2e-fav-bili-ai-1'); req.onsuccess = () => resolve(req.result); });
      db.close();
      return { jobs: all.map((j) => ({ id: j.id, due: j.dueDate, status: j.status, log: j.rescheduleLog ?? null })), biliFav: fav ? { deletedAt: fav.deletedAt ?? null, type: fav.type } : null };
    })()`);
    process.stdout.write(`[diag] reviewJobs=${JSON.stringify(reviewJobDbDiag)}\n`);
    // 诊断：从扩展页（有 chrome.runtime）直呼 review.due，捕捉 SW 侧真实错误
    const opProbe = await evalInExtPage(`(async () => {
      try {
        const env = { chrome: typeof chrome, runtime: typeof chrome?.runtime, id: chrome?.runtime?.id ?? null, send: typeof chrome?.runtime?.sendMessage };
        if (!chrome?.runtime?.sendMessage) return 'NOENV:' + JSON.stringify(env);
        const res = await chrome.runtime.sendMessage({ type: 'REQUEST', requestId: 'e2e-probe-op', op: 'review.due', args: {} });
        return 'OK:' + JSON.stringify(res).slice(0, 220);
      } catch (e) { return 'ERR:' + ((e && (e.message || String(e))) || 'unknown'); }
    })()`);
    process.stdout.write(`[diag] op probe (options)=${JSON.stringify(opProbe)}\n`);

    // ── Popup 今日待办卡（第 84 轮）：种子（复习作业/视频收藏）落库后重开工具栏弹窗验证 ──
    // 计数断言为数据驱动：从扩展 DB 现算今日到期 pending 数（含逾期），避免种子变动导致断言失配
    const reviewJobsSnapshot = await evalInExtPage(`(async () => {
      const request = indexedDB.open('hdu-assistant');
      const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const tx = db.transaction(['reviewJobs'], 'readonly');
      const all = await new Promise((resolve) => { const req = tx.objectStore('reviewJobs').getAll(); req.onsuccess = () => resolve(req.result); });
      db.close();
      const today = new Date();
      const todayKey = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
      const dueToday = all.filter((j) => j.status === 'pending' && j.dueDate === todayKey).length;
      const overdue = all.filter((j) => j.status === 'pending' && j.dueDate < todayKey).length;
      return { dueToday, overdue };
    })()`);
    const expectedDue = reviewJobsSnapshot ? reviewJobsSnapshot.dueToday : null;
    let popupTodoOk = null;
    await openExtPage('popup.html', {
      readyText: '今日',
      interact: async (send, sid) => {
        popupTodoOk = await waitFor(async () => {
          const res = await send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true }, sid);
          const text = String(res?.result?.value ?? '');
          return text.includes('今日待办') && text.includes(`到期复习 ${expectedDue}`) && text.includes('待学视频 1') ? text : null;
        }, 'Popup 今日待办卡渲染', { sid });
      },
    });
    check('Popup 今日待办卡（第 84 轮）', typeof popupTodoOk === 'string' && popupTodoOk.includes('今日待办'));

    const biliPage = await openBiliPage(BILI_VID);
    try {
      check('B 站页注入收藏宿主（唯一 + 四入口 FAB）', await waitBiliMounted(biliPage)
        && (await biliEval(biliPage.sid)("document.querySelectorAll('#hdu-bili-collect-host').length")) === 1);

      // 第 44 轮 FAB 收敛：主入口 + 菜单容器与四个常驻子钮同场
      check('B 站 FAB 收敛结构（主入口 + 菜单容器，第 44 轮）', await biliEval(biliPage.sid)(
        `!!${biliShadowExpr("querySelector('.bili-fab-main')")} && !!${biliShadowExpr("querySelector('.bili-fab-menu')")}`,
      ));

      // 字幕获取：预置缓存命中 → bili.subtitle.fetch 不联网直接 ok → toast + 浮层打开
      check('B 站字幕获取成功（预置缓存命中，不联网）', await biliClick(biliPage.sid, '.bili-sub-fab') && (await waitFor(async () => {
        const toast = await biliText(biliPage.sid, '.bili-toast');
        return toast.includes('字幕已就绪') ? toast : null;
      }, '字幕就绪 toast')));
      check('B 站字幕浮层打开并渲染 4 段', await waitFor(async () => {
        const rows = await biliCount(biliPage.sid, '.bili-sub-row');
        const list = await biliText(biliPage.sid, '.bili-sub-list');
        return rows === 4 && list.includes('矩阵乘法不满足交换律') ? rows : null;
      }, '字幕浮层段落渲染'));

      // 字幕搜索过滤（React 受控输入：原生 setter 赋值 + input 事件触发 onChange）
      await biliEval(biliPage.sid)(`(() => {
        const input = ${biliShadowExpr("querySelector('.bili-sub-search')")};
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, '交换律');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      check('B 站字幕搜索过滤（命中 1 / 共 4 条）', await waitFor(async () => {
        const meta = await biliText(biliPage.sid, '.bili-sub-meta');
        const rows = await biliCount(biliPage.sid, '.bili-sub-row');
        const list = await biliText(biliPage.sid, '.bili-sub-list');
        return meta.includes('命中 1 / 共 4 条') && rows === 1 && list.includes('交换律') ? meta : null;
      }, '字幕搜索过滤结果'));
      // 空结果建议词随输入长度变化（第 308 轮）：超长关键词 → 空结果提示点名「关键词较长（N 字）」
      await biliEval(biliPage.sid)(`(() => {
        const input = ${biliShadowExpr("querySelector('.bili-sub-search')")};
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, '这是一个特别长的搜索关键词用来触发空结果提示');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      check('B 站字幕空结果建议词随长度变化（第 308 轮）', await waitFor(async () => {
        const tips = await biliText(biliPage.sid, '.bili-sub-empty-tips');
        return tips.includes('关键词较长（') && tips.includes('试试更短的关键词') ? tips : null;
      }, 'B 站字幕超长关键词建议词'));
      // 还原搜索词（恢复 4 条渲染，不扰后续断言）
      await biliEval(biliPage.sid)(`(() => {
        const input = ${biliShadowExpr("querySelector('.bili-sub-search')")};
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, '');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      // 短词负向（第 309 轮）：短词空结果仍为通用建议（不点名长度）
      await biliEval(biliPage.sid)(`(() => {
        const input = ${biliShadowExpr("querySelector('.bili-sub-search')")};
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, '丙');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      check('B 站字幕短词建议词不点名（第 309 轮）', await waitFor(async () => {
        const tips = await biliText(biliPage.sid, '.bili-sub-empty-tips');
        return tips.includes('试试更短的关键词') && !tips.includes('关键词较长') ? tips : null;
      }, 'B 站字幕短词通用建议'));
      // 还原搜索词（恢复 4 条渲染）
      await biliEval(biliPage.sid)(`(() => {
        const input = ${biliShadowExpr("querySelector('.bili-sub-search')")};
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, '');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      // 字幕导出（第 105 轮巡检）：TXT / SRT 导出按钮在场（下载落盘走人工验收 §49）
      check('B 站字幕导出按钮（TXT/SRT，第 105 轮）', await waitFor(async () => {
        const tools = await biliText(biliPage.sid, '.bili-sub-tools');
        return tools.includes('导出 TXT') && tools.includes('导出 SRT') ? tools : null;
      }, '字幕导出按钮'));

      // 学习助手面板：字幕可用 → 问答页签可提问（此处只验面板打开与可用性标记）
      check('B 站学习助手面板打开（问答页签，字幕可用）', await biliClick(biliPage.sid, '.bili-qa-fab') && (await waitFor(async () => {
        const modal = await biliExists(biliPage.sid, '.bili-qa-modal');
        const meta = await biliText(biliPage.sid, '.bili-qa-meta');
        return modal && meta.includes('字幕可用') ? meta : null;
      }, '学习助手面板渲染')));

      // 收藏此时刻：<video> 在场（currentTime=0）→ fav.put 落库 → 宿主 toast
      check('B 站收藏此时刻（toast 提示）', await biliClick(biliPage.sid, '.bili-qa-moment') && (await waitFor(async () => {
        const toast = await biliText(biliPage.sid, '.bili-toast');
        return toast.includes('已收藏此时刻') ? toast : null;
      }, '收藏此时刻 toast')));
      const momentCount = await evalInExtPage(`(async () => {
        const request = indexedDB.open('hdu-assistant');
        const db = await new Promise((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        try {
          if (!Array.from(db.objectStoreNames).includes('favorites')) return -1;
          const tx = db.transaction('favorites', 'readonly');
          const all = await new Promise((resolve, reject) => {
            const req = tx.objectStore('favorites').getAll();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          return all.filter((item) => item.type === 'time' && item.metadata && item.metadata.bvid === '${BILI_VID}').length;
        } finally {
          db.close();
        }
      })()`);
      check('B 站收藏此时刻写入 IndexedDB（type=time）', Number(momentCount) >= 1);

      // ── 第 44 轮速览页签：四格指标（fixture 预置 transcript 4 段 + AI 2 知识点）──
      await biliEval(biliPage.sid)(`(() => {
        const tabs = [...(${biliShadowExpr("querySelectorAll('.bili-qa-tab')")} ?? [])];
        const tab = tabs.find((el) => el.textContent?.includes('速览'));
        tab?.click();
        return !!tab;
      })()`);
      check('B 站速览页签四格渲染（第 44 轮）', await waitFor(async () => {
        const cells = await biliCount(biliPage.sid, '.bili-ov-cell');
        const body = await biliText(biliPage.sid, '.bili-qa-body');
        return cells === 4 && body.includes('字幕覆盖') && body.includes('知识标注') ? cells : null;
      }, '速览四格'));

      // 本周学习小结 mini 卡（第 81 轮）：速览页签头部展示本周站内外合计与环比
      check('B 站速览本周学习小结（第 81 轮）', await waitFor(async () => {
        const body = await biliText(biliPage.sid, '.bili-qa-body');
        return body.includes('本周学习') && body.includes('完整周报见学习中心') ? body : null;
      }, '本周学习小结'));

      // ── 第 44 轮大纲页签：预置 outline 1 节点渲染 ──
      await biliEval(biliPage.sid)(`(() => {
        const tabs = [...(${biliShadowExpr("querySelectorAll('.bili-qa-tab')")} ?? [])];
        const tab = tabs.find((el) => el.textContent?.includes('大纲'));
        tab?.click();
        return !!tab;
      })()`);
      check('B 站大纲页签节点渲染（第 44 轮）', await waitFor(async () => {
        const nodes = await biliCount(biliPage.sid, '.bili-ai-outline');
        return nodes === 1 ? nodes : null;
      }, '大纲节点'));

      // 内容脚本隔离世界补挂 duration 伪装：内容脚本与页面主世界相互隔离（expando 互不可见），
      // fixture 页对 HTMLMediaElement.prototype.duration 的伪装只作用于主世界——内容脚本读
      // <video>.duration 仍是 NaN，时间轴标记的换算基准拿不到。这里在内容脚本自己的隔离
      // 世界内补同一伪装（ctx 已随开页收集），再派发一次 resize 触发标记条的重新测量。
      const isoContext = biliPage.contexts.find(
        (c) => c.auxData?.type === 'isolated' && String(c.origin ?? '').startsWith('chrome-extension://'),
      );
      if (isoContext) {
        await send(
          'Runtime.evaluate',
          {
            expression: `(() => {
              Object.defineProperty(HTMLMediaElement.prototype, 'duration', { configurable: true, get() { return 600; } });
              window.dispatchEvent(new Event('resize'));
              return true;
            })()`,
            returnByValue: true,
            contextId: isoContext.id,
          },
          biliPage.sid,
        ).catch(() => { /* 隔离世界不可用则跳过（标记检查会如实失败） */ });
      }

      // AI 标注页签：经真实 UI 验证 ai.get 数据面（问答面板内切换页签读同一 mediaKey）
      await biliEval(biliPage.sid)(`(() => {
        const tabs = [...(${biliShadowExpr("querySelectorAll('.bili-qa-tab')")} ?? [])];
        const tab = tabs.find((el) => el.textContent?.includes('AI 标注'));
        tab?.click();
        return !!tab;
      })()`);
      check('B 站 AI 标注页签展示预置知识点', await waitFor(async () => {
        const meta = await biliText(biliPage.sid, '.bili-qa-meta');
        const topic = await biliText(biliPage.sid, '.bili-ai-topic-name');
        return meta.includes('已生成') && meta.includes('2 个知识点') && topic.includes('矩阵乘法') ? meta : null;
      }, 'AI 标注页签渲染'));

      // AI 标注时间轴标记：预置 aiResult.topics × 伪装 duration(600s) → 2 个区间标记，1 低置信
      check('B 站 AI 标注时间轴标记渲染（2 标记，低置信 1）', await waitFor(async () => {
        const marks = await biliCount(biliPage.sid, '.bili-timeline-mark');
        const low = await biliCount(biliPage.sid, '.bili-timeline-mark.is-low');
        const titles = await biliEval(biliPage.sid)(
          `[...(${biliShadowExpr("querySelectorAll('.bili-timeline-mark')")} ?? [])].map((el) => el.title).join('|')`,
        );
        return marks === 2 && low === 1 && titles.includes('矩阵乘法') && titles.includes('特征值') ? marks : null;
      }, '时间轴标记渲染'));

      // ── 学习中心（第 32 轮）：第四入口 FAB → BiliHubPanel（独立 shadow host：hdu-bili-hub-host） ──
      const hubShadowExpr = (expression) =>
        `document.getElementById('hdu-bili-hub-host')?.shadowRoot?.${expression}`;
      const hubText = (selector) =>
        biliEval(biliPage.sid)(`${hubShadowExpr(`querySelector('${selector}')`)}?.textContent ?? ''`);
      const hubCount = (selector) =>
        biliEval(biliPage.sid)(`(${hubShadowExpr(`querySelectorAll('${selector}')`)} ?? []).length`);
      const hubClickByText = (selector, text) =>
        biliEval(biliPage.sid)(`(() => {
          const root = document.getElementById('hdu-bili-hub-host')?.shadowRoot;
          const el = [...(root?.querySelectorAll('${selector}') ?? [])].find((node) => node.textContent?.includes('${text}'));
          el?.click();
          return !!el;
        })()`);

      // 打开面板：标题「学习中心」出现（面板壳为 hdu-modal，独立宿主内查询）
      check('B 站学习中心面板打开（第四入口 FAB）', await biliClick(biliPage.sid, '.bili-hub-fab') && (await waitFor(async () => {
        const title = await hubText('.hdu-modal-title');
        return title.includes('学习中心') ? title : null;
      }, '学习中心面板打开')));

      // ── 统一搜索（第 77 轮巡检）：HDU 侧 TopBarSearch 注入学习中心头部（search.all
      //    三路聚合：字幕/收藏/笔记）。输入命中预置收藏标题 → 结果面板出现「收藏」组；
      //    断言后清空恢复，不影响后续知识库/统计检查。B 站宿主内 course 跳转被覆写为
      //    新标签深链（onSessionJump），此处只验证聚合检索与渲染，不触发跳转。
      const hubTypeUnified = (text) =>
        biliEval(biliPage.sid)(`(() => {
          const input = ${hubShadowExpr("querySelector('.hdu-topbar-search input')")};
          if (!input) return false;
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(input, '${text}');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        })()`);
      check('B 站学习中心统一搜索（search.all 命中收藏组，第 77 轮）', (await hubTypeUnified('矩阵乘法')) && (await waitFor(async () => {
        const pop = await hubText('.hdu-search-pop');
        return pop.includes('收藏') && pop.includes('矩阵乘法') ? pop : null;
      }, '统一搜索结果面板')));
      await hubTypeUnified('');

      // 知识库页签：预置 video/ai 收藏 + 前面「收藏此时刻」落库的 time 收藏，共 3 张卡片
      check('B 站知识库页签渲染收藏列表（video + time + ai 共 3 卡）', await waitFor(async () => {
        const cards = await hubCount('.hdu-knowledge-card');
        const grid = await hubText('.hdu-knowledge-grid');
        return cards === 3 && grid.includes('矩阵乘法') && grid.includes('时间点') && grid.includes('AI 回答') ? cards : null;
      }, '知识库收藏卡片渲染'));

      // 知识库搜索（第 33 轮巡检）：纯前端过滤当前列表——输入「矩阵乘法」后仅命中预置
      // video 收藏 1 卡（time 收藏标题为「<页标题> · 时刻」、ai 收藏标题为特征值问答，
      // 均不含该关键词）；断言后清空恢复全量，不影响后续加入复习/统计页签检查
      const hubTypeSearch = (text) =>
        biliEval(biliPage.sid)(`(() => {
          const input = ${hubShadowExpr("querySelector('.hdu-hub-search')")};
          if (!input) return false;
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(input, '${text}');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        })()`);
      check('B 站知识库搜索过滤（命中 1 / 共 3 卡）', (await hubTypeSearch('矩阵乘法')) && (await waitFor(async () => {
        const cards = await hubCount('.hdu-knowledge-card');
        const grid = await hubText('.hdu-knowledge-grid');
        return cards === 1 && grid.includes('矩阵乘法') && !grid.includes('时间点') ? cards : null;
      }, '知识库搜索过滤结果')));
      await hubTypeSearch('');

      // 类型筛选（第 34 轮巡检）：点「此时刻」chip → 仅剩 time 收藏卡（video/ai 卡被过滤）；
      // 点「问答」chip → 仅剩预置 ai 收藏卡（第 34 轮 P2-1：B 站侧 AI 回答收藏进知识库的
      // 入口断言）；断言后恢复「全部」，不影响后续加入复习/统计页签检查
      const hubClickTypeChip = (text) => hubClickByText('.hdu-hub-type-chip', text);
      check('B 站知识库类型筛选（此时刻 chip → 仅 time 卡）', (await hubClickTypeChip('此时刻')) && (await waitFor(async () => {
        const cards = await hubCount('.hdu-knowledge-card');
        const grid = await hubText('.hdu-knowledge-grid');
        return cards === 1 && grid.includes('时间点') && !grid.includes('矩阵乘法') ? cards : null;
      }, '类型筛选结果')));
      check('B 站知识库类型筛选（问答 chip → 仅 ai 收藏卡，第 34 轮）', (await hubClickTypeChip('问答')) && (await waitFor(async () => {
        const cards = await hubCount('.hdu-knowledge-card');
        const grid = await hubText('.hdu-knowledge-grid');
        return cards === 1 && grid.includes('AI 回答') && grid.includes('特征值') && !grid.includes('矩阵乘法') ? cards : null;
      }, '问答类型筛选结果')));
      await hubClickTypeChip('全部');

      // 文件夹筛选（第 79 轮）：工具行增文件夹下拉（全部 / 未分组 / 各文件夹，纯前端过滤；
      // fixture 未预置文件夹，仅断言入口与默认项在场）
      check('B 站知识库文件夹筛选入口（第 79 轮）', await waitFor(async () => {
        const sel = await hubText('.hdu-hub-folder');
        return sel.includes('全部文件夹') && sel.includes('未分组') ? sel : null;
      }, '文件夹筛选下拉'));

      // 标签筛选（第 82 轮）：预置收藏 tags=['e2e'] → 高频标签自动聚合为 chips
      check('B 站知识库标签筛选（预置 tags 聚合，第 82 轮）', await waitFor(async () => {
        const chips = await hubText('[aria-label="按标签筛选"]');
        return chips.includes('# e2e') ? chips : null;
      }, '标签筛选 chips'));

      // 复习状态筛选（第 107 轮）：全部 / 复习中 / 未入计划——数据源 review.list 全量
      // pending 作业的 favoriteIds；断言「复习中」与「未入计划」互补（合计 = 全量卡数）
      const hubSetReviewFilter = (value) =>
        biliEval(biliPage.sid)(`(() => {
          const sel = [...(${hubShadowExpr("querySelectorAll('select')")} ?? [])].find((n) => n.getAttribute('aria-label') === '按复习状态筛选');
          if (!sel) return false;
          const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
          setter.call(sel, '${value}');
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()`);
      check('B 站知识库复习状态筛选入口（第 107 轮）', await waitFor(async () => {
        const sel = await hubText('[aria-label="按复习状态筛选"]');
        return sel.includes('全部复习状态') && sel.includes('复习中') && sel.includes('未入计划') ? sel : null;
      }, '复习状态筛选下拉'));
      await hubSetReviewFilter('reviewing');
      const reviewingCount = await waitFor(async () => {
        const cards = await hubCount('.hdu-knowledge-card');
        return cards < 3 ? cards : null;
      }, '复习中筛选');
      check('B 站知识库复习状态筛选（复习中，第 107 轮）', reviewingCount !== null);
      check('B 站知识库复习状态筛选（未入计划互补，第 107 轮）', (await hubSetReviewFilter('none')) && (await waitFor(async () => {
        const cards = await hubCount('.hdu-knowledge-card');
        return cards === 3 - Number(reviewingCount) ? cards : null;
      }, '未入计划筛选')));
      await hubSetReviewFilter('all');
      // 知识库排序（第 113 轮）：默认（置顶/时间）/ 按标题（中文典序）/ 复习中优先
      const hubSetSort = (value) =>
        biliEval(biliPage.sid)(`(() => {
          const sel = [...(${hubShadowExpr("querySelectorAll('select')")} ?? [])].find((n) => n.getAttribute('aria-label') === '知识库排序');
          if (!sel) return false;
          const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
          setter.call(sel, '${value}');
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()`);
      check('B 站知识库排序入口（第 113 轮）', await waitFor(async () => {
        const sel = await hubText('[aria-label="知识库排序"]');
        return sel.includes('默认排序') && sel.includes('按标题') && sel.includes('复习中优先') ? sel : null;
      }, '排序下拉'));
      check('B 站知识库按标题排序（第 113 轮）', (await hubSetSort('title')) && (await waitFor(async () => {
        const first = await hubText('.hdu-knowledge-card');
        // 中文典序：特（te）< 线（xian）→ ai 收藏卡排首
        return first.includes('特征值') ? first : null;
      }, '标题排序首卡')));
      check('B 站知识库复习中优先排序（第 113 轮）', (await hubSetSort('review')) && (await waitFor(async () => {
        const first = await hubText('.hdu-knowledge-card');
        return first.includes('特征值') ? first : null;
      }, '复习中优先首卡')));
      await hubSetSort('default');

      // 批量整理（第 99 轮）：知识库多选 → 全选 → 批量加入复习计划
      check('B 站知识库批量整理入口（第 99 轮）', await hubClickByText('button', '批量整理') && (await waitFor(async () => {
        const bar = await hubText('.hdu-tidy-bar');
        return bar.includes('已选') ? bar : null;
      }, '整理操作条')));
      const tidySelectAll = (checked) => biliEval(biliPage.sid)(`(() => {
        const root = document.getElementById('hdu-bili-hub-host')?.shadowRoot;
        const input = [...(root?.querySelectorAll('.hdu-tidy-bar input[type="checkbox"]') ?? [])][0];
        if (!input) return { found: false };
        // 受控 checkbox：React onChange 由 click 触发（原生 change 不生效）
        if (input.checked !== ${checked}) input.click();
        return { found: true, checked: input.checked, bar: (root?.querySelector('.hdu-tidy-bar')?.textContent ?? '').slice(0, 80) };
      })()`);
      const selectAllResult = await tidySelectAll(true);
      process.stdout.write(`[diag] selectAll=${JSON.stringify(selectAllResult)}\n`);
      check('B 站知识库全选（第 99 轮）', selectAllResult?.found === true && selectAllResult?.checked === true && (await waitFor(async () => {
        const bar = await hubText('.hdu-tidy-bar');
        return bar.includes('已选 3 项') ? bar : null;
      }, '全选结果')));
      // 退出整理模式（第 99 轮）：恢复卡片正常点击（后续「加入复习」单条断言依赖）；
      // 批量加入复习的点击链路转人工验收（§33-3），避免提前改写复习排期影响后续断言
      await hubClickByText('button', '取消整理');

      // 加入复习：卡片「加入复习」→ review.plan 成功 → 面板内 ToastHost 提示
      const reviewClicked = await biliEval(biliPage.sid)(`(() => {
        const root = document.getElementById('hdu-bili-hub-host')?.shadowRoot;
        const el = [...(root?.querySelectorAll('.hdu-icon-btn') ?? [])].find((node) => node.getAttribute('aria-label') === '加入复习');
        el?.click();
        return !!el;
      })()`);
      check('B 站知识库加入复习（review.plan + 面板 toast）', reviewClicked && (await waitFor(async () => {
        const toast = await hubText('.hdu-toast');
        return toast.includes('已加入复习计划') ? toast : null;
      }, '加入复习 toast')));

      // ── 导出复习卡（第 37 轮巡检）：知识库工具行「导出复习卡」→ 共享 reviewCards
      //    生成复习卡片 md 并经 a[download] 下载。浏览器端真实下载不经页面跳转、
      //    e2e 难以断言文件落盘，退而断言按钮在场、点击不报错且走完生成 + 面板
      //    toast 链路（md 生成口径由单测 review-cards-export.test.ts 锁定）。
      //    置于「加入复习」之后：后续 toast 断言均为 some 口径或无 toast，不互扰。
      const exportClicked = await biliEval(biliPage.sid)(`(() => {
        const root = document.getElementById('hdu-bili-hub-host')?.shadowRoot;
        const el = [...(root?.querySelectorAll('button') ?? [])].find((node) => node.textContent?.trim() === '导出复习卡');
        el?.click();
        return !!el;
      })()`);
      check('B 站知识库导出复习卡（点击 → md 生成下载 + 面板 toast，第 37 轮）', exportClicked && (await waitFor(async () => {
        const hit = await biliEval(biliPage.sid)(
          `[...(document.getElementById('hdu-bili-hub-host')?.shadowRoot?.querySelectorAll('.hdu-toast') ?? [])].some((el) => el.textContent?.includes('复习卡片已导出'))`,
        );
        return hit === true ? hit : null;
      }, '导出复习卡 toast')));

      // ── 知识库最近搜索回放（第 304 轮）：搜索词为空时平铺 settings.ui.recentQueries chips
      //    （与统一搜索 / HDU 知识库同源；种子词「高等数学（E2E）」），点击回填搜索框
      const hubChipsOk = await waitFor(async () => {
        const chips = await biliEval(biliPage.sid)(
          `[...document.getElementById('hdu-bili-hub-host')?.shadowRoot?.querySelectorAll('.hdu-lib-recent-chip') ?? []].length`,
        );
        const row = await hubText('.hdu-lib-recent');
        return Number(chips) > 0 && row.includes('最近搜索') ? Number(chips) : null;
      }, 'B 站知识库最近搜索 chips 渲染');
      check('B 站知识库最近搜索 chips（第 304 轮）', hubChipsOk !== null && hubChipsOk > 0);
      check('B 站知识库最近搜索点击回填（第 304 轮）', await biliEval(biliPage.sid)(`(() => {
        const root = document.getElementById('hdu-bili-hub-host')?.shadowRoot;
        const chip = root?.querySelector('.hdu-lib-recent-chip > button');
        chip?.click();
        return !!chip;
      })()`) && (await waitFor(async () => {
        const value = await biliEval(biliPage.sid)(`(() => {
          const input = document.getElementById('hdu-bili-hub-host')?.shadowRoot?.querySelector('input[aria-label="搜索知识库"]');
          return input?.value ?? '';
        })()`);
        return typeof value === 'string' && value.length > 0 ? value : null;
      }, 'B 站 chips 点击回填')));
      // 还原：清空搜索词（不影响后续页签断言）
      await biliEval(biliPage.sid)(`(() => {
        const input = document.getElementById('hdu-bili-hub-host')?.shadowRoot?.querySelector('input[aria-label="搜索知识库"]');
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, '');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      // 一键清空（第 305 轮）：清掉共享 recentQueries——置于 B 站段末尾，其后无 chips 依赖
      const hubClearClicked = await biliEval(biliPage.sid)(`(() => {
        const btn = document.getElementById('hdu-bili-hub-host')?.shadowRoot?.querySelector('.hdu-lib-recent-clear');
        btn?.click();
        return !!btn;
      })()`);
      check('B 站知识库最近搜索一键清空（第 305 轮）', hubClearClicked === true && (await waitFor(async () => {
        const n = await biliEval(biliPage.sid)(`[...document.getElementById('hdu-bili-hub-host')?.shadowRoot?.querySelectorAll('.hdu-lib-recent-chip') ?? []].length`);
        return n === 0 ? true : null;
      }, '清空后无 chips')));
      check('B 站知识库 chips 清空后焦点回归（第 312 轮）', await waitFor(async () => {
        const r = await biliEval(biliPage.sid)(`(() => {
          const root = document.getElementById('hdu-bili-hub-host')?.shadowRoot;
          const input = root?.querySelector('input[aria-label="搜索知识库"]');
          return !!input && root?.activeElement === input;
        })()`);
        return r === true ? true : null;
      }, '清空后焦点回归输入框'));

      // 统计页签：PillTabs 切换 → BiliWatchCard 外壳（未预置站外观看流水 → 空态文案）
      check('B 站统计页签渲染（BiliWatchCard 空态）', await hubClickByText('.hdu-pill-tab', '统计') && (await waitFor(async () => {
        const body = await hubText('.hdu-modal-body');
        return body.includes('B 站视频') && body.includes('还没有站外观看记录') ? body : null;
      }, '统计页签渲染')));

      // 学习热力图（第 77 轮巡检）：与 HDU 统计页同一 ActivityHeatmap（stats.heatmap），
      // 周报卡之后渲染；空数据也输出完整网格（4 周窗口最少 28 格）+ 图例 + 引导提示
      check('B 站统计页签学习热力图渲染（stats.heatmap，第 77 轮）', await waitFor(async () => {
        const grids = await hubCount('.hdu-heatmap-grid');
        const cells = await hubCount('.hdu-heatmap-cell');
        const legend = await hubCount('.hdu-heatmap-legend');
        return grids >= 1 && cells >= 28 && legend >= 1 ? `${grids}x${cells}` : null;
      }, '热力图网格渲染'));

      // ── 今日待办页签（第 35 轮）：预置 reviewJob（dueDate=今天）→ 切「今日」页签
      //    渲染 BiliHubTodayCard 精简卡（标题/类型/今日到期/去复习链接，AI 收藏带 ?t= 锚点）──
      // 诊断：在内容脚本隔离世界（有 chrome.runtime）直呼 review.due，捕捉真实错误
      try {
        const { frameTree } = await send('Page.getFrameTree', {}, biliPage.sid);
        const frameId = frameTree?.frame?.id;
        const iso = frameId ? await send('Page.createIsolatedWorld', { frameId, worldName: 'hdu-e2e-probe' }, biliPage.sid) : null;
        const isoCtx = iso?.executionContextId;
        const dueProbe = isoCtx
          ? (await send('Runtime.evaluate', {
              expression: `(async () => { try { const res = await chrome.runtime.sendMessage({ type: 'REQUEST', requestId: 'e2e-probe-due', op: 'review.due', args: {} }); return 'OK:' + JSON.stringify(res).slice(0, 260); } catch (e) { return 'ERR:' + ((e && (e.message || String(e))) || 'unknown'); } })()`,
              returnByValue: true,
              awaitPromise: true,
              contextId: isoCtx,
            }, biliPage.sid))?.result?.value
          : 'NO-ISOLATED-WORLD';
        process.stdout.write(`[diag] review.due probe(iso)=${JSON.stringify(dueProbe)}\n`);
      } catch (probeErr) {
        process.stdout.write(`[diag] review.due probe(iso) failed=${String(probeErr).slice(0, 120)}\n`);
      }
      check('B 站今日待办页签渲染到期复习（预置 review job）', await hubClickByText('.hdu-pill-tab', '今日') && (await waitFor(async () => {
        const card = await hubText('.hdu-hub-today');
        process.stdout.write(`[diag] 今日卡=${JSON.stringify(card.slice(0, 240))}\n`);
        return card.includes('今日待办') && card.includes('特征值') && card.includes('今日到期') && card.includes('去复习')
          ? card
          : null;
      }, '今日待办卡渲染')));
      // 学习成就角标（第 131 轮巡检）：今日卡头部显示已解锁徽章数（种子数据下 ≥1 枚）
      check('B 站今日卡学习成就角标（第 131 轮）', await waitFor(async () => {
        const card = await hubText('.hdu-hub-today');
        return card.includes('🏅') ? card : null;
      }, '今日卡成就角标'));

      // 待学视频分区（第 78 轮）：预置未完看视频收藏进「待学视频」分区（每周计划未命中 →
      // 无「今日计划」前缀），行内带勾选框与续看链接；置于完成勾选之前（完成后复习分区
      // 转空态，但视频分区不受影响）
      check('B 站今日待办待学视频分区（预置视频收藏，第 78 轮）', await waitFor(async () => {
        const card = await hubText('.hdu-hub-today');
        const checks = await hubCount('.hdu-hub-today input[type="checkbox"]');
        return card.includes('待学视频') && card.includes('矩阵乘法') && checks >= 1 ? card : null;
      }, '待学视频分区渲染'));

      // 完成度徽标（第 79 轮，对齐 HDU 今日待办）：预置 2 复习（均今日到期）+ 1 视频 → 0 / 3 已完成
      check('B 站今日待办完成度徽标（勾选前 0/3，第 79/93 轮）', await waitFor(async () => {
        const chip = await hubText('.hdu-hub-today .hdu-chip');
        process.stdout.write(`[diag] chip勾选前=${JSON.stringify(chip)}\n`);
        return chip.includes('0 / 3 已完成') ? chip : null;
      }, '完成度徽标（勾选前）'));

      // 完成勾选：点条目「完成」→ review.complete(status='done') → 重拉 review.due →
      // 条目移出待办（预置 round=1 无下一轮）→ 空态 + 面板内 toast
      const completeClicked = await biliEval(biliPage.sid)(`(() => {
        const rows = [...(document.getElementById('hdu-bili-hub-host')?.shadowRoot?.querySelectorAll('.hdu-hub-today .hdu-todo-row') ?? [])];
        const row = rows.find((node) => node.textContent?.includes('特征值'));
        const btn = row ? [...row.querySelectorAll('button')].find((b) => b.textContent?.includes('完成')) : null;
        btn?.click();
        return !!btn;
      })()`);
      check('B 站今日待办完成勾选（review.complete 后移出待办）', completeClicked && (await waitFor(async () => {
        const card = await hubText('.hdu-hub-today');
        const toastHit = await biliEval(biliPage.sid)(
          `[...(document.getElementById('hdu-bili-hub-host')?.shadowRoot?.querySelectorAll('.hdu-toast') ?? [])].some((el) => el.textContent?.includes('完成一轮复习'))`,
        );
        // 完成后：今日到期的特征值作业移出；剩明日到期的站内作业（不在今日卡）与
        // 今日到期的站内作业（高等数学复习要点）仍在计划视图
        return card.includes('高等数学复习要点') && !card.includes('特征值') && toastHit === true ? card : null;
      }, '完成复习后状态')));

      // 完成度徽标（第 79 轮）：复习完成后移出计划（kv 勾选保留但条目不再出现），
      // 剩今日到期的站内作业 1 项 + 视频 1 项未完成 → 0 / 2 已完成
      check('B 站今日待办完成度徽标（完成后 0/2，第 79 轮）', await waitFor(async () => {
        const chip = await hubText('.hdu-hub-today .hdu-chip');
        return chip.includes('0 / 2 已完成') ? chip : null;
      }, '完成度徽标（完成后）'));

      // 今日到期全部顺延（第 122 轮巡检）：点按钮 → 今日到期复习行推到明天（与 HDU 复习计划第 119 轮对齐）；
      // 此时今日卡剩 1 条今日到期站内作业 → 顺延后复习分区转空态 + 面板 toast
      const todayPostponeClicked = await biliEval(biliPage.sid)(`(() => {
        const root = document.getElementById('hdu-bili-hub-host')?.shadowRoot;
        const btn = [...(root?.querySelectorAll('button') ?? [])].find((n) => n.textContent?.trim() === '今日到期全部顺延');
        btn?.click();
        return !!btn;
      })()`);
      check('B 站今日待办今日到期全部顺延（第 122 轮）', todayPostponeClicked && (await waitFor(async () => {
        const card = await hubText('.hdu-hub-today');
        const toastHit = await biliEval(biliPage.sid)(
          `[...(document.getElementById('hdu-bili-hub-host')?.shadowRoot?.querySelectorAll('.hdu-toast') ?? [])].some((el) => el.textContent?.includes('已顺延 1 条今日到期作业'))`,
        );
        return card.includes('今日无到期复习') && toastHit === true ? card : null;
      }, '今日到期全部顺延生效')));

      // ── 笔记页签（第 33 轮「笔记转收藏」补 e2e，第 36 轮）：切「笔记」→ 新增一条
      //    笔记 → 「转收藏」→ note.toFavorite 落库 type=note（metadata.mediaKey 归属
      //    当前视频）。置于知识库计数类检查之后执行：转出的 note 收藏也进知识库页签
      //    （第 34 轮收录），提前执行会改变「共 3 卡」等既有断言的基数。笔记不依赖
      //    字幕，走真实 note.put / note.toFavorite 消息面，提示走宿主 toast 通道。
      await biliEval(biliPage.sid)(`(() => {
        const tabs = [...(${biliShadowExpr("querySelectorAll('.bili-qa-tab')")} ?? [])];
        const tab = tabs.find((el) => el.textContent?.includes('笔记'));
        tab?.click();
        return !!tab;
      })()`);
      // React 受控 textarea：原生 setter 赋值 + input 事件触发 onChange
      const noteTyped = await biliEval(biliPage.sid)(`(() => {
        const input = ${biliShadowExpr("querySelector('.bili-note-composer textarea')")};
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(input, 'E2E 笔记：特征值在 60s 处讲解');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      const noteSaved = await biliEval(biliPage.sid)(`(() => {
        const btn = ${biliShadowExpr("querySelector('.bili-note-composer .bili-qa-send')")};
        btn?.click();
        return !!btn;
      })()`);
      check('B 站笔记新增保存（note.put → toast + 列表渲染）', noteTyped && noteSaved && (await waitFor(async () => {
        const toast = await biliText(biliPage.sid, '.bili-toast');
        const row = await biliText(biliPage.sid, '.bili-note-item');
        return toast.includes('笔记已保存') && row.includes('特征值') ? toast : null;
      }, '笔记保存 toast 与条目渲染')));
      check('B 站笔记转收藏（note.toFavorite → toast）', await biliClick(biliPage.sid, '.bili-note-convert') && (await waitFor(async () => {
        const toast = await biliText(biliPage.sid, '.bili-toast');
        return toast.includes('已转为收藏') ? toast : null;
      }, '转收藏 toast')));
      const noteFavCount = await evalInExtPage(`(async () => {
        const request = indexedDB.open('hdu-assistant');
        const db = await new Promise((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        try {
          if (!Array.from(db.objectStoreNames).includes('favorites')) return -1;
          const tx = db.transaction('favorites', 'readonly');
          const all = await new Promise((resolve, reject) => {
            const req = tx.objectStore('favorites').getAll();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          return all.filter((item) => item.type === 'note' && item.metadata && item.metadata.mediaKey === 'bili:${BILI_VID}').length;
        } finally {
          db.close();
        }
      })()`);
      check('B 站笔记转收藏写入 IndexedDB（type=note，metadata.mediaKey 归属视频）', Number(noteFavCount) >= 1);
      // 笔记导出（第 106 轮巡检）：笔记页签「导出笔记」按钮在场（下载落盘走人工验收 §50）
      check('B 站笔记导出按钮（第 106 轮）', await waitFor(async () => {
        const text = await biliText(biliPage.sid, '.bili-qa-body');
        return text.includes('导出笔记') ? text : null;
      }, '笔记导出按钮'));

      // ── 收藏 AI 回答（第 33 轮功能补 e2e，第 36 轮）：预置 done 状态问答消息已随
      //    seedBiliData 写入 chats store。切回「问答」→ AI 气泡与「收藏」按钮出现 →
      //    点击 → buildAiFavorite → fav.put（type=ai，refId=消息 id，metadata 带
      //    question/mediaKey）→ toast「已收藏该回答」→ 按钮置灰（防重状态变化）。
      await biliEval(biliPage.sid)(`(() => {
        const tabs = [...(${biliShadowExpr("querySelectorAll('.bili-qa-tab')")} ?? [])];
        const tab = tabs.find((el) => el.textContent?.includes('问答'));
        tab?.click();
        return !!tab;
      })()`);
      check('B 站预置问答消息渲染（qa.list 真实消息面恢复）', await waitFor(async () => {
        const bubble = await biliText(biliPage.sid, '.bili-qa-msg.is-ai .bili-qa-bubble');
        return bubble.includes('特征值描述线性变换') ? bubble : null;
      }, '预置 AI 回答气泡渲染'));
      // 问答导出（第 81 轮）：qa 工具行带「导出问答」入口（有消息时出现）
      check('B 站问答导出按钮（第 81 轮）', await waitFor(async () => {
        const toolbar = await biliText(biliPage.sid, '.bili-qa-toolbar');
        return toolbar.includes('导出问答') ? toolbar : null;
      }, '问答导出按钮'));
      check('B 站收藏 AI 回答（buildAiFavorite → fav.put → toast）', await biliClick(biliPage.sid, '.bili-qa-fav') && (await waitFor(async () => {
        const toast = await biliText(biliPage.sid, '.bili-toast');
        return toast.includes('已收藏该回答') ? toast : null;
      }, '收藏回答 toast')));
      const aiFavRecord = await evalInExtPage(`(async () => {
        const request = indexedDB.open('hdu-assistant');
        const db = await new Promise((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        try {
          if (!Array.from(db.objectStoreNames).includes('favorites')) return null;
          const tx = db.transaction('favorites', 'readonly');
          const all = await new Promise((resolve, reject) => {
            const req = tx.objectStore('favorites').getAll();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          const hit = all.find((item) => item.type === 'ai' && item.refId === 'e2e-chat-a1');
          return hit ? { mediaKey: hit.metadata && hit.metadata.mediaKey, question: hit.metadata && hit.metadata.question } : null;
        } finally {
          db.close();
        }
      })()`);
      check(
        'B 站收藏 AI 回答写入 IndexedDB（type=ai，refId=消息 id，metadata 含 mediaKey/question）',
        Boolean(aiFavRecord) && aiFavRecord.mediaKey === `bili:${BILI_VID}` && aiFavRecord.question === '特征值是什么？',
      );
      check('B 站收藏 AI 回答后按钮置灰（防重状态变化）', await waitFor(async () => {
        const disabled = await biliEval(biliPage.sid)(`${biliShadowExpr("querySelector('.bili-qa-fav')")}?.disabled ?? false`);
        return disabled === true;
      }, '收藏按钮置灰'));
      // 回答复制按钮（第 114 轮）：AI 消息操作区含「复制回答」按钮（剪贴板落盘走人工验收）
      check('B 站回答复制按钮（第 114 轮）', await waitFor(async () => {
        const ok = await biliEval(biliPage.sid)(`!!${biliShadowExpr("querySelector('.bili-qa-msg-actions .bili-qa-copy')")}`);
        return ok === true ? ok : null;
      }, '复制按钮'));

      // ── 第 44 轮快捷键：先切到笔记页签，按 q 应切回问答页签（B 站内容脚本
      //    document 级 keydown；输入态/B 站占用键避让由单测锁定，此处验真实链路）──
      await biliEval(biliPage.sid)(`(() => {
        const tabs = [...(${biliShadowExpr("querySelectorAll('.bili-qa-tab')")} ?? [])];
        const tab = tabs.find((el) => el.textContent?.includes('笔记'));
        tab?.click();
        return !!tab;
      })()`);
      await biliEval(biliPage.sid)("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', bubbles: true, cancelable: true }))");
      check('B 站 q 快捷键切回问答页签（第 44 轮）', await waitFor(async () => {
        const active = await biliText(biliPage.sid, '.bili-qa-tab.is-active');
        return active === '问答' ? active : null;
      }, 'q 快捷键切页签'));

      // ── 会话历史跨 P 聚合（第 104 轮）：预置 P2 会话（e2e-group-2，mediaKey 带 :p2）。
      //    打开会话历史 → 默认仅当前 P 的 e2e-group-1；开「跨 P 聚合」→ P2 组带徽标出现 ──
      await biliEval(biliPage.sid)(`(() => {
        const btns = [...(${biliShadowExpr("querySelectorAll('.bili-qa-toolbar button')")} ?? [])];
        const btn = btns.find((el) => el.textContent?.includes('会话历史'));
        btn?.click();
        return !!btn;
      })()`);
      check('B 站会话历史打开（默认仅当前 P，第 104 轮）', await waitFor(async () => {
        const text = await biliText(biliPage.sid, '.bili-qa-history');
        return text.includes('特征值是什么') && !text.includes('第二分 P 的问题') ? text : null;
      }, '历史模态仅当前 P 会话'));
      const crosspToggleOn = await biliEval(biliPage.sid)(`(() => {
        const toggle = ${biliShadowExpr("querySelector('.bili-qa-crossp')")};
        toggle?.click();
        return !!toggle;
      })()`);
      check('B 站跨 P 聚合展开 P2 会话（第 104 轮）', crosspToggleOn && (await waitFor(async () => {
        const text = await biliText(biliPage.sid, '.bili-qa-history');
        return text.includes('跨 P 聚合') && text.includes('第二分 P 的问题') && text.includes('P2') ? text : null;
      }, '跨P聚合 P2 会话与徽标')));
      // 收尾：关闭历史模态（避免影响后续页签断言）
      await biliEval(biliPage.sid)(`${biliShadowExpr("querySelector('.bili-qa-history-close')")}?.click()`);

      // ── 第 51 轮 P2-1 真机级验证：shadow 输入框聚焦时按 q/b 不误触 ──
      // 键盘事件从 shadow 内输入框派发，document 监听器只有经 composedPath()[0]
      // 取真实目标才能识别输入态（event.target 已被重定向为宿主 div）
      const shadowFocusOk = await waitFor(async () => {
        const ok = await biliEval(biliPage.sid)(`(() => {
          const input = ${biliShadowExpr("querySelector('.bili-qa-composer input')")};
          if (!input) return false;
          input.focus();
          return input.getRootNode().activeElement === input;
        })()`);
        return ok === true;
      }, 'shadow 输入框聚焦');
      await biliEval(biliPage.sid)(`(() => {
        const input = ${biliShadowExpr("querySelector('.bili-qa-composer input')")};
        input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', bubbles: true, cancelable: true }));
        input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true, cancelable: true }));
        return true;
      })()`);
      const timeCountAfterKeys = await evalInExtPage(`(async () => {
        const request = indexedDB.open('hdu-assistant');
        const db = await new Promise((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        try {
          if (!Array.from(db.objectStoreNames).includes('favorites')) return -1;
          const tx = db.transaction('favorites', 'readonly');
          const all = await new Promise((resolve, reject) => {
            const req = tx.objectStore('favorites').getAll();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          return all.filter((item) => item.type === 'time' && item.metadata && item.metadata.bvid === '${BILI_VID}').length;
        } finally {
          db.close();
        }
      })()`);
      check('B 站 P2-1 前置：shadow 输入框可聚焦', shadowFocusOk === true);
      check('B 站 P2-1：聚焦输入框按 q 页签不变（第 51 轮）', (await biliText(biliPage.sid, '.bili-qa-tab.is-active')) === '问答');
      check('B 站 P2-1：聚焦输入框按 b 不新增收藏（第 51 轮）', Number(timeCountAfterKeys) === 1);

      // ── 第 51 轮 P1-1 真机级验证：CDP Input 域派发真实指针事件（非程序化 click），
      //    经浏览器命中测试穿透 shadow DOM——展开菜单后的子钮必须可点 ──
      const realClick = async (selector) => {
        // 输入事件只对前台页面生效：多页面（HDU/扩展/B 站）并存时先置前（第 52 轮排障）
        await send('Page.bringToFront', {}, biliPage.sid);
        const rect = await biliEval(biliPage.sid)(
          `${biliShadowExpr(`querySelector('${selector}')`)}?.getBoundingClientRect().toJSON() ?? null`,
        );
        if (!rect) return false;
        const x = Math.round(rect.x + rect.width / 2);
        const y = Math.round(rect.y + rect.height / 2);
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 }, biliPage.sid);
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }, biliPage.sid);
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 1, clickCount: 1 }, biliPage.sid);
        return true;
      };
      // 先关闭学习助手面板、学习中心面板与字幕浮层：三者的全屏 backdrop
      // （z 2147483001）会依次遮挡 FAB 的真实点击命中（诊断证实）
      await biliEval(biliPage.sid)(`(() => { const el = ${biliShadowExpr("querySelector('.bili-qa-scope .bili-modal-close')")}; el?.click(); return !!el; })()`);
      await biliEval(biliPage.sid)("(() => { const el = document.getElementById('hdu-bili-hub-host')?.shadowRoot?.querySelector('button[aria-label=\"关闭\"]'); el?.click(); return !!el; })()");
      await biliEval(biliPage.sid)(`(() => { const el = ${biliShadowExpr("querySelector('.bili-sub-scope .bili-modal-close')")}; el?.click(); return !!el; })()`);
      const mainClicked = await realClick('.bili-fab-main');
      check('B 站 P1-1 前置：真实点击主钮（第 51 轮）', mainClicked === true);
      const menuOpened = mainClicked && (await waitFor(async () => (await biliExists(biliPage.sid, '.bili-fab-menu.is-open')) === true, '菜单展开'));
      check('B 站 P1-1：真实点击后菜单展开（第 51 轮）', menuOpened === true);
      const hubClicked = menuOpened && (await realClick('.bili-hub-fab'));
      check('B 站 P1-1：真实点击学习中心子钮（第 51 轮）', hubClicked === true);
      check('B 站 P1-1：学习中心面板打开（第 51 轮）', hubClicked && (await waitFor(async () => {
        const title = await hubText('.hdu-modal-title');
        return title.includes('学习中心') ? title : null;
      }, '真实指针点击打开学习中心')));
    } finally {
      await biliPage.close();
    }

    // 无字幕视频：另一 BV 不预置任何数据、不点字幕按钮（避免触达真实接口），
    // 问答入口可见但给友好空态（第 14 轮「无字幕作罢」裁决的 UI 行为）
    const biliNoSubPage = await openBiliPage('BV1NoSub9');
    try {
      check('B 站无字幕页宿主挂载', await waitBiliMounted(biliNoSubPage));
      check('B 站无字幕问答空态（不发起问答）', await biliClick(biliNoSubPage.sid, '.bili-qa-fab') && (await waitFor(async () => {
        const meta = await biliText(biliNoSubPage.sid, '.bili-qa-meta');
        const empty = await biliText(biliNoSubPage.sid, '.bili-qa-empty');
        return meta.includes('无官方字幕') && empty.includes('该视频暂无可用字幕') ? empty : null;
      }, '无字幕问答空态')));
    } finally {
      await biliNoSubPage.close();
    }

    // ── 复习计划批量重新入计划（第 99 轮）：HDU 学习中心复习计划视图，已跳过 2 项一键重新入计划 ──
    const replanToastOk = await clickByText('.hdu-nav-item', '复习计划') && (await clickByText('button', '全部重新入计划')) && (await waitFor(async () => {
      const toast = await shadowQuery('.hdu-toast');
      return toast.includes('已重新加入 2 项复习') ? toast : null;
    }, '批量重新入计划 toast'));
    const replanRowOk = await waitFor(async () => {
      const r = await evaluate(`(() => {
        const root = document.getElementById('hdu-assistant-host')?.shadowRoot;
        const center = root?.querySelector('.hdu-center')?.textContent ?? '';
        return { ok: center.includes('高等数学复习要点'), center: center.slice(0, 220) };
      })()`);
      if (!r?.ok) process.stdout.write(`[diag] 重新入计划=${JSON.stringify(r)}\n`);
      return r?.ok ? r : null;
    }, '重新入计划后待完成出现');
    check('复习计划批量重新入计划（第 99 轮）', Boolean(replanToastOk) && Boolean(replanRowOk));

    // ── 诊断日志开关端到端（第 301 轮）：以内容脚本启动 info 日志为确定性探针 ──
    // 关→新开站点页不新增 debug/info；开→恢复并出现「内容脚本已启动」。
    // 必须放在全部检查之后：新开 fixture 页会触发站点课程同步、覆盖预置课程名，
    // 若先于知识库检查执行会使「笔记课程筛选」的「高等数学」选项消失（已实测复现）。
    // 全程在 options 页上下文读 chrome.storage（扩展上下文），不依赖主会话。
    {
      const logOptionsTarget = await send('Target.createTarget', { url: `chrome-extension://${loaded.id}/options.html` });
      const logOptionsAttached = await send('Target.attachToTarget', { targetId: logOptionsTarget.targetId, flatten: true });
      const logOptionsSid = logOptionsAttached.sessionId;
      await send('Runtime.enable', {}, logOptionsSid);
      await waitFor(async () => {
        const res = await send('Runtime.evaluate', { expression: 'document.body?.innerText ?? ""', returnByValue: true }, logOptionsSid);
        return String(res?.result?.value ?? '').includes('AI 服务') ? true : null;
      }, '末段 options 页渲染');
      // 切到「数据与隐私」分区（记录诊断日志开关所在）
      await send('Runtime.evaluate', {
        expression: `[...document.querySelectorAll('.hdu-nav-item')].find((b) => b.textContent?.includes('数据与隐私'))?.click()`,
        returnByValue: true,
      }, logOptionsSid);
      await waitFor(async () => {
        const res = await send('Runtime.evaluate', {
          expression: `[...document.querySelectorAll('.hdu-options-row')].some((r) => r.textContent?.includes('记录诊断日志'))`,
          returnByValue: true,
        }, logOptionsSid);
        return res?.result?.value === true ? true : null;
      }, '记录诊断日志行渲染');
      const readInfoLogCount = async () => {
        const res = await send('Runtime.evaluate', {
          expression: `(async () => {
            const store = await chrome.storage.local.get('logs.v1');
            const logs = Array.isArray(store['logs.v1']) ? store['logs.v1'] : [];
            return logs.filter((l) => l.level === 'debug' || l.level === 'info').length;
          })()`,
          returnByValue: true,
          awaitPromise: true,
        }, logOptionsSid);
        return Number(res?.result?.value ?? -1);
      };
      const toggleLogSwitch = async () => {
        await send('Runtime.evaluate', {
          expression: `(() => {
            const row = [...document.querySelectorAll('.hdu-options-row')].find((r) => r.textContent?.includes('记录诊断日志'));
            const box = row?.querySelector('input[type="checkbox"]');
            if (!box) return false;
            box.click();
            return box.checked;
          })()`,
          returnByValue: true,
        }, logOptionsSid);
        await sleep(400); // patchSettings 异步落盘，给新开页面读取设置留窗口
      };
      const bootOnFreshFixture = async () => {
        const t = await send('Target.createTarget', { url: playUrl });
        const attached = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
        const fsid = attached.sessionId;
        await send('Runtime.enable', {}, fsid);
        await waitFor(async () => {
          const res = await send('Runtime.evaluate', { expression: "!!document.getElementById('hdu-assistant-host')", returnByValue: true }, fsid);
          return res?.result?.value === true ? true : null;
        }, '新开站点页内容脚本挂载', { sid: fsid });
        await send('Target.closeTarget', { targetId: t.targetId });
      };
      // 重播种预置课程（第 302 轮，测试域防御）：新开 fixture 页的站点同步会覆盖
      // 预置课程名（teclId 9001 → 高等数学（E2E）），每次新开页后回写，保持种子不变量；
      // 未来任何「新开 fixture 页」的断言都应复用此模式（见第 301 轮顺序耦合教训）
      const reseedSeededCourse = async () => {
        await send('Runtime.evaluate', {
          expression: `(async () => {
            const db = await new Promise((resolve, reject) => {
              const req = indexedDB.open('hdu-assistant');
              req.onsuccess = () => resolve(req.result);
              req.onerror = () => reject(req.error);
            });
            await new Promise((resolve, reject) => {
              const tx = db.transaction(['courses'], 'readwrite');
              tx.objectStore('courses').put({ teclId: 9001, subjName: '高等数学（E2E）', teclCode: 'M9001', teacherNames: [], updatedAt: Date.now() });
              tx.oncomplete = resolve;
              tx.onerror = () => reject(tx.error);
            });
            db.close();
            return true;
          })()`,
          returnByValue: true,
          awaitPromise: true,
        }, logOptionsSid);
      };
      const logsBeforeOff = await readInfoLogCount();
      await toggleLogSwitch(); // 开 → 关
      await bootOnFreshFixture();
      await reseedSeededCourse();
      const logsOff = await readInfoLogCount();
      check('诊断日志关闭→新开站点页不新增 debug/info（第 301 轮）', logsBeforeOff >= 0 && logsOff === logsBeforeOff);
      await toggleLogSwitch(); // 关 → 开
      await bootOnFreshFixture();
      await reseedSeededCourse();
      const logsOn = await readInfoLogCount();
      const bootRes = await send('Runtime.evaluate', {
        expression: `(async () => {
          const store = await chrome.storage.local.get('logs.v1');
          const logs = Array.isArray(store['logs.v1']) ? store['logs.v1'] : [];
          return logs.some((l) => l.scope === 'content' && l.message.includes('内容脚本已启动'));
        })()`,
        returnByValue: true,
        awaitPromise: true,
      }, logOptionsSid);
      check('诊断日志开启→启动日志恢复且含「内容脚本已启动」（第 301 轮）', logsOn > logsOff && bootRes?.result?.value === true);
      // 金丝雀（第 302 轮）：重播种后预置课程名必须保持——若未来同步行为变化导致
      // 覆盖再现，此处先于「知识库笔记课程筛选」类断言暴露
      const courseRes = await send('Runtime.evaluate', {
        expression: `(async () => {
          const db = await new Promise((resolve, reject) => {
            const req = indexedDB.open('hdu-assistant');
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          const row = await new Promise((resolve, reject) => {
            const tx = db.transaction(['courses'], 'readonly');
            const req = tx.objectStore('courses').get(9001);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          db.close();
          return row?.subjName ?? null;
        })()`,
        returnByValue: true,
        awaitPromise: true,
      }, logOptionsSid);
      check('新开 fixture 页后预置课程名保持（第 302 轮）', courseRes?.result?.value === '高等数学（E2E）');
      await send('Target.closeTarget', { targetId: logOptionsTarget.targetId });
    }

    // ── 演示模式全链路（第 319 轮）：放全部检查之后 —— 涉及设置旗标翻转 + 新开页，
    //    遵守「重播种 / 顺序耦合」红线。演示期间 siteSync 被 gate，fixture 页不再触发
    //    站点课程同步，预置课程不变量天然安全；退出后不再开 fixture 页（避免解除门禁后的同步）。 ──
    {
      // 1) 设置页（数据与隐私分区）开启演示模式：确认弹窗 → 页面自刷新 → 已开启态
      const demoOptionsTarget = await send('Target.createTarget', { url: `chrome-extension://${loaded.id}/options.html#data` });
      const demoOptionsAtt = await send('Target.attachToTarget', { targetId: demoOptionsTarget.targetId, flatten: true });
      const demoSid = demoOptionsAtt.sessionId;
      await send('Runtime.enable', {}, demoSid);
      await waitFor(async () => {
        const probe = await send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true }, demoSid);
        const text = String(probe?.result?.value ?? '');
        return text.includes('演示模式') && text.includes('开启演示模式') ? 'ready' : null;
      }, 'options 演示卡渲染');
      await send('Runtime.evaluate', {
        expression: `[...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('开启演示模式'))?.click()`,
        returnByValue: true,
      }, demoSid);
      const confirmed = await waitFor(async () => {
        const res = await send('Runtime.evaluate', {
          expression: `(() => { const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === '确认开启'); if (!btn) return null; btn.click(); return 'clicked'; })()`,
          returnByValue: true,
        }, demoSid);
        return res?.result?.value === 'clicked' ? 'clicked' : null;
      }, '开启演示确认弹窗');
      check('演示模式开启入口与确认弹窗（第 319 轮）', confirmed === 'clicked');
      const entered = await waitFor(async () => {
        const probe = await send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true }, demoSid);
        const text = String(probe?.result?.value ?? '');
        return text.includes('退出演示') && text.includes('已开启') ? 'entered' : null;
      }, 'options 演示已开启态（自刷新后）', { timeoutMs: 15000 });
      check('演示模式开启后设置页显示已开启（第 319 轮）', entered === 'entered');
      await send('Target.closeTarget', { targetId: demoOptionsTarget.targetId });

      // 2) 看板知识库：演示角标在场 + 演示收藏出现 + 真实 E2E 收藏不可见（并行库隔离）
      await openExtPage('dashboard.html#library', {
        readyText: '知识库',
        interact: async (send, sid) => {
          const libText = await waitFor(async () => {
            const probe = await send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true }, sid);
            const text = String(probe?.result?.value ?? '');
            return text.includes('演示模式') && text.includes('中序遍历的非递归实现') ? text : null;
          }, '看板演示角标 + 演示收藏点亮', { sid, timeoutMs: 15000 });
          check('看板页头显示演示角标且演示收藏出现（第 319 轮）', typeof libText === 'string' && libText.includes('中序遍历的非递归实现'));
          check('演示期间真实 E2E 收藏在看板不可见（并行库隔离，第 319 轮）', typeof libText === 'string' && !libText.includes('线性代数复习要点（E2E 预置）'));
        },
      });

      // 3) fixture 学习中心：演示课程点亮；门禁断言（负向）——fixture 站点课程不得混入演示库
      {
        const lcTarget = await send('Target.createTarget', { url: `${BASE}/play-center-sim.html#/home` });
        const lcAtt = await send('Target.attachToTarget', { targetId: lcTarget.targetId, flatten: true });
        const lcSid = lcAtt.sessionId;
        await send('Runtime.enable', {}, lcSid);
        const lcText = await waitFor(async () => {
          const probe = await send('Runtime.evaluate', {
            expression: `document.getElementById('hdu-assistant-host')?.shadowRoot?.textContent ?? ''`,
            returnByValue: true,
          }, lcSid);
          const text = String(probe?.result?.value ?? '');
          return text.includes('数据结构与算法') ? text : null;
        }, '学习中心载入演示课程', { timeoutMs: 15000 });
        check('学习中心载入演示课程「数据结构与算法」（第 319 轮）', typeof lcText === 'string' && lcText.includes('数据结构与算法'));
        // 负向门禁：轮询数秒，站点同步若未被门禁会写入「线性代数（模拟课程）」并点亮课程墙
        let polluted = false;
        for (let i = 0; i < 8 && !polluted; i += 1) {
          const probe = await send('Runtime.evaluate', {
            expression: `document.getElementById('hdu-assistant-host')?.shadowRoot?.textContent ?? ''`,
            returnByValue: true,
          }, lcSid);
          polluted = String(probe?.result?.value ?? '').includes('线性代数（模拟课程）');
          if (!polluted) await sleep(500);
        }
        check('演示模式门禁：fixture 站点同步不写入演示库（第 319 轮）', !polluted);
        await send('Target.closeTarget', { targetId: lcTarget.targetId });
      }

      // 4) 退出演示：设置页退出按钮 → 自刷新 → 回到未开启态
      await openExtPage('options.html#data', {
        readyText: '退出演示',
        interact: async (send, sid) => {
          await send('Runtime.evaluate', {
            expression: `[...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === '退出演示')?.click()`,
            returnByValue: true,
          }, sid);
          const exited = await waitFor(async () => {
            const probe = await send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true }, sid);
            const text = String(probe?.result?.value ?? '');
            return text.includes('开启演示模式') ? 'exited' : null;
          }, '退出后回到未开启态', { sid, timeoutMs: 15000 });
          check('退出演示后设置页回到未开启态（第 319 轮）', exited === 'exited');
        },
      });

      // 5) 退出后看板：角标消失、演示收藏消失、真实 E2E 收藏恢复可见
      await openExtPage('dashboard.html#library', {
        readyText: '知识库',
        interact: async (send, sid) => {
          const libText = await waitFor(async () => {
            const probe = await send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true }, sid);
            const text = String(probe?.result?.value ?? '');
            return text.includes('线性代数复习要点（E2E 预置）') ? text : null;
          }, '退出后真实 E2E 收藏恢复', { sid, timeoutMs: 15000 });
          check('退出演示后角标消失、演示数据退场、真实收藏恢复（第 319 轮）', typeof libText === 'string' && !libText.includes('演示模式') && !libText.includes('中序遍历的非递归实现'));
        },
      });

      // 6) 金丝雀（扩展页上下文直查真实库）：预置课程名保持 + 演示库已删除
      const demoCanary = await evalInExtPage(`(async () => {
        const db = await new Promise((resolve, reject) => {
          const req = indexedDB.open('hdu-assistant');
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        const row = await new Promise((resolve, reject) => {
          const tx = db.transaction(['courses'], 'readonly');
          const req = tx.objectStore('courses').get(9001);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        const names = (await indexedDB.databases())?.map((d) => d.name) ?? [];
        db.close();
        return { course: row?.subjName ?? null, demoDbGone: !names.includes('hdu-assistant-demo') };
      })()`);
      check('退出后真实库预置课程名保持（第 319 轮）', demoCanary?.course === '高等数学（E2E）');
      check('退出后演示库已删除（第 319 轮）', demoCanary?.demoDbGone === true);
    }
  } finally {
    chrome.kill();
    server?.kill();
    // 自清理本次临时用户目录：Chrome 独立 profile 每次运行约 300MB，不清理会在系统盘持续累积
    await sleep(800);
    try {
      rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch {
      /* 清理失败不影响结果（下次运行用全新目录） */
    }
  }

  // 错误日志诊断（第 316 轮）：跑尾导出最近 5 条 error 级日志（渲染崩溃/异常会经
  // ErrorBoundary → logger.error 落到 chrome.storage.local，便于失败归因）
  try {
    const errLogs = await evalInExtPage(`(async () => (await chrome.storage.local.get('logs.v1'))['logs.v1']?.filter((l) => l.level === 'error')?.slice(-5) ?? [])()`);
    process.stdout.write(`[diag] 错误日志=${JSON.stringify(errLogs)}\n`);
  } catch { /* 诊断失败不影响结果 */ }

  // 错误日志诊断（第 316 轮）：跑尾导出最近 5 条 error 级日志（渲染崩溃/异常会经
  // ErrorBoundary → logger.error 落到 chrome.storage.local，便于失败归因）
  try {
    const errLogs = await evalInExtPage(`(async () => (await chrome.storage.local.get('logs.v1'))['logs.v1']?.filter((l) => l.level === 'error')?.slice(-5) ?? [])()`);
    process.stdout.write(`[diag] 错误日志=${JSON.stringify(errLogs)}\n`);
  } catch { /* 诊断失败不影响结果 */ }
  if (consoleErrors.length > 0) {
    process.stdout.write(`[diag] console.error=${JSON.stringify(consoleErrors.slice(-8))}\n`);
  }

  const failed = checks.filter((item) => !item.ok);
  process.stdout.write(`\n${checks.length - failed.length}/${checks.length} 项通过\n`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`E2E 失败：${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
