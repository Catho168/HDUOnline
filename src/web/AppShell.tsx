import { useEffect, useState } from 'react';
import { getDb } from '@/core/db';
import { enterDemo } from '@/core/demo/seed';
import { loadSettings, onSettingsChanged } from '@/core/shared/settings';
import { useResolvedTheme } from '@/core/shared/useResolvedTheme';
import type { AppSettings, CourseEntity, SessionEntity } from '@/core/shared/types';
import { ensureUiHost } from '@/entrypoints/content/ui/host';
import { mountUi } from '@/entrypoints/content/ui/mount';
import { uiStore } from '@/entrypoints/content/ui/store';
import { App as DashboardApp } from '@/entrypoints/dashboard/App';
import { App as OptionsApp } from '@/entrypoints/options/App';
import { App as PopupApp } from '@/entrypoints/popup/App';
import { BiliSim } from './BiliSim';
import { PlayPageSim } from './PlayPageSim';
import { navigateWebSurface, onWebNavigate, type WebSurface } from './chromeShim';
import { createWebContentController, type WebContentController } from './contentBridge';

const DEFAULT_PLAY_HASH = '#/play-center?teclId=9102&courseId=1227052&target=video';
const DEMO_BOOTED_KEY = 'hdu_web_demo_booted';

const TABS: ReadonlyArray<{ id: WebSurface; label: string }> = [
  { id: 'center', label: '学习中心' },
  { id: 'play', label: '播放页助手' },
  { id: 'dashboard', label: '学习看板' },
  { id: 'bili', label: 'B 站助手' },
  { id: 'options', label: '设置' },
  { id: 'popup', label: '扩展弹窗' },
];

function inferInitialSurface(): WebSurface {
  const sp = new URLSearchParams(window.location.search);
  const querySurface = sp.get('surface') as WebSurface | null;
  if (querySurface && TABS.some((t) => t.id === querySurface)) return querySurface;
  const h = window.location.hash;
  if (h.includes('play-center') || h.includes('video-detail') || h.includes('play-video')) {
    return 'play';
  }
  return 'center';
}

function isPlayHash(hash: string): boolean {
  return hash.includes('play-center') || hash.includes('video-detail') || hash.includes('play-video');
}

function extractBvidFromHash(hash?: string): string | undefined {
  if (!hash) return undefined;
  const m = hash.match(/bvid=(BV[\w]+)/);
  return m?.[1];
}

function PortalBackdrop({
  dark,
  onOpenCenter,
  onOpenPlay,
}: {
  dark: boolean;
  onOpenCenter: () => void;
  onOpenPlay: (teclId: number, courId: number) => void;
}) {
  const [courses, setCourses] = useState<CourseEntity[]>([]);
  const [sessions, setSessions] = useState<SessionEntity[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const db = await getDb();
        const [cs, ss] = await Promise.all([db.getAll('courses'), db.getAll('sessions')]);
        if (cancelled) return;
        setCourses(cs);
        setSessions(ss);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className={`hdu-portal-bg${dark ? ' is-dark' : ''}`}>
      <div className="hdu-portal-inner">
        <div className="hdu-portal-hero">
          <div>
            <h2>杭电智慧课堂 · 站点首页模拟</h2>
            <p>学习中心已收起时显示站点课程墙；可随时重新打开学习中心或进入任一课次的播放页助手。</p>
          </div>
          <button type="button" className="hdu-portal-btn" onClick={onOpenCenter}>
            展开学习中心
          </button>
        </div>

        <div className="hdu-portal-grid">
          {courses.map((course) => {
            const firstSession = sessions.find((s) => s.teclId === course.teclId);
            return (
              <div key={course.teclId} className="lesson-card card-item hdu-portal-card">
                <div className="course-title">{course.subjName}</div>
                <div className="hdu-portal-meta">
                  {course.teacherNames.join('、') || '主讲教师'}
                  {course.clroName ? ` · ${course.clroName}` : ''}
                </div>
                {firstSession ? (
                  <button
                    type="button"
                    className="hdu-portal-link"
                    onClick={() => onOpenPlay(course.teclId, firstSession.courId)}
                  >
                    进入播放页 ({firstSession.courLabel || `课次 #${firstSession.courId}`})
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function AppShell() {
  const [surface, setSurface] = useState<WebSurface>(() => inferInitialSurface());
  const [biliBvid, setBiliBvid] = useState<string | undefined>(undefined);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [ready, setReady] = useState(false);
  const [dataRevision, setDataRevision] = useState(0);

  // 初始化设置与演示数据（仅首次空库启动时自动播种，之后保留用户切换状态）
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await loadSettings();
        if (!localStorage.getItem(DEMO_BOOTED_KEY)) {
          localStorage.setItem(DEMO_BOOTED_KEY, '1');
          if (!loaded.demo?.enabled) {
            const db = await getDb();
            const [courseCount, favCount] = await Promise.all([db.count('courses'), db.count('favorites')]);
            if (courseCount === 0 && favCount === 0) {
              await enterDemo();
            }
          }
        }
        const finalSettings = await loadSettings();
        if (!cancelled) {
          setSettings(finalSettings);
          setReady(true);
        }
      } catch {
        if (!cancelled) setReady(true);
      }
    })();

    const offSettings = onSettingsChanged((next) => {
      setSettings((prev) => {
        if (prev?.demo?.enabled !== next.demo?.enabled) {
          setDataRevision((r) => r + 1);
        }
        return next;
      });
    });

    return () => {
      cancelled = true;
      offSettings();
    };
  }, []);

  const resolvedTheme = useResolvedTheme(settings);
  const dark = resolvedTheme === 'dark';

  // 监听来自 chromeShim / window.open / hashchange 的导航
  useEffect(() => {
    const offNav = onWebNavigate((nextSurface, hash) => {
      if (nextSurface === 'bili') {
        const extracted = extractBvidFromHash(hash);
        if (extracted) setBiliBvid(extracted);
      }
      setSurface(nextSurface);
    });

    const onHashChange = () => {
      if (isPlayHash(window.location.hash)) {
        setSurface('play');
      } else if (window.location.hash === '#/home') {
        setSurface('center');
      }
    };

    window.addEventListener('hashchange', onHashChange);
    return () => {
      offNav();
      window.removeEventListener('hashchange', onHashChange);
    };
  }, []);

  // 仅在 HDU 站点模式（学习中心 / 播放页助手）挂载 Shadow DOM 浮层与 WebContentController
  useEffect(() => {
    if (!ready) return;
    if (surface !== 'center' && surface !== 'play') return;

    if (surface === 'center' && (!window.location.hash || isPlayHash(window.location.hash) || window.location.hash === '#/')) {
      window.history.replaceState(null, '', '#/home');
    } else if (surface === 'play' && !isPlayHash(window.location.hash)) {
      window.history.replaceState(null, '', DEFAULT_PLAY_HASH);
    }

    const { shadow } = ensureUiHost();
    let offsetStyle = shadow.querySelector<HTMLStyleElement>('style[data-hdu-web-shell]');
    if (!offsetStyle) {
      offsetStyle = document.createElement('style');
      offsetStyle.setAttribute('data-hdu-web-shell', '1');
      offsetStyle.textContent = '.hdu-center { top: 38px !important; }';
      shadow.appendChild(offsetStyle);
    }

    const unmount = mountUi();
    let controller: WebContentController | null = null;
    let cancelled = false;

    void createWebContentController().then((ctrl) => {
      if (cancelled) {
        ctrl.dispose();
        return;
      }
      controller = ctrl;
      ctrl.start();
    });

    return () => {
      cancelled = true;
      controller?.dispose();
      unmount();
    };
  }, [ready, surface, dataRevision]);

  const switchSurface = (target: WebSurface) => {
    if (target === 'center') {
      navigateWebSurface('center', '#/home');
      if (surface === 'center') {
        uiStore.patch({ centerOpen: true, centerSuppressed: false });
      }
      return;
    }
    if (target === 'play') {
      const targetHash = isPlayHash(window.location.hash) ? window.location.hash : DEFAULT_PLAY_HASH;
      navigateWebSurface('play', targetHash);
      return;
    }
    navigateWebSurface(target);
  };

  if (!ready) {
    return (
      <div className={`hdu-web-loading${dark ? ' is-dark' : ''}`}>
        <style>{SHELL_CSS}</style>
        <span>正在初始化工作区…</span>
      </div>
    );
  }

  return (
    <div className={`hdu-web-shell${dark ? ' is-dark' : ''}`}>
      <style>{SHELL_CSS}</style>
      <header className="hdu-web-bar">
        <div className="hdu-web-brand">
          <span className="hdu-web-dot" aria-hidden="true" />
          <span className="hdu-web-title">杭电智慧课堂学习助手</span>
        </div>
        <nav className="hdu-web-tabs" aria-label="功能入口切换">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`hdu-web-tab${surface === tab.id ? ' is-active' : ''}`}
              onClick={() => switchSurface(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="hdu-web-stage" key={`${surface}-${dataRevision}`}>
        {surface === 'center' ? (
          <PortalBackdrop
            dark={dark}
            onOpenCenter={() => uiStore.patch({ centerOpen: true, centerSuppressed: false })}
            onOpenPlay={(teclId, courId) => {
              navigateWebSurface('play', `#/play-center?teclId=${teclId}&courseId=${courId}&target=video`);
            }}
          />
        ) : null}

        {surface === 'play' ? <PlayPageSim dark={dark} /> : null}
        {surface === 'dashboard' ? <DashboardApp /> : null}
        {surface === 'bili' ? <BiliSim dark={dark} bvid={biliBvid} /> : null}
        {surface === 'options' ? <OptionsApp /> : null}
        {surface === 'popup' ? (
          <div className="hdu-popup-stage">
            <div className="hdu-popup-frame">
              <PopupApp />
            </div>
          </div>
        ) : null}
      </main>
    </div>
  );
}

const SHELL_CSS = String.raw`
* { box-sizing: border-box; }
html, body, #root {
  margin: 0;
  padding: 0;
  min-height: 100%;
  font-family: "PingFang SC", "Microsoft YaHei", "Segoe UI", system-ui, sans-serif;
}
.hdu-web-loading {
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f5f1e8;
  color: #474d52;
  font-size: 14px;
}
.hdu-web-loading.is-dark {
  background: #131518;
  color: #bcb6a8;
}
.hdu-web-shell {
  min-height: 100vh;
  padding-top: 38px;
  background: #f5f1e8;
  color: #171a1d;
}
.hdu-web-shell.is-dark {
  background: #131518;
  color: #ece8dd;
}
.hdu-web-bar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 38px;
  z-index: 2147483050;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 16px;
  background: #eee8db;
  border-bottom: 1px solid #e2d9c8;
  color: #171a1d;
}
.hdu-web-shell.is-dark .hdu-web-bar {
  background: #1a1d21;
  border-bottom-color: #2c3137;
  color: #ece8dd;
}
.hdu-web-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  font-weight: 600;
  white-space: nowrap;
}
.hdu-web-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #a4551b;
}
.hdu-web-shell.is-dark .hdu-web-dot {
  background: #dfa05a;
}
.hdu-web-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  overflow-x: auto;
  scrollbar-width: none;
}
.hdu-web-tabs::-webkit-scrollbar {
  display: none;
}
.hdu-web-tab {
  height: 26px;
  padding: 0 11px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: #474d52;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition: background .15s, color .15s, border-color .15s;
}
.hdu-web-tab:hover {
  background: rgba(164, 85, 27, 0.08);
  color: #171a1d;
}
.hdu-web-tab.is-active {
  background: #fffdf8;
  border-color: #cfc3ad;
  color: #a4551b;
  font-weight: 600;
}
.hdu-web-shell.is-dark .hdu-web-tab {
  color: #bcb6a8;
}
.hdu-web-shell.is-dark .hdu-web-tab:hover {
  background: rgba(223, 160, 90, 0.12);
  color: #ece8dd;
}
.hdu-web-shell.is-dark .hdu-web-tab.is-active {
  background: #22262b;
  border-color: #3d444c;
  color: #dfa05a;
}
.hdu-web-stage {
  min-height: calc(100vh - 38px);
}
.hdu-dash, .hdu-options {
  height: calc(100vh - 38px) !important;
}
.hdu-popup-stage {
  min-height: calc(100vh - 38px);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 28px 16px 60px;
}
.hdu-popup-frame {
  border-radius: 16px;
  overflow: hidden;
  border: 1px solid #e2d9c8;
  box-shadow: 0 22px 48px -24px rgba(23, 26, 29, 0.32);
}
.hdu-web-shell.is-dark .hdu-popup-frame {
  border-color: #2c3137;
  box-shadow: 0 22px 48px -20px rgba(0, 0, 0, 0.7);
}
.hdu-portal-bg {
  min-height: calc(100vh - 38px);
  padding: 28px 24px 80px;
  background: #f5f1e8;
}
.hdu-portal-bg.is-dark {
  background: #131518;
}
.hdu-portal-inner {
  max-width: 1080px;
  margin: 0 auto;
}
.hdu-portal-hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  padding: 20px 24px;
  border-radius: 16px;
  background: #fffdf8;
  border: 1px solid #e2d9c8;
}
.hdu-portal-bg.is-dark .hdu-portal-hero {
  background: #1a1d21;
  border-color: #2c3137;
}
.hdu-portal-hero h2 {
  margin: 0 0 4px;
  font-size: 18px;
}
.hdu-portal-hero p {
  margin: 0;
  font-size: 13px;
  color: #6a6e71;
}
.hdu-portal-bg.is-dark .hdu-portal-hero p {
  color: #948f84;
}
.hdu-portal-btn {
  padding: 8px 16px;
  border-radius: 10px;
  border: none;
  background: #a4551b;
  color: #fffdf8;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.hdu-portal-bg.is-dark .hdu-portal-btn {
  background: #dfa05a;
  color: #131518;
}
.hdu-portal-grid {
  margin-top: 18px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 14px;
}
.hdu-portal-card {
  padding: 16px 18px;
  border-radius: 14px;
  background: #fffdf8;
  border: 1px solid #e2d9c8;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.hdu-portal-bg.is-dark .hdu-portal-card {
  background: #1a1d21;
  border-color: #2c3137;
}
.hdu-portal-card .course-title {
  font-size: 15px;
  font-weight: 600;
}
.hdu-portal-meta {
  font-size: 12.5px;
  color: #6a6e71;
}
.hdu-portal-bg.is-dark .hdu-portal-meta {
  color: #948f84;
}
.hdu-portal-link {
  margin-top: auto;
  align-self: flex-start;
  padding: 6px 12px;
  border-radius: 8px;
  border: 1px solid #e2d9c8;
  background: transparent;
  color: #a4551b;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}
.hdu-portal-bg.is-dark .hdu-portal-link {
  border-color: #2c3137;
  color: #dfa05a;
}
`;
