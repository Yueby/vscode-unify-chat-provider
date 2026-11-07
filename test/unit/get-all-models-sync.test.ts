import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OfficialModelsFetchState } from '../../src/official-models-manager';
import type { ModelConfig, ProviderConfig } from '../../src/types';

const mocks = vi.hoisted(() => ({
  getProviderState: vi.fn<(providerName: string) => OfficialModelsFetchState | undefined>(),
  triggerBackgroundFetch: vi.fn<(provider: ProviderConfig) => void>(),
}));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({ get: () => undefined }),
  },
}));

vi.mock('../../src/i18n', () => ({
  t: (message: string, ...args: readonly unknown[]) =>
    message.replace(/\{(\d+)\}/g, (placeholder, index: string) => {
      const value = args[Number(index)];
      return value === undefined ? placeholder : String(value);
    }),
}));

vi.mock('../../src/official-models-manager', () => ({
  officialModelsManager: {
    getProviderState: mocks.getProviderState,
    triggerBackgroundFetch: mocks.triggerBackgroundFetch,
  },
}));

import {
  getAllModelsForProviderSync,
  PLACEHOLDER_MODEL_ID,
} from '../../src/utils';

function createProvider(overrides?: Partial<ProviderConfig>): ProviderConfig {
  return {
    type: 'openai-chat-completion',
    name: 'test-provider',
    baseUrl: 'https://api.example.com',
    models: [],
    autoFetchOfficialModels: true,
    ...overrides,
  };
}

function createFetchState(
  overrides?: Partial<OfficialModelsFetchState>,
): OfficialModelsFetchState {
  return {
    lastFetchTime: 0,
    lastAttemptTime: 0,
    models: [],
    modelsHash: '',
    consecutiveIdenticalFetches: 0,
    currentIntervalMs: 60000,
    ...overrides,
  };
}

describe('getAllModelsForProviderSync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('1. autoFetch is disabled: returns user models immediately and does not query manager or trigger background fetch', () => {
    const userModel: ModelConfig = { id: 'custom-model', name: 'Custom Model' };
    const provider = createProvider({
      autoFetchOfficialModels: false,
      models: [userModel],
    });

    const result = getAllModelsForProviderSync(provider);

    expect(result).toEqual([userModel]);
    expect(mocks.getProviderState).not.toHaveBeenCalled();
    expect(mocks.triggerBackgroundFetch).not.toHaveBeenCalled();
  });

  it('2. Unfetched (state undefined): returns placeholder model and triggers background fetch once', () => {
    mocks.getProviderState.mockReturnValue(undefined);
    const provider = createProvider();

    const result = getAllModelsForProviderSync(provider);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(PLACEHOLDER_MODEL_ID);
    expect(mocks.getProviderState).toHaveBeenCalledWith('test-provider');
    expect(mocks.triggerBackgroundFetch).toHaveBeenCalledTimes(1);
    expect(mocks.triggerBackgroundFetch).toHaveBeenCalledWith(provider);
  });

  it('3. Initial fetch in progress (never completed): returns placeholder model and triggers background fetch', () => {
    mocks.getProviderState.mockReturnValue(
      createFetchState({
        isFetching: true,
        lastFetchTime: 0,
        lastAttemptTime: 0,
        models: [],
      }),
    );
    const provider = createProvider();

    const result = getAllModelsForProviderSync(provider);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(PLACEHOLDER_MODEL_ID);
    expect(mocks.triggerBackgroundFetch).toHaveBeenCalledTimes(1);
  });

  it('4. Successful empty: initial fetch completed with 0 models, returns empty list without fake model', () => {
    mocks.getProviderState.mockReturnValue(
      createFetchState({
        lastFetchTime: 1700000000000,
        models: [],
        isFetching: false,
      }),
    );
    const provider = createProvider();

    const result = getAllModelsForProviderSync(provider);

    expect(result).toEqual([]);
    expect(mocks.triggerBackgroundFetch).toHaveBeenCalledTimes(1);
  });

  it('5. Failed empty: fetch completed with error, returns empty list without fake model', () => {
    mocks.getProviderState.mockReturnValue(
      createFetchState({
        lastFetchTime: 0,
        lastError: 'Unauthorized 401',
        lastErrorTime: 1700000000000,
        models: [],
      }),
    );
    const provider = createProvider();

    const result = getAllModelsForProviderSync(provider);

    expect(result).toEqual([]);
    expect(mocks.triggerBackgroundFetch).toHaveBeenCalledTimes(1);
  });

  it('6. Background refresh with previously successful empty: keeps empty result and does not flash placeholder', () => {
    mocks.getProviderState.mockReturnValue(
      createFetchState({
        lastFetchTime: 1700000000000,
        models: [],
        isFetching: true,
      }),
    );
    const provider = createProvider();

    const result = getAllModelsForProviderSync(provider);

    expect(result).toEqual([]);
    expect(mocks.triggerBackgroundFetch).toHaveBeenCalledTimes(1);
  });

  it('7. Successful non-empty: returns cached official models', () => {
    const officialModel: ModelConfig = {
      id: 'gpt-4o',
      name: 'GPT-4o',
    };
    mocks.getProviderState.mockReturnValue(
      createFetchState({
        lastFetchTime: 1700000000000,
        models: [officialModel],
      }),
    );
    const provider = createProvider();

    const result = getAllModelsForProviderSync(provider);

    expect(result).toEqual([officialModel]);
    expect(mocks.triggerBackgroundFetch).toHaveBeenCalledTimes(1);
  });

  it('8. User model priority: user models are preserved and deduplicate conflicting official models', () => {
    const userModel1: ModelConfig = { id: 'custom-gpt', name: 'My Custom GPT' };
    const userModel2: ModelConfig = { id: 'gpt-4o', name: 'User Overridden 4o' };
    const officialModel1: ModelConfig = { id: 'gpt-4o', name: 'Official 4o' };
    const officialModel2: ModelConfig = { id: 'claude-3-5', name: 'Official Claude' };

    mocks.getProviderState.mockReturnValue(
      createFetchState({
        lastFetchTime: 1700000000000,
        models: [officialModel1, officialModel2],
      }),
    );
    const provider = createProvider({
      models: [userModel1, userModel2],
    });

    const result = getAllModelsForProviderSync(provider);

    expect(result).toEqual([userModel1, userModel2, officialModel2]);
    expect(mocks.triggerBackgroundFetch).toHaveBeenCalledTimes(1);
  });

  it('9. Initial 0 timestamp case: state exists with all timestamps at 0 and no error (unfetched), returns placeholder', () => {
    mocks.getProviderState.mockReturnValue(
      createFetchState({
        lastFetchTime: 0,
        lastAttemptTime: 0,
        lastErrorTime: 0,
        lastError: undefined,
        models: [],
      }),
    );
    const provider = createProvider();

    const result = getAllModelsForProviderSync(provider);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(PLACEHOLDER_MODEL_ID);
    expect(mocks.triggerBackgroundFetch).toHaveBeenCalledTimes(1);
  });
});
