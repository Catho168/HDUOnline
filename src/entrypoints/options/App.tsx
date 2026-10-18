import { useCallback, useEffect, useState } from 'react';
import { callOp } from '@/core/shared/client';
import { ASR_MODELS, DEFAULT_SETTINGS, PROVIDER_PRESETS, type AsrModelTier } from '@/core/shared/constants';
import { checkUrl, toOriginPattern } from '@/core/shared/urlGuard';
import { loadSecrets, loadSettings, saveSecrets, saveSettings } from '@/core/shared/settings';
import { clearLogs, readLogs, type LogEntry } from '@/core/shared/logger';
import { importModelFile } from '@/core/asr/modelCache';
import type { AppSettings, LlmKind, LlmProviderConfig, SecretsStore } from '@/core/shared/types';
import { UI_CSS } from '../content/ui/styles';
import { Button, Chip, Field, IconButton, Modal, PillTabs, TextInput, cx } from '../content/ui/components';
import { Icon, type IconName } from '../content/ui/icons';

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
.hdu-options-row-side { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; }
.hdu-switch { position: relative; width: 38px; height: 22px; flex: 0 0 auto; }
.hdu-switch input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
.hdu-switch-track { position: absolute; inset: 0; border-radius: 99px; background: var(--paper-3); border: 1px solid var(--line); transition: background .15s, border-color .15s; }
.hdu-switch-thumb { position: absolute; top: 3px; left: 3px; width: 14px; height: 14px; border-radius: 50%; background: var(--muted); transition: transform .15s, background .15s; }
.hdu-switch input:checked + .hdu-switch-track { background: var(--ink); border-color: var(--ink); }
.hdu-switch input:checked + .hdu-switch-track + .hdu-switch-thumb { transform: translateX(16px); background: var(--paper-2); }
.hdu-provider { display: flex; align-items: center; gap: 12px; padding: 13px 0; border-bottom: 1px solid var(--line); }
.hdu-provider:last-child { border-bottom: 0; }
.hdu-provider-icon { width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent); flex: 0 0 auto; }
.hdu-provider-name { font-size: 13px; font-weight: 500; }
.hdu-provider-sub { font-size: 11px; color: var(--muted); margin-top: 2px; }
.hdu-provider-actions { margin-left: auto; display: flex; align-items: center; gap: 4px; }
.hdu-log { font-family: var(--font-mono); font-size: 10.5px; line-height: 1.7; color: var(--ink-soft); white-space: pre-wrap; word-break: break-all; padding: 8px 0; border-bottom: 1px dashed var(--line); }
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
  const [section, setSection] = useState<OptionsSection>('ai');
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);

  const theme = useResolvedTheme(settings);
  useEffect(() => {
    document.body.classList.toggle('dark', theme === 'dark');
  }, [theme]);

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
        <div className="hdu-options-content hdu-scroll">
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

function AiSection({
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
      notify(err instanceof Error ? err.message : '连接失败', true);
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
                  <IconButton icon="trash" label="删除" onClick={() => {
                    if (!window.confirm(`删除 ${provider.label}？`)) return;
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
            <label className="hdu-switch">
              <input
                type="checkbox"
                checked={localAllowed}
                onChange={(e) => {
                  const next = e.target.checked;
                  if (next && !window.confirm('开启后，插件可以向本机或局域网地址发起 AI 请求。请确认这些服务由你本人控制。')) return;
                  setLocalAllowed(next);
                  void persist({ ...secrets, allowLocalEndpoints: next });
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
                      notify(err instanceof Error ? err.message : '下载启动失败', true);
                    }
                  }}
                >
                  {s?.cached ? '重新下载' : '下载'}
                </Button>
                <IconButton
                  icon="trash"
                  label="清除该模型"
                  onClick={async () => {
                    if (!window.confirm(`清除 ${spec.label} 的本地缓存？`)) return;
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

function LearningSection({
  settings,
  patchSettings,
}: {
  settings: AppSettings;
  patchSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const setUi = (patch: Partial<AppSettings['ui']>) => patchSettings({ ui: { ...settings.ui, ...patch } });
  const setCaption = (patch: Partial<AppSettings['captionStyle']>) =>
    patchSettings({ captionStyle: { ...settings.captionStyle, ...patch } });
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
        ] as const).map(([key, label]) => (
          <div className="hdu-options-row" key={key}>
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
          </div>
        ))}
      </div>
    </>
  );
}

// ───────────────────────── 数据 ─────────────────────────

type DataKind = 'ai' | 'transcript' | 'stats' | 'library' | 'screenshots' | 'models';

function DataSection({
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
  const [showLogs, setShowLogs] = useState(false);

  const refresh = useCallback(async () => {
    const [u, l] = await Promise.all([callOp('storage.usage', {}).catch(() => null), readLogs().catch(() => [])]);
    setUsage(u);
    setLogs(l.slice(-80).reverse());
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const clear = async (kind: DataKind) => {
    const labels: Record<DataKind, string> = {
      ai: 'AI 缓存（标注/大纲/问答）',
      transcript: '全部转写文本与分片',
      stats: '学习统计流水',
      library: '收藏、文件夹、标签与笔记',
      screenshots: '板书截图',
      models: '本地模型缓存',
    };
    if (!window.confirm(`清除${labels[kind]}？此操作不可撤销，建议先导出备份。`)) return;
    await callOp('data.clear', { kinds: [kind] });
    notify('已清除');
    void refresh();
  };

  return (
    <>
      <div className="hdu-card">
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
              <Button size="small" variant="ghost" icon="trash" onClick={() => void clear(kind as DataKind)}>清除</Button>
            </div>
          </div>
        ))}
      </div>

      <div className="hdu-card" style={{ marginTop: 14 }}>
        <div className="hdu-section-head">
          <div className="hdu-section-title">备份与迁移</div>
        </div>
        <div className="hdu-hint">
          全量导出（JSON 数据 + 截图 ZIP）与导入在「学习看板 → 数据管理」中完成。导入会校验版本与结构，损坏文件不会破坏现有数据。
        </div>
        <div style={{ marginTop: 10 }}>
          <Button size="small" icon="chart" onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') })}>打开学习看板</Button>
        </div>
      </div>

      <div className="hdu-card" style={{ marginTop: 14 }}>
        <div className="hdu-options-row">
          <div className="hdu-options-row-main">
            <div className="hdu-options-row-title">本地调试日志</div>
            <div className="hdu-options-row-sub">最多 200 条，URL 与 Key 自动打码。</div>
          </div>
          <div className="hdu-options-row-side">
            <Button size="small" variant="ghost" onClick={() => setShowLogs((v) => !v)}>{showLogs ? '收起' : `查看（${logs.length}）`}</Button>
            <Button size="small" variant="ghost" icon="trash" onClick={async () => { await clearLogs(); void refresh(); notify('日志已清空'); }}>清空</Button>
          </div>
        </div>
        <div className="hdu-options-row">
          <div className="hdu-options-row-main">
            <div className="hdu-options-row-title">记录诊断日志</div>
            <div className="hdu-options-row-sub">关闭后仅保留警告与错误。</div>
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
            {logs.length === 0 ? <div className="hdu-hint">暂无日志。</div> : logs.map((entry, i) => (
              <div className="hdu-log" key={`${entry.ts}-${i}`}>
                [{new Date(entry.ts).toLocaleTimeString()}] [{entry.level}] [{entry.scope}] {entry.message}
                {entry.detail ? `\n${entry.detail}` : ''}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </>
  );
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
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

function useResolvedTheme(settings: AppSettings): 'light' | 'dark' {
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
  if (settings.theme === 'dark') return 'dark';
  if (settings.theme === 'light') return 'light';
  return dark ? 'dark' : 'light';
}
