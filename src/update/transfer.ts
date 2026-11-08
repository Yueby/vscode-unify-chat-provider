import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UpdateError } from './errors';
import { checkedUrl, LATEST_RELEASE_URL, MAX_VSIX_BYTES, parseLatestRelease, type ReleaseInfo } from './release';
import { validateUpdatePackage } from './package';

const PUBLIC_HEADERS = { Accept: 'application/vnd.github+json', 'User-Agent': 'ucp-release-updater' };

export async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([work, aborted]); }
  finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
}

function discard(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}
async function readBounded(response: Response, max: number, signal: AbortSignal, report?: (bytes: number) => void): Promise<Buffer> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > max)) {
    discard(response);
    throw new UpdateError('network');
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let completed = false;
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await abortable(reader.read(), signal);
      if (part.done) { completed = true; break; }
      size += part.value.byteLength;
      if (size > max) throw new UpdateError('network');
      chunks.push(part.value);
      report?.(size);
    }
    return Buffer.concat(chunks, size);
  } finally {
    if (!completed) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function request(fetcher: typeof fetch, url: string, signal: AbortSignal, redirects: boolean): Promise<Response> {
  let current = url;
  for (let hops = 0; hops <= 3; hops++) {
    signal.throwIfAborted();
    const response = await abortable(fetcher(current, {
      method: 'GET', headers: { ...PUBLIC_HEADERS }, redirect: redirects ? 'manual' : 'error', signal,
    }), signal);
    signal.throwIfAborted();
    if (!redirects || ![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    discard(response);
    if (!location || hops === 3) throw new UpdateError('network');
    let destination: string;
    try { destination = new URL(location, current).toString(); } catch { throw new UpdateError('invalid-release'); }
    current = checkedUrl(destination, 'redirect').toString();
  }
  throw new UpdateError('network');
}

export async function checkLatestRelease(fetcher: typeof fetch, currentVersion: string, extensionName: string, signal: AbortSignal): Promise<ReleaseInfo | undefined> {
  signal.throwIfAborted();
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
  try {
    const response = await request(fetcher, LATEST_RELEASE_URL, deadline, false);
    if (response.status === 404) { discard(response); return undefined; }
    if (!response.ok) { discard(response); throw new UpdateError('network'); }
    const data = await readBounded(response, 2 * 1024 * 1024, deadline);
    deadline.throwIfAborted();
    let raw: unknown;
    try { raw = JSON.parse(data.toString('utf8')); } catch { throw new UpdateError('invalid-release'); }
    return parseLatestRelease(raw, currentVersion, extensionName);
  } catch (error) {
    signal.throwIfAborted();
    throw error instanceof UpdateError ? error : new UpdateError('network');
  }
}

async function download(fetcher: typeof fetch, url: string, max: number, expected: number, signal: AbortSignal, report?: (bytes: number) => void): Promise<Buffer> {
  checkedUrl(url, 'asset');
  const response = await request(fetcher, url, signal, true);
  if (!response.ok) { discard(response); throw new UpdateError('network'); }
  const bytes = await readBounded(response, max, signal, report);
  if (bytes.length !== expected) throw new UpdateError('network');
  return bytes;
}

export async function prepareUpdate(
  release: ReleaseInfo, extensionId: string, fetcher: typeof fetch,
  signal: AbortSignal, report: (percent: number) => void,
): Promise<{ vsixPath: string; dispose(): Promise<void> }> {
  signal.throwIfAborted();
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
  let directory: string | undefined;
  try {
    const checksum = await download(fetcher, release.checksum.url, 4096, release.checksum.size, deadline);
    const line = checksum.toString('utf8').replace(/\r?\n$/, '');
    if (!/^[a-fA-F0-9]{64}  /.test(line) || line.slice(64) !== `  ${release.vsix.name}`) throw new UpdateError('checksum');
    const expectedHash = line.slice(0, 64).toLowerCase();
    const vsix = await download(fetcher, release.vsix.url, MAX_VSIX_BYTES, release.vsix.size, deadline,
      (bytes) => report(Math.min(90, bytes * 90 / release.vsix.size)));
    if (createHash('sha256').update(vsix).digest('hex') !== expectedHash) throw new UpdateError('checksum');
    deadline.throwIfAborted();
    directory = await mkdtemp(join(tmpdir(), 'ucp-update-'));
    await chmod(directory, 0o700);
    const vsixPath = join(directory, 'update.vsix');
    await writeFile(vsixPath, vsix, { mode: 0o600, flag: 'wx' });
    await validateUpdatePackage(vsixPath, { extensionId, version: release.version }, deadline);
    deadline.throwIfAborted();
    report(100);
    const ownedDirectory = directory;
    return { vsixPath, dispose: () => rm(ownedDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    signal.throwIfAborted();
    throw error instanceof UpdateError ? error : new UpdateError('network');
  }
}
