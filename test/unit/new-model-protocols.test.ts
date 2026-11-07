import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const network = vi.hoisted(() => ({
  fetch: vi.fn<typeof fetch>(),
  requests: new Array<Request>(),
}));

vi.mock('vscode', () => {
  class LanguageModelTextPart {
    constructor(readonly value: string) {}
  }
  class LanguageModelThinkingPart {
    constructor(readonly value: string | readonly string[]) {}
  }
  class LanguageModelToolCallPart {
    constructor(readonly callId: string, readonly name: string, readonly input: object) {}
  }
  class LanguageModelToolResultPart {
    constructor(readonly callId: string, readonly content: unknown[]) {}
  }
  return {
    LanguageModelTextPart,
    LanguageModelThinkingPart,
    LanguageModelToolCallPart,
    LanguageModelToolResultPart,
    LanguageModelToolResultPart2: class extends LanguageModelToolResultPart {},
    LanguageModelDataPart: class {
      constructor(readonly data: Uint8Array, readonly mimeType: string) {}
    },
    LanguageModelChatMessageRole: { System: 1, User: 2, Assistant: 3 },
    LanguageModelChatToolMode: { Auto: 1, Required: 2 },
    EventEmitter: class {
      readonly event = () => ({ dispose: () => undefined });
      fire(): void {}
      dispose(): void {}
    },
    ThemeIcon: class { constructor(readonly id: string) {} },
    env: { language: 'en' },
    l10n: { t: (message: string) => message },
    extensions: { getExtension: () => undefined },
    workspace: {
      getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }),
    },
  };
});

vi.mock('../../src/logger', () => {
  class RequestLogger {
    error(): void {}
    verbose(): void {}
    providerRequest(): void {}
    providerResponseChunk(): void {}
    providerResponseMeta(): void {}
  }
  return { RequestLogger };
});

vi.mock('../../src/client/utils', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/client/utils')>(),
  createCustomFetch: () => network.fetch,
}));

vi.mock('../../src/utils', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/utils')>(),
  // Exercise reconstruction from VS Code parts without raw-message restoration.
  sanitizeMessagesForModelSwitch: (
    messages: readonly import('vscode').LanguageModelChatRequestMessage[],
  ) => [...messages],
}));

import * as vscode from 'vscode';
import { PROVIDER_TYPES } from '../../src/client/definitions';
import { RequestLogger } from '../../src/logger';
import { applyPresetTemplateSelections } from '../../src/preset-templates';
import type { ModelConfig, ProviderConfig } from '../../src/types';
import { mergeWithWellKnownModel } from '../../src/well-known/models';

const STOP = 'request-captured';
const history: vscode.LanguageModelChatRequestMessage[] = [
  {
    role: vscode.LanguageModelChatMessageRole.User,
    name: undefined,
    content: [new vscode.LanguageModelTextPart('Calculate the answer.')],
  },
  {
    role: vscode.LanguageModelChatMessageRole.Assistant,
    name: undefined,
    content: [
      new vscode.LanguageModelThinkingPart('I need to use the calculator.'),
      new vscode.LanguageModelToolCallPart('call-1', 'calculate', {}),
    ],
  },
  {
    role: vscode.LanguageModelChatMessageRole.User,
    name: undefined,
    content: [
      new vscode.LanguageModelToolResultPart('call-1', [new vscode.LanguageModelTextPart('42')]),
    ],
  },
];

beforeEach(() => {
  network.requests.length = 0;
  network.fetch.mockImplementation(async (input, init) => {
    network.requests.push(new Request(input, init));
    return new Response(JSON.stringify({ error: { message: STOP } }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', network.fetch);
});

afterEach(() => vi.unstubAllGlobals());

async function requestBody(
  baseUrl: string,
  model: ModelConfig,
  type: ProviderConfig['type'] = 'openai-chat-completion',
  messages: readonly vscode.LanguageModelChatRequestMessage[] = history,
): Promise<unknown> {
  const config: ProviderConfig = {
    name: 'New model protocol test', type, baseUrl, models: [],
    proxy: { type: 'direct' }, retry: { maxRetries: 0 },
  };
  const provider = new PROVIDER_TYPES[type].class(config);
  const send = async () => {
    for await (const part of provider.streamChat(
      model.id,
      { ...model, stream: false },
      messages,
      { requestInitiator: 'test', toolMode: vscode.LanguageModelChatToolMode.Auto },
      { performance: { tts: Date.now(), ttf: 0, ttft: 0, tps: 0, tl: 0 } },
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) },
      new RequestLogger('new-model-protocol-test'),
      { kind: 'token', token: 'test-key' },
    )) { void part; }
  };
  await expect(send()).rejects.toThrow(STOP);
  expect(network.requests).toHaveLength(1);
  const body: unknown = await network.requests[0].json();
  return body;
}

describe('New model request protocols', () => {
  it.each(['cn', 'sgp', 'ams'])(
    'preserves MiMo thinking and tool-call reasoning on the %s Token Plan',
    async (region) => {
      const body = await requestBody(
        `https://token-plan-${region}.xiaomimimo.com/v1`,
        mergeWithWellKnownModel({ id: 'mimo-v2.6-pro' }),
      );
      expect(body).toMatchObject({
        thinking: { type: 'enabled' },
        max_completion_tokens: 128000,
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'assistant',
            reasoning_content: 'I need to use the calculator.',
          }),
        ]),
      });
      expect(body).not.toHaveProperty('reasoning_effort');
    },
  );

  it.each(['high', 'none'] as const)('sends supported Hy4 %s parameters', async (effort) => {
    const model = applyPresetTemplateSelections(
      mergeWithWellKnownModel({ id: 'hy4-preview' }),
      { reasoningEffort: effort },
    );
    const body = await requestBody('https://tokenhub.tencentmaas.com', model);
    expect(body).toMatchObject({
      thinking: { type: effort === 'none' ? 'disabled' : 'enabled' },
    });
    if (effort === 'none') {
      expect(body).not.toHaveProperty('reasoning_effort');
    } else {
      expect(body).toHaveProperty('reasoning_effort', 'high');
    }
  });

  it('preserves Kimi K2.8 reasoning on the overseas Coding API', async () => {
    const body = await requestBody(
      'https://api.kimi.ai/coding/v1',
      mergeWithWellKnownModel({ id: 'kimi-for-coding' }),
    );
    expect(body).toMatchObject({
      model: 'kimi-for-coding',
      reasoning_effort: 'max',
      max_completion_tokens: 131072,
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          reasoning_content: 'I need to use the calculator.',
        }),
      ]),
    });
  });

  it('sends Fable 5.1 xhigh without converting it to max', async () => {
    const model = applyPresetTemplateSelections(
      mergeWithWellKnownModel({ id: 'claude-fable-5-1' }),
      { reasoningEffort: 'xhigh' },
    );
    const body = await requestBody('https://api.anthropic.com', model, 'anthropic');
    expect(body).toMatchObject({ output_config: { effort: 'xhigh' } });
  });
});

describe('Catalog model request serialization', () => {
  const gptIds = ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna'];
  const openaiCases = gptIds.flatMap((id) => [
    { id, type: 'openai-responses' as const },
    { id, type: 'openai-chat-completion' as const },
  ]);

  it.each(openaiCases)('preserves max effort for $id over $type', async ({ id, type }) => {
    const model = applyPresetTemplateSelections(mergeWithWellKnownModel({ id }), {
      reasoningEffort: 'max',
    });
    const body = await requestBody('https://api.openai.com/v1', model, type);
    expect(body).toMatchObject(type === 'openai-responses'
      ? { model: id, reasoning: { effort: 'max' }, max_output_tokens: 128000 }
      : { model: id, reasoning_effort: 'max', max_completion_tokens: 128000 });
    expect(body).not.toHaveProperty('max_tokens');
  });

  it.each(openaiCases.filter(({ id }) => id !== 'gpt-6.1-sol'))(
    'serializes the none preset for $id over $type', async ({ id, type }) => {
      const model = applyPresetTemplateSelections(mergeWithWellKnownModel({ id }), {
        reasoningEffort: 'none',
      });
      const body = await requestBody('https://api.openai.com/v1', model, type);
      expect(body).toMatchObject(type === 'openai-responses'
        ? { reasoning: { effort: 'none' } }
        : { reasoning_effort: 'none' });
    },
  );

  const claudeCases = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']
    .flatMap((id) => ['low', 'medium', 'high', 'xhigh', 'max'].map((effort) => ({ id, effort })));
  it.each(claudeCases)('sends adaptive $effort for $id', async ({ id, effort }) => {
    const model = applyPresetTemplateSelections(mergeWithWellKnownModel({ id }), {
      reasoningEffort: effort,
    });
    const body = await requestBody('https://api.anthropic.com', model, 'anthropic');
    expect(body).toMatchObject({
      model: id, max_tokens: 128000,
      thinking: { type: 'adaptive' }, output_config: { effort },
    });
    const betas = network.requests[0]?.headers.get('anthropic-beta') ?? '';
    expect(betas).not.toContain('context-1m-2025-08-07');
    expect(betas).not.toContain('mid-conversation-tool-changes-2026-07-01');
    expect(betas).not.toContain('interleaved-thinking-2025-05-14');
  });

  it.each(['https://api.minimaxi.com/anthropic', 'https://api.minimax.io/anthropic']
    .flatMap((baseUrl) => ['xhigh', 'max'].map((effort) => ({ baseUrl, effort }))))(
    'sends stable MiniMax $effort on $baseUrl', async ({ baseUrl, effort }) => {
      const model = applyPresetTemplateSelections(mergeWithWellKnownModel({
        id: 'MiniMax-M3.1-Flash',
      }), { reasoningEffort: effort });
      const body = await requestBody(baseUrl, model, 'anthropic');
      expect(body).toMatchObject({
        model: 'MiniMax-M3.1-Flash', max_tokens: 131072,
        output_config: { effort },
      });
      // M3.1 Flash enables adaptive thinking by default when this field is omitted.
      expect(body).not.toHaveProperty('thinking');
    },
  );

  it.each(
    ['api.kimi.com', 'api.kimi.ai'].flatMap((host) =>
      ['/coding', '/coding/', '/coding/v1', '/coding/v1/'].flatMap((path) =>
        ['k3.1-pro', 'k3.1-pro-highspeed', 'k3-256k']
          .map((id) => ({ baseUrl: `https://${host}${path}`, id })),
      ),
    ),
  )(
    'preserves K3 effort and wire ID for $id on $baseUrl', async ({ baseUrl, id }) => {
      const provider: ProviderConfig = {
        name: 'Kimi Coding', type: 'openai-chat-completion', baseUrl, models: [],
      };
      const model = applyPresetTemplateSelections(mergeWithWellKnownModel({ id }, provider), {
        reasoningEffort: 'low',
      });
      const body = await requestBody(baseUrl, model);
      expect(body).toMatchObject({ model: id, reasoning_effort: 'low', max_completion_tokens: 131072 });
      expect(body).not.toHaveProperty('thinking');
      expect(new URL(network.requests[0].url).pathname).toBe('/coding/v1/chat/completions');
    },
  );

  it.each(['https://api.moonshot.cn', 'https://api.moonshot.ai']
    .flatMap((baseUrl) => ['kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed']
      .map((id) => ({ baseUrl, id }))))(
    'sends the public Kimi default effort for $id on $baseUrl', async ({ baseUrl, id }) => {
      const model = mergeWithWellKnownModel({ id });
      expect(await requestBody(baseUrl, model)).toMatchObject({
        model: id, reasoning_effort: 'max', max_completion_tokens: 131072,
      });
    },
  );

  it.each(['high', 'medium', 'low'])(
    'serializes Gemini Argon thinkingLevel $effort', async (effort) => {
      const model = applyPresetTemplateSelections(mergeWithWellKnownModel({ id: 'gemini-4-argon' }), {
        reasoningEffort: effort,
      });
      const body = await requestBody(
        'https://generativelanguage.googleapis.com', model, 'google-ai-studio', history.slice(0, 1),
      );
      expect(body).toMatchObject({
        generationConfig: {
          maxOutputTokens: 65536,
          thinkingConfig: { includeThoughts: true, thinkingLevel: effort.toUpperCase() },
        },
      });
      expect(body).not.toHaveProperty('generationConfig.thinkingConfig.thinkingBudget');
    },
  );
});
