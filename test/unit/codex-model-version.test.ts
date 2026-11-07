import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const now = Date.UTC(2026, 10, 8);
function release(tag = 'rust-v0.168.0'): Response {
  return Response.json({ tag_name: tag, draft: false, prerelease: false });
}
async function resolver() {
  return (await import('../../src/client/openai/codex-model-version')).getCodexModelsClientVersion;
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Codex stable client version lookup', () => {
  it('uses the original public stable-release endpoint and credential-free headers', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(release());
    expect(await (await resolver())(fetcher)).toBe('0.168.0');
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/openai/codex/releases/latest');
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
    const headers = new Headers(init?.headers);
    expect(Array.from(headers.keys()).sort()).toEqual(['accept', 'user-agent']);
    expect(headers.get('accept')).toBe('application/vnd.github+json');
    expect(headers.get('user-agent')).toBe('unify-chat-provider');
  });

  it('caches successful public metadata for 30 minutes', async () => {
    const getVersion = await resolver();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(release()).mockResolvedValueOnce(release('rust-v0.169.0'));
    expect(await getVersion(fetcher)).toBe('0.168.0');
    vi.setSystemTime(now + 29 * 60000);
    expect(await getVersion(fetcher)).toBe('0.168.0');
    expect(fetcher).toHaveBeenCalledOnce();
    vi.setSystemTime(now + 30 * 60000 + 1);
    expect(await getVersion(fetcher)).toBe('0.169.0');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('backs off a failed lookup while allowing model discovery to use a known version', async () => {
    const getVersion = await resolver();
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(release());
    expect(await getVersion(fetcher)).toBe('0.167.0');
    expect(await getVersion(fetcher)).toBe('0.167.0');
    expect(fetcher).toHaveBeenCalledOnce();
    vi.setSystemTime(now + 5 * 60000 + 1);
    expect(await getVersion(fetcher)).toBe('0.168.0');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('retains an expired successful version if its refresh fails', async () => {
    const getVersion = await resolver();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(release('rust-v0.170.0')).mockRejectedValueOnce(new Error('unavailable'));
    expect(await getVersion(fetcher)).toBe('0.170.0');
    vi.setSystemTime(now + 31 * 60000);
    expect(await getVersion(fetcher)).toBe('0.170.0');
  });

  it.each([
    { tag_name: 'rust-v0.168.0', draft: true },
    { tag_name: 'rust-v0.168.0', prerelease: true },
    { tag_name: 'rust-v0.168.0-beta.1' },
    { tag_name: 'unexpected' }, { tag_name: 168 }, {}, null,
  ])('does not use invalid release metadata: %j', async (body) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(body));
    expect(await (await resolver())(fetcher)).toBe('0.167.0');
  });

  it('releases a failed public response without waiting indefinitely for cleanup', async () => {
    const response = new Response('rate limited', { status: 429 });
    if (!response.body) throw new Error('Expected body');
    const cancel = vi.spyOn(response.body, 'cancel').mockImplementation(() => new Promise<void>(() => {}));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response);
    expect(await (await resolver())(fetcher)).toBe('0.167.0');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('honors caller cancellation even on a populated cache', async () => {
    const getVersion = await resolver();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(release());
    await getVersion(fetcher);
    const controller = new AbortController();
    controller.abort();
    await expect(getVersion(fetcher, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('does not cache an aborted lookup or cancel an independent caller', async () => {
    const getVersion = await resolver();
    let finish: ((response: Response) => void) | undefined;
    const first = vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const controller = new AbortController();
    const pending = getVersion(first, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const second = vi.fn<typeof fetch>().mockResolvedValueOnce(release('rust-v0.169.0'));
    expect(await getVersion(second)).toBe('0.169.0');
    expect(second).toHaveBeenCalledOnce();
    finish?.(release());
    await Promise.resolve();
    expect(await getVersion(second)).toBe('0.169.0');
  });

  it('bounds response-body reads and does not cache their late completion', async () => {
    const getVersion = await resolver();
    const timeout = new AbortController();
    const deadline = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    const response = release();
    let finishBody: ((body: unknown) => void) | undefined;
    let markReadStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markReadStarted = resolve; });
    vi.spyOn(response, 'json').mockImplementation(() => {
      markReadStarted?.();
      return new Promise((resolve) => { finishBody = resolve; });
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response);
    const pending = getVersion(fetcher);
    await started;
    timeout.abort(new DOMException('Version lookup deadline', 'TimeoutError'));
    expect(await pending).toBe('0.167.0');
    expect(deadline).toHaveBeenCalledWith(3000);
    finishBody?.({ tag_name: 'rust-v0.999.0' });
    await Promise.resolve();
    expect(await getVersion(fetcher)).toBe('0.167.0');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('does not let a late failed lookup overwrite a concurrent successful cache', async () => {
    const getVersion = await resolver();
    let rejectFirst: ((error: Error) => void) | undefined;
    const first = vi.fn<typeof fetch>(() => new Promise<Response>((_resolve, reject) => { rejectFirst = reject; }));
    const pending = getVersion(first);
    const second = vi.fn<typeof fetch>().mockResolvedValueOnce(release('rust-v0.169.0'));
    expect(await getVersion(second)).toBe('0.169.0');
    rejectFirst?.(new Error('offline'));
    expect(await pending).toBe('0.169.0');
    vi.setSystemTime(now + 10 * 60000);
    expect(await getVersion(second)).toBe('0.169.0');
    expect(second).toHaveBeenCalledOnce();
  });
});
