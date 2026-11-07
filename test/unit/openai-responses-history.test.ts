import OpenAI from 'openai';
import * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelConfig, ProviderConfig } from '../../src/types';

vi.mock('vscode', () => {
  class LanguageModelTextPart {
    constructor(readonly value: string) {}
  }

  class LanguageModelThinkingPart {
    constructor(
      readonly value: string | string[],
      readonly id?: string,
      readonly metadata?: object,
    ) {}
  }

  class LanguageModelToolCallPart {
    constructor(
      readonly callId: string,
      readonly name: string,
      readonly input: object,
    ) {}
  }

  class LanguageModelToolResultPart {
    constructor(
      readonly callId: string,
      readonly content: unknown[],
    ) {}
  }

  class LanguageModelToolResultPart2 {
    constructor(
      readonly callId: string,
      readonly content: unknown[],
    ) {}
  }

  class LanguageModelDataPart {
    constructor(
      readonly data: Uint8Array,
      readonly mimeType: string,
    ) {}
  }

  return {
    LanguageModelTextPart,
    LanguageModelThinkingPart,
    LanguageModelToolCallPart,
    LanguageModelToolResultPart,
    LanguageModelToolResultPart2,
    LanguageModelDataPart,
    LanguageModelChatMessageRole: { System: 1, User: 2, Assistant: 3 },
    LanguageModelChatToolMode: { Auto: 1, Required: 2 },
    extensions: { getExtension: () => undefined },
    workspace: {
      getConfiguration: () => ({
        get: (_key: string, fallback: unknown) => fallback,
      }),
    },
  };
});

vi.mock('../../src/i18n', () => ({ t: (message: string) => message }));
vi.mock('../../src/official-models-manager', () => ({
  officialModelsManager: {},
}));
vi.mock('../../src/client/definitions', () => ({
  FeatureId: { OpenAIUsePreviousResponseId: 'previous_response_id' },
  FEATURES: { previous_response_id: { customCheckers: [() => true] } },
  PROVIDER_TYPES: {},
}));
vi.mock('../../src/logger', () => {
  class RequestLogger {
    constructor(readonly requestId: string) {}
    providerResponseChunk(): void {}
    verbose(): void {}
    usage(): void {}
  }
  return {
    RequestLogger,
    createSimpleHttpLogger: () => undefined,
    authLog: { warn: () => undefined },
  };
});

import { RequestLogger } from '../../src/logger';
import { createStatefulMarkerIdentity } from '../../src/utils';
import { OpenAIResponsesProvider } from '../../src/client/openai/responses-client';
import { webSocketSessionManager } from '../../src/client/websocket-session-manager';

afterEach(() => vi.restoreAllMocks());

const config: ProviderConfig = {
  type: 'openai-responses',
  name: 'history-test',
  baseUrl: 'https://api.z.ai/api/v1',
  models: [],
};
const model: ModelConfig = { id: 'test-model', stream: false };
const modelId = 'history-test/test-model';

function completedResponse() {
  return {
    id: 'resp-test',
    status: 'completed',
    output: [{
      id: 'msg-test', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'done', annotations: [] }],
    }],
    usage: null,
  };
}

class HistoryTestProvider extends OpenAIResponsesProvider {
  readonly requests: unknown[] = [];

  constructor(configuration: ProviderConfig, private readonly rejectContinuation = false) {
    super(configuration);
  }

  protected override createClient(): OpenAI {
    return new OpenAI({
      apiKey: 'test',
      baseURL: this.baseUrl,
      maxRetries: 0,
      fetch: async (_input, init) => {
        if (typeof init?.body !== 'string') {
          throw new Error('Expected a serialized Responses request');
        }
        const body: unknown = JSON.parse(init.body);
        this.requests.push(body);
        if (this.rejectContinuation && typeof body === 'object' && body !== null &&
          'previous_response_id' in body) {
          return Response.json({ error: {
            code: 'previous_response_not_found', type: 'invalid_request_error',
            param: 'previous_response_id', message: 'Previous response not found',
          } }, { status: 400 });
        }
        if (typeof body === 'object' && body !== null && 'input' in body &&
          Array.isArray(body.input) && body.input.some((item: unknown) =>
            typeof item === 'object' && item !== null && 'type' in item &&
            item.type === 'reasoning' && 'status' in item,
          )) {
          return Response.json({ error: {
            code: 'unknown_parameter', type: 'invalid_request_error',
            param: 'input.status', message: 'Unknown parameter: reasoning status',
          } }, { status: 400 });
        }
        return Response.json(completedResponse());
      },
    });
  }
}

function message(
  role: vscode.LanguageModelChatMessageRole,
  ...content: vscode.LanguageModelChatRequestMessage['content']
): vscode.LanguageModelChatRequestMessage {
  return { role, content, name: undefined };
}

function toolRound(round: number): vscode.LanguageModelChatRequestMessage[] {
  const callId = `call-${round}`;
  return [
    message(
      vscode.LanguageModelChatMessageRole.Assistant,
      new vscode.LanguageModelThinkingPart('inspect the file', `rs_byok_${round}`),
    ),
    message(
      vscode.LanguageModelChatMessageRole.Assistant,
      new vscode.LanguageModelToolCallPart(callId, 'inspect', { path: 'file.ts' }),
    ),
    message(
      vscode.LanguageModelChatMessageRole.User,
      round % 2 === 0
        ? new vscode.LanguageModelToolResultPart(callId, [
            new vscode.LanguageModelTextPart(`result-${round}`),
          ])
        : new vscode.LanguageModelToolResultPart2(callId, [
            new vscode.LanguageModelTextPart(`result-${round}`),
          ]),
    ),
  ];
}

function expectedToolInput(round: number): object[] {
  return [
    {
      type: 'reasoning',
      id: `rs_byok_${round}`,
      summary: [],
      content: [{ type: 'reasoning_text', text: 'inspect the file' }],
    },
    {
      type: 'function_call',
      call_id: `call-${round}`,
      name: 'inspect',
      arguments: '{"path":"file.ts"}',
    },
    {
      type: 'function_call_output',
      call_id: `call-${round}`,
      output: `result-${round}`,
    },
  ];
}

function createMarker(
  identity = createStatefulMarkerIdentity(config, model),
  output: readonly object[] = [{
    type: 'message', role: 'assistant',
    content: [{ type: 'output_text', text: 'prior answer', annotations: [] }],
  }],
): vscode.LanguageModelDataPart {
  const envelope = {
    identity,
    data: {
      data: output,
      sessionId: 'trusted-session',
      responseId: 'resp-trusted',
    },
  };
  return new vscode.LanguageModelDataPart(
    Buffer.from(`${modelId}\\${Buffer.from(JSON.stringify(envelope)).toString('base64')}`),
    'stateful_marker',
  );
}

async function sendRequests(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  settings: {
    configuration?: ProviderConfig;
    requestModel?: ModelConfig;
    rejectContinuation?: boolean;
  } = {},
): Promise<unknown[]> {
  const provider = new HistoryTestProvider(settings.configuration ?? config, settings.rejectContinuation);
  const parts = [];
  for await (const part of provider.streamChat(
    modelId,
    settings.requestModel ?? model,
    messages,
    {
      requestInitiator: 'history-test',
      toolMode: vscode.LanguageModelChatToolMode.Auto,
    },
    { performance: { tts: Date.now(), ttf: 0, ttft: 0, tps: 0, tl: 0 } },
    {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose: () => undefined }),
    },
    new RequestLogger('history-test'),
    { kind: 'none' },
  )) {
    parts.push(part);
  }
  expect(parts).toContainEqual(new vscode.LanguageModelTextPart('done'));
  return provider.requests;
}

async function send(messages: readonly vscode.LanguageModelChatRequestMessage[]): Promise<unknown> {
  const requests = await sendRequests(messages);
  expect(requests).toHaveLength(1);
  return requests[0];
}

describe('Responses reasoning history compatibility', () => {
  it.each(['redactedData', 'encrypted_content', 'encrypted'])(
    'prefers %s ciphertext to visible thinking across tool rounds', async (key) => {
      const round = toolRound(0);
      round[0] = message(vscode.LanguageModelChatMessageRole.Assistant,
        new vscode.LanguageModelThinkingPart('visible summary', 'rs_encrypted', {
          [key]: 'opaque-reasoning', _completeThinking: 'display-only complete thought',
        }),
      );
      const request = await send([
        message(vscode.LanguageModelChatMessageRole.User, new vscode.LanguageModelTextPart('question')),
        ...round, ...toolRound(1),
      ]);
      expect(request).toMatchObject({ input: [
        { role: 'user', content: [{ type: 'input_text', text: 'question' }] },
        { type: 'reasoning', id: 'rs_encrypted', summary: [], encrypted_content: 'opaque-reasoning' },
        ...expectedToolInput(0).slice(1), ...expectedToolInput(1),
      ] });
      expect(JSON.stringify(request)).not.toContain('visible summary');
      expect(JSON.stringify(request)).not.toContain('display-only complete thought');
    },
  );

  it.each([
    { metadata: { redactedData: 'legacy', encrypted_content: 'wire', encrypted: 'short' }, expected: 'legacy' },
    { metadata: { redactedData: '', encrypted_content: 'wire', encrypted: 'short' }, expected: 'wire' },
    { metadata: { redactedData: 42, encrypted_content: 'wire' }, expected: 'wire' },
    { metadata: { redactedData: null, encrypted_content: false, encrypted: 'short' }, expected: 'short' },
  ])('uses the first nonempty ciphertext: $metadata', async ({ metadata, expected }) => {
    const request = await send([message(vscode.LanguageModelChatMessageRole.Assistant,
      new vscode.LanguageModelThinkingPart('summary', undefined, { ...metadata, signature: 'rs_signature' }),
    )]);
    expect(request).toMatchObject({ input: [{
      type: 'reasoning', id: 'rs_signature', summary: [], encrypted_content: expected,
    }] });
  });

  it.each([
    { value: 'visible thought', metadata: {}, expected: ['visible thought'] },
    { value: ['first', 'second'], metadata: { encrypted_content: '', encrypted: null }, expected: ['first', 'second'] },
    { value: 'summary', metadata: { _completeThinking: 'complete thought', encrypted: '' }, expected: ['complete thought'] },
    { value: ['first', 'second'], metadata: { _completeThinking: '' }, expected: ['first', 'second'] },
  ])('retains plaintext fallback: $value', async ({ value, metadata, expected }) => {
    expect(await send([message(vscode.LanguageModelChatMessageRole.Assistant,
      new vscode.LanguageModelThinkingPart(value, 'rs_plain', metadata),
    )])).toMatchObject({ input: [{
      type: 'reasoning', id: 'rs_plain', summary: [],
      content: expected.map((text) => ({ type: 'reasoning_text', text })),
    }] });
  });

  function trustedRound(identity: string, status: string) {
    const reasoning = {
      type: 'reasoning', id: 'rs_trusted', status,
      summary: [{ type: 'summary_text', text: 'summary' }],
      content: [{ type: 'reasoning_text', text: 'compatibility reasoning' }],
      encrypted_content: 'trusted-ciphertext', vendor_extension: { retained: true },
    };
    const assistant = {
      type: 'message', id: 'msg_prior', role: 'assistant', status: 'completed', phase: 'commentary',
      content: [{ type: 'output_text', text: 'prior answer', annotations: [] }],
    };
    const call = {
      type: 'function_call', id: 'fc_prior', call_id: 'call-prior', name: 'inspect',
      arguments: '{}', status: 'completed',
    };
    const expectedReasoning = { ...reasoning };
    Reflect.deleteProperty(expectedReasoning, 'status');
    return {
      messages: [
        message(vscode.LanguageModelChatMessageRole.User, new vscode.LanguageModelTextPart('earlier')),
        message(vscode.LanguageModelChatMessageRole.Assistant, createMarker(identity, [reasoning, assistant, call])),
        message(vscode.LanguageModelChatMessageRole.User,
          new vscode.LanguageModelToolResultPart('call-prior', [new vscode.LanguageModelTextPart('prior result')]),
        ),
        message(vscode.LanguageModelChatMessageRole.User, new vscode.LanguageModelTextPart('continue')),
        ...toolRound(0),
      ],
      fullInput: [
        { role: 'user', content: [{ type: 'input_text', text: 'earlier' }] },
        expectedReasoning, assistant, call,
        { type: 'function_call_output', call_id: 'call-prior', output: 'prior result' },
        { role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
        ...expectedToolInput(0),
      ],
      continuationInput: [
        { type: 'function_call_output', call_id: 'call-prior', output: 'prior result' },
        { role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
        ...expectedToolInput(0),
      ],
    };
  }

  it.each(['completed', 'in_progress', 'incomplete'])(
    'normalizes reasoning status %s in stateless serialized history', async (status) => {
      const configuration: ProviderConfig = { ...config, extraBody: { store: false } };
      const history = trustedRound(createStatefulMarkerIdentity(configuration, model), status);
      const requests = await sendRequests(history.messages, { configuration });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ store: false, input: history.fullInput });
      expect(requests[0]).not.toHaveProperty('previous_response_id');
    },
  );

  it('keeps successful continuation limited to the trusted-boundary suffix', async () => {
    const history = trustedRound(createStatefulMarkerIdentity(config, model), 'completed');
    const requests = await sendRequests(history.messages);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ previous_response_id: 'resp-trusted', input: history.continuationInput });
  });

  it('replays normalized full history after continuation is rejected', async () => {
    const history = trustedRound(createStatefulMarkerIdentity(config, model), 'completed');
    const requests = await sendRequests(history.messages, { rejectContinuation: true });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ previous_response_id: 'resp-trusted', input: history.continuationInput });
    expect(requests[1]).not.toHaveProperty('previous_response_id');
    expect(requests[1]).toMatchObject({ input: history.fullInput });
  });

  it('uses normalized full input in a stateless WebSocket response.create payload', async () => {
    const configuration: ProviderConfig = { ...config, transport: 'websocket', extraBody: { store: false } };
    const requestModel: ModelConfig = { ...model, stream: true };
    const history = trustedRound(createStatefulMarkerIdentity(configuration, requestModel), 'completed');
    const frames: unknown[] = [];
    vi.spyOn(webSocketSessionManager, 'createRequest').mockImplementation(async (_target, payload) => {
      frames.push(JSON.parse(JSON.stringify(payload)));
      return {
        reusedConnection: false,
        stream: (async function* () {
          yield { type: 'response.completed', response: completedResponse(), sequence_number: 1 };
        })(),
        release: () => undefined,
        terminate: () => undefined,
      };
    });
    expect(await sendRequests(history.messages, { configuration, requestModel })).toEqual([]);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: 'response.create', store: false, input: history.fullInput });
    expect(frames[0]).not.toHaveProperty('input.1.status');
    expect(frames[0]).not.toHaveProperty('previous_response_id');
    expect(frames[0]).not.toHaveProperty('stream');
  });
});

describe('Responses markerless history requests', () => {
  it.each([false, true])(
    'sends full tool history with proxy previous-response metadata=%s',
    async (withPreviousResponse) => {
      const messages: vscode.LanguageModelChatRequestMessage[] = [];
      if (withPreviousResponse) {
        // VS Code's BYOK handler prepends this bare ID, not a Unify envelope.
        messages.push(
          message(
            vscode.LanguageModelChatMessageRole.Assistant,
            new vscode.LanguageModelDataPart(
              Buffer.from(`${modelId}\\resp-byok`),
              'stateful_marker',
            ),
          ),
        );
      }
      messages.push(
        message(
          vscode.LanguageModelChatMessageRole.System,
          new vscode.LanguageModelTextPart('system'),
        ),
        message(
          vscode.LanguageModelChatMessageRole.User,
          new vscode.LanguageModelTextPart('question'),
        ),
        ...toolRound(0),
        ...toolRound(1),
      );

      const request = await send(messages);

      expect(request).toMatchObject({
        input: [
          { role: 'system', content: [{ type: 'input_text', text: 'system' }] },
          { role: 'user', content: [{ type: 'input_text', text: 'question' }] },
          ...expectedToolInput(0),
          ...expectedToolInput(1),
        ],
      });
      expect(request).not.toHaveProperty('previous_response_id');
    },
  );

  it('keeps markerless rounds after a trusted previous-response boundary', async () => {
    const request = await send([
      message(
        vscode.LanguageModelChatMessageRole.User,
        new vscode.LanguageModelTextPart('earlier question'),
      ),
      message(vscode.LanguageModelChatMessageRole.Assistant, createMarker()),
      message(
        vscode.LanguageModelChatMessageRole.User,
        new vscode.LanguageModelTextPart('inspect'),
      ),
      ...toolRound(0),
    ]);

    expect(request).toMatchObject({
      previous_response_id: 'resp-trusted',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'inspect' }] },
        ...expectedToolInput(0),
      ],
    });
  });

  it('disables continuation when a later tool round has a foreign marker', async () => {
    const round = toolRound(0);
    round[1] = {
      ...round[1],
      content: [...round[1].content, createMarker('foreign-identity')],
    };
    const request = await send([
      message(
        vscode.LanguageModelChatMessageRole.User,
        new vscode.LanguageModelTextPart('earlier question'),
      ),
      message(vscode.LanguageModelChatMessageRole.Assistant, createMarker()),
      message(
        vscode.LanguageModelChatMessageRole.User,
        new vscode.LanguageModelTextPart('inspect'),
      ),
      ...round,
    ]);

    expect(request).not.toHaveProperty('previous_response_id');
    expect(request).toMatchObject({
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'earlier question' }] },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'prior answer', annotations: [] }],
        },
        { role: 'user', content: [{ type: 'input_text', text: 'inspect' }] },
      ],
    });
  });
});
