import { APIError } from 'openai';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
  officialModelsManager: {},
}));

import {
  fetchWithRetryUsingFetch,
  isRetryableStreamReadError,
  RetryableStreamReadError,
  shouldRetryStreamReadError,
  withIdleTimeout,
} from '../../src/utils';

class CodedError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

function pendingStream(): AsyncIterable<number> {
  const iterator: AsyncIterator<number> = {
    next: () => new Promise<IteratorResult<number>>(() => undefined),
    return: async () => ({ done: true, value: undefined }),
  };
  return {
    [Symbol.asyncIterator]: () => iterator,
  };
}

function throwingStream(error: unknown): AsyncIterable<number> {
  const iterator: AsyncIterator<number> = {
    next: async () => {
      throw error;
    },
    return: async () => ({ done: true, value: undefined }),
  };
  return {
    [Symbol.asyncIterator]: () => iterator,
  };
}

async function consume(source: AsyncIterable<unknown>): Promise<void> {
  for await (const value of source) {
    void value;
  }
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected promise to reject');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('chat stream retry classification', () => {
  it('marks response idle timeouts as retryable stream-read errors', async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const rejection = captureError(
      consume(withIdleTimeout(pendingStream(), 100, undefined, onTimeout)),
    );

    await vi.advanceTimersByTimeAsync(100);
    const error = await rejection;

    expect(error).toBeInstanceOf(RetryableStreamReadError);
    if (!(error instanceof RetryableStreamReadError)) {
      throw new Error('Expected RetryableStreamReadError');
    }
    expect(error.name).toBe('TimeoutError');
    expect(error.message).toBe(
      'Response timeout: No data received for 100ms',
    );
    expect(error.cause).toMatchObject({
      name: 'TimeoutError',
      message: 'Response timeout: No data received for 100ms',
    });
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it.each([
    'UND_ERR_SOCKET',
    'UND_ERR_BODY_TIMEOUT',
    'ECONNRESET',
    'ETIMEDOUT',
  ])('marks body-read network error %s as retryable', async (code) => {
    const sourceError = new CodedError('stream failed', code);
    const error = await captureError(
      consume(withIdleTimeout(throwingStream(sourceError), 100)),
    );

    expect(error).toBeInstanceOf(RetryableStreamReadError);
    expect(isRetryableStreamReadError(error)).toBe(true);
  });

  it('recognizes a terminated wrapper with a socket cause', async () => {
    const socketError = new CodedError(
      'other side closed',
      'UND_ERR_SOCKET',
    );
    const terminatedError = new TypeError('terminated', {
      cause: socketError,
    });
    const error = await captureError(
      consume(withIdleTimeout(throwingStream(terminatedError), 100)),
    );

    expect(error).toBeInstanceOf(RetryableStreamReadError);
    if (!(error instanceof RetryableStreamReadError)) {
      throw new Error('Expected RetryableStreamReadError');
    }
    expect(error.cause).toBe(socketError);
  });

  it('still recognizes stream_read_error codes on Error instances', () => {
    expect(
      isRetryableStreamReadError(
        new CodedError('provider stream failed', 'stream_read_error'),
      ),
    ).toBe(true);
  });

  it.each([
    { error: { code: 'upstream_http2_stream_error', message: 'HTTP/2 stream failed' } },
    { error: { message: 'upstream stream returned an error payload' } },
    { error: { message: 'upstream service temporarily unavailable' } },
    { error: { message: 'stream closed before response.completed' } },
  ])('recognizes an explicit gateway stream error: %j', (error) => {
    expect(isRetryableStreamReadError(error)).toBe(true);
  });

  it('recognizes a gateway stream code on an Error instance', () => {
    expect(isRetryableStreamReadError(
      new CodedError('HTTP/2 stream failed', 'upstream_http2_stream_error'),
    )).toBe(true);
  });

  it('does not retry an upstream error type without a transient stream signal', () => {
    expect(isRetryableStreamReadError({
      error: { type: 'upstream_error', message: 'invalid provider configuration' },
    })).toBe(false);
  });

  it.each([400, 401, 408, 429, 500, 502, 503, 504, 599])(
    'leaves HTTP %i failures to the HTTP retry layer',
    (status) => {
      const error = Object.assign(new Error('stream_read_error'), { status });
      expect(isRetryableStreamReadError(error)).toBe(false);
      expect(isRetryableStreamReadError({ error: { status, code: 'stream_read_error' } })).toBe(false);
    },
  );

  it.each([
    new Error('stream_read_error', {
      cause: Object.assign(new Error('HTTP failure'), { status: 502 }),
    }),
    Object.assign(new Error('HTTP failure', {
      cause: new CodedError('stream failed', 'stream_read_error'),
    }), { status: 502 }),
    new RetryableStreamReadError(Object.assign(new Error('HTTP failure'), { status: 502 })),
    Object.assign(new Error('stream_read_error', {
      cause: Object.assign(new Error('HTTP failure'), { status: 502 }),
    }), { source: 'stream' }),
    new Error('stream_read_error', {
      cause: { error: { status: 502, message: 'HTTP failure' } },
    }),
  ])('does not let wrappers mask an HTTP failure: %j', (error) => {
    expect(isRetryableStreamReadError(error)).toBe(false);
  });

  it('allows an explicitly identified stream failure to carry an HTTP status', () => {
    const streamError = Object.assign(new CodedError('stream failed', 'stream_read_error'), {
      status: 502,
      source: 'stream',
    });
    expect(isRetryableStreamReadError(new Error('wrapped stream error', { cause: streamError }))).toBe(true);
    expect(isRetryableStreamReadError({ error: streamError })).toBe(true);
    expect(isRetryableStreamReadError({
      source: 'stream', status: 502, type: 'upstream_error', message: 'invalid provider configuration',
    })).toBe(false);
  });

  it('checks HTTP status on its own error node rather than inheriting the stream source', () => {
    expect(isRetryableStreamReadError({
      source: 'stream', code: 'stream_read_error', error: { status: 502 },
    })).toBe(false);
  });

  it('terminates on a cyclic cause chain', () => {
    const error = new CodedError('stream failed', 'upstream_http2_stream_error');
    Object.assign(error, { cause: error });
    expect(isRetryableStreamReadError(error)).toBe(true);
  });

  it('does not retry an aborted gateway stream', () => {
    const error = new Error('upstream service temporarily unavailable');
    error.name = 'AbortError';
    expect(isRetryableStreamReadError(error)).toBe(false);
  });

  it('does not treat an unmarked fetch-stage network error as a stream error', () => {
    expect(
      isRetryableStreamReadError(
        new CodedError('connection failed', 'UND_ERR_SOCKET'),
      ),
    ).toBe(false);
  });

  it('does not mark parser or business errors as transport failures', async () => {
    const sourceError = new Error('invalid response payload');
    const error = await captureError(
      consume(withIdleTimeout(throwingStream(sourceError), 100)),
    );

    expect(error).toBe(sourceError);
    expect(isRetryableStreamReadError(error)).toBe(false);
  });

  it('does not retry an unmarked abort error', () => {
    const abortError = new Error('stream_read_error after abort');
    abortError.name = 'AbortError';

    expect(isRetryableStreamReadError(abortError)).toBe(false);
  });
});

describe('chat stream retry policy', () => {
  it('does not restart an exhausted HTTP retry budget at the service boundary', async () => {
    const maxRetries = 2;
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      error: {
        type: 'upstream_error',
        message: 'upstream service temporarily unavailable: stream_read_error',
      },
    }), { status: 502, headers: { 'Content-Type': 'application/json' } }));

    for (let retryAttempt = 0; ; retryAttempt++) {
      const response = await fetchWithRetryUsingFetch(fetcher, 'https://example.test/responses', {
        proxy: { type: 'direct' },
        retryConfig: {
          maxRetries,
          initialDelayMs: 0,
          maxDelayMs: 0,
          jitterFactor: 0,
        },
      });
      const payload: unknown = await response.json();
      if (typeof payload !== 'object' || payload === null) {
        throw new Error('Expected an HTTP error payload');
      }
      const error = APIError.generate(response.status, payload, undefined, response.headers);
      expect(error).toMatchObject({ status: 502, type: 'upstream_error' });
      if (!shouldRetryStreamReadError(error, {
        emittedPartCount: 0,
        cancellationRequested: false,
        retryAttempt,
        maxRetries,
      })) {
        break;
      }
    }

    expect(fetcher).toHaveBeenCalledTimes(maxRetries + 1);
  });

  const retryableError = new RetryableStreamReadError(
    new Error('transient stream failure'),
  );

  it('retries a marked error before the first emitted part', () => {
    expect(
      shouldRetryStreamReadError(retryableError, {
        emittedPartCount: 0,
        cancellationRequested: false,
        retryAttempt: 0,
        maxRetries: 1,
      }),
    ).toBe(true);
  });

  it.each([
    {
      name: 'a response part was already emitted',
      emittedPartCount: 1,
      cancellationRequested: false,
      retryAttempt: 0,
      maxRetries: 1,
    },
    {
      name: 'the request was cancelled',
      emittedPartCount: 0,
      cancellationRequested: true,
      retryAttempt: 0,
      maxRetries: 1,
    },
    {
      name: 'the retry budget is exhausted',
      emittedPartCount: 0,
      cancellationRequested: false,
      retryAttempt: 1,
      maxRetries: 1,
    },
  ])('does not retry when $name', ({ name: _name, ...state }) => {
    expect(shouldRetryStreamReadError(retryableError, state)).toBe(false);
  });
});
