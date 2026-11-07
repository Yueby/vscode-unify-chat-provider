import { beforeEach, describe, expect, it, vi } from 'vitest';

const providerClient = vi.hoisted(() => ({
  getAvailableModels: vi.fn(),
}));

vi.mock('vscode', () => {
  class Disposable {
    constructor(private readonly callback: () => void = () => undefined) {}
    dispose(): void {
      this.callback();
    }
  }
  class EventEmitter<T> {
    private readonly listeners = new Set<(value: T) => void>();
    readonly event = (listener: (value: T) => void): Disposable => {
      this.listeners.add(listener);
      return new Disposable(() => this.listeners.delete(listener));
    };
    fire(value: T): void {
      for (const listener of this.listeners) listener(value);
    }
    dispose(): void {
      this.listeners.clear();
    }
  }
  return {
    Disposable,
    EventEmitter,
    env: { language: 'en' },
    l10n: { t: (message: string) => message },
    workspace: {
      getConfiguration: () => ({
        get: <T>(_key: string, fallback: T) => fallback,
      }),
    },
  };
});

vi.mock('../../src/main-instance', () => ({
  mainInstance: {
    isLeader: () => true,
    onDidReceiveEvent: () => ({ dispose: () => undefined }),
    onDidChangeRole: () => ({ dispose: () => undefined }),
    broadcast: vi.fn(),
    runInLeaderWhenAvailable: vi.fn(),
  },
}));

vi.mock('../../src/client/utils', () => ({
  createProvider: () => ({
    getAvailableModels: providerClient.getAvailableModels,
  }),
}));

vi.mock('../../src/utils', () => ({
  isRawBaseUrlEnabled: () => false,
  normalizeBaseUrlInput: (value: string) => value.trim().replace(/\/+$/, ''),
  normalizeRawBaseUrlInput: (value: string) => value.trim(),
  normalizeUseRawBaseUrl: (value: unknown) => value === true,
}));

vi.mock('../../src/auth', () => ({
  createAuthProvider: vi.fn(),
  normalizeAuthForProvider: (auth: unknown) => auth,
  redactAuthForExport: (auth: Record<string, unknown>) => ({
    ...auth,
    token: undefined,
  }),
}));

import type * as vscode from 'vscode';
import {
  OfficialModelsManager,
  type OfficialModelsAuthManager,
  type OfficialModelsConfigStore,
  type OfficialModelsExtensionContext,
} from '../../src/official-models-manager';
import { SecretStore } from '../../src/secret/secret-store';
import type { ModelConfig, ProviderConfig } from '../../src/types';
import { applyPresetTemplateSelections } from '../../src/preset-templates';
import { resolveCommandCodeProtocol } from '../../src/client/command-code/protocol';

const ZED_BINDING_ID = '00000000-0000-4000-8000-000000000103';
const CODEX_BINDING_ID = '00000000-0000-4000-8000-000000001367';

class MemoryMemento implements vscode.Memento {
  constructor(private readonly values: Map<string, unknown>) {}
  keys(): readonly string[] {
    return Array.from(this.values.keys());
  }
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.values.has(key)
      ? (this.values.get(key) as T)
      : defaultValue;
  }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.values.delete(key);
    else this.values.set(key, value);
  }
}

class MemorySecretStorage implements vscode.SecretStorage {
  readonly onDidChange: vscode.Event<vscode.SecretStorageChangeEvent> = () => ({
    dispose: () => undefined,
  });
  async keys(): Promise<string[]> {
    return [];
  }
  async get(_key: string): Promise<string | undefined> {
    return undefined;
  }
  async store(_key: string, _value: string): Promise<void> {}
  async delete(_key: string): Promise<void> {}
}

function provider(): ProviderConfig {
  return {
    type: 'zed',
    name: 'Zed',
    baseUrl: 'https://zed.dev',
    auth: {
      method: 'zed',
      bindingId: ZED_BINDING_ID,
      baseUrl: 'https://zed.dev',
    },
    models: [],
    autoFetchOfficialModels: true,
  };
}

function commandCodeProvider(): ProviderConfig {
  return {
    type: 'command-code',
    name: 'Command Code',
    baseUrl: 'https://api.commandcode.ai/provider/v1',
    models: [],
    autoFetchOfficialModels: true,
  };
}

function codexProvider(): ProviderConfig {
  return {
    type: 'openai-codex', name: 'Codex', baseUrl: 'https://api.openai.com/v1',
    auth: { method: 'openai-codex', bindingId: CODEX_BINDING_ID },
    models: [], autoFetchOfficialModels: true,
  };
}

function codexAuthManager(getAccount: () => string = () => 'account-a'): OfficialModelsAuthManager {
  return {
    getCredential: async () => ({
      value: 'catalog-token', tokenType: 'Bearer',
      authContext: {
        method: 'openai-codex', bindingId: CODEX_BINDING_ID,
        sessionId: getAccount(), revision: 1, accountId: getAccount(),
      },
    }),
  };
}

function configStore(config: ProviderConfig): OfficialModelsConfigStore {
  return {
    endpoints: [config],
    getProvider: (name: string) => (name === config.name ? config : undefined),
    onDidChange: () => ({ dispose: () => undefined }),
  };
}

function authManager(
  hasCredential = true,
  getOrganizationId: () => string = () => 'org-a',
): OfficialModelsAuthManager {
  return {
    getCredential: async () =>
      hasCredential
        ? {
            value: 'llm-token',
            tokenType: 'Bearer',
            authContext: {
              method: 'zed',
              bindingId: ZED_BINDING_ID,
              sessionId: 'identity',
              revision: 1,
              organizationId: getOrganizationId(),
              dataCollection: false,
              dataCollectionAllowed: false,
            },
          }
        : undefined,
  };
}

function context(storage: Map<string, unknown>): OfficialModelsExtensionContext {
  return { globalState: new MemoryMemento(storage) };
}

function secretStore(): SecretStore {
  return new SecretStore(new MemorySecretStorage());
}

beforeEach(() => {
  providerClient.getAvailableModels.mockReset();
});

describe('official model manager provider boundary', () => {
  it('stores only the models returned through the common Provider API', async () => {
    providerClient.getAvailableModels.mockResolvedValue([
      { id: 'zeta-cloud' },
      { id: 'dynamic-model' },
    ]);
    const config = provider();
    const storage = new Map<string, unknown>();
    const manager = new OfficialModelsManager();
    await manager.initialize(
      context(storage),
      configStore(config),
      secretStore(),
      authManager(),
    );

    const models = await manager.getOfficialModels(config, true);

    expect(providerClient.getAvailableModels).toHaveBeenCalledOnce();
    expect(models.map((model) => model.id)).toEqual([
      'zeta-cloud',
      'dynamic-model',
    ]);
    const state = manager.getProviderState(config.name);
    expect(state?.models.map((model) => model.id)).toEqual([
      'zeta-cloud',
      'dynamic-model',
    ]);
    expect(Object.hasOwn(state ?? {}, 'zedRoutes')).toBe(false);
    expect(Object.hasOwn(state ?? {}, 'zedOrganizationId')).toBe(false);
    const persisted = storage.get('officialModelsState') as
      | Record<string, Record<string, unknown>>
      | undefined;
    expect(Object.hasOwn(persisted?.[config.name] ?? {}, 'zedRoutes')).toBe(
      false,
    );
    manager.dispose();
  });

  it('does not inject provider-specific models when the Provider fetch fails', async () => {
    providerClient.getAvailableModels.mockRejectedValue(
      new Error('Authentication required'),
    );
    const config = provider();
    const manager = new OfficialModelsManager();
    await manager.initialize(
      context(new Map()),
      configStore(config),
      secretStore(),
      authManager(false),
    );

    await expect(manager.getOfficialModels(config, true)).resolves.toEqual([]);
    expect(providerClient.getAvailableModels).toHaveBeenCalledWith(
      { kind: 'none' },
      undefined,
      expect.any(AbortSignal),
    );
    manager.dispose();
  });

  it('prevents an obsolete provider fetch from overwriting a newer local auth context', async () => {
    const config = provider();
    let organizationId = 'org-a';
    let releaseFirst: ((models: Array<{ id: string }>) => void) | undefined;
    let firstSignal: AbortSignal | undefined;
    providerClient.getAvailableModels
      .mockImplementationOnce(
        (_credential, _refreshCredential, signal: AbortSignal | undefined) => {
          firstSignal = signal;
          return new Promise<Array<{ id: string }>>((resolve) => {
            releaseFirst = resolve;
          });
        },
      )
      .mockResolvedValueOnce([{ id: 'new-organization-model' }]);
    const manager = new OfficialModelsManager();
    await manager.initialize(
      context(new Map()),
      configStore(config),
      secretStore(),
      authManager(true, () => organizationId),
    );

    const first = manager.getOfficialModels(config, true);
    await vi.waitFor(() => {
      expect(providerClient.getAvailableModels).toHaveBeenCalledOnce();
    });
    organizationId = 'org-b';
    await manager.clearProviderState(config.name);
    expect(firstSignal?.aborted).toBe(true);
    await manager.getOfficialModels(config, true);
    releaseFirst?.([{ id: 'old-organization-model' }]);
    await first;

    expect(manager.getProviderState(config.name)?.models).toEqual([
      expect.objectContaining({ id: 'new-organization-model' }),
    ]);
    manager.dispose();
  });

  it('invalidates cached models when the local auth state changes', async () => {
    providerClient.getAvailableModels
      .mockResolvedValueOnce([{ id: 'old-organization-model' }])
      .mockRejectedValue(new Error('Authentication revoked'));
    const config = provider();
    const store: OfficialModelsConfigStore = {
      endpoints: [config],
      getProvider: (name) => (name === config.name ? config : undefined),
      onDidChange: () => ({ dispose: () => undefined }),
    };
    const manager = new OfficialModelsManager();
    await manager.initialize(
      context(new Map()),
      store,
      secretStore(),
      authManager(),
    );
    await manager.getOfficialModels(config, true);

    await manager.clearProviderState(config.name);

    await vi.waitFor(() => {
      expect(
        manager
          .getProviderState(config.name)
          ?.models.some((model) => model.id === 'old-organization-model') ?? false,
      ).toBe(false);
    });
    manager.dispose();
  });

  it('preserves Command Code routing identity across an official-model cache restart', async () => {
    const config = commandCodeProvider();
    const storage = new Map<string, unknown>();
    providerClient.getAvailableModels.mockResolvedValue([
      {
        id: 'opaque-id',
        name: 'Claude Model With Opaque ID',
        maxInputTokens: 1_000_000,
      },
    ]);
    const firstManager = new OfficialModelsManager();
    await firstManager.initialize(
      context(storage),
      configStore(config),
      secretStore(),
      authManager(false),
    );
    await firstManager.getOfficialModels(config, true);
    firstManager.dispose();

    const serialized = JSON.stringify(storage.get('officialModelsState'));
    const reloadedState: unknown = JSON.parse(serialized);
    const restartedStorage = new Map<string, unknown>([
      ['officialModelsState', reloadedState],
    ]);
    providerClient.getAvailableModels.mockReset();
    const secondManager = new OfficialModelsManager();
    await secondManager.initialize(
      context(restartedStorage),
      configStore(config),
      secretStore(),
      authManager(false),
    );

    const models = await secondManager.getOfficialModels(config);

    expect(providerClient.getAvailableModels).not.toHaveBeenCalled();
    expect(models).toEqual([
      expect.objectContaining({
        id: 'opaque-id',
        name: 'Claude Model With Opaque ID',
        maxInputTokens: 1_000_000,
      }),
    ]);
    expect(resolveCommandCodeProtocol(models[0])).toBe('anthropic-messages');
    secondManager.dispose();
  });
});

describe('Codex official-model cache integration', () => {
  it('caches successful catalogs, honors force, preserves errors and accepts an empty replacement', async () => {
    const config = codexProvider();
    const manager = new OfficialModelsManager();
    await manager.initialize(context(new Map()), configStore(config), secretStore(), codexAuthManager());
    try {
      providerClient.getAvailableModels.mockResolvedValueOnce([{ id: 'codex-account-model' }]);
      const first = await manager.getOfficialModels(config, true);
      expect(await manager.getOfficialModels(config)).toEqual(first);
      expect(providerClient.getAvailableModels).toHaveBeenCalledOnce();

      providerClient.getAvailableModels.mockRejectedValueOnce(new Error('HTTP 503'));
      expect(await manager.getOfficialModels(config, true)).toEqual(first);
      expect(manager.getProviderState(config.name)?.lastError).toBe('HTTP 503');
      expect(await manager.getOfficialModels(config)).toEqual(first);
      expect(providerClient.getAvailableModels).toHaveBeenCalledTimes(2);

      providerClient.getAvailableModels.mockResolvedValueOnce([]);
      expect(await manager.getOfficialModels(config, true)).toEqual([]);
      expect(await manager.getOfficialModels(config)).toEqual([]);
      expect(manager.getProviderState(config.name)?.lastError).toBeUndefined();
      expect(providerClient.getAvailableModels).toHaveBeenCalledTimes(3);
    } finally {
      manager.dispose();
    }
  });

  it('does not restore an earlier account catalog after auth invalidation and a failed refresh', async () => {
    const config = codexProvider();
    let account = 'account-a';
    const manager = new OfficialModelsManager();
    await manager.initialize(context(new Map()), configStore(config), secretStore(), codexAuthManager(() => account));
    try {
      providerClient.getAvailableModels.mockResolvedValueOnce([{ id: 'account-a-model' }]);
      await manager.getOfficialModels(config, true);
      account = 'account-b';
      await manager.clearProviderState(config.name);
      providerClient.getAvailableModels.mockRejectedValueOnce(new Error('HTTP 401'));
      expect(await manager.getOfficialModels(config, true)).toEqual([]);
      expect(manager.getProviderState(config.name)?.lastError).toBe('HTTP 401');
      expect(manager.getProviderState(config.name)?.models).toEqual([]);
    } finally {
      manager.dispose();
    }
  });

  it('ignores a late response from an invalidated account request', async () => {
    const config = codexProvider();
    let account = 'account-a';
    let release: ((models: ModelConfig[]) => void) | undefined;
    let firstSignal: AbortSignal | undefined;
    providerClient.getAvailableModels.mockImplementationOnce(
      (_credential, _refresh, signal: AbortSignal) => {
        firstSignal = signal;
        return new Promise<ModelConfig[]>((resolve) => { release = resolve; });
      },
    ).mockResolvedValueOnce([{ id: 'account-b-model' }]);
    const manager = new OfficialModelsManager();
    await manager.initialize(context(new Map()), configStore(config), secretStore(), codexAuthManager(() => account));
    try {
      const first = manager.getOfficialModels(config, true);
      await vi.waitFor(() => expect(providerClient.getAvailableModels).toHaveBeenCalledOnce());
      account = 'account-b';
      await manager.clearProviderState(config.name);
      expect(firstSignal?.aborted).toBe(true);
      await manager.getOfficialModels(config, true);
      release?.([{ id: 'account-a-model' }]);
      await first;
      expect(manager.getProviderState(config.name)?.models.map((model) => model.id)).toEqual(['account-b-model']);
    } finally {
      manager.dispose();
    }
  });

  it('retains authoritative metadata after well-known merging and a JSON cache restart', async () => {
    const config = codexProvider();
    const storage = new Map<string, unknown>();
    const raw: ModelConfig = {
      id: 'gpt-6.1-sol', maxInputTokens: 475000, maxOutputTokens: undefined,
      thinking: undefined, verbosity: undefined, presetTemplates: [],
      capabilities: { toolCalling: true, imageInput: false, editTools: 'multi-find-replace' },
    };
    providerClient.getAvailableModels.mockResolvedValueOnce([raw]);
    const first = new OfficialModelsManager();
    await first.initialize(context(storage), configStore(config), secretStore(), codexAuthManager());
    await first.getOfficialModels(config, true);
    first.dispose();
    const persisted: unknown = JSON.parse(JSON.stringify(storage.get('officialModelsState')));
    providerClient.getAvailableModels.mockReset();
    const second = new OfficialModelsManager();
    await second.initialize(context(new Map([['officialModelsState', persisted]])), configStore(config), secretStore(), codexAuthManager());
    try {
      const [cached] = await second.getOfficialModels(config);
      expect(providerClient.getAvailableModels).not.toHaveBeenCalled();
      expect(cached).toMatchObject({
        id: 'gpt-6.1-sol', maxInputTokens: 475000, presetTemplates: [],
        capabilities: { toolCalling: true, imageInput: false, editTools: 'multi-find-replace' },
      });
      expect(cached.maxOutputTokens).toBeUndefined();
      expect(applyPresetTemplateSelections(cached, undefined).thinking).toBeUndefined();
      expect(applyPresetTemplateSelections(cached, undefined).verbosity).toBeUndefined();
      expect(JSON.stringify(persisted)).not.toContain('catalog-token');
    } finally {
      second.dispose();
    }
  });
});
