/*!
 * HDU 智慧课堂 · 注入锚点实站勘察片段（第 19 轮，注入式 UI 第二阶段前置）
 *
 * 用法：在真实 HDU 智慧课堂站点（已登录）的目标页面打开 DevTools Console，
 * 整段粘贴执行。结果对象会挂到 window.__hduRecon、打印到控制台，并自动触发
 * JSON 下载（也可用 copy(__hduRecon) 复制）。把下载的 JSON 交给开发侧即可。
 *
 * 设计约束：只读 DOM，不写入、不修改站点任何节点；纯前端片段，无网络请求。
 * 采集目标：为「浮窗 → 注入」第二阶段确定候选锚点（全局导航 / 播放器控制条 /
 * AI 模块位等）提供选择器与几何证据。
 */
(() => {
  'use strict';

  const pathOf = (el) => {
    if (!el || el === document.body) return 'body';
    const parts = [];
    let cur = el;
    while (cur && cur !== document.body && parts.length < 6) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) { parts.unshift(part + '#' + cur.id); break; }
      const cls = Array.from(cur.classList).filter((c) => !c.startsWith('hdu-')).slice(0, 3);
      if (cls.length) part += '.' + cls.join('.');
      const parent = cur.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(' > ');
  };

  const describe = (el, depth, maxDepth) => {
    if (!el || depth > maxDepth) return null;
    const r = el.getBoundingClientRect();
    const node = {
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      cls: el.classList.length ? Array.from(el.classList).slice(0, 8) : undefined,
      path: pathOf(el),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      text: el.childElementCount === 0 ? (el.textContent || '').trim().slice(0, 40) || undefined : undefined,
    };
    if (el.childElementCount) {
      node.children = depth < maxDepth
        ? Array.from(el.children).slice(0, 12).map((c) => describe(c, depth + 1, maxDepth))
        : [{ truncated: el.childElementCount + ' children' }];
    }
    return node;
  };

  const q = (sel) => document.querySelector(sel);
  const video = q('video');

  const result = {
    url: location.href,
    title: document.title,
    collectedAt: new Date().toISOString(),
    viewport: { w: window.innerWidth, h: window.innerHeight },
    candidates: {
      playHeader: describe(q('.play-header'), 0, 2),
      globalNav: describe(q('header') || q('.header') || q('.nav') || q('[class*="navbar"]'), 0, 3),
      playerWrapper: video && video.closest('div') ? describe(video.closest('div'), 0, 3) : null,
      controlBar: describe(q('.control-bar') || q('.player-controls') || q('[class*="control"]'), 0, 2),
      aiCaptionWrapper: describe(q('.ai-caption-wrapper'), 0, 2),
      rightRail: describe(q('.right-body') || q('[class*="right"]'), 0, 2),
    },
    video: video
      ? {
          src: String(video.currentSrc || video.src || '').slice(0, 80),
          resolution: video.videoWidth + 'x' + video.videoHeight,
          paused: video.paused,
        }
      : null,
    kmediaGlobals: Object.keys(window)
      .filter((k) => /kmedia|player|KM/i.test(k))
      .slice(0, 20),
    bodyTopLevel: Array.from(document.body.children).map((el) => ({
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      cls: el.classList.length ? Array.from(el.classList).slice(0, 6) : undefined,
    })),
  };

  window.__hduRecon = result;
  console.log('%c[HDU recon] 采集完成，结果对象见 window.__hduRecon：', 'color:#0a7;font-weight:bold', result);
  try {
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'hdu-recon-' + location.pathname.replace(/[^a-z0-9]+/gi, '-').slice(0, 40) + '-' + Date.now() + '.json';
    a.click();
    console.log('[HDU recon] JSON 已触发下载；也可在 Console 执行 copy(__hduRecon) 后直接粘贴给开发侧。');
  } catch (e) {
    console.warn('[HDU recon] 下载失败，请用 copy(__hduRecon) 复制：', e);
  }
})();
