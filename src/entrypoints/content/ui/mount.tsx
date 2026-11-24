import { createRoot, type Root } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './ErrorBoundary';
import { ensureUiHost, removeUiHost } from './host';

let root: Root | null = null;

export function mountUi(): () => void {
  const { container } = ensureUiHost();
  if (!root) {
    root = createRoot(container);
    // 渲染错误兜底（第 271 轮，健壮性域）：学习中心 / 浮层渲染错误降级为提示卡片
    // + 本地日志，不白屏（宿主页面场景下白屏代价最高）
    root.render(
      <ErrorBoundary entry="content">
        <App />
      </ErrorBoundary>,
    );
  }
  return () => {
    root?.unmount();
    root = null;
    removeUiHost();
  };
}
