import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  env: { language: 'en' },
  l10n: {
    t: (message: string | { message: string }) =>
      typeof message === 'string' ? message : message.message,
  },
  EventEmitter: class {
    readonly event = () => ({ dispose: () => undefined });
    fire(): void {}
    dispose(): void {}
  },
  ThemeIcon: class { constructor(readonly id: string) {} },
  extensions: { getExtension: () => undefined },
  workspace: {
    getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }),
  },
}));

import { FeatureId } from '../../src/client/definitions';
import { GoogleAIStudioProvider } from '../../src/client/google/ai-studio-client';
import { OpenAICodexProvider } from '../../src/client/openai/codex-client';
import { OpenAIResponsesProvider } from '../../src/client/openai/responses-client';
import { isFeatureSupported } from '../../src/client/utils';
import {
  applyPresetTemplateSelections,
  buildPresetTemplateConfigurationSchema,
} from '../../src/preset-templates';
import type { ModelConfig, ProviderConfig } from '../../src/types';
import { findBestMatchingWellKnownModel, mergeWithWellKnownModel } from '../../src/well-known/models';
import { resolveProviderModels, WELL_KNOWN_PROVIDERS } from '../../src/well-known/providers';

const openai: ProviderConfig = {
  name: 'OpenAI', type: 'openai-responses', baseUrl: 'https://api.openai.com/v1', models: [],
};
const gptIds = ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna'] as const;
const fullEfforts = ['max', 'xhigh', 'high', 'medium', 'low', 'none'];

function providerModel(providerName: string, id: string): ModelConfig {
  const provider = WELL_KNOWN_PROVIDERS.find((entry) => entry.name === providerName);
  if (!provider) throw new Error(`Missing provider: ${providerName}`);
  const model = resolveProviderModels(provider).find((entry) => entry.id === id);
  if (!model) throw new Error(`Missing model: ${providerName}/${id}`);
  return model;
}

function invoke(client: object, method: string, args: readonly unknown[]): unknown {
  const builder: unknown = Reflect.get(client, method);
  if (typeof builder !== 'function') throw new Error(`Missing builder: ${method}`);
  return Reflect.apply(builder, client, args);
}

describe('model catalog budgets and identity', () => {
  it.each([
    ['gpt-6.1-sol', 922000, 128000, 'medium'],
    ['gpt-6.1-terra', 922000, 128000, 'medium'],
    ['gpt-6-sol', 922000, 128000, 'medium'],
    ['gpt-6-luna', 922000, 128000, 'medium'],
    ['claude-opus-5-5', 872000, 128000, 'medium'],
    ['claude-sonnet-5-5', 872000, 128000, 'high'],
    ['claude-haiku-5-5', 872000, 128000, 'medium'],
    ['MiniMax-M3.1-Flash', 868928, 131072, 'max'],
    ['kimi-k3.1-pro', 917504, 131072, 'max'],
    ['kimi-k3.1-pro-highspeed', 917504, 131072, 'max'],
    ['k3-256k', 131072, 131072, 'high'],
    ['gemini-4-argon', 983040, 65536, 'medium'],
  ] as const)('reserves output space for %s', (id, input, output, effort) => {
    expect(findBestMatchingWellKnownModel(`${id}#custom`)?.id).toBe(id);
    expect(mergeWithWellKnownModel({ id })).toMatchObject({
      id, maxInputTokens: input, maxOutputTokens: output, thinking: { effort },
      capabilities: { toolCalling: true, imageInput: true },
    });
  });

  it('reserves the full DeepSeek output budget inside a conservative decimal 1M window', () => {
    for (const id of ['deepseek-flash', 'deepseek-v4.1-flash', 'deepseek-ai/DeepSeek-V4.1-Flash']) {
      const model = mergeWithWellKnownModel({ id });
      expect(model).toMatchObject({ maxInputTokens: 606784, maxOutputTokens: 393216 });
      expect((model.maxInputTokens ?? 0) + (model.maxOutputTokens ?? 0)).toBe(1000000);
    }
  });

  it.each(['MiniMax (China)', 'MiniMax (International)'])(
    'uses the stable MiniMax wire ID for %s', (provider) => {
      expect(providerModel(provider, 'MiniMax-M3.1-Flash')).toMatchObject({
        id: 'MiniMax-M3.1-Flash', maxInputTokens: 868928, maxOutputTokens: 131072,
      });
    },
  );

  it.each(['k3.1-pro', 'k3.1-pro-highspeed', 'k3-256k'])(
    'preserves K3 protocol identity and a baseline Coding Plan budget for %s', (id) => {
      const model = providerModel('Moonshot AI (Coding Plan)', id);
      expect(model).toMatchObject({
        id, family: expect.stringContaining('kimi-k3'),
        maxInputTokens: 131072, maxOutputTokens: 131072, thinking: { effort: 'high' },
      });
      expect((model.maxInputTokens ?? 0) + (model.maxOutputTokens ?? 0)).toBe(262144);
    },
  );
});

describe('Kimi Coding endpoint compatibility', () => {
  const cases = ['api.kimi.com', 'api.kimi.ai'].flatMap((host) =>
    ['/coding', '/coding/', '/coding/v1', '/coding/v1/'].flatMap((path) =>
      ['kimi-k3.1-pro', 'k3.1-pro', 'kimi-k3.1-pro-highspeed', 'k3.1-pro-highspeed']
        .map((id) => ({ baseUrl: `https://${host}${path}`, id })),
    ),
  );
  it.each(cases)('applies the Coding budget for $id on $baseUrl', ({ baseUrl, id }) => {
    const provider: ProviderConfig = {
      name: 'Kimi Coding', type: 'openai-chat-completion', baseUrl, models: [],
    };
    const model = mergeWithWellKnownModel({ id }, provider);
    expect(model).toMatchObject({
      id, family: expect.stringContaining('kimi-k3.1'),
      maxInputTokens: 131072, maxOutputTokens: 131072,
    });
    expect(applyPresetTemplateSelections(model, undefined).thinking?.effort).toBe('high');
  });

  it.each([
    'https://api.kimi.com/coding-extra',
    'https://api.kimi.ai/coding/v2',
    'https://api.kimi.ai.example.test/coding/v1',
  ])('keeps the public configuration outside Coding endpoints: %s', (baseUrl) => {
    const provider: ProviderConfig = {
      name: 'Kimi', type: 'openai-chat-completion', baseUrl, models: [],
    };
    expect(mergeWithWellKnownModel({ id: 'kimi-k3.1-pro' }, provider)).toMatchObject({
      id: 'kimi-k3.1-pro', maxInputTokens: 917504, thinking: { effort: 'max' },
    });
  });
});

describe('GPT model request compatibility', () => {
  it.each(gptIds)('preserves supported efforts and tool declarations for %s', (id) => {
    const model = providerModel('Open AI', id);
    expect(model.capabilities?.toolCalling).toBe(true);
    expect(buildPresetTemplateConfigurationSchema(model)?.properties?.['reasoningEffort'])
      .toMatchObject({ enum: id === 'gpt-6.1-sol' ? fullEfforts.slice(0, -1) : fullEfforts, default: 'medium' });
    const configured = applyPresetTemplateSelections(model, { reasoningEffort: 'max' });
    expect(invoke(new OpenAIResponsesProvider(openai), 'buildReasoningParams', [configured, false]))
      .toEqual({ reasoning: { effort: 'max', mode: 'standard', context: 'auto' } });

    const chat = { ...openai, type: 'openai-chat-completion' as const };
    const chatModel = mergeWithWellKnownModel({ id }, chat);
    expect(chatModel.capabilities?.toolCalling).toBe(false);
    expect(isFeatureSupported(FeatureId.OpenAIOnlyMaxCompletionTokens, chat, chatModel)).toBe(true);
    if (id !== 'gpt-6.1-sol') {
      expect(applyPresetTemplateSelections(chatModel, { reasoningEffort: 'none' }).capabilities?.toolCalling)
        .toBe(false);
    }
    expect(mergeWithWellKnownModel({ id }, { ...chat, baseUrl: 'https://gateway.example/v1' })
      .capabilities?.toolCalling).toBe(true);
  });

  it.each([
    { id: 'gpt-6.1-sol#custom', expected: 'max' },
    { id: 'deployment', family: 'gpt-6.1-terra', expected: 'max' },
    { id: 'gpt-6-sol-2026-10-01', expected: 'max' },
    { id: 'gpt-6-luna', expected: 'max' },
    { id: 'gpt-6.1-terrarium', expected: 'xhigh' },
    { id: 'gpt-6-solstice', expected: 'xhigh' },
    { id: 'gpt-5.4', expected: 'xhigh' },
  ])('bounds max effort support for $id', ({ id, family, expected }) => {
    expect(invoke(new OpenAIResponsesProvider(openai), 'buildReasoningParams', [{
      id, family, thinking: { type: 'enabled', effort: 'max' },
    }, false])).toEqual({ reasoning: { effort: expected } });
  });

  it('keeps OAuth prompt and output policy when catalog metadata is merged', async () => {
    const codex: ProviderConfig = {
      ...openai, type: 'openai-codex', auth: { method: 'openai-codex', bindingId: 'catalog-test' },
    };
    const models = await new OpenAICodexProvider(codex).getAvailableModels({ kind: 'none' });
    for (const id of gptIds) {
      const raw = models.find((model) => model.id === id);
      if (!raw) throw new Error(`Missing Codex model: ${id}`);
      expect(Object.hasOwn(raw, 'maxOutputTokens')).toBe(true);
      expect(mergeWithWellKnownModel(raw, codex)).toMatchObject({
        id, maxInputTokens: 272000, maxOutputTokens: undefined,
      });
    }
  });
});

describe('Claude and MiniMax thinking compatibility', () => {
  const anthropic: ProviderConfig = {
    ...openai, type: 'anthropic', baseUrl: 'https://api.anthropic.com',
  };
  it.each(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'MiniMax-M3.1-Flash'])(
    'preserves all five effort levels for %s', (id) => {
      const model = mergeWithWellKnownModel({ id });
      expect(buildPresetTemplateConfigurationSchema(model)?.properties?.['reasoningEffort'])
        .toMatchObject({ enum: fullEfforts.slice(0, -1) });
      expect(isFeatureSupported(FeatureId.AnthropicXHighEffort, anthropic, model)).toBe(true);
      expect(isFeatureSupported(FeatureId.AnthropicAlwaysOnAdaptiveThinking, anthropic, model))
        .toBe(id !== 'claude-haiku-5-5');
    },
  );

  it.each([
    { id: 'claude-opus-5', expected: true },
    { id: 'claude-opus-5-20260901#thinking', expected: true },
    { id: 'deployment', family: 'claude-opus-5', expected: true },
    { id: 'claude-opus-5-5', expected: false },
    { id: 'claude-opus-5.5', expected: false },
    { id: 'deployment', family: 'claude-opus-5-5', expected: false },
  ])('bounds the legacy tool-change beta for $id', ({ id, family, expected }) => {
    expect(isFeatureSupported(FeatureId.AnthropicMidConversationToolChanges, anthropic, { id, family }))
      .toBe(expected);
  });
});

describe('Gemini Argon platform limits', () => {
  it.each(['high', 'medium', 'low'])(
    'uses thinkingLevel for the %s preset', (effort) => {
      const model = applyPresetTemplateSelections(
        providerModel('Google AI Studio', 'gemini-4-argon'), { reasoningEffort: effort },
      );
      const google: ProviderConfig = {
        name: 'Google', type: 'google-ai-studio', baseUrl: 'https://generativelanguage.googleapis.com', models: [],
      };
      expect(isFeatureSupported(FeatureId.GeminiUseThinkingLevel, google, model)).toBe(true);
      expect(isFeatureSupported(FeatureId.GeminiUseThinkingLevel, google, { id: 'models/gemini-4-argon#custom' }))
        .toBe(true);
      expect(isFeatureSupported(FeatureId.GeminiUseThinkingLevel, google, { id: 'gemini-4-other' })).toBe(false);
      expect(isFeatureSupported(FeatureId.GeminiUseThinkingLevel, google, { id: 'gemini-2.5-flash' })).toBe(false);
      expect(invoke(new GoogleAIStudioProvider(google), 'buildThinkingConfig', [model, true])).toEqual({
        thinkingConfig: { includeThoughts: true, thinkingLevel: effort.toUpperCase() },
      });
    },
  );

  it('keeps the Vertex output budget valid for both streaming and non-streaming requests', () => {
    const studio = providerModel('Google AI Studio', 'gemini-4-argon');
    const vertex = providerModel('Google Vertex AI', 'gemini-4-argon');
    expect(studio).toMatchObject({ maxInputTokens: 983040, maxOutputTokens: 65536 });
    expect(vertex).toMatchObject({ maxInputTokens: 983040, maxOutputTokens: 32768 });
    expect(findBestMatchingWellKnownModel('models/gemini-4-argon')?.id).toBe('gemini-4-argon');
    expect(buildPresetTemplateConfigurationSchema(studio)?.properties?.['reasoningEffort'])
      .toMatchObject({ enum: ['high', 'medium', 'low'], default: 'medium' });
  });
});
