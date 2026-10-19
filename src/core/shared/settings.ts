/**
 * 设置与秘密读写。
 *  - chrome.storage.sync  ← 纯偏好；
 *  - chrome.storage.local ← LLM provider（含 Key）、模型源、用户词表。
 */

import { DEFAULT_SECRETS, DEFAULT_SETTINGS, STORAGE_KEYS } from './constants';
import { extStorage } from './storage';
import type { AppSettings, SecretsStore } from './types';
import { deepMerge } from './utils';

export async function loadSettings(): Promise<AppSettings> {
  return extStorage.getMerged<AppSettings>('sync', STORAGE_KEYS.settings, DEFAULT_SETTINGS);
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await loadSettings();
  const next = deepMerge(current, patch);
  await extStorage.set('sync', STORAGE_KEYS.settings, next);
  return next;
}

export async function replaceSettings(next: AppSettings): Promise<void> {
  await extStorage.set('sync', STORAGE_KEYS.settings, next);
}

export async function loadSecrets(): Promise<SecretsStore> {
  return extStorage.getMerged<SecretsStore>('local', STORAGE_KEYS.secrets, DEFAULT_SECRETS);
}

export async function saveSecrets(patch: Partial<SecretsStore>): Promise<SecretsStore> {
  const current = await loadSecrets();
  const next = deepMerge(current, patch);
  await extStorage.set('local', STORAGE_KEYS.secrets, next);
  return next;
}

export async function replaceSecrets(next: SecretsStore): Promise<void> {
  await extStorage.set('local', STORAGE_KEYS.secrets, next);
}

export async function getActiveProvider(): Promise<SecretsStore['providers'][number] | null> {
  const secrets = await loadSecrets();
  if (!secrets.activeProviderId) return null;
  return secrets.providers.find((p) => p.id === secrets.activeProviderId) ?? null;
}

/** 读取云端 ASR 配置（未配置时返回 null；调用方负责提示去设置中填写） */
export async function getCloudAsr(): Promise<SecretsStore['cloudAsr']> {
  const secrets = await loadSecrets();
  return secrets.cloudAsr ?? null;
}

export function onSettingsChanged(cb: (settings: AppSettings) => void): () => void {
  const g = globalThis as {
    chrome?: {
      storage?: {
        onChanged?: {
          addListener: (fn: (changes: object, area: string) => void) => void;
          removeListener: (fn: (changes: object, area: string) => void) => void;
        };
      };
    };
  };
  const onChanged = g.chrome?.storage?.onChanged;
  if (!onChanged) return () => undefined;
  const listener = (changes: object, area: string) => {
    if (area !== 'sync' || typeof changes !== 'object' || changes === null) return;
    if (!(STORAGE_KEYS.settings in (changes as Record<string, unknown>))) return;
    void loadSettings().then(cb);
  };
  onChanged.addListener(listener);
  return () => onChanged.removeListener(listener);
}
