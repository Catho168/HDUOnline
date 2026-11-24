import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from '../content/ui/ErrorBoundary';

// 渲染错误兜底（第 271 轮，健壮性域）：子树渲染错误降级为提示卡片 + 本地日志，不白屏
createRoot(document.getElementById('root')!).render(
  <ErrorBoundary entry="popup">
    <App />
  </ErrorBoundary>,
);
