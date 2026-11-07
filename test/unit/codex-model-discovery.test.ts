import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthTokenInfo, CodexAuthContext } from '../../src/auth/types';
import type { ProviderConfig } from '../../src/types';

type FetchOptions = Parameters<typeof import('../../src/client/utils').createCustomFetch>[0];
const network = vi.hoisted(() => ({
  fetch: vi.fn<typeof fetch>(),
  options: [] as unknown[],
  errors: vi.fn<(error: unknown) => void>(),
  diagnostics: vi.fn<(...args: unknown[]) => void>(),
}));

vi.mock('vscode', () => {
  class TextPart { constructor(readonly value: string) {} }
  class ThinkingPart { constructor(readonly value: string, readonly id?: string, readonly metadata?: object) {} }
  class DataPart { constructor(readonly data: Uint8Array, readonly mimeType: string) {} }
  class ToolCall { constructor(readonly callId: string, readonly name: string, readonly input: object) {} }
  class ToolResult { constructor(readonly callId: string, readonly content: unknown[]) {} }
  return {
    env: { language: 'en' },
    l10n: { t: (message: string) => message },
    EventEmitter: class {
      readonly event = () => ({ dispose: () => undefined });
      fire(): void {}
      dispose(): void {}
    },
    ThemeIcon: class { constructor(readonly id: string) {} },
    LanguageModelTextPart: TextPart,
    LanguageModelThinkingPart: ThinkingPart,
    LanguageModelDataPart: DataPart,
    LanguageModelToolCallPart: ToolCall,
    LanguageModelToolResultPart: ToolResult,
    LanguageModelToolResultPart2: class extends ToolResult {},
    LanguageModelChatMessageRole: { System: 1, User: 2, Assistant: 3 },
    LanguageModelChatToolMode: { Auto: 1, Required: 2 },
    extensions: { getExtension: () => undefined },
    workspace: { getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }) },
  };
});

vi.mock('../../src/logger', () => ({
  createSimpleHttpLogger: () => ({ error: network.errors }),
  authLog: { warn: () => undefined, error: () => undefined, verbose: () => undefined },
  RequestLogger: class {
    constructor(_id: string) {}
    verbose(): void {}
    error(): void {}
    usage(): void {}
    providerRequest(): void {}
    providerResponseMeta(): void {}
    providerResponseChunk(): void {}
  },
}));

vi.mock('../../src/client/utils', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/client/utils')>(),
  createCustomFetch: (options: FetchOptions): typeof fetch => {
    network.options.push(options);
    return async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      const rewritten = options.urlTransformer?.(url);
      const target = rewritten && input instanceof Request ? new Request(rewritten, input) : rewritten ?? input;
      return network.fetch(target, init);
    };
  },
}));

import { OpenAICodexProvider } from '../../src/client/openai/codex-client';
import { RequestLogger } from '../../src/logger';
import { applyPresetTemplateSelections } from '../../src/preset-templates';
import { mergeWithWellKnownModel } from '../../src/well-known/models';

const BINDING_ID = '00000000-0000-4000-8000-000000001367';
const config: ProviderConfig = {
  name: 'Codex', type: 'openai-codex', baseUrl: 'https://api.openai.com/v1', models: [],
  auth: { method: 'openai-codex', bindingId: BINDING_ID },
};

function credential(token = 'expired-token', overrides: Partial<CodexAuthContext> = {}): AuthTokenInfo {
  return {
    kind: 'token', token,
    authContext: {
      method: 'openai-codex', bindingId: BINDING_ID, sessionId: 'session-a',
      revision: 1, accountId: 'account-a', ...overrides,
    },
  };
}

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: 'account-specific-model', display_name: 'Account model', visibility: 'list',
    supported_in_api: false, context_window: 500000, max_context_window: 2000000,
    effective_context_window_percent: 95,
    input_modalities: ['text', 'image'],
    default_reasoning_level: 'medium',
    supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
      .map((effort) => ({ effort })),
    supports_reasoning_summary_parameter: true, default_reasoning_summary: 'auto',
    apply_patch_tool_type: 'freeform', supports_parallel_tool_calls: true,
    support_verbosity: true, default_verbosity: 'low', ...overrides,
  };
}

function catalog(models: unknown[] = [entry()]): Response {
  return Response.json({ models });
}

function responseError(status: number): Response {
  return Response.json({ error: { message: 'server-private-message' } }, { status });
}

beforeEach(() => {
  network.fetch.mockReset();
  network.options.length = 0;
  network.errors.mockReset();
  network.diagnostics.mockReset();
  vi.spyOn(console, 'info').mockImplementation(network.diagnostics);
  network.fetch.mockImplementation(async () => catalog());
});
afterEach(() => vi.restoreAllMocks());

describe('authenticated Codex model discovery', () => {
  it('uses the Codex protocol version, account headers and normal networking path', async () => {
    const controller = new AbortController();
    const provider = new OpenAICodexProvider({
      ...config, proxy: { type: 'custom', url: 'http://proxy.example:8080' },
      extraHeaders: {
        authorization: 'stale-header', 'ChatGPT-Account-Id': 'wrong-account', 'User-Agent': 'wrong-agent',
        'OpenAI-Organization': 'private-org', 'OpenAI-Project': 'private-project', 'X-Stainless-Lang': 'test',
      },
    });
    const models = await provider.getAvailableModels(credential(), undefined, controller.signal);
    expect(network.fetch).toHaveBeenCalledOnce();
    const [input, init] = network.fetch.mock.calls[0];
    const url = new URL(input.toString());
    const headers = new Headers(init?.headers);
    expect(url.origin + url.pathname).toBe('https://chatgpt.com/backend-api/codex/models');
    expect(url.searchParams.get('client_version')).toBe('0.167.0');
    expect(headers.get('user-agent')).toContain(`codex-tui/${url.searchParams.get('client_version')}`);
    expect(headers.get('authorization')).toBe('Bearer expired-token');
    expect(headers.get('chatgpt-account-id')).toBe('account-a');
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.has('openai-organization')).toBe(false);
    expect(headers.has('openai-project')).toBe(false);
    expect(headers.has('x-stainless-lang')).toBe(false);
    expect(init).toMatchObject({ method: 'GET', redirect: 'error', signal: controller.signal });
    expect(network.options[0]).toMatchObject({
      type: 'normal', connectionTimeoutMs: 20000, responseTimeoutMs: 20000,
      proxy: { type: 'custom', url: 'http://proxy.example:8080' }, abortSignal: controller.signal,
    });
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: 'account-specific-model', name: 'Account model', maxInputTokens: 475000,
      maxOutputTokens: undefined, thinking: { type: 'enabled', effort: 'medium', summary: 'auto' },
      capabilities: { toolCalling: true, imageInput: true, editTools: 'apply-patch' },
      parallelToolCalling: true, verbosity: 'low',
    });
    expect(models[0]?.presetTemplates?.find((template) => template.id === 'reasoningEffort')?.presets.map((preset) => preset.id))
      .toEqual(['max', 'xhigh', 'high', 'medium', 'low']);
    expect(models[0]?.presetTemplates?.find((template) => template.id === 'verbosity')?.default).toBe('low');
    expect(Object.hasOwn(models[0], 'maxOutputTokens')).toBe(true);
  });

  it('keeps public-API-ineligible ChatGPT models and filters hidden picker entries', async () => {
    network.fetch.mockResolvedValueOnce(catalog([
      entry(), entry({ slug: 'hidden', visibility: 'hide' }), entry({ slug: 'manual', visibility: 'none' }), entry(),
    ]));
    expect((await new OpenAICodexProvider(config).getAvailableModels(credential())).map((model) => model.id))
      .toEqual(['account-specific-model']);
  });

  it('logs fixed catalog counts without model contents or authentication identifiers', async () => {
    network.fetch.mockResolvedValueOnce(catalog([
      entry({ slug: 'private-model-sentinel', display_name: 'private-display-sentinel' }),
      entry({ slug: 'hidden-sentinel', visibility: 'hide' }),
      entry({ slug: 'manual-sentinel', visibility: 'none' }),
      entry({ slug: 'private-model-sentinel' }),
    ]));
    await new OpenAICodexProvider(config).getAvailableModels(credential());
    expect(network.diagnostics).toHaveBeenCalledOnce();
    expect(network.diagnostics).toHaveBeenCalledWith(
      '[UCP Codex catalog] version=0.167.0 total=4 list=2 hide=1 none=1 returned=1',
    );
    const output = JSON.stringify(network.diagnostics.mock.calls);
    for (const value of ['private-model-sentinel', 'private-display-sentinel', 'hidden-sentinel',
      'manual-sentinel', 'expired-token', 'account-a', 'session-a', BINDING_ID]) {
      expect(output).not.toContain(value);
    }
  });

  it('leaves caching to the official-model manager so direct refreshes reach the backend', async () => {
    await new OpenAICodexProvider(config).getAvailableModels(credential());
    await new OpenAICodexProvider(config).getAvailableModels(credential());
    expect(network.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([{ models: [] }, { models: [entry({ visibility: 'hide' })] }, { models: [entry({ visibility: 'none' })] }])(
    'returns an authoritative empty picker list for %j', async ({ models }) => {
      network.fetch.mockResolvedValueOnce(catalog(models));
      await expect(new OpenAICodexProvider(config).getAvailableModels(credential())).resolves.toEqual([]);
      expect(network.diagnostics).toHaveBeenCalledOnce();
      expect(network.diagnostics.mock.calls[0][0]).toContain(`total=${models.length}`);
      expect(network.diagnostics.mock.calls[0][0]).toContain('returned=0');
    },
  );

  it.each([
    { fields: { context_window: 272000 }, expected: 258400 },
    { fields: { effective_context_window_percent: 80 }, expected: 400000 },
    { fields: { effective_context_window_percent: 100 }, expected: 475000 },
    { fields: { effective_context_window_percent: undefined }, expected: 475000 },
    { fields: { context_window: null, max_context_window: 600000 }, expected: 570000 },
    { fields: { context_window: undefined, max_context_window: 600000 }, expected: 570000 },
  ])('derives a conservative account prompt budget: $fields', async ({ fields, expected }) => {
    network.fetch.mockResolvedValueOnce(catalog([entry(fields)]));
    const [model] = await new OpenAICodexProvider(config).getAvailableModels(credential());
    expect(model.maxInputTokens).toBe(expected);
    expect(model.maxOutputTokens).toBeUndefined();
  });

  it('clears public catalog defaults when reasoning and verbosity are unavailable', async () => {
    network.fetch.mockResolvedValueOnce(catalog([entry({
      slug: 'gpt-6.1-sol', supported_reasoning_levels: [], support_verbosity: false,
      input_modalities: ['text'], apply_patch_tool_type: null,
    })]));
    const [raw] = await new OpenAICodexProvider(config).getAvailableModels(credential());
    const model = mergeWithWellKnownModel(raw, config);
    expect(Object.hasOwn(raw, 'thinking')).toBe(true);
    expect(Object.hasOwn(raw, 'verbosity')).toBe(true);
    expect(model).toMatchObject({
      maxInputTokens: 475000, maxOutputTokens: undefined, thinking: undefined,
      verbosity: undefined, presetTemplates: [],
      capabilities: { toolCalling: true, imageInput: false, editTools: 'multi-find-replace' },
    });
  });

  it('uses advertised known efforts without inventing support for an unknown default', async () => {
    network.fetch.mockResolvedValueOnce(catalog([entry({
      default_reasoning_level: 'ultra',
      supported_reasoning_levels: [{ effort: 'ultra' }, { effort: 'medium' }, { effort: 'medium' }, { effort: 'max' }],
      supports_reasoning_summary_parameter: false, input_modalities: undefined,
    })]));
    const [model] = await new OpenAICodexProvider(config).getAvailableModels(credential());
    expect(model.thinking).toMatchObject({ effort: 'medium', summary: 'none' });
    expect(model.capabilities?.imageInput).toBe(true);
    expect(model.presetTemplates?.[0].presets.map((preset) => preset.id)).toEqual(['max', 'medium']);
  });

  it.each([
    { models: null }, { data: [] }, { models: [null] },
    { models: [entry({ visibility: 'unexpected' })] },
    { models: [entry({ slug: ' ' })] },
    { models: [entry({ context_window: 0 })] },
    { models: [entry({ context_window: -1 })] },
    { models: [entry({ context_window: '500000' })] },
    { models: [entry({ context_window: Number.MAX_SAFE_INTEGER + 1 })] },
    { models: [entry({ context_window: null, max_context_window: null })] },
    { models: [entry({ effective_context_window_percent: 0 })] },
    { models: [entry({ effective_context_window_percent: 101 })] },
    { models: [entry({ effective_context_window_percent: 1.5 })] },
    { models: [entry({ input_modalities: 'image' })] },
  ])('rejects malformed metadata rather than reporting an empty success: %j', async (payload) => {
    network.fetch.mockResolvedValueOnce(Response.json(payload));
    await expect(new OpenAICodexProvider(config).getAvailableModels(credential())).rejects.toThrow('Invalid Codex model catalog');
    expect(network.diagnostics).not.toHaveBeenCalled();
  });
});

describe('Codex discovery authentication and cancellation', () => {
  it('refreshes one 401 with rebuilt headers and releases the rejected response body', async () => {
    const stale = responseError(401);
    if (!stale.body) throw new Error('Expected a response body');
    const cancel = vi.spyOn(stale.body, 'cancel');
    network.fetch.mockResolvedValueOnce(stale).mockResolvedValueOnce(catalog());
    const refresh = vi.fn(async () => credential('fresh-token', { revision: 2 }));
    await new OpenAICodexProvider(config).getAvailableModels(credential(), refresh);
    expect(refresh).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(network.fetch).toHaveBeenCalledTimes(2);
    expect(new Headers(network.fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer expired-token');
    expect(new Headers(network.fetch.mock.calls[1][1]?.headers).get('authorization')).toBe('Bearer fresh-token');
    expect(new Headers(network.fetch.mock.calls[1][1]?.headers).get('chatgpt-account-id')).toBe('account-a');
  });

  it.each([401, 403, 429, 500, 503])('surfaces HTTP %i after the networking layer returns it', async (status) => {
    network.fetch.mockImplementation(async () => responseError(status));
    const refresh = vi.fn(async () => credential('fresh-token', { revision: 2 }));
    let error: unknown;
    try {
      await new OpenAICodexProvider(config).getAvailableModels(credential(), refresh);
    } catch (caught) { error = caught; }
    expect(error).toMatchObject({ status });
    expect(refresh).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
    expect(network.fetch).toHaveBeenCalledTimes(status === 401 ? 2 : 1);
    expect(error instanceof Error ? error.message : '').not.toContain('server-private-message');
    expect(error instanceof Error ? error.message : '').not.toContain('expired-token');
  });

  it.each([
    { bindingId: 'other-binding' }, { sessionId: 'other-session' },
    { accountId: 'other-account' }, { accountId: undefined }, { revision: 0 },
  ])('does not retry with a changed refreshed context: %j', async (changed) => {
    network.fetch.mockResolvedValueOnce(responseError(401));
    const refresh = vi.fn(async () => credential('fresh-token', { revision: 2, ...changed }));
    await expect(new OpenAICodexProvider(config).getAvailableModels(credential(), refresh))
      .rejects.toThrow('context changed');
    expect(network.fetch).toHaveBeenCalledOnce();
  });

  it('snapshots identity before callers mutate a shared credential context', async () => {
    const initial = credential();
    if (initial.kind !== 'token' || initial.authContext?.method !== 'openai-codex') throw new Error('Expected context');
    const mutable = { ...initial.authContext };
    const shared: AuthTokenInfo = { ...initial, authContext: mutable };
    network.fetch.mockImplementationOnce(async () => { mutable.accountId = 'other-account'; return catalog(); });
    await expect(new OpenAICodexProvider(config).getAvailableModels(shared)).rejects.toThrow('context changed');
  });

  it('does not refresh credentials after identity changes during a rejected request', async () => {
    const initial = credential();
    if (initial.kind !== 'token' || initial.authContext?.method !== 'openai-codex') throw new Error('Expected context');
    const mutable = { ...initial.authContext };
    network.fetch.mockImplementationOnce(async () => { mutable.accountId = 'other-account'; return responseError(401); });
    const refresh = vi.fn(async () => credential('fresh-token', { revision: 2 }));
    await expect(new OpenAICodexProvider(config).getAvailableModels({ ...initial, authContext: mutable }, refresh))
      .rejects.toThrow('context changed');
    expect(refresh).not.toHaveBeenCalled();
    expect(network.fetch).toHaveBeenCalledOnce();
  });

  it('rechecks identity after asynchronous rejection-body cleanup and before refresh', async () => {
    const initial = credential();
    if (initial.kind !== 'token' || initial.authContext?.method !== 'openai-codex') throw new Error('Expected context');
    const mutable = { ...initial.authContext };
    const stale = responseError(401);
    if (!stale.body) throw new Error('Expected body');
    const cancelBody = stale.body.cancel.bind(stale.body);
    let releaseCancel: (() => void) | undefined;
    const cancel = vi.spyOn(stale.body, 'cancel').mockImplementation(async () => {
      await new Promise<void>((resolve) => { releaseCancel = resolve; });
      await cancelBody();
    });
    network.fetch.mockResolvedValueOnce(stale);
    const refresh = vi.fn(async () => credential('fresh-token', { revision: 2 }));
    const result = new OpenAICodexProvider(config).getAvailableModels({ ...initial, authContext: mutable }, refresh);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    mutable.accountId = 'other-account';
    releaseCancel?.();
    await expect(result).rejects.toThrow('context changed');
    expect(refresh).not.toHaveBeenCalled();
    expect(network.fetch).toHaveBeenCalledOnce();
  });

  it('retains the original identity check while credential refresh is pending', async () => {
    const initial = credential();
    if (initial.kind !== 'token' || initial.authContext?.method !== 'openai-codex') throw new Error('Expected context');
    const mutable = { ...initial.authContext };
    network.fetch.mockResolvedValueOnce(responseError(401));
    let finishRefresh: ((value: AuthTokenInfo) => void) | undefined;
    const refresh = vi.fn(() => new Promise<AuthTokenInfo>((resolve) => { finishRefresh = resolve; }));
    const result = new OpenAICodexProvider(config).getAvailableModels({ ...initial, authContext: mutable }, refresh);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    mutable.accountId = 'other-account';
    finishRefresh?.(credential('fresh-token', { revision: 2 }));
    await expect(result).rejects.toThrow('context changed');
    expect(network.fetch).toHaveBeenCalledOnce();
  });

  it('checks the original identity again after the refreshed response JSON is read', async () => {
    const initial = credential();
    if (initial.kind !== 'token' || initial.authContext?.method !== 'openai-codex') throw new Error('Expected context');
    const mutable = { ...initial.authContext };
    const response = catalog();
    vi.spyOn(response, 'json').mockImplementation(async () => {
      mutable.accountId = 'other-account';
      return { models: [entry()] };
    });
    network.fetch.mockResolvedValueOnce(responseError(401)).mockResolvedValueOnce(response);
    await expect(new OpenAICodexProvider(config).getAvailableModels(
      { ...initial, authContext: mutable }, async () => credential('fresh-token', { revision: 2 }),
    )).rejects.toThrow('context changed');
    expect(network.fetch).toHaveBeenCalledTimes(2);
  });

  it.each<AuthTokenInfo>([
    { kind: 'none' },
    { kind: 'token', token: 'fresh-token' },
    { kind: 'token', token: 'fresh-token', authContext: {
      method: 'oauth2', bindingId: BINDING_ID, sessionId: 'session-a', revision: 2,
    } },
  ])('rejects cleared or incompatible refreshed credentials: %j', async (refreshed) => {
    network.fetch.mockResolvedValueOnce(responseError(401));
    await expect(new OpenAICodexProvider(config).getAvailableModels(credential(), async () => refreshed))
      .rejects.toThrow(/context changed|Authentication required/);
    expect(network.fetch).toHaveBeenCalledOnce();
  });

  it('rejects a mismatched initial binding before making a request', async () => {
    await expect(new OpenAICodexProvider(config).getAvailableModels(credential('token', { bindingId: 'other' })))
      .rejects.toThrow('context changed');
    expect(network.fetch).not.toHaveBeenCalled();
  });

  it('allows a legacy token request but does not refresh without identity context', async () => {
    const bare: AuthTokenInfo = { kind: 'token', token: 'legacy-token' };
    await new OpenAICodexProvider(config).getAvailableModels(bare);
    expect(new Headers(network.fetch.mock.calls[0][1]?.headers).has('chatgpt-account-id')).toBe(false);
    network.fetch.mockReset().mockResolvedValueOnce(responseError(401));
    const refresh = vi.fn(async () => credential('fresh-token'));
    await expect(new OpenAICodexProvider(config).getAvailableModels(bare, refresh)).rejects.toMatchObject({ status: 401 });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('honors pre-cancellation before authentication or networking work', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(new OpenAICodexProvider(config).getAvailableModels(credential(), undefined, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(network.fetch).not.toHaveBeenCalled();
    expect(network.options).toEqual([]);
    expect(network.diagnostics).not.toHaveBeenCalled();
  });

  it('does not publish a catalog canceled while its JSON body is read', async () => {
    const controller = new AbortController();
    const response = catalog();
    vi.spyOn(response, 'json').mockImplementation(async () => { controller.abort(); return { models: [entry()] }; });
    network.fetch.mockResolvedValueOnce(response);
    await expect(new OpenAICodexProvider(config).getAvailableModels(credential(), undefined, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(network.errors).not.toHaveBeenCalled();
    expect(network.diagnostics).not.toHaveBeenCalled();
  });

  it('does not make a second request after cancellation during credential refresh', async () => {
    const controller = new AbortController();
    network.fetch.mockResolvedValueOnce(responseError(401));
    const refresh = vi.fn(async () => { controller.abort(); return credential('fresh-token', { revision: 2 }); });
    await expect(new OpenAICodexProvider(config).getAvailableModels(credential(), refresh, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(network.fetch).toHaveBeenCalledOnce();
  });

  it('checks cancellation after an already-started credential refresh resolves', async () => {
    const controller = new AbortController();
    network.fetch.mockResolvedValueOnce(responseError(401));
    let finishRefresh: ((value: AuthTokenInfo) => void) | undefined;
    const refresh = vi.fn(() => new Promise<AuthTokenInfo>((resolve) => { finishRefresh = resolve; }));
    const result = new OpenAICodexProvider(config).getAvailableModels(credential(), refresh, controller.signal);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    controller.abort();
    finishRefresh?.(credential('fresh-token', { revision: 2 }));
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(network.fetch).toHaveBeenCalledOnce();
  });

  it('keeps network and JSON errors visible instead of returning static models', async () => {
    network.fetch.mockRejectedValueOnce(new TypeError('offline'));
    await expect(new OpenAICodexProvider(config).getAvailableModels(credential())).rejects.toThrow('offline');
    network.fetch.mockResolvedValueOnce(new Response('invalid JSON'));
    await expect(new OpenAICodexProvider(config).getAvailableModels(credential())).rejects.toBeInstanceOf(SyntaxError);
  });
});

describe('Codex discovery and request integration', () => {
  it('keeps API-key discovery on its configured endpoint', async () => {
    network.fetch.mockResolvedValueOnce(Response.json({
      object: 'list', data: [{ id: 'proxy-only', object: 'model', created: 0, owned_by: 'proxy' }],
    }));
    const provider = new OpenAICodexProvider({
      ...config, baseUrl: 'https://proxy.example/v1', auth: { method: 'api-key' },
    });
    expect(await provider.getAvailableModels({ kind: 'token', token: 'proxy-key' })).toEqual([{ id: 'proxy-only' }]);
    expect(network.fetch).toHaveBeenCalledOnce();
    expect(network.fetch.mock.calls[0][0].toString()).toBe('https://proxy.example/v1/models');
    expect(new Headers(network.fetch.mock.calls[0][1]?.headers).has('chatgpt-account-id')).toBe(false);
  });

  it('preserves a discovered max preset in the actual Codex request and leaves output limits to the backend', async () => {
    let sent: unknown;
    let generationAgent: string | null = null;
    network.fetch.mockImplementation(async (_input, init) => {
      if (init?.method === 'GET') return catalog();
      if (typeof init?.body !== 'string') throw new Error('Expected JSON request');
      generationAgent = new Headers(init.headers).get('user-agent');
      sent = JSON.parse(init.body);
      return Response.json({ error: { message: 'request-captured' } }, { status: 400 });
    });
    const provider = new OpenAICodexProvider(config);
    const [raw] = await provider.getAvailableModels(credential());
    const model = applyPresetTemplateSelections(mergeWithWellKnownModel(raw, config), { reasoningEffort: 'max' });
    await expect(async () => {
      for await (const part of provider.streamChat(
        model.id, { ...model, stream: false }, [{
          role: vscode.LanguageModelChatMessageRole.User, name: undefined,
          content: [new vscode.LanguageModelTextPart('hello')],
        }], { requestInitiator: 'test', toolMode: vscode.LanguageModelChatToolMode.Auto },
        { performance: { tts: Date.now(), ttf: 0, ttft: 0, tps: 0, tl: 0 } },
        { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) },
        new RequestLogger('catalog-request'), credential(),
      )) { void part; }
    }).rejects.toThrow('request-captured');
    expect(sent).toMatchObject({ model: 'account-specific-model', reasoning: { effort: 'max' }, store: false });
    expect(generationAgent).toContain('codex-tui/0.135.0');
    expect(generationAgent).not.toContain('0.167.0');
    expect(sent).not.toHaveProperty('max_output_tokens');
    expect(sent).not.toHaveProperty('max_completion_tokens');
  });
});
