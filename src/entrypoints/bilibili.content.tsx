/**
 * B站内容脚本：在视频播放页注入收藏入口（保存到知识库文件夹）、官方字幕入口
 * （获取/查看/搜索字幕；无字幕作罢，见 docs/B站字幕获取专项设计.md）与学习助手入口
 * （AI 时间点问答 + AI 标注/大纲 + 收藏此时刻；无字幕时给友好空态，不发起请求）。
 * 另有学习中心入口（第 32 轮）：打开 BiliHubPanel（知识库管理 + 统计两页签），
 * 面板挂独立 shadow host（hdu-bili-hub-host，注入 UI_CSS），见 BiliHubPanel.tsx。
 * 另在播放器视频区域上方叠加 AI 标注时间轴标记条（BiliTimelineMarkers，行为对标
 * HDU 侧 TimelineLayer）。
 * 进度上报与站外学习时长统计沿用既有通道，与字幕/问答/标注功能互不影响。
 */

import { defineContentScript } from 'wxt/utils/define-content-script';
import { createRoot } from 'react-dom/client';
import { installUnhandledRejectionSafetyNet } from '@/core/shared/client';
import { applyDebugLogEnabled, createLogger } from '@/core/shared/logger';
import { loadSettings, onSettingsChanged } from '@/core/shared/settings';
import { createBiliToolbarProbe } from '@/entrypoints/content/site/biliToolbarProbe';
import { BiliCollectApp } from '@/entrypoints/content/ui/bili/BiliCollectApp';
import { BILI_CSS } from '@/entrypoints/content/ui/bili/bili-styles';
import { setupProgressTracking } from '@/entrypoints/content/ui/bili/progressTracking';
import { extractBiliVideoInfo } from '@/entrypoints/content/ui/bili/videoInfo';

const BILI_HOST_ID = 'hdu-bili-collect-host';

export default defineContentScript({
  matches: ['https://www.bilibili.com/video/*'],
  runAt: 'document_idle',
  allFrames: false,
  async main(ctx) {
    // 全局 unhandledrejection 安全网（第 253 轮 callOp 审计，与 HDU 侧同型）：只静默记录
    const offRejectionNet = installUnhandledRejectionSafetyNet(createLogger('bili-content').warn);
    ctx.onInvalidated(() => offRejectionNet());
    // 诊断日志开关（第 299 轮，工程域）：B 站上下文同受「记录诊断日志」约束（初始 + 热更）；
    // 面板内各自 loadSettings 的功能行为不受影响，这里只负责日志开关
    void loadSettings()
      .then((s) => applyDebugLogEnabled(s.debug.logEnabled))
      .catch(() => undefined);
    const offLogSwitch = onSettingsChanged((next) => applyDebugLogEnabled(next.debug.logEnabled));
    ctx.onInvalidated(() => offLogSwitch());
    let host = document.getElementById(BILI_HOST_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = BILI_HOST_ID;
      host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483000; pointer-events: none;';
      document.body.appendChild(host);
    }
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });

    let style = shadow.querySelector('style[data-bili-collect]');
    if (!style) {
      style = document.createElement('style');
      style.setAttribute('data-bili-collect', '1');
      style.textContent = BILI_CSS;
      shadow.appendChild(style);
    }

    let container = shadow.querySelector<HTMLElement>('#bili-collect-root');
    if (!container) {
      container = document.createElement('div');
      container.id = 'bili-collect-root';
      container.style.cssText = 'position: fixed; inset: 0; pointer-events: none;';
      shadow.appendChild(container);
    }

    const root = createRoot(container);
    root.render(<BiliCollectApp />);

    const info = extractBiliVideoInfo();
    if (info) {
      setupProgressTracking(info.bvid, info.title, (fn) => ctx.onInvalidated(fn));
    }

    // ───── 第 33 轮巡检：工具栏注入探针（框架先行）；第 44 轮随 FAB 收敛调整 ─────
    // 命中视频页原生工具栏（点赞/投币/收藏按钮区域）时，把「学习助手」入口迁入工具栏
    // （单入口策略：注入期间隐藏整个 .bili-fab-group 浮层入口组——第 44 轮起四入口已
    // 收敛为主钮+菜单一组；未命中/被站点 diff 掉时恢复显示，探针全不命中则保持 FAB
    // 降级，零回归）。点击经既有 .bili-qa-fab 子钮的 onClick（openQa('qa') 等价路径）
    // 打开面板——子钮常驻 DOM，菜单收起态下程序化 click 同样生效，不新增面板控制通道。
    // 后续若要迁移更多入口进工具栏，扩展点在此接线处增加对应的隐藏/激活对即可。
    const toolbarProbe = createBiliToolbarProbe({
      onMountedChange: (mounted) => {
        // P3-2（第 34 轮巡检）：探针挂载回调可能早于 React 首帧提交（.bili-fab-group 尚未
        // 进入 shadow DOM），此时隐藏是空操作且无补挂 → 工具栏入口与浮层 FAB 双入口并存。
        // mounted 且找不到入口组时用 requestAnimationFrame 重试（至多 5 帧），仍失败则
        // 放弃（降级为双入口，不影响探针本身）；恢复显示（mounted=false）无需重试——
        // 入口组不在场即无隐藏态可恢复。
        const apply = () => {
          const group = document
            .getElementById(BILI_HOST_ID)
            ?.shadowRoot?.querySelector<HTMLElement>('.bili-fab-group');
          if (!group) return false;
          group.style.display = mounted ? 'none' : '';
          return true;
        };
        if (apply() || !mounted) return;
        let retries = 0;
        const retryHide = () => {
          if (apply() || retries >= 5) return;
          retries += 1;
          requestAnimationFrame(retryHide);
        };
        requestAnimationFrame(retryHide);
      },
      onActivate: () => {
        document.getElementById(BILI_HOST_ID)?.shadowRoot?.querySelector<HTMLElement>('.bili-qa-fab')?.click();
      },
    });

    ctx.onInvalidated(() => {
      toolbarProbe.dispose();
      root.unmount();
    });
  },
});
