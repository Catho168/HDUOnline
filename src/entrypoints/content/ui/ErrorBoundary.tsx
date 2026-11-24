import { Component, type ErrorInfo, type ReactNode } from 'react';
import { createLogger } from '@/core/shared/logger';

const logger = createLogger('ui');

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** 入口标识（日志定位：popup / dashboard / options / content / learning/<view>） */
  entry: string;
  /**
   * 是否提供「重试当前界面」按钮（第 290 轮）：仅入口级边界传 true——入口级重试
   * （整页 reload）与原地重挂语义不同；视图级 / 页签级边界的数据来自 props（重挂
   * 不重新取数，重试必然复现同一错误），故不提供无效的重试按钮，仅保留「刷新页面」。
   */
  retryable?: boolean;
}

interface State {
  error: Error | null;
}

/**
 * 降级卡片样式（第 272 轮暗色适配）：类名 + <style> 注入（含 prefers-color-scheme
 * 暗色档）——入口根部无 .hdu-root 主题变量也可用；亮色为品牌纸色，暗色跟随系统。
 */
const EB_CSS = `
.hdu-eb-backdrop{min-height:100vh;display:grid;place-items:center;background:#f5f1e8;font-family:system-ui,-apple-system,sans-serif;padding:24px}
.hdu-eb-card{max-width:430px;border:1px solid #d8d2c4;border-radius:16px;background:#fffdf8;padding:22px 24px;box-shadow:0 10px 30px rgba(0,0,0,.08)}
.hdu-eb-title{font-size:16px;font-weight:700;color:#3d3a33;margin:0 0 8px}
.hdu-eb-text{font-size:12.5px;color:#6b675c;line-height:1.7;margin:0 0 6px}
.hdu-eb-btn{border:1px solid #3d3a33;border-radius:8px;background:#3d3a33;color:#f5f1e8;font-size:13px;font-weight:600;padding:7px 16px;cursor:pointer;font-family:inherit;margin-top:8px}
.hdu-eb-btn.is-secondary{background:transparent;color:#3d3a33;border-color:#b9b2a2}
@media (prefers-color-scheme:dark){
.hdu-eb-backdrop{background:#131518}
.hdu-eb-card{background:#1d2126;border-color:#33383e;box-shadow:0 10px 30px rgba(0,0,0,.4)}
.hdu-eb-title{color:#e2e6ea}
.hdu-eb-text{color:#a6adb5}
.hdu-eb-btn{background:#e2e6ea;color:#131518;border-color:#e2e6ea}
.hdu-eb-btn.is-secondary{background:transparent;color:#e2e6ea;border-color:#4a5158}
}`;

/**
 * 渲染错误兜底（第 271 轮巡检，健壮性域；第 272 轮暗色适配）：捕获子树渲染期错误，
 * 降级为「界面出错了」卡片 + 刷新按钮，并写入本地环形日志（脱敏，可在设置 → 数据
 * 管理 查看）——替代整页白屏。四个入口（popup / dashboard / options / content）根
 * 组件外各包一层；学习中心另按视图包一层（key=view，单视图错误不拖垮整页、切视图
 * 自动复位）。
 *
 * 边界：只兜「渲染期」错误；事件回调与异步链路错误由各自的 try/catch 与全局
 * unhandledrejection 安全网（client.ts，第 253 轮）承接，职责不重叠。
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    logger.error(`[${this.props.entry}] 界面渲染错误`, String(info.componentStack || error.stack || error.message));
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    const retryable = this.props.retryable !== false;
    return (
      <>
        <style>{EB_CSS}</style>
        <div className="hdu-eb-backdrop">
          <div className="hdu-eb-card">
            <div className="hdu-eb-title">⚠️ 界面出错了</div>
            <div className="hdu-eb-text">入口「{this.props.entry}」渲染时发生意外错误，已记录到本地日志（设置 → 数据管理可查看）。</div>
            <div className="hdu-eb-text">
              你的学习数据不受影响。{retryable ? '可先「重试当前界面」（原地重挂，不刷新整页）；若反复出现，再「刷新页面」或附带本地日志反馈。' : '请「刷新页面」重试；若反复出现，请附带本地日志反馈。'}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {retryable ? (
                <button
                  type="button"
                  className="hdu-eb-btn"
                  onClick={() => this.setState({ error: null })}
                >
                  重试当前界面
                </button>
              ) : null}
              <button type="button" className="hdu-eb-btn is-secondary" onClick={() => location.reload()}>
                刷新页面
              </button>
            </div>
          </div>
        </div>
      </>
    );
  }
}
