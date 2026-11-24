/**
 * B 站播放器 <video> 元素捕获/跟随基建（bilibili.content.tsx 使用；体验小项池两项的机制层）。
 *
 * B 站视频页是 SPA：<video> 可能晚于内容脚本就绪（首挂轮询兜底）；切分 P/切清晰度时
 * 播放器可能整体替换 <video> 节点——旧节点脱离 DOM，挂在它上面的监听（timeupdate 等）
 * 全部失联。这里提供两个原语：
 *  - waitForVideoElement：一次性等待 <video> 出现（轮询，上限约 20s），供「捕获一次即够」
 *    的简单场景（不跟随节点替换）；
 *  - watchVideoElement：持续跟随「当前 <video>」——首次捕获 + 节点被替换后重新捕获；
 *    stop() 随时终止等待与跟随（字幕浮层关闭即停轮询，不再无谓空转）。
 *    进度上报/站外时长统计与字幕高亮均经此跟随换节点（订阅方在 onVideo 里解绑旧节点、
 *    重绑新节点，见 setupProgressTracking 与字幕 effect）。
 */

export interface VideoElementWatcher {
  /** 当前捕获的 <video>（尚未捕获到时为 null；节点替换后指向新节点） */
  getCurrent(): HTMLVideoElement | null;
  /** 停止等待与跟随（清理轮询定时器与 MutationObserver）；可安全重复调用 */
  stop(): void;
}

export interface WatchVideoElementOptions {
  /** 每次捕获（首次与每次重挂）时回调；订阅方应先解绑旧节点的监听再绑新节点 */
  onVideo: (video: HTMLVideoElement) => void;
  /** 首次等待上限 ms（SPA 晚就绪兜底），超时放弃；缺省 20s */
  timeoutMs?: number;
  /** 首次等待的轮询步长 ms；缺省 500ms */
  stepMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_STEP_MS = 500;

function queryVideo(): HTMLVideoElement | null {
  return document.querySelector('video');
}

/** 等待页面 <video> 元素出现（B 站为 SPA，播放器可能晚于内容脚本就绪），上限约 20s */
export function waitForVideoElement(
  timeoutMs = DEFAULT_TIMEOUT_MS,
  stepMs = DEFAULT_STEP_MS,
): Promise<HTMLVideoElement | null> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      const video = queryVideo();
      if (video) {
        resolve(video);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(null);
        return;
      }
      setTimeout(poll, stepMs);
    };
    poll();
  });
}

/**
 * 持续跟随当前 <video>：首次捕获 + SPA 换节点后重新捕获（重挂）。
 *
 * 节点替换检测用 MutationObserver（document 子树增删）：每批变更后重查
 * `document.querySelector('video')`，与当前节点不同即视为替换、再次回调 onVideo。
 * 「先删旧、后插新」的替换空窗期查询为空，不误回调，等新节点插入的下一次批次自然捕获；
 * 节点在 DOM 内移动（未替换成新节点）不触发重复回调。首挂兜底沿用 waitForVideoElement
 * 的轮询口径（上限 timeoutMs，超时放弃，不无限空转）；捕获成功后改由 observer 跟随，
 * 停止轮询。stop() 由订阅方在面板关闭/卸载时调用，终止等待与跟随。
 */
export function watchVideoElement(options: WatchVideoElementOptions): VideoElementWatcher {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const stepMs = options.stepMs ?? DEFAULT_STEP_MS;
  let stopped = false;
  let current: HTMLVideoElement | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let observer: MutationObserver | null = null;

  const capture = (video: HTMLVideoElement): void => {
    current = video;
    options.onVideo(video);
  };

  const startObserver = (): void => {
    if (observer || stopped) return;
    observer = new MutationObserver(() => {
      if (stopped) return;
      const latest = queryVideo();
      if (latest && latest !== current) capture(latest);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  };

  const poll = (deadline: number): void => {
    if (stopped) return;
    const found = queryVideo();
    if (found) {
      capture(found);
      startObserver();
      return;
    }
    if (Date.now() >= deadline) return; // SPA 一直不出播放器：到上限放弃，不无限轮询
    timer = setTimeout(() => poll(deadline), stepMs);
  };

  poll(Date.now() + timeoutMs);

  return {
    getCurrent: () => current,
    stop() {
      stopped = true;
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
      observer?.disconnect();
      observer = null;
    },
  };
}
