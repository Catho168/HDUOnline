/**
 * 三步上手引导纯函数测试（第 256 轮巡检，引导域）。
 * 覆盖：完成态派生 / 脏输入兜底 / 文案单点 / 步骤序稳定。
 */
import { describe, expect, it } from 'vitest';
import { buildOnboardingSteps, ONBOARDING_SUBTITLE, ONBOARDING_TITLE } from '@/core/plan/onboarding';

describe('buildOnboardingSteps', () => {
  it('全空输入：三步全部待完成，doneCount 0 / allDone false', () => {
    const result = buildOnboardingSteps({ hasCourse: false, hasWatch: false, hasLibrary: false });
    expect(result.steps.map((s) => s.key)).toEqual(['sync', 'watch', 'collect']);
    expect(result.steps.every((s) => !s.done)).toBe(true);
    expect(result.doneCount).toBe(0);
    expect(result.allDone).toBe(false);
  });

  it('逐项点亮：hasCourse → sync done；hasWatch → watch done；hasLibrary → collect done', () => {
    const onlyCourse = buildOnboardingSteps({ hasCourse: true, hasWatch: false, hasLibrary: false });
    expect(onlyCourse.steps.find((s) => s.key === 'sync')?.done).toBe(true);
    expect(onlyCourse.doneCount).toBe(1);

    const courseAndWatch = buildOnboardingSteps({ hasCourse: true, hasWatch: true, hasLibrary: false });
    expect(courseAndWatch.doneCount).toBe(2);
    expect(courseAndWatch.allDone).toBe(false);

    const all = buildOnboardingSteps({ hasCourse: true, hasWatch: true, hasLibrary: true });
    expect(all.allDone).toBe(true);
    expect(all.doneCount).toBe(3);
  });

  it('hasLibrary 缺省（调用方拿不到计数）：collect 步如实不点亮，不默认完成', () => {
    const result = buildOnboardingSteps({ hasCourse: true, hasWatch: true });
    expect(result.steps.find((s) => s.key === 'collect')?.done).toBe(false);
    expect(result.allDone).toBe(false);
  });

  it('脏输入（null / undefined / 多余字段）：按未完成处理，不抛错', () => {
    type OnboardingArg = Parameters<typeof buildOnboardingSteps>[0];
    const result = buildOnboardingSteps(null as unknown as OnboardingArg);
    expect(result.steps).toHaveLength(3);
    expect(result.doneCount).toBe(0);
    const dirty = buildOnboardingSteps({ hasCourse: 'yes', hasWatch: 1 } as unknown as OnboardingArg);
    expect(dirty.doneCount).toBe(0);
  });

  it('文案单点：标题/副题非空，步骤 label 与 hint 一一齐全', () => {
    expect(ONBOARDING_TITLE.length).toBeGreaterThan(0);
    expect(ONBOARDING_SUBTITLE.length).toBeGreaterThan(0);
    // 缺字段输入（运行时防御口径；类型断言仅为通过编译检查）
    const result = buildOnboardingSteps({} as Parameters<typeof buildOnboardingSteps>[0]);
    for (const step of result.steps) {
      expect(step.label.length).toBeGreaterThan(0);
      expect(step.hint.length).toBeGreaterThan(0);
    }
  });
});
