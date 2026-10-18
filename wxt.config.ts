import { defineConfig } from 'wxt';

/**
 * 扩展清单与构建配置。
 *
 * 安全边界（技术文档 §1.3 / §8.1）：
 *  - host_permissions 只列两个主站源、两个视频源、预设模型源；禁止 *.webvpn.hdu.edu.cn 通配；
 *  - optional_host_permissions 仅在用户手势下为自定义 LLM 端点申请；
 *  - webRequest 只读观测站点自身的课次接口（识别 #/play-center 的当前课次），
 *    不申请 webRequestBlocking，不修改/阻断/重放请求。
 */
export default defineConfig({
  srcDir: 'src',
  outDir: '.output',
  modules: ['@wxt-dev/module-react'],
  manifestVersion: 3,
  manifest: {
    name: '杭电智慧课堂学习助手',
    short_name: '智慧课堂助手',
    description:
      '把杭电智慧课堂变成个人学习中心：本地转写、AI 知识标注与大纲、时间点问答、板书截图、收藏知识库与学习统计。数据全部留在本机。',
    version: '1.0.0',
    minimum_chrome_version: '110',
    permissions: ['storage', 'unlimitedStorage', 'offscreen', 'alarms', 'notifications', 'webRequest'],
    host_permissions: [
      'https://course.hdu.edu.cn/*',
      'https://https-course-hdu-edu-cn-443.webvpn.hdu.edu.cn/*',
      'https://vod.hdu.edu.cn/*',
      'https://https-vod-hdu-edu-cn-50443.webvpn.hdu.edu.cn/*',
      'https://api.anthropic.com/*',
      'https://api.openai.com/*',
      'https://hf-mirror.com/*',
      'https://huggingface.co/*',
      // 模型权重经 LFS 302 到 CDN（hf.co / cdn-lfs.huggingface.co 等）；
      // 扩展页/Worker 的跨域读取需要对这些重定向目标也有 host 权限，否则会报
      // “TypeError: network error”，表现为模型下载中途失败。
      'https://*.hf-mirror.com/*',
      'https://*.huggingface.co/*',
      'https://*.hf.co/*',
    ],
    optional_host_permissions: ['https://*/*', 'http://127.0.0.1/*', 'http://localhost/*'],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    web_accessible_resources: [
      {
        resources: ['wasm/*', 'assets/ui/*'],
        matches: [
          'https://course.hdu.edu.cn/*',
          'https://https-course-hdu-edu-cn-443.webvpn.hdu.edu.cn/*',
        ],
      },
    ],
    icons: {
      16: 'icon/16.png',
      32: 'icon/32.png',
      48: 'icon/48.png',
      128: 'icon/128.png',
    },
    action: {
      default_title: '智慧课堂学习助手',
      default_icon: {
        16: 'icon/16.png',
        32: 'icon/32.png',
        48: 'icon/48.png',
        128: 'icon/128.png',
      },
    },
  },
  vite: () => ({
    resolve: {
      // 使用外置 wasm 版 onnxruntime-web（ort.min.mjs），避免把 wasm 以 base64 内联进 bundle。
      conditions: ['onnxruntime-web-use-extern-wasm', 'module', 'browser', 'development|production'],
    },
    build: {
      target: 'chrome110',
      chunkSizeWarningLimit: 8192,
    },
    worker: {
      format: 'es',
    },
    optimizeDeps: {
      exclude: ['onnxruntime-web'],
    },
  }),
});
