/*!
 * B 站视频页 · 注入锚点实站勘察片段（第 44 轮，B 站工具栏注入回填前置）
 *
 * 用法：在 B 站视频播放页（https://www.bilibili.com/video/BVxxxx）打开 DevTools
 * Console，整段粘贴执行。结果对象挂到 window.__hduBiliRecon、打印到控制台，并自动
 * 触发 JSON 下载（也可用 copy(__hduBiliRecon) 复制）。把下载的 JSON 交给开发侧即可。
 *
 * 设计约束：只读 DOM，不写入、不修改站点任何节点；纯前端片段，无网络请求。
 * 采集目标：为 B 站工具栏注入探针（biliToolbarProbe）回填
 * BILI_TOOLBAR_PROBE_SELECTORS 提供选择器与几何证据；顺带采集播放器控制条候选，
 * 为后续「B 站侧浮窗 → 注入」第二阶段储备。
 */

(() => {
  'use strict';

  var pathOf = function (el) {
    if (!el || el === document.body) return 'body';
    var parts = [];
    var cur = el;
    while (cur && cur !== document.body && parts.length < 6) {
      var part = cur.tagName.toLowerCase();
      if (cur.id) { parts.unshift(part + '#' + cur.id); break; }
      var cls = Array.from(cur.classList).filter(function (c) { return !c.startsWith('hdu-'); }).slice(0, 3);
      if (cls.length) part += '.' + cls.join('.');
      var parent = cur.parentElement;
      if (parent) {
        var same = Array.from(parent.children).filter(function (c) { return c.tagName === cur.tagName; });
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(' > ');
  };

  var describe = function (el, depth, maxDepth) {
    if (!el || depth > maxDepth) return null;
    var r = el.getBoundingClientRect();
    var node = {
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      cls: el.classList.length ? Array.from(el.classList).slice(0, 8) : undefined,
      path: pathOf(el),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      text: el.childElementCount === 0 ? (el.textContent || '').trim().slice(0, 40) || undefined : undefined,
    };
    if (el.childElementCount) {
      node.children = depth < maxDepth
        ? Array.from(el.children).slice(0, 12).map(function (c) { return describe(c, depth + 1, maxDepth); })
        : [{ truncated: el.childElementCount + ' children' }];
    }
    return node;
  };

  var q = function (sel) { return document.querySelector(sel); };
  var video = q('video');

  // 与 constants.ts BILI_TOOLBAR_PROBE_SELECTORS 同清单（回填后同步更新两边）：
  // 每个候选独立采集（不只第一个命中），便于对照哪个选择器在真机稳定存在。
  var TOOLBAR_CANDIDATES = [
    '.video-toolbar-left-main',
    '.video-toolbar-left',
    '.toolbar-left-main',
    '.video-toolbar',
    '[class*="video-toolbar"]',
  ];
  // 播放器控制条候选（B 站 bpx 播放器；为第二阶段储备，当前探针不消费）
  var CONTROL_CANDIDATES = [
    '.bpx-player-control-bottom',
    '.bpx-player-control',
    '.bpx-player-video-area',
  ];

  var pickCandidates = function (selectors) {
    var out = {};
    selectors.forEach(function (sel) {
      try {
        out[sel] = describe(q(sel), 0, 2);
      } catch (e) {
        out[sel] = null;
      }
    });
    return out;
  };

  var result = {
    url: location.href,
    title: document.title,
    collectedAt: new Date().toISOString(),
    viewport: { w: window.innerWidth, h: window.innerHeight },
    candidates: {
      toolbar: pickCandidates(TOOLBAR_CANDIDATES),
      playerControls: pickCandidates(CONTROL_CANDIDATES),
      videoWrapper: video && video.closest('div') ? describe(video.closest('div'), 0, 3) : null,
      titleArea: describe(q('.video-title') || q('h1'), 0, 1),
    },
    video: video
      ? {
          src: String(video.currentSrc || video.src || '').slice(0, 80),
          resolution: video.videoWidth + 'x' + video.videoHeight,
          paused: video.paused,
          duration: Number.isFinite(video.duration) ? Math.round(video.duration) : null,
        }
      : null,
    themeSignals: {
      htmlClass: document.documentElement.className || null,
      htmlDataTheme: document.documentElement.getAttribute('data-theme') || null,
      bodyClass: document.body.className || null,
      bodyDataTheme: document.body.getAttribute('data-theme') || null,
    },
    bodyTopLevel: Array.from(document.body.children).map(function (el) {
      return {
        tag: el.tagName.toLowerCase(),
        id: el.id || undefined,
        cls: el.classList.length ? Array.from(el.classList).slice(0, 6) : undefined,
      };
    }),
  };

  window.__hduBiliRecon = result;
  console.log('%c[HDU Bili recon] 采集完成，结果对象见 window.__hduBiliRecon：', 'color:#0a7;font-weight:bold', result);
  try {
    var blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'bili-recon-' + location.pathname.replace(/[^a-z0-9]+/gi, '-').slice(0, 40) + '-' + Date.now() + '.json';
    a.click();
    console.log('[HDU Bili recon] JSON 已触发下载；也可在 Console 执行 copy(__hduBiliRecon) 后直接粘贴给开发侧。');
  } catch (e) {
    console.warn('[HDU Bili recon] 下载失败，请用 copy(__hduBiliRecon) 复制：', e);
  }
})();
