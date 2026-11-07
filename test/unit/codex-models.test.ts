import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthTokenInfo } from '../../src/auth/types';
import type { ModelConfig, ProviderConfig } from '../../src/types';

const state = vi.hoisted(() => ({
  getAvailableModels: vi.fn<(...args: unknown[]) => Promise<ModelConfig[]>>(),
  fetch: vi.fn<typeof fetch>(),
}));

vi.mock('vscode', () => ({
  LanguageModelChatMessageRole: { User: 1, Assistant: 2, System: 3 },
  env: { language: 'en' },
  l10n: { t: (message: string) => message },
}));

vi.mock('../../src/logger', () => ({
  createSimpleHttpLogger: () => ({ error: () => undefined }),
}));

vi.mock('../../src/utils', () => ({
  DEFAULT_NORMAL_TIMEOUT_CONFIG: { connection: 30_000, response: 30_000 },
  isRawBaseUrlEnabled: () => false,
  resolveChatNetwork: () => ({ proxy: { type: 'direct' } }),
  resolveSdkTotalTimeoutMs: () => 60_000,
}));

vi.mock('../../src/client/utils', () => ({
  createCustomFetch: () => state.fetch,
  getToken: (credential: AuthTokenInfo) => credential.kind === 'token' ? credential.token : undefined,
}));

vi.mock('../../src/client/openai/responses-client', () => ({
  OpenAIResponsesProvider: class OpenAIResponsesProvider {
    constructor(protected readonly config: ProviderConfig) {}

    protected buildHeaders(_sessionId: string, credential?: AuthTokenInfo): Record<string, string> {
      return credential?.kind === 'token' ? { Authorization: `Bearer ${credential.token}` } : {};
    }

    async getAvailableModels(...args: unknown[]): Promise<ModelConfig[]> {
      return state.getAvailableModels(...args);
    }
  },
}));

import { OpenAICodexProvider } from '../../src/client/openai/codex-client';

function createConfig(auth: ProviderConfig['auth']): ProviderConfig {
  return {
    type: 'openai-codex',
    name: 'Codex',
    baseUrl: 'https://127.0.0.1:9999/v1',
    models: [],
    auth,
  };
}

beforeEach(() => {
  state.getAvailableModels.mockReset();
  state.fetch.mockReset();
});

describe('OpenAI Codex model list', () => {
  it('fetches models from the configured endpoint for API-key auth', async () => {
    const remoteModels: ModelConfig[] = [
      { id: 'claude-opus-5.5_zero' },
      { id: 'gemini-3.8-flash' },
    ];
    state.getAvailableModels.mockResolvedValue(remoteModels);
    const credential: AuthTokenInfo = { kind: 'token', token: 'sk-test' };
    const refreshCredential = vi.fn(async () => credential);
    const controller = new AbortController();
    const provider = new OpenAICodexProvider(
      createConfig({ method: 'api-key', apiKey: 'sk-test' }),
    );

    await expect(
      provider.getAvailableModels(
        credential,
        refreshCredential,
        controller.signal,
      ),
    ).resolves.toEqual(remoteModels);
    expect(state.getAvailableModels).toHaveBeenCalledWith(
      credential,
      refreshCredential,
      controller.signal,
    );
  });

  it('follows the original release-to-catalog sequence with no credentials on the public request', async () => {
    state.fetch.mockResolvedValueOnce(Response.json({
      tag_name: 'rust-v0.168.0', draft: false, prerelease: false,
    })).mockResolvedValueOnce(Response.json({ models: [{
      slug: 'account-model', visibility: 'list', context_window: 100000,
      default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'medium' }],
    }] }));
    const provider = new OpenAICodexProvider(createConfig({ method: 'openai-codex', bindingId: 'binding-1' }));
    const models = await provider.getAvailableModels({
      kind: 'token', token: 'oauth-sentinel', authContext: {
        method: 'openai-codex', bindingId: 'binding-1', sessionId: 'session', revision: 1, accountId: 'account',
      },
    });
    expect(models.map((model) => model.id)).toEqual(['account-model']);
    expect(state.fetch).toHaveBeenCalledTimes(2);
    const [publicUrl, publicInit] = state.fetch.mock.calls[0];
    expect(publicUrl).toBe('https://api.github.com/repos/openai/codex/releases/latest');
    const publicHeaders = new Headers(publicInit?.headers);
    expect(Array.from(publicHeaders.keys()).sort()).toEqual(['accept', 'user-agent']);
    expect(publicHeaders.has('authorization')).toBe(false);
    const [modelUrl, modelInit] = state.fetch.mock.calls[1];
    expect(new URL(modelUrl.toString()).searchParams.get('client_version')).toBe('0.168.0');
    const modelHeaders = new Headers(modelInit?.headers);
    expect(modelHeaders.get('user-agent')).toBe('codex-tui/0.168.0');
    expect(modelHeaders.get('authorization')).toBe('Bearer oauth-sentinel');
    expect(modelHeaders.get('chatgpt-account-id')).toBe('account');
  });

  it('requires credentials for authenticated ChatGPT model discovery', async () => {
    const provider = new OpenAICodexProvider(
      createConfig({ method: 'openai-codex', bindingId: 'binding-1' }),
    );

    await expect(provider.getAvailableModels({ kind: 'none' }))
      .rejects.toThrow('Authentication required');
    expect(state.getAvailableModels).not.toHaveBeenCalled();
  });
});
