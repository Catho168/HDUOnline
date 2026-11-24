// 三步上手引导卡（第 256 轮巡检，引导域 / 冷启动视角）。
// 纯展示组件：步骤与完成态由 core/plan/onboarding 的 buildOnboardingSteps 派生
// （调用方用已持有数据给 hasCourse / hasWatch / hasLibrary，零新增 op 语义由调用方保证）。
// 三处空态入口共用同一份步骤与文案：学习中心总览空库 / 看板概览无课次 / popup 空态卡。
//
// 第 257 轮（引导域 / 可执行性延续）：新增 actions 插槽——调用方按步骤 key 提供
// { label, onClick }，步骤行尾渲染小号直达按钮（学习中心：sync→立即同步、
// collect→去知识库）。动作语义由调用方定义（组件不感知路由 / op），无动作的
// 步骤不渲染按钮——「怎么做」进一步变成「点这里做」。
import { buildOnboardingSteps, ONBOARDING_SUBTITLE, ONBOARDING_TITLE, type OnboardingInput } from '@/core/plan/onboarding';
import type { ReactNode } from 'react';
import { cx } from '../components';

export type OnboardingStepKey = 'sync' | 'watch' | 'collect';

export function OnboardingCard({
  input,
  compact = false,
  actions,
  footer,
}: {
  input: OnboardingInput;
  /** compact：popup 窄版（372px 弹窗内）省略副题、压缩行距 */
  compact?: boolean;
  /** 步骤直达动作（第 257 轮）：按步骤 key 提供，行尾小按钮；未提供的步骤不渲染 */
  actions?: Partial<Record<OnboardingStepKey, { label: string; onClick: () => void }>>;
  /** 卡片页脚插槽（第 319 轮）：冷启动一键演示等行动入口，由调用方注入 */
  footer?: ReactNode;
}) {
  const { steps, doneCount, allDone } = buildOnboardingSteps(input);
  return (
    <div className={cx('hdu-onboard', compact ? 'is-compact' : '', allDone ? 'is-all-done' : '')} role="group" aria-label="上手引导">
      <div className="hdu-onboard-head">
        <span className="hdu-onboard-title">{ONBOARDING_TITLE}</span>
        <span className="hdu-onboard-count" aria-label={`已完成 ${doneCount} 步，共 ${steps.length} 步`}>
          {doneCount}/{steps.length}
        </span>
      </div>
      {compact ? null : <div className="hdu-onboard-sub">{ONBOARDING_SUBTITLE}</div>}
      <ol className="hdu-onboard-steps">
        {steps.map((step, i) => {
          const action = actions?.[step.key];
          return (
            <li
              key={step.key}
              className={cx('hdu-onboard-step', step.done ? 'is-done' : '')}
              aria-label={`第 ${i + 1} 步 ${step.label}${step.done ? '，已完成' : '，待完成'}`}
            >
              <span className="hdu-onboard-step-mark" aria-hidden="true">
                {step.done ? '✓' : i + 1}
              </span>
              <span className="hdu-onboard-step-main">
                <span className="hdu-onboard-step-label">{step.label}</span>
                <span className="hdu-onboard-step-hint">{step.hint}</span>
              </span>
              {action ? (
                <button
                  type="button"
                  className="hdu-onboard-step-action"
                  onClick={action.onClick}
                >
                  {action.label}
                </button>
              ) : null}
            </li>
          );
        })}
      </ol>
      {footer ? <div className="hdu-onboard-foot">{footer}</div> : null}
    </div>
  );
}
