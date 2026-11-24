/**
 * 演示模式角标与一键演示按钮（第 319 轮，演示域）。
 *
 *  - DemoBadge：演示模式开启期间显示的琥珀色「演示模式」角标 + 退出按钮。
 *    挂在三个入口的页头（学习中心顶栏 / popup / 学习看板），防止演示数据被误认为
 *    真实学习记录。退出后统一 location.reload()——三个入口的数据都随新连接按
 *    真实库重读，页面级重载是最省心智的刷新方式。
 *  - DemoStartButton：冷启动空状态（OnboardingCard 页脚）与设置页共用的
 *    「一键演示」入口；开启成功后同样整页重载进入满配界面。
 */
import { useEffect, useState } from 'react';
import { callOp } from '@/core/shared/client';
import { errorTextOf } from '@/core/shared/errors';
import type { DemoStatusResult } from '@/core/shared/ops';
import { Button, Chip, cx } from './components';

/** 退出演示并整页重载（低频操作，重载换来三入口数据一致重读） */
async function exitAndReload(): Promise<void> {
  await callOp('demo.exit', {});
  window.location.reload();
}

export function DemoBadge({ className }: { className?: string }) {
  const [status, setStatus] = useState<DemoStatusResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    callOp('demo.status', {})
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (!status?.enabled) return null;
  return (
    <span className={cx('hdu-demo-badge', className)} role="status" aria-label="当前处于演示模式">
      <Chip tone="accent" icon="spark" title="演示数据存放在独立数据库，退出即删除；真实数据不受影响">
        演示模式
      </Chip>
      <Button
        size="small"
        variant="ghost"
        loading={busy}
        onClick={() => {
          setBusy(true);
          void exitAndReload()
            .catch(() => undefined) // 退出失败不阻塞页面（角标留在场，可重试）
            .finally(() => setBusy(false));
        }}
      >
        退出
      </Button>
    </span>
  );
}

/** 「一键演示」入口：进入演示模式（幂等播种）后整页重载 */
export function DemoStartButton({ label = '一键演示' }: { label?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="small"
      variant="accent"
      icon="spark"
      loading={busy}
      onClick={() => {
        if (busy) return;
        setBusy(true);
        callOp('demo.enter', {})
          .then(() => window.location.reload())
          .catch((err) => {
            // 失败留在空态界面，错误只提示不阻塞（空态卡仍在）
            window.alert(`演示模式开启失败：${errorTextOf(err, '未知错误')}`);
            setBusy(false);
          });
      }}
    >
      {label}
    </Button>
  );
}
