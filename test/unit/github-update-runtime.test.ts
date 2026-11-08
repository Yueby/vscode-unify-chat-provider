import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProxyConfig } from '../../src/types';

const state = vi.hoisted(() => ({
  strict: true,
  proxy: undefined as ProxyConfig | undefined,
  fetcher: vi.fn<typeof fetch>(),
  factory: vi.fn(),
}));
vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ get: () => state.strict }) },
}));
vi.mock('../../src/client/utils', () => ({ createCustomFetch: (...args: unknown[]) => { state.factory(...args); return state.fetcher; } }));
vi.mock('../../src/utils', () => ({ resolveChatNetwork: () => ({ proxy: state.proxy }) }));
vi.mock('../../src/main-instance', () => ({ mainInstance: {} }));
vi.mock('../../src/update/ui', () => ({ createUpdateUi: vi.fn() }));
import { createReleaseFetcher } from '../../src/update/runtime';

beforeEach(() => {
  state.strict = true; state.proxy = undefined;
  state.fetcher.mockReset().mockResolvedValue(new Response('ok'));
  state.factory.mockReset();
  vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '1');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('update network wiring', () => {
  it('uses current application proxy settings and no response/body logger', async () => {
    state.proxy = { type: 'custom', url: 'http://proxy.invalid:8080', strictSSL: true };
    await createReleaseFetcher()('https://api.github.com/test', { headers: { Accept: 'application/json' } });
    expect(state.factory).toHaveBeenCalledWith({
      type: 'normal', proxy: state.proxy, connectionTimeoutMs: 8000, responseTimeoutMs: 30000, retryConfig: { maxRetries: 0 },
    });
    expect(state.fetcher).toHaveBeenCalledOnce();
  });
  it('does not download executable updates with relaxed VS Code TLS settings', async () => {
    state.strict = false;
    await expect(createReleaseFetcher()('https://api.github.com/test')).rejects.toMatchObject({ code: 'network' });
    expect(state.factory).not.toHaveBeenCalled();
  });
  it('does not inherit a provider-style proxy certificate bypass', async () => {
    state.proxy = { type: 'custom', url: 'https://proxy.invalid', strictSSL: false };
    await expect(createReleaseFetcher()('https://api.github.com/test')).rejects.toMatchObject({ code: 'network' });
    expect(state.fetcher).not.toHaveBeenCalled();
  });
  it('refuses process-wide TLS bypass without printing environment data', async () => {
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0');
    await expect(createReleaseFetcher()('https://api.github.com/test')).rejects.toMatchObject({ code: 'network' });
    expect(state.fetcher).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith('[UCP update] TLS certificate validation is required');
  });
});
