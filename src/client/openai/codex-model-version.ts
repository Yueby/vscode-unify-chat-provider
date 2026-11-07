const CODEX_LATEST_RELEASE_URL = 'https://api.github.com/repos/openai/codex/releases/latest';
const FALLBACK_CLIENT_VERSION = '0.167.0';
const VERSION_CACHE_MS = 30 * 60 * 1000;
const VERSION_RETRY_MS = 5 * 60 * 1000;
const VERSION_LOOKUP_TIMEOUT_MS = 3000;

let cached: { version: string; nextLookupAt: number } | undefined;

function releaseVersion(raw: unknown): string {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Unexpected Codex release metadata');
  }
  const tag: unknown = Reflect.get(raw, 'tag_name');
  const version = typeof tag === 'string' ? /^rust-v(\d+\.\d+\.\d+)$/.exec(tag)?.[1] : undefined;
  if (!version || Reflect.get(raw, 'draft') === true || Reflect.get(raw, 'prerelease') === true) {
    throw new Error('Unexpected Codex release metadata');
  }
  return version;
}

/** Resolves the latest stable Codex release with a bounded public metadata cache. */
export async function getCodexModelsClientVersion(
  fetchWithNetwork: typeof fetch,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  if (cached && Date.now() < cached.nextLookupAt) return cached.version;
  const observedCache = cached;
  const lookupSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(VERSION_LOOKUP_TIMEOUT_MS)])
    : AbortSignal.timeout(VERSION_LOOKUP_TIMEOUT_MS);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(lookupSignal.reason);
    if (lookupSignal.aborted) onAbort();
    else lookupSignal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const lookup = (async (): Promise<string> => {
      const response = await fetchWithNetwork(CODEX_LATEST_RELEASE_URL, {
        method: 'GET',
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'unify-chat-provider' },
        signal: lookupSignal,
        redirect: 'error',
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new Error('Codex release lookup failed');
      }
      const raw: unknown = await response.json();
      lookupSignal.throwIfAborted();
      return releaseVersion(raw);
    })();
    const version = await Promise.race([lookup, aborted]);
    signal?.throwIfAborted();
    lookupSignal.throwIfAborted();
    cached = { version, nextLookupAt: Date.now() + VERSION_CACHE_MS };
    return version;
  } catch {
    signal?.throwIfAborted();
    // A late failed lookup must not replace a successful concurrent lookup.
    if (cached === observedCache) {
      cached = {
        version: observedCache?.version ?? FALLBACK_CLIENT_VERSION,
        nextLookupAt: Date.now() + VERSION_RETRY_MS,
      };
    }
    return cached?.version ?? FALLBACK_CLIENT_VERSION;
  } finally {
    if (onAbort) lookupSignal.removeEventListener('abort', onAbort);
  }
}
