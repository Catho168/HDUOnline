import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { callOp } from '@/core/shared/client';
import { errorTextOf } from '@/core/shared/errors';
import { ASR_MODELS, DEFAULT_SETTINGS, MAX_LOG_ENTRIES, PROVIDER_PRESETS, type AsrModelTier } from '@/core/shared/constants';
import { checkUrl, toOriginPattern } from '@/core/shared/urlGuard';
import { loadSecrets, loadSettings, saveSecrets, saveSettings } from '@/core/shared/settings';
import { clearLogs, readLogs, applyDebugLogEnabled, formatLogsAsText, type LogEntry } from '@/core/shared/logger';
import { estimateStoreGrowth, type StoreGrowthEstimate } from '@/core/shared/storage';
import { addDaysKey, formatBytes, localDayKey } from '@/core/shared/utils';
import { useResolvedTheme } from '@/core/shared/useResolvedTheme';
import { importModelFile } from '@/core/asr/modelCache';
import { clampDailyGoalMin, goalConsistencyHint } from '@/core/plan/dailyGoal';
import { WeeklyGoalCalendarRow } from '../content/ui/learning/OverviewView';
import { shortcutIssueOf } from '@/core/shared/shortcutRules';
import type { AppSettings, LlmKind, LlmProviderConfig, ReviewTemplate, SecretsStore, WatchRecordEntity } from '@/core/shared/types';
import type { DemoStatusResult } from '@/core/shared/ops';
import { UI_CSS } from '../content/ui/styles';
import { downloadTextFile } from '../content/ui/download';
import { Button, Chip, ConfirmButton, ConfirmIconButton, Field, IconButton, Modal, PillTabs, TextInput, cx, useTwoStepConfirm } from '../content/ui/components';
import { Icon, type IconName } from '../content/ui/icons';

/** 全量数据导出成功摘要的段清单（第 250 轮巡检）：与 core/export/dataExport 的
 *  counts 键对齐，按用户关心的资产优先排列；顺序即摘要行展示顺序 */
const EXPORT_SUMMARY_KEYS = ['favorites', 'notes', 'reviewJobs', 'weeklyPlans', 'courses', 'sessions', 'folders', 'tags', 'videoProgress', 'curriculum', 'settings'] as const;
const EXPORT_SUMMARY_LABELS: Record<(typeof EXPORT_SUMMARY_KEYS)[number], string> = {
  favorites: '收藏',
  notes: '笔记',
  reviewJobs: '复习',
  weeklyPlans: '周计划',
  courses: '课程',
  sessions: '课次',
  folders: '文件夹',
  tags: '标签',
  videoProgress: 'B站进度',
  curriculum: '课表',
  settings: '设置',
};

const EXTRA_CSS = String.raw`
html, body { margin: 0; height: 100%; background: #f5f1e8; }
body.dark { background: #131518; }
.hdu-options { display: flex; height: 100vh; background: var(--paper); overflow: hidden; }
.hdu-options-nav { width: 232px; flex: 0 0 232px; border-right: 1px solid var(--line); background: color-mix(in srgb, var(--paper-2) 60%, transparent); padding: 22px 14px; display: flex; flex-direction: column; gap: 24px; }
.hdu-options-main { flex: 1; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
.hdu-options-content { flex: 1; overflow: auto; }
.hdu-options-inner { max-width: 900px; margin: 0 auto; padding: 30px 36px 90px; }
.hdu-options .hdu-card { padding: 20px; }
.hdu-options-row { display: flex; align-items: center; gap: 14px; padding: 14px 0; border-bottom: 1px solid var(--line); }
.hdu-options-row:last-child { border-bottom: 0; }
.hdu-options-row-main { flex: 1; min-width: 0; }
.hdu-options-row-title { font-size: 13px; font-weight: 500; }
.hdu-options-row-sub { font-size: 11.5px; color: var(--muted); margin-top: 2px; line-height: 1.6; }
/* 开关副文案的次要说明行（第 243 轮巡检）：时刻说明 muted 小字，比主副文案再弱一档 */
.hdu-options-row-sub-note { font-size: 11px; opacity: .82; margin-top: 1px; }
.hdu-options-row-side { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; }
/* 全量数据导出行（第 250 轮巡检，数据自主权域）：中性行 + 主操作轻按钮（非 danger——
   纯读操作无破坏性）；sub 副文案说明字段范围与「不用于导入」防呆；摘要行 muted 小字
   （成功后出现，数据条目数如实汇报），淡入 150ms 对齐 toast 节奏；loading 态按钮
   disabled + 文案切换「导出中…」，完成后自然恢复（无闪烁——状态单调切换） */
.hdu-export-row { display: flex; align-items: center; gap: 14px; padding: 14px 0; }
.hdu-export-row-main { flex: 1; min-width: 0; }
.hdu-export-summary { font-size: 11px; color: var(--muted); margin-top: 4px; line-height: 1.6; animation: hdu-fade-in .15s ease-out; overflow-wrap: anywhere; }
/* 存储用量行（第 254 轮巡检，存储健康域）：与 .hdu-export-row 同构行距；三段式
   数值排版（serif 数值 tabular-nums + muted 标签）+ 4px 细进度条（accent-soft 底 +
   accent 填充，超 80% 加 .warn 转 gold 预警档）——全走 --* 变量，暗色自动跟随 */
.hdu-storage-row { display: flex; align-items: center; gap: 14px; padding: 14px 0; border-bottom: 1px solid var(--line); }
.hdu-storage-row-main { flex: 1; min-width: 0; }
.hdu-storage-segments { display: flex; flex-wrap: wrap; gap: 6px 28px; margin-top: 7px; }
.hdu-storage-seg { display: flex; flex-direction: column; gap: 2px; min-width: 76px; }
.hdu-storage-seg-value { font-family: var(--font-serif); font-size: 16.5px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.2; }
.hdu-storage-seg-label { font-size: 10.5px; color: var(--muted); letter-spacing: .02em; }
.hdu-storage-meter { height: 4px; border-radius: 99px; background: var(--accent-soft); overflow: hidden; margin-top: 10px; max-width: 320px; }
.hdu-storage-meter > i { display: block; height: 100%; border-radius: inherit; background: var(--accent); transition: width .4s ease; }
.hdu-storage-meter.warn > i { background: var(--gold); }
/* 自定义徽章编辑态（第 151 轮巡检）：强调色描边 + 浅底，区分浏览态 */
.hdu-badge-edit { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 5px 7px; border: 1px solid var(--accent); border-radius: 8px; background: color-mix(in srgb, var(--accent) 5%, transparent); }
.hdu-switch { position: relative; width: 38px; height: 22px; flex: 0 0 auto; }
.hdu-switch input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
.hdu-switch-track { position: absolute; inset: 0; border-radius: 99px; background: var(--paper-3); border: 1px solid var(--line); transition: background .15s, border-color .15s; }
.hdu-switch-thumb { position: absolute; top: 3px; left: 3px; width: 14px; height: 14px; border-radius: 50%; background: var(--muted); transition: transform .15s, background .15s; }
.hdu-switch input:checked + .hdu-switch-track { background: var(--ink); border-color: var(--ink); }
.hdu-switch input:checked + .hdu-switch-track + .hdu-switch-thumb { transform: translateX(16px); background: var(--paper-2); }
/* 聚焦态（第 263 轮，样式域 / 三态一致性）：开关的 input 为视觉隐藏覆盖层，键盘聚焦
   此前无任何可见反馈——focus-visible 时轨道转 accent-2 边框 + 光环（与 .hdu-input:focus
   同语言），鼠标点击不触发（focus-visible 仅键盘聚焦） */
.hdu-switch input:focus-visible + .hdu-switch-track { border-color: var(--accent-2); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-2) 16%, transparent); }
.hdu-provider { display: flex; align-items: center; gap: 12px; padding: 13px 0; border-bottom: 1px solid var(--line); }
.hdu-provider:last-child { border-bottom: 0; }
.hdu-provider-icon { width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent); flex: 0 0 auto; }
.hdu-provider-name { font-size: 13px; font-weight: 500; }
.hdu-provider-sub { font-size: 11px; color: var(--muted); margin-top: 2px; }
.hdu-provider-actions { margin-left: auto; display: flex; align-items: center; gap: 4px; }
.hdu-log { font-family: var(--font-mono); font-size: 10.5px; line-height: 1.7; color: var(--ink-soft); white-space: pre-wrap; word-break: break-all; padding: 8px 0; }
.hdu-log-row { display: flex; align-items: flex-start; gap: 4px; border-bottom: 1px dashed var(--line); }
.hdu-log-row .hdu-log { flex: 1 1 auto; }
.hdu-log-row .hdu-icon-btn { flex: 0 0 auto; margin-top: 6px; }
.hdu-log-reset { border: 0; background: transparent; padding: 0 2px; margin-left: 4px; font: inherit; color: var(--accent); cursor: pointer; text-decoration: underline; }
.hdu-log-reset:hover { color: var(--danger); }
.hdu-kv { display: grid; grid-template-columns: 130px 1fr; gap: 8px 14px; font-size: 12px; }
.hdu-kv dt { color: var(--muted); }
.hdu-kv dd { margin: 0; }
.hdu-options .hdu-nav { flex-direction: column; gap: 3px; }
.hdu-options .hdu-nav-item { width: 100%; }
@media (max-width: 820px) {
  .hdu-options .hdu-nav { flex-direction: column; }
  .hdu-options .hdu-nav-item { width: 100%; padding: 10px 12px; }
}
@media (max-width: 640px) { .hdu-options-nav { width: 68px; flex-basis: 68px; } .hdu-options-nav .hdu-nav-label, .hdu-options-nav .hdu-nav-item span, .hdu-options-nav .hdu-brand-name, .hdu-options-nav .hdu-brand-sub { display: none; } .hdu-options-nav .hdu-nav-item { justify-content: center; width: 100%; } .hdu-options-inner { padding: 20px 18px 70px; } }
/* 键位冲突提示行（第 251 轮巡检，帮助域 / 一致性视角）：语言对齐 .hdu-goal-hint 家族
   （同圆角 8 / 同字号 11 / 同 color-mix gold 淡底 + ⚑ 前缀，软提示不阻断保存——
   即改即存模型下用户可自由改回）；归一 kbd 键帽展示（与速查浮层 kbd 同视觉：
   细描边 + 圆角 6 + tabular-nums + 600 字重），读出「当前冲突值」时键帽与输入框
   内容一眼对应；仅在有问题的行下方渲染（无问题不渲染，设置区保持安静） */
.hdu-shortcut-hint {
  display: flex; align-items: flex-start; gap: 7px;
  margin: 6px 0 2px; padding: 7px 11px; border-radius: 8px;
  font-size: 11px; line-height: 1.6;
  border: 1px solid transparent;
  color: var(--gold);
  background: color-mix(in srgb, var(--gold) 9%, transparent);
  border-color: color-mix(in srgb, var(--gold) 30%, transparent);
}
.hdu-shortcut-hint::before { content: '⚑'; flex: none; font-size: 11px; line-height: 1.6; }
.hdu-shortcut-hint kbd {
  flex: none; min-width: 20px; text-align: center; padding: 1px 6px; margin: 0 2px;
  border-radius: 6px; border: 1px solid color-mix(in srgb, var(--gold) 45%, transparent);
  font-family: var(--font-mono, monospace); font-size: 10.5px; font-weight: 600;
  font-variant-numeric: tabular-nums;
}
@media (max-width: 600px) { .hdu-shortcut-hint { padding: 6px 9px; font-size: 10.5px; } }
`;

type OptionsSection = 'ai' | 'asr' | 'learning' | 'data' | 'about';

const NAV: Array<{ key: OptionsSection; label: string; icon: IconName }> = [
  { key: 'ai', label: 'AI 服务', icon: 'spark' },
  { key: 'asr', label: '转写与模型', icon: 'brain' },
  { key: 'learning', label: '学习与界面', icon: 'settings' },
  { key: 'data', label: '数据与隐私', icon: 'library' },
  { key: 'about', label: '关于', icon: 'info' },
];

export function App() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [secrets, setSecrets] = useState<SecretsStore | null>(null);
  // 分区初始值从 URL hash 恢复（第 289 轮，可用性域）：刷新 / 直达链接可定位分区；
  // 非法 hash 回退 'ai'。切换分区时同步 hash（replaceState，不产生历史记录）。
  const [section, setSection] = useState<OptionsSection>(() => {
    const hash = typeof window !== 'undefined' ? window.location.hash.replace('#', '') : '';
    return (['ai', 'asr', 'learning', 'data', 'about'] as OptionsSection[]).includes(hash as OptionsSection)
      ? (hash as OptionsSection)
      : 'ai';
  });
  useEffect(() => {
    const hash = `#${section}`;
    if (typeof window !== 'undefined' && window.location.hash !== hash) {
      window.history.replaceState(null, '', hash);
    }
  }, [section]);
  // 切分区后内容区滚回顶部（第 278 轮，可用性域）：长分区阅读中途切走再切回，
  // 不残留上一分区的滚动位置
  const contentRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [section]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);

  const theme = useResolvedTheme(settings);
  useEffect(() => {
    document.body.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  // 诊断日志开关应用（第 291 轮，工程域）：settings.debug.logEnabled → logger 全局开关
  // （加载与即改即存后都生效——此前开关无消费方，属「假开关」）
  useEffect(() => {
    if (settings) applyDebugLogEnabled(settings.debug.logEnabled);
  }, [settings]);

  useEffect(() => {
    void (async () => {
      const [s, sec] = await Promise.all([loadSettings(), loadSecrets()]);
      setSettings(s);
      setSecrets(sec);
      setLoading(false);
    })();
  }, []);

  const notify = useCallback((text: string, error = false) => {
    setToast({ text, error });
    window.setTimeout(() => setToast(null), 3200);
  }, []);

  const patchSettings = useCallback(async (patch: Partial<AppSettings>) => {
    const next = await saveSettings(patch);
    setSettings(next);
  }, []);

  if (loading || !secrets) {
    return (
      <div className={cx('hdu-root', 'hdu-options')} data-theme={theme}>
        <style>{UI_CSS + EXTRA_CSS}</style>
        <div style={{ margin: 'auto', display: 'flex', alignItems: 'center', gap: 10, color: 'var(--muted)' }}>
          <span className="hdu-spinner" /> 正在读取设置…
        </div>
      </div>
    );
  }

  return (
    <div className={cx('hdu-root', 'hdu-options')} data-theme={theme}>
      <style>{UI_CSS + EXTRA_CSS}</style>
      <aside className="hdu-options-nav">
        <div className="hdu-brand">
          <div className="hdu-brand-mark">学</div>
          <div>
            <div className="hdu-brand-name">智慧课堂</div>
            <div className="hdu-brand-sub">Settings</div>
          </div>
        </div>
        <nav className="hdu-nav">
          <div className="hdu-nav-label">设置</div>
          {NAV.map((item) => (
            <button
              key={item.key}
              type="button"
              className={cx('hdu-nav-item', section === item.key ? 'is-active' : '')}
              onClick={() => setSection(item.key)}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="hdu-rail-foot">
          <Button size="small" variant="ghost" icon="chart" onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') })}>
            学习看板
          </Button>
          <div className="hdu-hint">所有数据只保存在本机</div>
        </div>
      </aside>
      <main className="hdu-options-main">
        <div className="hdu-topbar">
          <div>
            <div className="hdu-topbar-title">{NAV.find((n) => n.key === section)?.label}</div>
            <div className="hdu-topbar-sub">
              {section === 'ai' ? '三种请求格式，Key 仅存本机' :
                section === 'asr' ? '模型档位、转写范围与手动导入' :
                section === 'learning' ? '目标、阈值、字幕与快捷键' :
                section === 'data' ? '存储占用、日志与清理' : '版本与隐私说明'}
            </div>
          </div>
          <div className="hdu-topbar-actions">
            {toast ? <Chip tone={toast.error ? 'danger' : 'jade'} icon={toast.error ? 'alert' : 'check'}>{toast.text}</Chip> : null}
          </div>
        </div>
        <div ref={contentRef} className="hdu-options-content hdu-scroll">
          <div className="hdu-options-inner">
            {section === 'ai' ? (
              <AiSection secrets={secrets} setSecrets={setSecrets} notify={notify} />
            ) : section === 'asr' ? (
              <AsrSection settings={settings} patchSettings={patchSettings} notify={notify} />
            ) : section === 'learning' ? (
              <LearningSection settings={settings} patchSettings={patchSettings} />
            ) : section === 'data' ? (
              <DataSection settings={settings} patchSettings={patchSettings} notify={notify} />
            ) : (
              <AboutSection />
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

// ───────────────────────── AI ─────────────────────────

/** 导出供单元测试（two-step-confirm.test.ts）：provider 删除与「允许本地推理端点」开启型两步确认的行为验证 */
export function AiSection({
  secrets,
  setSecrets,
  notify,
}: {
  secrets: SecretsStore;
  setSecrets: (s: SecretsStore) => void;
  notify: (text: string, error?: boolean) => void;
}) {
  const [editing, setEditing] = useState<LlmProviderConfig | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [localAllowed, setLocalAllowed] = useState(secrets.allowLocalEndpoints);
  // 「允许本地推理端点」开启方向的两步确认（关闭方向无风险，仍即时生效）：
  // 开关第一次拨到「开」不落库，只出现红色「再点一次确认开启」按钮，3 秒无操作自动收回；
  // 第二次点击该按钮才真正持久化。开关本身始终如实反映已生效状态，不做乐观翻转再回滚。
  const localConfirm = useTwoStepConfirm();

  const persist = async (next: SecretsStore) => {
    await saveSecrets(next);
    setSecrets(next);
  };

  const test = async (provider: LlmProviderConfig) => {
    setTestingId(provider.id);
    try {
      const result = await callOp('ai.testProvider', { providerId: provider.id });
      notify(result.ok ? `连接成功：${result.text?.slice(0, 40) ?? 'OK'}` : `连接失败：${result.error ?? '未知错误'}`, !result.ok);
    } catch (err) {
      // errorTextOf：AppError 显示 userMessage，非 Error 异常值回退语境化兜底（第 29 轮清尾）
      notify(errorTextOf(err, '连接失败'), true);
    } finally {
      setTestingId(null);
    }
  };

  return (
    <>
      <div className="hdu-card">
        <div className="hdu-section-head">
          <div className="hdu-section-title">AI 服务</div>
          <div className="hdu-section-sub">Anthropic / OpenAI Chat / OpenAI Responses</div>
          <div className="hdu-section-actions">
            <Button size="small" icon="plus" onClick={() => setEditing(emptyProvider())}>添加</Button>
          </div>
        </div>
        {secrets.providers.length === 0 ? (
          <div className="hdu-hint" style={{ padding: '12px 0' }}>
            尚未配置 AI 服务。知识标注、大纲与时间点问答需要一个大模型端点；转写、收藏、统计不依赖它。
          </div>
        ) : (
          <div>
            {secrets.providers.map((provider) => (
              <div className="hdu-provider" key={provider.id}>
                <div className="hdu-provider-icon"><Icon name={provider.kind === 'anthropic-messages' ? 'spark' : 'brain'} /></div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="hdu-provider-name">
                    {provider.label}
                    {secrets.activeProviderId === provider.id ? <Chip tone="jade" className="hdu-chip">使用中</Chip> : null}
                  </div>
                  <div className="hdu-provider-sub">
                    {kindLabel(provider.kind)} · {provider.model} · {provider.baseUrl.replace(/^https?:\/\//, '')}
                  </div>
                </div>
                <div className="hdu-provider-actions">
                  <Button size="small" variant="ghost" icon="target" loading={testingId === provider.id} onClick={() => void test(provider)}>测试</Button>
                  {secrets.activeProviderId !== provider.id ? (
                    <Button size="small" variant="ghost" onClick={() => void persist({ ...secrets, activeProviderId: provider.id })}>启用</Button>
                  ) : null}
                  <IconButton icon="settings" label="编辑" onClick={() => setEditing(provider)} />
                  {/* 两步确认：第一次点击仅进入确认态（图标变警示色 + title 切换，3 秒复原），第二次点击才删除 */}
                  <ConfirmIconButton icon="trash" label="删除" confirmLabel="再点一次确认删除" onConfirm={() => {
                    const providers = secrets.providers.filter((p) => p.id !== provider.id);
                    void persist({ ...secrets, providers, activeProviderId: secrets.activeProviderId === provider.id ? (providers[0]?.id ?? null) : secrets.activeProviderId });
                  }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="hdu-card" style={{ marginTop: 14 }}>
        <div className="hdu-options-row">
          <div className="hdu-options-row-main">
            <div className="hdu-options-row-title">允许本地推理端点</div>
            <div className="hdu-options-row-sub">
              默认拒绝 127.0.0.1、10/8、192.168/16 等地址。仅当你确实在本机运行 Ollama 等推理服务时开启；
              云元数据地址始终拒绝。
            </div>
          </div>
          <div className="hdu-options-row-side">
            {localConfirm.confirming ? (
              <Button
                size="small"
                className="is-confirm"
                onClick={() => {
                  if (!localConfirm.step()) return;
                  setLocalAllowed(true);
                  void persist({ ...secrets, allowLocalEndpoints: true });
                }}
              >
                再点一次确认开启
              </Button>
            ) : null}
            <label className="hdu-switch">
              <input
                type="checkbox"
                checked={localAllowed}
                onChange={(e) => {
                  const next = e.target.checked;
                  if (!next) {
                    // 关闭方向即时生效（并收回未确认的开启态）
                    localConfirm.reset();
                    setLocalAllowed(false);
                    void persist({ ...secrets, allowLocalEndpoints: false });
                    return;
                  }
                  // 开启方向的两步确认：第一次点击只进入确认态（3 秒无操作自动收回），不落库
                  localConfirm.arm();
                }}
              />
              <span className="hdu-switch-track" />
              <span className="hdu-switch-thumb" />
            </label>
          </div>
        </div>
        <div className="hdu-hint">
          提示词、上下文窗口与温度等参数在「学习与界面」中调整；修改提示词会由版本号触发缓存失效。
        </div>
      </div>

      {editing ? (
        <ProviderModal
          provider={editing}
          allowLocal={localAllowed}
          onClose={() => setEditing(null)}
          onSave={async (provider) => {
            const exists = secrets.providers.some((p) => p.id === provider.id);
            const providers = exists ? secrets.providers.map((p) => (p.id === provider.id ? provider : p)) : [...secrets.providers, provider];
            await persist({ ...secrets, providers, activeProviderId: secrets.activeProviderId ?? provider.id });
            setEditing(null);
            notify('AI 服务已保存');
          }}
        />
      ) : null}
    </>
  );
}

function emptyProvider(): LlmProviderConfig {
  return {
    id: crypto.randomUUID(),
    label: '新的 AI 服务',
    kind: 'openai-chat',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    apiKey: '',
  };
}

function kindLabel(kind: LlmKind): string {
  return kind === 'anthropic-messages' ? 'Anthropic Messages' : kind === 'openai-chat' ? 'OpenAI Chat Completions' : 'OpenAI Responses';
}

function ProviderModal({
  provider,
  allowLocal,
  onClose,
  onSave,
}: {
  provider: LlmProviderConfig;
  allowLocal: boolean;
  onClose: () => void;
  onSave: (provider: LlmProviderConfig) => Promise<void>;
}) {
  const [draft, setDraft] = useState(provider);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showKey, setShowKey] = useState(false);

  const save = async () => {
    setError(null);
    const guard = checkUrl(draft.baseUrl, { allowLocal });
    if (!guard.ok) {
      setError(guard.message ?? '端点地址不合法');
      return;
    }
    if (!draft.apiKey.trim()) {
      setError('请填写 API Key（示例：sk-test-not-a-real-key）');
      return;
    }
    if (!draft.model.trim()) {
      setError('请填写模型名');
      return;
    }
    const origin = toOriginPattern(draft.baseUrl);
    if (origin) {
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) {
        setError('未授予该端点的访问权限，保存失败');
        return;
      }
    }
    setSaving(true);
    try {
      await onSave({ ...draft, baseUrl: draft.baseUrl.replace(/\/+$/, ''), label: draft.label.trim() || draft.model });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      title={provider.apiKey ? '编辑 AI 服务' : '添加 AI 服务'}
      onClose={onClose}
      footer={
        <>
          <Button size="small" variant="ghost" onClick={onClose}>取消</Button>
          <Button size="small" variant="primary" loading={saving} onClick={() => void save()}>保存</Button>
        </>
      }
    >
      <Field label="预设">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {PROVIDER_PRESETS.map((preset) => (
            <button
              type="button"
              key={preset.label}
              className="hdu-filter-pill"
              onClick={() => setDraft({ ...draft, label: preset.label, kind: preset.kind, baseUrl: preset.baseUrl, model: preset.model })}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </Field>
      <Field label="名称">
        <TextInput value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="例如：DeepSeek" />
      </Field>
      <Field label="请求格式">
        <PillTabs
          value={draft.kind}
          items={[
            { value: 'anthropic-messages', label: 'Anthropic' },
            { value: 'openai-chat', label: 'Chat' },
            { value: 'openai-responses', label: 'Responses' },
          ]}
          onChange={(kind) => setDraft({ ...draft, kind })}
        />
      </Field>
      <Field label="端点 Base URL" hint="只填到域名或反代前缀；插件会拼接 /v1/messages、/v1/chat/completions 或 /v1/responses">
        <TextInput value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} placeholder="https://api.deepseek.com" />
      </Field>
      <Field label="模型">
        <TextInput value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} placeholder="deepseek-chat" />
      </Field>
      <Field label="API Key" hint="仅保存在 chrome.storage.local，不参与账号云同步；日志会自动打码。">
        <div style={{ display: 'flex', gap: 6 }}>
          <TextInput
            type={showKey ? 'text' : 'password'}
            value={draft.apiKey}
            onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
            placeholder="sk-..."
            style={{ flex: 1 }}
          />
          <Button size="small" variant="ghost" icon={showKey ? 'eyeOff' : 'eye'} onClick={() => setShowKey((v) => !v)}>
            {showKey ? '隐藏' : '显示'}
          </Button>
        </div>
      </Field>
      {error ? <div className="hdu-error-text">{error}</div> : null}
      <div className="hdu-hint">
        保存时会为自定义端点申请 host 权限；拒绝授权则无法保存。API Key 只在本机使用，请求由扩展后台发出。
      </div>
    </Modal>
  );
}

// ───────────────────────── ASR ─────────────────────────

function AsrSection({
  settings,
  patchSettings,
  notify,
}: {
  settings: AppSettings;
  patchSettings: (patch: Partial<AppSettings>) => Promise<void>;
  notify: (text: string, error?: boolean) => void;
}) {
  const [status, setStatus] = useState<Record<AsrModelTier, { cached: boolean; bytes?: number; state: string; error?: string }>>({
    fast: { cached: false, state: 'missing' },
    standard: { cached: false, state: 'missing' },
    high: { cached: false, state: 'missing' },
  });
  const [downloading, setDownloading] = useState<AsrModelTier | null>(null);

  const refresh = useCallback(async () => {
    const result = await Promise.all(
      (Object.keys(ASR_MODELS) as AsrModelTier[]).map(async (tier) => {
        try {
          const s = await callOp('asr.model.status', { tier });
          return [tier, { cached: s.cached, bytes: s.bytes, state: s.state, error: s.error }] as const;
        } catch {
          return [tier, { cached: false, state: 'error', error: '状态读取失败' }] as const;
        }
      }),
    );
    setStatus(Object.fromEntries(result) as typeof status);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!downloading) return;
    const timer = window.setInterval(() => {
      void refresh().then(async () => {
        const s = await callOp('asr.model.status', { tier: downloading }).catch(() => null);
        if (s?.state !== 'downloading') {
          setDownloading(null);
          if (s?.cached) notify(`${ASR_MODELS[downloading].label} 已就绪`, false);
          else if (s?.error) notify(s.error, true);
        }
      });
    }, 2500);
    return () => window.clearInterval(timer);
  }, [downloading, notify, refresh]);

  const setAsr = (patch: Partial<AppSettings['asr']>) => patchSettings({ asr: { ...settings.asr, ...patch } });

  const importModel = async (files: FileList) => {
    const tier = settings.asr.modelTier;
    const spec = ASR_MODELS[tier];
    let imported = 0;
    for (const file of Array.from(files)) {
      const raw = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      const parts = raw.replace(/\\/g, '/').split('/').filter(Boolean);
      // 目录选择时第一段是用户选中的根目录；单文件选择时保留文件名
      const relative = parts.length > 1 ? parts.slice(1).join('/') : (parts[0] ?? file.name);
      if (!relative || relative.startsWith('.')) continue;
      try {
        const data = new Uint8Array(await file.arrayBuffer());
        await importModelFile(spec.modelId, relative, data);
        imported += 1;
      } catch {
        /* 单个文件失败不阻塞其余文件 */
      }
    }
    if (imported > 0) {
      notify(`已导入 ${imported} 个文件到 ${spec.label}`);
      void refresh();
    } else {
      notify('未导入任何文件（请选择模型目录）', true);
    }
  };

  return (
    <>
      <div className="hdu-card">
        <div className="hdu-section-head">
          <div className="hdu-section-title">转写模型</div>
          <div className="hdu-section-sub">在本机运行，音频不出设备</div>
          <div className="hdu-section-actions">
            <Button size="small" variant="ghost" icon="refresh" onClick={() => void refresh()}>刷新状态</Button>
          </div>
        </div>
        {(Object.keys(ASR_MODELS) as AsrModelTier[]).map((tier) => {
          const spec = ASR_MODELS[tier];
          const s = status[tier];
          const active = settings.asr.modelTier === tier;
          return (
            <div className="hdu-options-row" key={tier}>
              <div className="hdu-options-row-main">
                <div className="hdu-options-row-title">
                  {spec.label}
                  {active ? <Chip tone="jade" className="hdu-chip">当前档位</Chip> : null}
                  {s?.cached ? <Chip tone="jade" className="hdu-chip" icon="check">已就绪</Chip> : s?.state === 'downloading' ? <Chip tone="info" className="hdu-chip" icon="refresh">下载中</Chip> : <Chip className="hdu-chip">未下载</Chip>}
                </div>
                <div className="hdu-options-row-sub">
                  {spec.description} · 约 {spec.approxMb}MB
                  {s?.bytes ? ` · 已缓存 ${(s.bytes / 1024 / 1024).toFixed(0)}MB` : ''}
                </div>
              </div>
              <div className="hdu-options-row-side">
                {!active ? <Button size="small" variant="ghost" onClick={() => void setAsr({ modelTier: tier })}>设为默认</Button> : null}
                <Button
                  size="small"
                  icon="download"
                  loading={downloading === tier}
                  onClick={async () => {
                    setDownloading(tier);
                    try {
                      await callOp('asr.model.download', { tier });
                      notify('已开始下载模型（首次较慢，可继续使用其他功能）');
                    } catch (err) {
                      setDownloading(null);
                      // errorTextOf：AppError 显示 userMessage，非 Error 异常值回退语境化兜底（第 29 轮清尾）
                      notify(errorTextOf(err, '下载启动失败'), true);
                    }
                  }}
                >
                  {s?.cached ? '重新下载' : '下载'}
                </Button>
                {/* 两步确认：第一次点击仅进入确认态（图标变警示色 + title 切换，3 秒复原），第二次点击才清除 */}
                <ConfirmIconButton
                  icon="trash"
                  label="清除该模型"
                  confirmLabel="再点一次确认清除"
                  onConfirm={async () => {
                    await callOp('asr.model.clear', { tier });
                    void refresh();
                    notify('模型缓存已清除');
                  }}
                />
              </div>
            </div>
          );
        })}
        <div className="hdu-hint" style={{ marginTop: 8 }}>
          国内网络建议把下载源设为 hf-mirror（默认）。也可以手动导入：在下方选择模型目录（需包含 onnx/、tokenizer.json、config.json 等完整文件），
          插件会把它们写入本机 OPFS，之后无需联网即可加载。
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <label className="hdu-btn small" style={{ cursor: 'pointer' }}>
            <Icon name="upload" size={14} /> 选择模型目录（{ASR_MODELS[settings.asr.modelTier].label}）
            <input
              type="file"
              multiple
              // @ts-expect-error 非标准属性，Chrome 支持目录选择
              webkitdirectory=""
              style={{ display: 'none' }}
              onChange={(e) => {
                const files = e.target.files;
                if (files && files.length > 0) void importModel(files);
                e.currentTarget.value = '';
              }}
            />
          </label>
          <span className="hdu-hint">当前档位：{ASR_MODELS[settings.asr.modelTier].label}</span>
        </div>
      </div>

      <div className="hdu-card" style={{ marginTop: 14 }}>
        <div className="hdu-section-head">
          <div className="hdu-section-title">转写范围</div>
          <div className="hdu-section-sub">默认只转当前进度前后一段，边看边补</div>
        </div>
        <div className="hdu-options-row">
          <div className="hdu-options-row-main">
            <div className="hdu-options-row-title">片段流式（推荐）</div>
            <div className="hdu-options-row-sub">只转当前播放位置前后 N 分钟；播放推进时自动滚动补齐，不一次性拉取整段音频。</div>
          </div>
          <div className="hdu-options-row-side">
            <label className="hdu-switch">
              <input
                type="checkbox"
                checked={settings.asr.windowMode === 'around'}
                onChange={(e) => void setAsr({ windowMode: e.target.checked ? 'around' : 'full' })}
              />
              <span className="hdu-switch-track" />
              <span className="hdu-switch-thumb" />
            </label>
          </div>
        </div>
        <div className="hdu-options-row">
          <div className="hdu-options-row-main">
            <div className="hdu-options-row-title">片段半径</div>
            <div className="hdu-options-row-sub">当前进度前后各多少分钟（2–30，默认 10）。拖动进度后会补上新区域。</div>
          </div>
          <div className="hdu-options-row-side">
            <TextInput
              type="number"
              min={2}
              max={30}
              value={settings.asr.windowMinutes}
              onChange={(e) => void setAsr({ windowMinutes: Math.max(2, Math.min(30, Number(e.target.value) || 10)) })}
              style={{ width: 78 }}
            />
            <span className="hdu-hint">分钟</span>
          </div>
        </div>
        <div className="hdu-options-row">
          <div className="hdu-options-row-main">
            <div className="hdu-options-row-title">浏览时自动跟进</div>
            <div className="hdu-options-row-sub">打开播放页后静默补齐窗口内字幕；失败自动退避，不弹提示、不打断播放。</div>
          </div>
          <div className="hdu-options-row-side">
            <label className="hdu-switch">
              <input type="checkbox" checked={settings.asr.streamFollow} onChange={(e) => void setAsr({ streamFollow: e.target.checked })} />
              <span className="hdu-switch-track" />
              <span className="hdu-switch-thumb" />
            </label>
          </div>
        </div>
        <div className="hdu-options-row">
          <div className="hdu-options-row-main">
            <div className="hdu-options-row-title">打开页面时预热模型</div>
            <div className="hdu-options-row-sub">提前加载模型，首次转写更快；会占用一定内存。</div>
          </div>
          <div className="hdu-options-row-side">
            <label className="hdu-switch">
              <input type="checkbox" checked={settings.asr.autoWarmup} onChange={(e) => void setAsr({ autoWarmup: e.target.checked })} />
              <span className="hdu-switch-track" />
              <span className="hdu-switch-thumb" />
            </label>
          </div>
        </div>
        <div className="hdu-options-row">
          <div className="hdu-options-row-main">
            <div className="hdu-options-row-title">打开播放页时自动开始转写</div>
            <div className="hdu-options-row-sub">仍受上面的片段范围限制；关闭时由你在面板中手动点击。</div>
          </div>
          <div className="hdu-options-row-side">
            <label className="hdu-switch">
              <input type="checkbox" checked={settings.asr.autoTranscribeOnOpen} onChange={(e) => void setAsr({ autoTranscribeOnOpen: e.target.checked })} />
              <span className="hdu-switch-track" />
              <span className="hdu-switch-thumb" />
            </label>
          </div>
        </div>
        <div className="hdu-options-row">
          <div className="hdu-options-row-main">
            <div className="hdu-options-row-title">识别语言</div>
            <div className="hdu-options-row-sub">中文课堂建议保持 zh；auto 会让模型自行判断。</div>
          </div>
          <div className="hdu-options-row-side">
            <PillTabs
              value={settings.asr.lang}
              items={[
                { value: 'zh', label: '中文' },
                { value: 'en', label: '英文' },
                { value: 'auto', label: '自动' },
              ]}
              onChange={(lang) => void setAsr({ lang })}
            />
          </div>
        </div>
      </div>

      <div className="hdu-card" style={{ marginTop: 14 }}>
        <div className="hdu-section-head">
          <div className="hdu-section-title">术语纠错</div>
          <div className="hdu-section-sub">确定性替换，不经大模型</div>
        </div>
        <div className="hdu-hint">
          内置数学/计算机基础词表；你还可以在播放页面板添加「本课术语」，转写完成后自动应用。
          词表更新后可对已有转写重新应用纠错，无需重跑 ASR。
        </div>
      </div>
    </>
  );
}

// ───────────────────────── 学习与界面 ─────────────────────────

/** export 仅为渲染单测可达（照 DataSection 先例）：键位冲突 hint 行的交互锁定 */
export function LearningSection({
  settings,
  patchSettings,
}: {
  settings: AppSettings;
  patchSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  // 复习间隔草稿（第 92 轮巡检）：输入过程保留草稿，失焦时解析提交
  const [intervalDrafts, setIntervalDrafts] = useState<Partial<Record<ReviewTemplate, string>>>({});
  // 每日目标 7 日格预览数据（第 259 轮，目标域收官）：挂载时取一次近 30 天日报
  // （stats.report，失败按空不渲染预览）；改每日目标输入时用同一份 days 即时重算，
  // 「改目标 → 看达标天数变化」不用离开设置页。weekSec 供周目标预览行（第 260 轮）。
  const [goalPreviewDays, setGoalPreviewDays] = useState<Array<{ date: string; validSec: number }>>([]);
  const [goalPreviewWeekSec, setGoalPreviewWeekSec] = useState(0);
  useEffect(() => {
    let disposed = false;
    void callOp('stats.report', { days: 30 })
      .then((report) => {
        if (disposed) return;
        setGoalPreviewDays(Array.isArray(report?.days) ? report.days : []);
        setGoalPreviewWeekSec(typeof report?.weekSec === 'number' && Number.isFinite(report.weekSec) ? report.weekSec : 0);
      })
      .catch(() => null);
    return () => {
      disposed = true;
    };
  }, []);
  const commitIntervals = (template: ReviewTemplate): void => {
    const fallback = DEFAULT_SETTINGS.review.intervals[template];
    const raw = intervalDrafts[template];
    if (raw == null) return;
    const values = [...new Set(
      raw
        .split(/[,，\s]+/)
        .map((s) => Math.round(Number(s)))
        .filter((n) => Number.isFinite(n) && n >= 1 && n <= 365),
    )].sort((a, b) => a - b);
    if (values.length === 0) {
      setIntervalDrafts((prev) => ({ ...prev, [template]: fallback.join(',') }));
      return;
    }
    void patchSettings({
      review: { ...settings.review, intervals: { ...settings.review?.intervals, [template]: values } },
    });
  };
  const setUi = (patch: Partial<AppSettings['ui']>) => patchSettings({ ui: { ...settings.ui, ...patch } });
  const setCaption = (patch: Partial<AppSettings['captionStyle']>) =>
    patchSettings({ captionStyle: { ...settings.captionStyle, ...patch } });
  // 目标合理性提示（第 242 轮巡检，防呆视角）：随两目标当前值实时重算（学习目标分区
  // 即改即存，当前值即草稿值）；null（合理区间 / 任一未设）不渲染提示行
  const goalHint = goalConsistencyHint(
    (Number.isFinite(settings.weeklyGoalHours) ? settings.weeklyGoalHours : 0) * 3600,
    settings.dailyGoalMin,
  );
  return (
    <>
      <div className="hdu-card">
        <div className="hdu-section-head">
          <div className="hdu-section-title">学习中心</div>
          <div className="hdu-section-sub">站点级接管，可随时切回原页面</div>
        </div>
        <div className="hdu-options-row">
          <div className="hdu-options-row-main">
            <div className="hdu-options-row-title">在列表页接管学习中心</div>
            <div className="hdu-options-row-sub">首页、课程点播与直播列表页用学习中心界面替代站点内容；右下角可一键切回。</div>
          </div>
          <div className="hdu-options-row-side">
            <label className="hdu-switch">
              <input type="checkbox" checked={settings.ui.learningCenter} onChange={(e) => void setUi({ learningCenter: e.target.checked })} />
              <span className="hdu-switch-track" />
              <span className="hdu-switch-thumb" />
            </label>
          </div>
        </div>
        <div className="hdu-options-row">
          <div className="hdu-options-row-main">
            <div className="hdu-options-row-title">播放页默认展开学习中心侧栏</div>
            <div className="hdu-options-row-sub">默认关闭，播放页以本节助手为主；需要时从右下角入口打开。</div>
          </div>
          <div className="hdu-options-row-side">
            <label className="hdu-switch">
              <input type="checkbox" checked={settings.ui.centerOnPlayPage} onChange={(e) => void setUi({ centerOnPlayPage: e.target.checked })} />
              <span className="hdu-switch-track" />
              <span className="hdu-switch-thumb" />
            </label>
          </div>
        </div>
        <div className="hdu-options-row">
          <div className="hdu-options-row-main">
            <div className="hdu-options-row-title">播放页顶栏注入助手入口</div>
            <div className="hdu-options-row-sub">在站点顶栏末尾注入助手 chip（与页面融合）；关闭或站点改版时自动回退为浮窗胶囊。</div>
          </div>
          <div className="hdu-options-row-side">
            <label className="hdu-switch">
              <input type="checkbox" checked={settings.ui.nativeAnchor !== false} onChange={(e) => void setUi({ nativeAnchor: e.target.checked })} />
              <span className="hdu-switch-track" />
              <span className="hdu-switch-thumb" />
            </label>
          </div>
        </div>
        <div className="hdu-options-row">
          <div className="hdu-options-row-main">
            <div className="hdu-options-row-title">显示时间轴知识标记</div>
            <div className="hdu-options-row-sub">在站点进度条上方叠加知识点色块，点击跳转。</div>
          </div>
          <div className="hdu-options-row-side">
            <label className="hdu-switch">
              <input type="checkbox" checked={settings.ui.showTimelineMarkers} onChange={(e) => void setUi({ showTimelineMarkers: e.target.checked })} />
              <span className="hdu-switch-track" />
              <span className="hdu-switch-thumb" />
            </label>
          </div>
        </div>
      </div>

      <div className="hdu-card" style={{ marginTop: 14 }}>
        <div className="hdu-section-head">
          <div className="hdu-section-title">学习目标与统计口径</div>
        </div>
        <div className="hdu-options-row">
          <div className="hdu-options-row-main">
            <div className="hdu-options-row-title">每周目标</div>
            <div className="hdu-options-row-sub">用于总览的目标进度与周报。</div>
          </div>
          <div className="hdu-options-row-side">
            <TextInput
              type="number"
              min={0.5}
              max={80}
              step={0.5}
              value={settings.weeklyGoalHours}
              onChange={(e) => void patchSettings({ weeklyGoalHours: Math.max(0.5, Number(e.target.value) || 5) })}
              style={{ width: 84 }}
            />
            <span className="hdu-hint">小时</span>
          </div>
        </div>
        {/* 每周目标即时预览（第 260 轮，目标域）：按本周当前已学秒数对当前输入值
            即时算完成度（即改即存 → settings.weeklyGoalHours 变化即重渲染）；与每日
            目标 7 日格预览同语境，改目标当场看效果 */}
        {goalPreviewDays.length > 0 ? (
          <div className="hdu-hint hdu-goal-weekly-preview" role="status">
            <span className="hdu-preview-tag">预览</span>
            本周已学 {Math.round(goalPreviewWeekSec / 60)} 分钟 · 按目标 {settings.weeklyGoalHours} 小时 = 完成{' '}
            {Math.min(100, Math.round((goalPreviewWeekSec / (Math.max(1, settings.weeklyGoalHours) * 3600)) * 100))}%
          </div>
        ) : null}
        {/* 每日目标（第 234 轮巡检）：总览「今日目标」Ring 与 dashboard 指标卡的进度分母；
            仅展示与激励层，不改打卡判定线（10 分钟）与 hitDaysThisWeek 语义 */}
        <div className="hdu-options-row">
          <div className="hdu-options-row-main">
            <div className="hdu-options-row-title">每日目标</div>
            <div className="hdu-options-row-sub">总览「今日目标」进度环的分母；仅激励展示，不影响打卡判定（10 分钟线）。</div>
          </div>
          <div className="hdu-options-row-side">
            <TextInput
              type="number"
              min={5}
              max={600}
              step={5}
              value={settings.dailyGoalMin}
              onChange={(e) => void patchSettings({ dailyGoalMin: clampDailyGoalMin(Number(e.target.value)) })}
              style={{ width: 84 }}
            />
            <span className="hdu-hint">分钟</span>
          </div>
        </div>
        {/* 目标合理性提示（第 242 轮巡检，防呆视角）：周目标 × 每日目标量纲悬殊时软提示
            （偏低 gold / 偏高 danger 淡色，goalConsistencyHint 纯函数）；本页无草稿态——
            两个输入即改即存（patchSettings），提示随当前值实时重算；合理区间返回 null
            不渲染；aria-live=polite 供读屏跟随，建议性文案不阻断保存 */}
        {goalHint ? (
          <div className={`hdu-goal-hint ${goalHint.kind === 'low' ? 'is-low' : 'is-high'}`} role="status" aria-live="polite">
            {goalHint.text}
          </div>
        ) : null}
        {/* 本周达标 7 日格预览（第 259 轮，目标域收官）：与总览 / 看板 / 统计页同款组件
            同源口径（buildWeeklyGoalCalendar）——改每日目标输入（即改即存）时预览即时
            重算，「改目标 → 看本周达标天数变化」不离开设置页；无日报数据（新用户 /
            取数失败）不渲染。下方括注说明判定口径与打卡线的边界。 */}
        {goalPreviewDays.length > 0 ? (
          <div className="hdu-goal-preview">
            <div className="hdu-preview-tag">预览</div>
            <WeeklyGoalCalendarRow days={goalPreviewDays} dailyGoalMin={clampDailyGoalMin(settings.dailyGoalMin)} />
            <div className="hdu-hint">按近 30 天数据预览本周（周一起）达标情况；判定用每日目标线，与 10 分钟打卡线相互独立。</div>
          </div>
        ) : null}
        <div className="hdu-options-row">
          <div className="hdu-options-row-main">
            <div className="hdu-options-row-title">成就目标倍率</div>
            <div className="hdu-options-row-sub">学习成就徽章的阈值倍率：进取 1.5 倍、挑战 2 倍。</div>
          </div>
          <div className="hdu-options-row-side">
            <select
              className="hdu-input"
              value={String(settings.achievementGoalScale ?? 1)}
              onChange={(e) => void patchSettings({ achievementGoalScale: Number(e.target.value) || 1 })}
              style={{ width: 132 }}
            >
              <option value="1">标准（×1）</option>
              <option value="1.5">进取（×1.5）</option>
              <option value="2">挑战（×2）</option>
            </select>
          </div>
        </div>
        <CustomAchievementsRow settings={settings} patchSettings={patchSettings} />
        <div className="hdu-options-row">
          <div className="hdu-options-row-main">
            <div className="hdu-options-row-title">标签覆盖率目标</div>
            <div className="hdu-options-row-sub">知识库已打标签收藏的占比目标；未达标时标签统计面板强调提示，每日待办通知附补打标签提醒。</div>
          </div>
          <div className="hdu-options-row-side">
            <select
              className="hdu-input"
              value={String(settings.ui?.tagCoverageGoal ?? 0)}
              onChange={(e) => void patchSettings({ ui: { ...settings.ui, tagCoverageGoal: Number(e.target.value) || 0 } })}
              style={{ width: 132 }}
            >
              <option value="0">不设目标</option>
              <option value="60">60%</option>
              <option value="80">80%</option>
              <option value="100">100%</option>
            </select>
          </div>
        </div>
        <div className="hdu-options-row">
          <div className="hdu-options-row-main">
            <div className="hdu-options-row-title">健康度统计窗口</div>
            <div className="hdu-options-row-sub">「近 N 天零完成」的统计窗口，用于每日/每周通知的标签健康度口径。</div>
          </div>
          <div className="hdu-options-row-side">
            <select
              className="hdu-input"
              value={String(settings.ui?.staleWindowDays ?? 28)}
              onChange={(e) => void patchSettings({ ui: { ...settings.ui, staleWindowDays: Number(e.target.value) || 28 } })}
              style={{ width: 132 }}
            >
              <option value="7">7 天</option>
              <option value="14">14 天</option>
              <option value="28">28 天（默认）</option>
              <option value="56">56 天</option>
            </select>
          </div>
        </div>
        <div className="hdu-options-row">
          <div className="hdu-options-row-main">
            <div className="hdu-options-row-title">挂机判定阈值</div>
            <div className="hdu-options-row-sub">超过该时长无交互、无进度变化，则暂停累计。</div>
          </div>
          <div className="hdu-options-row-side">
            <TextInput
              type="number"
              min={1}
              max={120}
              value={settings.idleThresholdMin}
              onChange={(e) => void patchSettings({ idleThresholdMin: Math.max(1, Number(e.target.value) || 15) })}
              style={{ width: 78 }}
            />
            <span className="hdu-hint">分钟</span>
          </div>
        </div>
        <div className="hdu-options-row">
          <div className="hdu-options-row-main">
            <div className="hdu-options-row-title">完看度阈值</div>
            <div className="hdu-options-row-sub">有效观看达到该比例时标记为已看完；补看清单据此判断。</div>
          </div>
          <div className="hdu-options-row-side">
            <TextInput
              type="number"
              min={50}
              max={100}
              value={Math.round(settings.finishThreshold * 100)}
              onChange={(e) => void patchSettings({ finishThreshold: Math.max(0.5, Math.min(1, (Number(e.target.value) || 90) / 100)) })}
              style={{ width: 78 }}
            />
            <span className="hdu-hint">%</span>
          </div>
        </div>
        <div className="hdu-options-row">
          <div className="hdu-options-row-main">
            <div className="hdu-options-row-title">复习模板</div>
            <div className="hdu-options-row-sub">
              新加入复习计划使用的排期模板；「考试」模式可设置考试日期参考（第 95 轮巡检新增）。
            </div>
          </div>
          <div className="hdu-options-row-side" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <select
              className="hdu-input"
              style={{ width: 'auto', height: 30 }}
              value={settings.review?.template ?? 'regular'}
              aria-label="复习模板"
              onChange={(e) =>
                void patchSettings({ review: { ...settings.review, template: e.target.value as ReviewTemplate } })
              }
            >
              <option value="regular">常规</option>
              <option value="exam">考试</option>
              <option value="custom">自定义</option>
            </select>
            {(settings.review?.template ?? 'regular') === 'exam' ? (
              <input
                type="date"
                className="hdu-input"
                style={{ width: 'auto', height: 30 }}
                value={settings.review?.examDate ?? ''}
                aria-label="考试日期"
                onChange={(e) =>
                  void patchSettings({ review: { ...settings.review, examDate: e.target.value || undefined } })
                }
              />
            ) : null}
          </div>
        </div>
        <div className="hdu-options-row">
          <div className="hdu-options-row-main">
            <div className="hdu-options-row-title">复习间隔</div>
            <div className="hdu-options-row-sub">
              各复习模板的排期间隔天数（逗号分隔、升序去重）；改动后新加入的复习按新间隔排期（第 92 轮巡检新增）。
            </div>
          </div>
          <div className="hdu-options-row-side" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {(['regular', 'exam', 'custom'] as ReviewTemplate[]).map((template) => (
              <label key={template} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5 }}>
                <span style={{ width: 40, color: 'var(--muted)' }}>
                  {template === 'regular' ? '常规' : template === 'exam' ? '考试' : '自定义'}
                </span>
                <TextInput
                  type="text"
                  style={{ width: 110 }}
                  value={
                    intervalDrafts[template] ??
                    (settings.review?.intervals?.[template] ?? DEFAULT_SETTINGS.review.intervals[template]).join(',')
                  }
                  onChange={(e) => setIntervalDrafts((prev) => ({ ...prev, [template]: e.target.value }))}
                  onBlur={() => commitIntervals(template)}
                  aria-label={`复习间隔（${template}）`}
                />
                <span className="hdu-hint">天</span>
              </label>
            ))}
            {/* 恢复默认间隔（第 94 轮巡检） */}
            <Button
              size="small"
              variant="ghost"
              icon="refresh"
              onClick={() => {
                void patchSettings({
                  review: { ...settings.review, intervals: { ...DEFAULT_SETTINGS.review.intervals } },
                });
                setIntervalDrafts({});
              }}
            >
              恢复默认
            </Button>
          </div>
        </div>
        <div className="hdu-options-row">
          <div className="hdu-options-row-main">
            <div className="hdu-options-row-title">缺课判定延时</div>
            <div className="hdu-options-row-sub">课次结束后多久仍无有效观看，才进入补看清单。</div>
          </div>
          <div className="hdu-options-row-side">
            <TextInput
              type="number"
              min={1}
              max={168}
              value={settings.missDelayHours}
              onChange={(e) => void patchSettings({ missDelayHours: Math.max(1, Number(e.target.value) || 24) })}
              style={{ width: 78 }}
            />
            <span className="hdu-hint">小时</span>
          </div>
        </div>
      </div>

      <div className="hdu-card" style={{ marginTop: 14 }}>
        <div className="hdu-section-head">
          <div className="hdu-section-title">提醒</div>
          <div className="hdu-section-sub">通知全部在本地生成，不发送远端</div>
        </div>
        <div className="hdu-options-row">
          <div className="hdu-options-row-main">
            <div className="hdu-options-row-title">每日待办提醒</div>
            <div className="hdu-options-row-sub">每天固定时刻检查今日待办，非空时发系统通知。</div>
          </div>
          <div className="hdu-options-row-side">
            <label className="hdu-switch">
              <input
                type="checkbox"
                checked={settings.todo?.dailyNotify !== false}
                onChange={(e) => void patchSettings({ todo: { ...settings.todo, dailyNotify: e.target.checked } })}
              />
              <span className="hdu-switch-track" />
              <span className="hdu-switch-thumb" />
            </label>
          </div>
        </div>
        <div className="hdu-options-row">
          <div className="hdu-options-row-main">
            <div className="hdu-options-row-title">提醒时刻</div>
            <div className="hdu-options-row-sub">每日待办提醒的本地触发时刻（默认 20:00；第 83 轮巡检新增）。</div>
          </div>
          <div className="hdu-options-row-side">
            <select
              className="hdu-input"
              style={{ width: 'auto', height: 30 }}
              value={settings.todo?.dailyNotifyHour ?? 20}
              disabled={settings.todo?.dailyNotify === false}
              aria-label="每日待办提醒时刻"
              onChange={(e) => void patchSettings({ todo: { ...settings.todo, dailyNotifyHour: Number(e.target.value) } })}
            >
              {Array.from({ length: 24 }, (_, hour) => (
                <option key={hour} value={hour}>
                  {String(hour).padStart(2, '0')}:00
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="hdu-options-row">
          <div className="hdu-options-row-main">
            <div className="hdu-options-row-title">提醒中包含上周回顾</div>
            <div className="hdu-options-row-sub">每日待办提醒末尾附一句上周学习时长与计划完成度。</div>
          </div>
          <div className="hdu-options-row-side">
            <label className="hdu-switch">
              <input
                type="checkbox"
                checked={settings.todo?.weeklyRecap !== false}
                onChange={(e) => void patchSettings({ todo: { ...settings.todo, weeklyRecap: e.target.checked } })}
              />
              <span className="hdu-switch-track" />
              <span className="hdu-switch-thumb" />
            </label>
          </div>
        </div>
        <div className="hdu-options-row">
          <div className="hdu-options-row-main">
            <div className="hdu-options-row-title">提醒中包含标签健康度</div>
            <div className="hdu-options-row-sub">每日待办提醒末尾附「N 个标签近 N 天零完成」及最久标签点名。</div>
          </div>
          <div className="hdu-options-row-side">
            <label className="hdu-switch">
              <input
                type="checkbox"
                checked={settings.todo?.notifyStaleTags !== false}
                onChange={(e) => void patchSettings({ todo: { ...settings.todo, notifyStaleTags: e.target.checked } })}
              />
              <span className="hdu-switch-track" />
              <span className="hdu-switch-thumb" />
            </label>
          </div>
        </div>
        <div className="hdu-options-row">
          <div className="hdu-options-row-main">
            <div className="hdu-options-row-title">提醒中包含标签覆盖率</div>
            <div className="hdu-options-row-sub">设了覆盖率目标且未达标时，每日待办提醒末尾附一行补打标签提醒。</div>
          </div>
          <div className="hdu-options-row-side">
            <label className="hdu-switch">
              <input
                type="checkbox"
                checked={settings.todo?.notifyCoverage !== false}
                onChange={(e) => void patchSettings({ todo: { ...settings.todo, notifyCoverage: e.target.checked } })}
              />
              <span className="hdu-switch-track" />
              <span className="hdu-switch-thumb" />
            </label>
          </div>
        </div>
        {/* 明日到期提醒（第 243 轮巡检）：默认关——主动提醒默认不打扰，用户显式开启才发；
            时刻联动每日待办提醒偏移 30 分钟（待办可配时跟随），时刻说明 muted 小字副行 */}
        <div className="hdu-options-row">
          <div className="hdu-options-row-main">
            <div className="hdu-options-row-title">明日到期提醒</div>
            <div className="hdu-options-row-sub">
              检查明日到期的复习作业，非空时发通知（明细含前 2 个课程/作业名）。默认关闭——主动提醒默认不打扰。
            </div>
            <div className="hdu-options-row-sub hdu-options-row-sub-note">
              触发时刻：每日待办提醒后 30 分钟（默认 20:30，随「提醒时刻」联动）。
            </div>
          </div>
          <div className="hdu-options-row-side">
            <label className="hdu-switch">
              <input
                type="checkbox"
                checked={settings.todo?.dueTomorrowNotify === true}
                onChange={(e) => void patchSettings({ todo: { ...settings.todo, dueTomorrowNotify: e.target.checked } })}
              />
              <span className="hdu-switch-track" />
              <span className="hdu-switch-thumb" />
            </label>
          </div>
        </div>
      </div>

      <div className="hdu-card" style={{ marginTop: 14 }}>
        <div className="hdu-section-head">
          <div className="hdu-section-title">问答与主题</div>
        </div>
        <div className="hdu-options-row">
          <div className="hdu-options-row-main">
            <div className="hdu-options-row-title">上下文窗口</div>
            <div className="hdu-options-row-sub">小：前 2 分钟 / 后 45 秒；中：前 3 / 后 1；大：前 5 / 后 2。</div>
          </div>
          <div className="hdu-options-row-side">
            <PillTabs
              value={settings.contextWindow}
              items={[
                { value: 'small', label: '小' },
                { value: 'medium', label: '中' },
                { value: 'large', label: '大' },
              ]}
              onChange={(contextWindow) => void patchSettings({ contextWindow })}
            />
          </div>
        </div>
        <div className="hdu-options-row">
          <div className="hdu-options-row-main">
            <div className="hdu-options-row-title">主题</div>
            <div className="hdu-options-row-sub">只影响插件界面，不修改站点样式。</div>
          </div>
          <div className="hdu-options-row-side">
            <PillTabs
              value={settings.theme}
              items={[
                { value: 'system', label: '跟随系统' },
                { value: 'light', label: '浅色' },
                { value: 'dark', label: '深色' },
              ]}
              onChange={(theme) => void patchSettings({ theme })}
            />
          </div>
        </div>
      </div>

      <div className="hdu-card" style={{ marginTop: 14 }}>
        <div className="hdu-section-head">
          <div className="hdu-section-title">字幕样式</div>
        </div>
        <div className="hdu-options-row">
          <div className="hdu-options-row-main">
            <div className="hdu-options-row-title">显示扩展字幕</div>
            <div className="hdu-options-row-sub">渲染在独立的 Shadow DOM 层，不写入站点字幕容器。</div>
          </div>
          <div className="hdu-options-row-side">
            <label className="hdu-switch">
              <input type="checkbox" checked={settings.captionStyle.enabled} onChange={(e) => void setCaption({ enabled: e.target.checked })} />
              <span className="hdu-switch-track" />
              <span className="hdu-switch-thumb" />
            </label>
          </div>
        </div>
        <div className="hdu-options-row">
          <div className="hdu-options-row-main">
            <div className="hdu-options-row-title">字号 / 距视频底部</div>
            <div className="hdu-options-row-sub">建议 18–24px；底部距离按视频画面计算。</div>
          </div>
          <div className="hdu-options-row-side">
            <TextInput
              type="number"
              min={12}
              max={40}
              value={settings.captionStyle.fontSize}
              onChange={(e) => void setCaption({ fontSize: Math.max(12, Number(e.target.value) || 20) })}
              style={{ width: 64 }}
            />
            <TextInput
              type="number"
              min={0}
              max={400}
              value={settings.captionStyle.bottomOffset}
              onChange={(e) => void setCaption({ bottomOffset: Math.max(0, Number(e.target.value) || 96) })}
              style={{ width: 64 }}
            />
          </div>
        </div>
        <div className="hdu-options-row">
          <div className="hdu-options-row-main">
            <div className="hdu-options-row-title">截图水印</div>
            <div className="hdu-options-row-sub">截图右下角附课程名、课次与时间点。</div>
          </div>
          <div className="hdu-options-row-side">
            <label className="hdu-switch">
              <input type="checkbox" checked={settings.screenshotWatermark} onChange={(e) => void patchSettings({ screenshotWatermark: e.target.checked })} />
              <span className="hdu-switch-track" />
              <span className="hdu-switch-thumb" />
            </label>
          </div>
        </div>
      </div>

      <div className="hdu-card" style={{ marginTop: 14 }}>
        <div className="hdu-section-head">
          <div className="hdu-section-title">快捷键</div>
          <div className="hdu-section-sub">输入框内不触发；站点已占用键（空格、方向键、F 等）一律不抢占</div>
        </div>
        {([
          ['ask', '提问'],
          ['favorite', '收藏当前时间点'],
          ['note', '记笔记'],
          ['prevTopic', '上一个知识点'],
          ['nextTopic', '下一个知识点'],
        ] as const).map(([key, label]) => {
          // 键位防呆 hint（第 251 轮巡检，帮助域 / 一致性视角）：随当前值实时重算
          // （即改即存模型下当前值即草稿值，与 goalConsistencyHint 同模式）；软提示
          // 不阻断保存，null（无问题）不渲染
          const issue = shortcutIssueOf(settings.shortcuts[key], key, settings.shortcuts);
          return (
            <div className="hdu-options-row" key={key} style={{ flexWrap: 'wrap' }}>
              <div className="hdu-options-row-main">
                <div className="hdu-options-row-title">{label}</div>
              </div>
              <div className="hdu-options-row-side">
                <TextInput
                  value={settings.shortcuts[key]}
                  maxLength={12}
                  onChange={(e) => void patchSettings({ shortcuts: { ...settings.shortcuts, [key]: e.target.value } })}
                  style={{ width: 90 }}
                />
              </div>
              {issue ? (
                <div className="hdu-shortcut-hint" role="status" aria-live="polite" style={{ flex: '1 0 100%' }}>
                  <span>
                    {issue.text}
                    {issue.kind === 'reserved' || issue.kind === 'conflict' || issue.kind === 'format' ? (
                      <>
                        {' '}
                        当前值
                        <kbd>{String(settings.shortcuts[key]).trim()}</kbd>
                      </>
                    ) : null}
                  </span>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </>
  );
}

// ───────────────────────── 数据 ─────────────────────────

type DataKind = 'ai' | 'transcript' | 'stats' | 'library' | 'screenshots' | 'models';

/** 导出供单元测试（two-step-confirm.test.ts）：「分类清除」两步确认的行为验证 */
/**
 * 演示模式卡（第 319 轮，演示域）：一键开启 / 退出 / 重新生成。
 * 真实数据零接触（并行库 hdu-assistant-demo），退出即删演示库；开启期间
 * 站点同步与学习时长记录自动暂停（core/demo 各 gate）。
 * export 仅为渲染单测可达。
 */
export function DemoSection({ notify }: { notify: (text: string, error?: boolean) => void }) {
  const [status, setStatus] = useState<DemoStatusResult | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState<'enter' | 'exit' | 'reset' | null>(null);

  const refresh = useCallback(async () => {
    const s = await callOp('demo.status', {}).catch(() => null);
    setStatus(s);
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runOp = async (op: 'demo.enter' | 'demo.exit' | 'demo.reset', doneText: string, kind: 'enter' | 'exit' | 'reset') => {
    if (busy) return;
    setBusy(kind);
    try {
      await callOp(op, {});
      notify(doneText);
      // 演示模式切换涉及数据库连接切换：整页重载让所有上下文按新旗标重读
      window.setTimeout(() => window.location.reload(), 600);
    } catch (err) {
      notify(errorTextOf(err, '操作失败'), true);
      setBusy(null);
      void refresh();
    }
  };

  const enabled = status?.enabled === true;
  const counts = status?.counts ?? null;
  return (
    <div className="hdu-card">
      <div className="hdu-section-head">
        <div className="hdu-section-title">演示模式</div>
        <div className="hdu-section-sub">{enabled ? '已开启' : '未开启'}</div>
        <div className="hdu-section-actions">
          {enabled ? (
            <>
              <Button size="small" variant="ghost" icon="refresh" loading={busy === 'reset'} onClick={() => void runOp('demo.reset', '演示数据已重新生成', 'reset')}>
                重新生成数据
              </Button>
              <Button size="small" variant="danger" loading={busy === 'exit'} onClick={() => void runOp('demo.exit', '已退出演示模式，演示数据已删除', 'exit')}>
                退出演示
              </Button>
            </>
          ) : (
            <Button size="small" variant="accent" icon="spark" loading={busy === 'enter'} onClick={() => setConfirmOpen(true)}>
              开启演示模式
            </Button>
          )}
        </div>
      </div>
      <div className="hdu-hint">
        {enabled
          ? '当前展示的是独立演示库中的虚构数据（真实数据零接触）。开启期间站点同步与学习时长记录自动暂停；退出后演示库即删除。'
          : '一键填入一套虚构但完整的演示数据（5 门课、转写与 AI 标注、收藏笔记、复习计划、近 90 天统计、B 站学习线），无需学校账号即可完整体验全部功能。数据写入独立数据库，退出即删除，真实数据不受影响。'}
      </div>
      {enabled && status?.enteredAt ? (
        <dl className="hdu-kv" style={{ marginTop: 8 }}>
          <dt>进入时间</dt>
          <dd>{new Date(status.enteredAt).toLocaleString()}</dd>
          {counts ? (
            <>
              <dt>演示规模</dt>
              <dd>
                {counts.courses ?? 0} 门课 · {counts.sessions ?? 0} 节课次 · {counts.favorites ?? 0} 条收藏 ·{' '}
                {counts.transcripts ?? 0} 节转写 · {counts.reviewJobs ?? 0} 项复习作业 · {counts.watchRecords ?? 0} 天流水
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}
      <Modal
        open={confirmOpen}
        title="开启演示模式"
        onClose={() => setConfirmOpen(false)}
        footer={
          <>
            <Button size="small" variant="ghost" onClick={() => setConfirmOpen(false)}>
              取消
            </Button>
            <Button size="small" variant="accent" loading={busy === 'enter'} onClick={() => void runOp('demo.enter', '演示模式已开启：界面将载入虚构演示数据', 'enter')}>
              确认开启
            </Button>
          </>
        }
      >
        <div className="hdu-hint">
          <p style={{ margin: '0 0 6px' }}>开启后本扩展的界面将载入一套虚构演示数据，用于完整展示与体验功能：</p>
          <p style={{ margin: '0 0 6px' }}>· 数据写入独立数据库（hdu-assistant-demo），<b>真实数据零接触</b>，退出即删除演示库；</p>
          <p style={{ margin: '0 0 6px' }}>· 开启期间站点同步与学习时长记录自动暂停，界面各处会显示「演示模式」角标；</p>
          <p style={{ margin: '0' }}>· 观看真实视频产生的转写 / AI 标注也会写进演示库（可弃），介意请勿在演示期间做真实学习。</p>
        </div>
      </Modal>
    </div>
  );
}

export function DataSection({
  settings,
  patchSettings,
  notify,
}: {
  settings: AppSettings;
  patchSettings: (patch: Partial<AppSettings>) => Promise<void>;
  notify: (text: string, error?: boolean) => void;
}) {
  const [usage, setUsage] = useState<{ indexedDbBytes: number; opfsBytes: number; quotaBytes: number; screenshotCount: number; transcriptCount: number; modelCached: boolean } | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  // 日志总数（第 316 轮，修复）：展示区只取最近 80 条，水位需与显示条数分离，
  // 否则「当前 X / 200 条」永远 ≤80、无法反映真实环形日志占用
  const [logTotal, setLogTotal] = useState(0);
  const [showLogs, setShowLogs] = useState(false);
  // 日志级别筛选（第 301 轮，功能域）：全部 / 警告 / 错误三档，排障时快速聚焦
  const [logFilter, setLogFilter] = useState<'all' | 'warn' | 'error'>('all');
  // 来源筛选（第 305 轮，功能域）：按 logger scope 过滤（content / asr-* / sw-* 等），
  // 与级别筛选叠加；第 313 轮起 scope 清单按日志条数降序排序（高频模块排前，同频按名称升序）
  const [scopeFilter, setScopeFilter] = useState('all');
  const scopeOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of logs) counts.set(entry.scope, (counts.get(entry.scope) ?? 0) + 1);
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([scope]) => scope);
  }, [logs]);
  // 当前筛选（级别 × 来源）命中的日志（第 306 轮，功能域）：导出与列表共用同一份——
  // 「导出」遵循筛选导出子集；筛选无命中时导出置灰
  const filteredLogs = useMemo(
    () => logs.filter((l) => (logFilter === 'all' || l.level === logFilter) && (scopeFilter === 'all' || l.scope === scopeFilter)),
    [logs, logFilter, scopeFilter],
  );
  // 导出文件名（第 316 轮，功能域）：带筛选摘要（级别/来源），多次导出不易混淆
  const logFileStem = useMemo(() => {
    const parts = ['hdu-logs'];
    if (logFilter !== 'all') parts.push(logFilter);
    if (scopeFilter !== 'all') parts.push(scopeFilter);
    return `${parts.join('-')}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
  }, [logFilter, scopeFilter]);
  // 存储用量与增长预估（第 254 轮巡检，存储健康域 / 透明度视角）：storage.estimate
  // 返回 null 表示浏览器不可用（区别于 0 值 → UI 显示「无法获取（浏览器限制）」）；
  // 增长预估按近 30 天 watchRecords 日均条数粗估（常数口径见 estimateStoreGrowth）
  const [quota, setQuota] = useState<{ usage: number; quota: number } | null>(null);
  const [growth, setGrowth] = useState<StoreGrowthEstimate | null>(null);
  // 全量数据导出（第 250 轮巡检）：按钮 loading 态 + 成功后条目数摘要行（muted 小字，
  // 数据量提示——导出前不知道规模，导出后如实汇报）；纯读操作，失败仅 toast 不影响数据
  const [exporting, setExporting] = useState(false);
  const [exportSummary, setExportSummary] = useState('');

  const exportAllData = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const { filename, json, counts } = await callOp('data.exportAll', {});
      downloadTextFile(filename, json, 'application/json;charset=utf-8');
      setExportSummary(
        `共 ${EXPORT_SUMMARY_KEYS.map((key) => counts[key] ?? 0).reduce((sum, n) => sum + n, 0)} 条 · ` +
          EXPORT_SUMMARY_KEYS.map((key) => `${EXPORT_SUMMARY_LABELS[key]} ${counts[key] ?? 0}`).join(' · '),
      );
      notify(`已导出 ${filename}`);
    } catch (err) {
      notify(errorTextOf(err, '导出失败'), true);
    } finally {
      setExporting(false);
    }
  };

  const refresh = useCallback(async () => {
    // 增长预估取数窗口：近 30 天（含今天）流水行，与 estimateStoreGrowth 的 days=30 一致
    const today = localDayKey();
    const from = addDaysKey(today, -29) ?? today;
    const [u, l, q, records] = await Promise.all([
      callOp('storage.usage', {}).catch(() => null),
      readLogs().catch(() => []),
      callOp('storage.estimate', {}).catch(() => null),
      callOp('stats.records', { fromDay: from, toDay: today }).catch(() => [] as WatchRecordEntity[]),
    ]);
    setUsage(u);
    setQuota(q);
    setGrowth(estimateStoreGrowth(records, 30));
    setLogTotal(l.length);
    setLogs(l.slice(-80).reverse());
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  // 实时尾巴（第 316 轮，可用性域）：日志区展开时每 3s 自动刷新，收起即停——
  // 排障时无需手动反复点「查看」
  useEffect(() => {
    if (!showLogs) return undefined;
    const timer = window.setInterval(() => { void refresh(); }, 3000);
    return () => window.clearInterval(timer);
  }, [showLogs, refresh]);

  // 两步确认后的实际执行：每行按钮是独立的 ConfirmButton 实例，第一次点击只进入确认态，第二次点击才清除
  const clear = async (kind: DataKind) => {
    await callOp('data.clear', { kinds: [kind] });
    notify('已清除');
    void refresh();
  };

  return (
    <>
      <DemoSection notify={notify} />
      <div className="hdu-card" style={{ marginTop: 14 }}>
        <div className="hdu-section-head">
          <div className="hdu-section-title">存储占用</div>
          <div className="hdu-section-actions"><Button size="small" variant="ghost" icon="refresh" onClick={() => void refresh()}>刷新</Button></div>
        </div>
        {usage ? (
          <dl className="hdu-kv">
            <dt>IndexedDB</dt><dd>{formatBytes(usage.indexedDbBytes)} · {usage.transcriptCount} 节转写 · {usage.screenshotCount} 张截图</dd>
            <dt>模型 / OPFS</dt><dd>{formatBytes(usage.opfsBytes)} {usage.modelCached ? '· 已缓存模型' : ''}</dd>
            <dt>浏览器配额</dt><dd>{formatBytes(usage.quotaBytes)}</dd>
          </dl>
        ) : (
          <div className="hdu-hint">读取中…</div>
        )}
      </div>

      <div className="hdu-card" style={{ marginTop: 14 }}>
        <div className="hdu-section-head">
          <div className="hdu-section-title">分类清除</div>
          <div className="hdu-section-sub">不可撤销</div>
        </div>
        {([
          ['ai', 'AI 缓存', '知识标注、大纲与问答记录'],
          ['transcript', '转写文本', '含分片缓存；模型文件不受影响'],
          ['stats', '学习统计', '仅本机流水，不影响站点记录'],
          ['library', '收藏与笔记', '收藏、文件夹、标签、笔记与截图元数据'],
          ['screenshots', '截图', '本地截图 Blob'],
          ['models', '模型缓存', '清除后需要重新下载或导入'],
        ] as const).map(([kind, title, sub]) => (
          <div className="hdu-options-row" key={kind}>
            <div className="hdu-options-row-main">
              <div className="hdu-options-row-title">{title}</div>
              <div className="hdu-options-row-sub">{sub}</div>
            </div>
            <div className="hdu-options-row-side">
              <ConfirmButton size="small" variant="ghost" icon="trash" confirmLabel="再点一次确认清除" onConfirm={() => void clear(kind as DataKind)}>清除</ConfirmButton>
            </div>
          </div>
        ))}
      </div>

      <div className="hdu-card" style={{ marginTop: 14 }}>
        <div className="hdu-section-head">
          <div className="hdu-section-title">备份与迁移</div>
        </div>
        {/* 存储用量行（第 254 轮巡检，存储健康域 / 透明度视角）：当前用量 / 配额 /
            预估月增长三段式 + 4px 细进度条（超 80% 转 gold 预警档）。增长为按近 30 天
            watchRecords 日均条数的粗估（常数口径见 estimateStoreGrowth），供备份 /
            迁移决策参考。数据挂载时查询一次 + 行内刷新按钮（轻查询不轮询）；
            storage.estimate 返回 null（浏览器限制）时如实显示「无法获取」。
            注意：watchRecords 是趋势图 / 统计聚合的数据底座，本页不提供该数据的
            清理入口（老流水归档评估见 docs/巡检日志.md 第 254 轮）。 */}
        <div className="hdu-storage-row">
          <div className="hdu-storage-row-main">
            <div className="hdu-options-row-title">存储用量</div>
            {quota ? (
              <>
                <div className="hdu-storage-segments">
                  <div className="hdu-storage-seg">
                    <span className="hdu-storage-seg-value">{formatBytes(quota.usage)}</span>
                    <span className="hdu-storage-seg-label">当前用量</span>
                  </div>
                  <div className="hdu-storage-seg">
                    <span className="hdu-storage-seg-value">{quota.quota > 0 ? formatBytes(quota.quota) : '—'}</span>
                    <span className="hdu-storage-seg-label">浏览器配额</span>
                  </div>
                  <div className="hdu-storage-seg">
                    <span className="hdu-storage-seg-value">
                      {growth && growth.monthlyCount > 0 ? `${growth.monthlyCount} 条 · 约 ${formatBytes(growth.monthlyBytes)}` : '≈ 0 条'}
                    </span>
                    <span className="hdu-storage-seg-label">预估月增长（粗估）</span>
                  </div>
                </div>
                {quota.quota > 0 ? (
                  <div
                    className={cx('hdu-storage-meter', quota.usage / quota.quota > 0.8 ? 'warn' : '')}
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.min(100, Math.max(0, Math.round((quota.usage / quota.quota) * 100)))}
                    aria-label="存储用量占配额比例"
                  >
                    <i style={{ width: `${Math.min(100, Math.max(0, Math.round((quota.usage / quota.quota) * 100)))}%` }} />
                  </div>
                ) : null}
                <div className="hdu-options-row-sub">
                  预估月增长按近 30 天学习流水日均条数粗估（单条约 200 字节），仅供量级参考。
                </div>
              </>
            ) : (
              <div className="hdu-options-row-sub">无法获取（浏览器限制）</div>
            )}
          </div>
          <div className="hdu-options-row-side">
            <Button size="small" variant="ghost" icon="refresh" onClick={() => void refresh()}>刷新</Button>
          </div>
        </div>
        {/* 全量数据导出（第 250 轮巡检，数据自主权域）：白名单式轻量 JSON 资产快照，
            纯读操作不写库；app 标识与备份不同 → 导入通道按不匹配拒绝（不用于写回，
            恢复走下方全量备份 ZIP）。按钮 loading 态 + 成功/失败 toast + 条目数摘要 */}
        <div className="hdu-export-row">
          <div className="hdu-export-row-main">
            <div className="hdu-options-row-title">导出全部数据</div>
            <div className="hdu-options-row-sub">
              收藏 / 文件夹 / 标签 / 笔记 / 复习计划 / 周计划 / 课程与课次 / B 站续看进度 / 课表 / 偏好设置的 JSON
              快照；不含转写文本与学习流水明细。此文件用于查阅与留档，不用于导入恢复。
            </div>
            {exportSummary ? <div className="hdu-export-summary">{exportSummary}</div> : null}
          </div>
          <div className="hdu-options-row-side">
            <Button
              size="small"
              variant="ghost"
              icon="download"
              disabled={exporting}
              onClick={() => void exportAllData()}
            >
              {exporting ? '导出中…' : '导出 JSON'}
            </Button>
          </div>
        </div>
        <div className="hdu-hint">
          换机 / 重装恢复请用全量备份 ZIP：在「学习看板 → 数据管理」完成导出与导入。导入会校验版本与结构，损坏文件不会破坏现有数据。
        </div>
        <div style={{ marginTop: 10 }}>
          <Button size="small" icon="chart" onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') })}>打开学习看板</Button>
        </div>
      </div>

      <div className="hdu-card" style={{ marginTop: 14 }}>
        <div className="hdu-options-row">
          <div className="hdu-options-row-main">
            <div className="hdu-options-row-title">本地调试日志</div>
            <div className="hdu-options-row-sub">最多 200 条，URL 与 Key 自动打码；当前 {logTotal} / {MAX_LOG_ENTRIES} 条。</div>
          </div>
          <div className="hdu-options-row-side">
            <Button size="small" variant="ghost" onClick={() => setShowLogs((v) => !v)}>{showLogs ? '收起' : `查看（${logs.length}）`}</Button>
            {/* 导出 TXT / 复制全部 / 导出 JSON（第 300/307/309 轮，功能域）：与列表同源 filteredLogs；
                第 312 轮图标化收敛（五钮并排过挤），条数水位保留在 aria-label/title */}
            <IconButton icon="download" label={`导出日志 TXT（共 ${filteredLogs.length} 条）`} disabled={filteredLogs.length === 0} onClick={() => { downloadTextFile(`${logFileStem}.txt`, formatLogsAsText(filteredLogs), 'text/plain;charset=utf-8'); notify(`已导出 ${filteredLogs.length} 条日志`); }} />
            {/* 复制全部筛选结果（第 307 轮，功能域）：与导出同源 filteredLogs，贴工单更快；
                第 311 轮：剪贴板被拒时降级引导改用「导出」落盘 */}
            <IconButton icon="copy" label={`复制全部日志（共 ${filteredLogs.length} 条）`} disabled={filteredLogs.length === 0} onClick={() => { void navigator.clipboard.writeText(formatLogsAsText(filteredLogs)).then(() => notify(`已复制 ${filteredLogs.length} 条日志`)).catch(() => notify('复制失败，可改用「导出」保存为文件', true)); }} />
            {/* 导出 JSON（第 309 轮，功能域）：同源 filteredLogs 的结构化导出，便于程序化分析 */}
            <IconButton icon="layers" label={`导出日志 JSON（共 ${filteredLogs.length} 条）`} disabled={filteredLogs.length === 0} onClick={() => { downloadTextFile(`${logFileStem}.json`, JSON.stringify(filteredLogs, null, 2), 'application/json;charset=utf-8'); notify(`已导出 ${filteredLogs.length} 条日志（JSON）`); }} />
            {/* 两步确认：第一次点击仅进入确认态（红色文案，3 秒复原），第二次点击才清空（操作日志一次性清除、不可恢复） */}
            <ConfirmButton size="small" variant="ghost" icon="trash" confirmLabel="再点一次确认清空" onConfirm={async () => { await clearLogs(); void refresh(); notify('日志已清空'); }}>清空</ConfirmButton>
          </div>
        </div>
        <div className="hdu-options-row">
          <div className="hdu-options-row-main">
            <div className="hdu-options-row-title">记录诊断日志</div>
            <div className="hdu-options-row-sub">全入口生效（站点页 / B 站页 / 后台 / 弹窗 / 看板）；关闭后仅停 debug/info，警告与错误仍保留。</div>
          </div>
          <div className="hdu-options-row-side">
            <label className="hdu-switch">
              <input type="checkbox" checked={settings.debug.logEnabled} onChange={(e) => void patchSettings({ debug: { logEnabled: e.target.checked } })} />
              <span className="hdu-switch-track" />
              <span className="hdu-switch-thumb" />
            </label>
          </div>
        </div>
        {showLogs ? (
          <div style={{ maxHeight: 300, overflow: 'auto' }}>
            {/* 级别筛选（第 301 轮，功能域）：与「记录诊断日志」语义呼应——关闭开关后
                debug/info 不再新增，警告 / 错误两档仍会积累，可单独聚焦查看 */}
            <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <PillTabs
                value={logFilter}
                items={[
                  { value: 'all', label: '全部' },
                  { value: 'warn', label: '警告' },
                  { value: 'error', label: '错误' },
                ]}
                onChange={setLogFilter}
              />
              {/* 来源筛选（第 305 轮，功能域）：按 logger scope 过滤，与级别筛选叠加；
                  scope 清单随当前日志聚合 */}
              <select
                className="hdu-input"
                aria-label="按来源筛选"
                value={scopeFilter}
                onChange={(e) => setScopeFilter(e.target.value)}
                style={{ flex: '0 0 auto', maxWidth: 170, fontSize: 11, height: 26 }}
              >
                <option value="all">全部来源</option>
                {scopeOptions.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
            {(() => {
              const filtered = filteredLogs;
              return (
                <>
                  {/* 筛选结果播报（第 302 轮，可访问性域）：aria-live=polite 随筛选/新增朗读条数，
                      与第 275 轮 role=status 清单同款；建议性文案不阻断操作；305 轮并入来源筛选 */}
                  <div className="hdu-hint" role="status" aria-live="polite">
                    {logFilter === 'all' && scopeFilter === 'all' ? `共 ${filtered.length} 条` : `筛选后 ${filtered.length} / ${logs.length} 条`}
                  </div>
                  {filtered.length === 0 ? (
                    <div className="hdu-hint">
                      {logs.length === 0 ? '暂无日志。' : (
                        <>
                          当前筛选无匹配日志。
                          {/* 清除筛选（第 306 轮，可用性域）：一键重置级别/来源（对齐知识库空态 action 惯例） */}
                          <button type="button" className="hdu-log-reset" onClick={() => { setLogFilter('all'); setScopeFilter('all'); }}>清除筛选</button>
                        </>
                      )}
                    </div>
                  ) : (
                    filtered.map((entry, i) => (
                      <div className="hdu-log-row" key={`${entry.ts}-${i}`}>
                        <div className="hdu-log">
                          [{new Date(entry.ts).toLocaleTimeString()}]{' '}
                          <Chip tone={entry.level === 'error' ? 'danger' : entry.level === 'warn' ? 'accent' : entry.level === 'debug' ? 'default' : 'info'}>{entry.level}</Chip>{' '}
                          [{entry.scope}] {entry.message}
                          {entry.detail ? `\n${entry.detail}` : ''}
                        </div>
                        {/* 复制单条（第 302 轮，功能域）：复制该条格式化文本（同导出格式），便于贴到工单/反馈 */}
                        <IconButton
                          icon="copy"
                          label="复制该条日志"
                          onClick={() => {
                            void navigator.clipboard
                              .writeText(formatLogsAsText([entry]))
                              .then(() => notify('已复制该条日志'))
                              .catch(() => notify('复制失败', true));
                          }}
                        />
                      </div>
                    ))
                  )}
                </>
              );
            })()}
          </div>
        ) : null}
      </div>
    </>
  );
}

// ───────────────────────── 关于 ─────────────────────────

function AboutSection() {
  return (
    <div className="hdu-card">
      <div className="hdu-brand" style={{ padding: 0, marginBottom: 16 }}>
        <div className="hdu-brand-mark">学</div>
        <div>
          <div className="hdu-brand-name">杭电智慧课堂学习助手</div>
          <div className="hdu-brand-sub">Version 1.0.0</div>
        </div>
      </div>
      <div className="hdu-hint" style={{ lineHeight: 1.8 }}>
        把智慧课堂变成个人学习中心：本地转写、AI 知识标注与大纲、时间点问答、板书截图、收藏知识库与学习统计。
      </div>
      <div className="hdu-divider" />
      <dl className="hdu-kv">
        <dt>隐私</dt><dd>音频与模型推理不出本机；不读取、不存储、不转发 Cookie 与 Token。</dd>
        <dt>站点写接口</dt><dd>不调用任何写接口，不污染站点观看记录、收藏与笔记。</dd>
        <dt>AI 内容</dt><dd>所有 AI 生成内容均带「AI 生成」标识；AI 不可用时功能置灰，不阻塞播放。</dd>
        <dt>转载</dt><dd>仅供个人学习辅助；补看清单等仅供个人参考，非考勤依据。</dd>
      </dl>
      <div className="hdu-divider" />
      <div className="hdu-hint">
        使用建议：先在「转写与模型」准备模型 → 打开一节播放课 → 生成字幕 → 生成知识标注 → 在面板中收藏与提问。
      </div>
    </div>
  );
}

/** 自定义成就徽章的维度名录（与 core/plan/achievements 的 metricValues 键一致） */
const ACHIEVEMENT_METRIC_LABELS: Record<string, string> = {
  streak: '连续天数',
  totalMin: '累计分钟',
  externalMin: '站外分钟',
  favorites: '收藏数',
  reviewDone: '完成复习数',
  notes: '笔记数',
};

/** 自定义徽章可选图标（第 142 轮巡检） */
const ACHIEVEMENT_ICONS: string[] = ['🏅', '⭐', '🔥', '🎯', '📚', '💎', '🚀', '🧠'];

/** 自定义成就徽章行（第 139 轮巡检）：列表 + 新增表单（名称/维度/阈值），随设置持久化；
 *  徽章在统计页/总览/今日卡与周报附录中与预置徽章同渲染，阈值同受目标倍率缩放。
 *  第 151 轮巡检：新增「编辑」——行内展开编辑表单，图标/名称/维度/阈值均可改（id 不变）。 */
function CustomAchievementsRow({
  settings,
  patchSettings,
}: {
  settings: AppSettings;
  patchSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const custom = settings.ui?.customAchievements ?? [];
  const [name, setName] = useState('');
  const [metric, setMetric] = useState('reviewDone');
  const [threshold, setThreshold] = useState(10);
  const [icon, setIcon] = useState('🏅');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState({ name: '', metric: 'reviewDone', threshold: 10, icon: '🏅' });
  const save = (next: Array<{ id: string; name: string; metric: string; threshold: number; icon?: string }>) => {
    void patchSettings({ ui: { ...settings.ui, customAchievements: next } });
  };
  const startEdit = (badge: { id: string; name: string; metric: string; threshold: number; icon?: string }) => {
    setEditingId(badge.id);
    setEditDraft({ name: badge.name, metric: badge.metric, threshold: badge.threshold, icon: badge.icon || '🏅' });
  };
  const saveEdit = () => {
    if (!editDraft.name.trim()) return;
    save(
      custom.map((item) =>
        item.id === editingId
          ? { ...item, name: editDraft.name.trim(), metric: editDraft.metric, threshold: Math.max(1, editDraft.threshold || 1), icon: editDraft.icon }
          : item,
      ),
    );
    setEditingId(null);
  };
  return (
    <div className="hdu-options-row">
      <div className="hdu-options-row-main">
        <div className="hdu-options-row-title">自定义成就</div>
        <div className="hdu-options-row-sub">自建徽章（名称 + 维度 + 阈值），与预置徽章同渲染、同受目标倍率缩放；支持编辑与删除。</div>
      </div>
      <div className="hdu-options-row-side" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
        {custom.length === 0 ? <span className="hdu-hint">暂无自定义徽章</span> : null}
        {custom.map((badge) =>
          editingId === badge.id ? (
            <span key={badge.id} className="hdu-badge-edit">
              <select className="hdu-input" value={editDraft.icon} onChange={(e) => setEditDraft({ ...editDraft, icon: e.target.value })} aria-label="编辑徽章图标" style={{ width: 70 }}>
                {ACHIEVEMENT_ICONS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
              <TextInput value={editDraft.name} onChange={(e) => setEditDraft({ ...editDraft, name: e.target.value })} placeholder="徽章名称" style={{ width: 100 }} />
              <select className="hdu-input" value={editDraft.metric} onChange={(e) => setEditDraft({ ...editDraft, metric: e.target.value })} aria-label="编辑成就维度" style={{ width: 110 }}>
                {Object.entries(ACHIEVEMENT_METRIC_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <TextInput type="number" min={1} value={editDraft.threshold} onChange={(e) => setEditDraft({ ...editDraft, threshold: Number(e.target.value) || 1 })} style={{ width: 70 }} />
              <Button size="small" disabled={!editDraft.name.trim()} onClick={saveEdit}>
                保存
              </Button>
              <Button size="small" variant="ghost" onClick={() => setEditingId(null)}>
                取消
              </Button>
            </span>
          ) : (
            <span key={badge.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span className="hdu-hint">
                {badge.icon || '🏅'} {badge.name} · {ACHIEVEMENT_METRIC_LABELS[badge.metric] ?? badge.metric} · ≥{badge.threshold}
              </span>
              <Button size="small" variant="ghost" onClick={() => startEdit(badge)}>
                编辑
              </Button>
              <Button
                size="small"
                variant="ghost"
                onClick={() => {
                  if (editingId === badge.id) setEditingId(null);
                  save(custom.filter((item) => item.id !== badge.id));
                }}
              >
                删除
              </Button>
            </span>
          ),
        )}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <select className="hdu-input" value={icon} onChange={(e) => setIcon(e.target.value)} aria-label="徽章图标" style={{ width: 70 }}>
            {ACHIEVEMENT_ICONS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="徽章名称" style={{ width: 100 }} />
          <select className="hdu-input" value={metric} onChange={(e) => setMetric(e.target.value)} aria-label="成就维度" style={{ width: 110 }}>
            {Object.entries(ACHIEVEMENT_METRIC_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <TextInput type="number" min={1} value={threshold} onChange={(e) => setThreshold(Number(e.target.value) || 1)} style={{ width: 70 }} />
          <Button
            size="small"
            disabled={!name.trim()}
            onClick={() => {
              save([...custom, { id: Date.now().toString(36), name: name.trim(), metric, threshold: Math.max(1, threshold), icon }]);
              setName('');
              setThreshold(10);
              setIcon('🏅');
            }}
          >
            添加
          </Button>
        </span>
      </div>
    </div>
  );
}
