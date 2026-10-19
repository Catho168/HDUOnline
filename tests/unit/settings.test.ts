/** 设置/秘密读写测试：旧版本存储数据升级后，新增字段取默认值（云端 ASR 相关）。 */

import { beforeEach, describe, expect, it } from 'vitest';
import { getCloudAsr, loadSecrets, loadSettings, saveSecrets } from '@/core/shared/settings';
import { DEFAULT_SECRETS, DEFAULT_SETTINGS, STORAGE_KEYS } from '@/core/shared/constants';
import { extStorage } from '@/core/shared/storage';

beforeEach(() => {
  extStorage.__resetMemory();
});

describe('云端 ASR 新增字段的默认值合并', () => {
  it('旧版 settings（无 asr.engine）经 loadSettings 合并后默认 local', async () => {
    // 模拟升级前写入的 settings：没有 engine 字段
    const legacy = structuredClone(DEFAULT_SETTINGS) as { asr: Record<string, unknown> };
    delete legacy.asr.engine;
    await extStorage.set('sync', STORAGE_KEYS.settings, legacy);

    const settings = await loadSettings();
    expect(settings.asr.engine).toBe('local');
    // 其余字段保持默认值
    expect(settings.asr.modelTier).toBe(DEFAULT_SETTINGS.asr.modelTier);
  });

  it('旧版 secrets（无 cloudAsr）经 loadSecrets 合并后为 null', async () => {
    const legacy = structuredClone(DEFAULT_SECRETS) as unknown as Record<string, unknown>;
    delete legacy.cloudAsr;
    await extStorage.set('local', STORAGE_KEYS.secrets, legacy);

    const secrets = await loadSecrets();
    expect(secrets.cloudAsr).toBeNull();
    expect(await getCloudAsr()).toBeNull();
  });

  it('保存云端配置后 getCloudAsr 原样返回', async () => {
    const cloudAsr = { baseUrl: 'https://api.siliconflow.cn', apiKey: 'sk-test-not-a-real-key', model: 'FunAudioLLM/SenseVoiceSmall' };
    await saveSecrets({ cloudAsr });
    expect(await getCloudAsr()).toEqual(cloudAsr);
    // 不影响其他 secrets 字段默认值
    const secrets = await loadSecrets();
    expect(secrets.allowLocalEndpoints).toBe(false);
    expect(secrets.modelSource.remoteHost).toBe('https://hf-mirror.com');
  });
});
