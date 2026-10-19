import { useEffect, useMemo, useState } from 'react';
import { callOp } from '@/core/shared/client';
import { loadSettings } from '@/core/shared/settings';
import type { AppSettings, CourseBundle, DashboardReport, PopupOverview } from '@/core/shared/types';
import { formatClock, formatDuration, localDayKey } from '@/core/shared/utils';
import { uuid } from '@/core/shared/utils';
import { UI_CSS } from '../content/ui/styles';
import { Button, Chip, IconButton, Progress, cx } from '../content/ui/components';
import { Icon } from '../content/ui/icons';

const EXTRA_CSS = `
.hdu-popup { width: 372px; min-height: 520px; background: var(--paper); padding: 0; }
.hdu-popup .hdu-popup-head { display: flex; align-items: center; gap: 10px; padding: 16px 16px 12px; }
.hdu-popup .hdu-popup-body { padding: 0 16px 16px; display: flex; flex-direction: column; gap: 13px; }
.hdu-popup .hdu-popup-foot { margin-top: auto; padding: 10px 16px 14px; border-top: 1px solid var(--line); display: flex; gap: 6px; background: var(--paper); }
.hdu-popup .hdu-hero-main { padding: 18px 18px; min-height: 0; gap: 12px; border-radius: 18px; }
.hdu-popup .hdu-hero-title { font-size: 20px; }
.hdu-popup .hdu-hero-main .hdu-ring { width: 60px; height: 60px; }
.hdu-popup .hdu-stat-grid { grid-template-columns: 1fr 1fr; }
.hdu-popup .hdu-stat { padding: 12px 13px; }
.hdu-popup .hdu-stat-value { font-size: 21px; }
.hdu-popup .hdu-empty { padding: 26px 12px; }
html, body { margin: 0; background: #f5f1e8; }
body.dark { background: #131518; }
`;

export function App() {
  const [overview, setOverview] = useState<PopupOverview | null>(null);
  const [fallback, setFallback] = useState<{ report: DashboardReport | null; bundles: CourseBundle[] }>({ report: null, bundles: [] });
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [tabId, setTabId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const loaded = await loadSettings();
      setSettings(loaded);
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (tab?.id != null) {
        setTabId(tab.id);
        try {
          const res = (await chrome.tabs.sendMessage(tab.id, { type: 'POPUP_OVERVIEW', requestId: uuid() })) as
            | { type?: string; overview?: PopupOverview }
            | undefined;
          if (res?.overview) setOverview(res.overview);
        } catch {
          /* 内容脚本未注入 */
        }
      }
      const [report, bundles] = await Promise.all([
        callOp('stats.report', { days: 30 }).catch(() => null),
        callOp('course.bundles', {}).catch(() => [] as CourseBundle[]),
      ]);
      setFallback({ report, bundles });
      setLoading(false);
    })();
  }, []);

  const theme = useResolvedTheme(settings);
  useEffect(() => {
    document.body.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  const session = overview?.session ?? null;
  const report = fallback.report;
  const recent = useMemo(() => {
    const list = [...fallback.bundles];
    list.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
    return list.slice(0, 3);
  }, [fallback.bundles]);

  const send = async (message: unknown) => {
    if (tabId == null) return;
    try {
      await chrome.tabs.sendMessage(tabId, message);
      window.close();
    } catch {
      /* 忽略 */
    }
  };

  return (
    <div className={cx('hdu-root', 'hdu-popup')} data-theme={theme}>
      <style>{UI_CSS + EXTRA_CSS}</style>
      <header className="hdu-popup-head">
        <div className="hdu-brand-mark" style={{ width: 32, height: 32, fontSize: 17 }}>学</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: 'var(--font-serif)', fontSize: 14.5, fontWeight: 600 }}>智慧课堂助手</div>
          <div style={{ fontSize: 10, color: 'var(--muted)', letterSpacing: '.08em' }}>LEARNING COMPANION</div>
        </div>
        <IconButton icon="settings" label="设置" onClick={() => { void chrome.runtime.openOptionsPage(); window.close(); }} />
      </header>

      <main className="hdu-popup-body">
        {session ? (
          <div className="hdu-hero-main">
            <div>
              <div className="hdu-hero-eyebrow">正在学习</div>
              <div className="hdu-hero-title">{session.courseName}</div>
              <div className="hdu-hero-meta" style={{ marginTop: 6 }}>{session.courLabel}</div>
            </div>
            <div className="hdu-hero-actions">
              <Button size="small" variant="accent" icon="panel" onClick={() => void send({ type: 'UI_COMMAND', command: 'openPanel' })}>
                打开本节助手
              </Button>
              <Button size="small" icon="library" onClick={() => void send({ type: 'UI_COMMAND', command: 'openCenter' })}>
                学习中心
              </Button>
            </div>
          </div>
        ) : (
          <div className="hdu-card pad" style={{ padding: 16 }}>
            <div className="hdu-section-title">今天，从一节课开始</div>
            <div className="hdu-hint" style={{ marginTop: 5 }}>
              {loading ? '正在读取本机数据…' : '打开智慧课堂的播放页或列表页，插件会在这里汇总你的进度。'}
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 11 }}>
              <Button size="small" icon="library" onClick={() => tabId != null && chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') })}>
                打开学习看板
              </Button>
            </div>
          </div>
        )}

        <div className="hdu-stat-grid">
          <div className="hdu-stat">
            <div className="hdu-stat-top"><Icon name="clock" /> 今日</div>
            <div className="hdu-stat-value">{(report?.todaySec ?? 0) >= 3600 ? `${((report?.todaySec ?? 0) / 3600).toFixed(1)}` : Math.round((report?.todaySec ?? 0) / 60)}<small>{(report?.todaySec ?? 0) >= 3600 ? '小时' : '分钟'}</small></div>
          </div>
          <div className="hdu-stat">
            <div className="hdu-stat-top"><Icon name="flame" /> 连续</div>
            <div className="hdu-stat-value">{report?.streakDays ?? 0}<small>天</small></div>
          </div>
        </div>

        {overview ? (
          <div className="hdu-card" style={{ padding: 13 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 }}>
              <span className="hdu-section-title" style={{ fontSize: 13.5 }}>本节状态</span>
              <Chip tone={overview.transcript?.exists ? 'jade' : 'default'}>{overview.transcript?.exists ? '已转写' : '未转写'}</Chip>
              <Chip tone={overview.ai?.exists ? 'accent' : 'default'}>{overview.ai?.exists ? `${overview.ai.topicCount} 个知识点` : '未标注'}</Chip>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--muted)' }}>
              <span>完看度 {Math.round((overview.watchRatio ?? 0) * 100)}%</span>
              {session?.lastPlayTime ? <span>· 上次 {formatClock(session.lastPlayTime)}</span> : null}
              {overview.job && ['transcribing', 'extracting', 'queued'].includes(overview.job.status) ? <span>· 转写 {Math.round(overview.job.progress * 100)}%</span> : null}
            </div>
            <div style={{ marginTop: 8 }}><Progress value={overview.watchRatio ?? 0} jade /></div>
          </div>
        ) : null}

        {recent.length > 0 ? (
          <div className="hdu-card" style={{ padding: '10px 13px' }}>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>最近学习</div>
            {recent.map((bundle) => (
              <div className="hdu-list-row" key={bundle.course.teclId} style={{ padding: '8px 0' }}>
                <div className="hdu-list-main">
                  <div className="hdu-list-title">{bundle.course.subjName}</div>
                  <div className="hdu-list-sub">{formatDuration(bundle.watchedSec)} · 完看 {bundle.finishedCount}/{bundle.sessionCount}</div>
                </div>
                <Icon name="chevronRight" size={14} />
              </div>
            ))}
          </div>
        ) : null}

        <div className="hdu-hint">
          数据只保存在本机 · 不调用站点写接口
        </div>
      </main>

      <footer className="hdu-popup-foot">
        <Button size="small" variant="ghost" icon="chart" onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') })}>
          学习看板
        </Button>
        <Button size="small" variant="ghost" icon="settings" onClick={() => { void chrome.runtime.openOptionsPage(); window.close(); }}>
          设置
        </Button>
        <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--muted)', alignSelf: 'center' }}>{localDayKey()}</span>
      </footer>
    </div>
  );
}

function useResolvedTheme(settings: AppSettings | null): 'light' | 'dark' {
  const [dark, setDark] = useState(() => {
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);
  if (settings?.theme === 'dark') return 'dark';
  if (settings?.theme === 'light') return 'light';
  return dark ? 'dark' : 'light';
}
