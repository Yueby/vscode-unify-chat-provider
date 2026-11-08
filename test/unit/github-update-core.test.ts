import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareVersions, parseLatestRelease, UPDATE_REPOSITORY } from '../../src/update/release';
import { checkLatestRelease, prepareUpdate } from '../../src/update/transfer';
import { ReleaseUpdateService } from '../../src/update/service';
import type { UpdateUi } from '../../src/update/types';

const ID = 'Yueby.vscode-unify-chat-provider';
const NAME = 'vscode-unify-chat-provider';
const VERSION = '8.14.2';
async function fixture() {
  const zip = new JSZip();
  zip.file('extension/package.json', JSON.stringify({ publisher: 'Yueby', name: NAME, version: VERSION }));
  const bytes = await zip.generateAsync({ type: 'nodebuffer' });
  const name = `${NAME}-${VERSION}.vsix`;
  const checksum = Buffer.from(`${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`);
  const base = `https://github.com/${UPDATE_REPOSITORY}/releases`;
  const raw = { tag_name: `v${VERSION}`, draft: false, prerelease: false, html_url: `${base}/tag/v${VERSION}`,
    assets: [
      { name, size: bytes.length, browser_download_url: `${base}/download/v${VERSION}/${name}` },
      { name: `${name}.sha256`, size: checksum.length, browser_download_url: `${base}/download/v${VERSION}/${name}.sha256` },
    ] };
  const release = parseLatestRelease(raw, '8.14.1', NAME);
  if (!release) throw Error('Expected fixture release');
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith('/latest')) return Response.json(raw);
    if (url.endsWith('.sha256')) return new Response(checksum);
    return new Response(new Uint8Array(bytes));
  });
  return { bytes, checksum, raw, release, fetcher };
}
function ui() {
  return {
    offerUpdate: vi.fn<UpdateUi['offerUpdate']>().mockResolvedValue(true),
    withProgress: async <T>(task: (signal: AbortSignal, report: (percent: number) => void) => Promise<T>) => task(new AbortController().signal, () => {}),
    notifyNoUpdate: vi.fn<UpdateUi['notifyNoUpdate']>().mockResolvedValue(),
    notifyInstalled: vi.fn<UpdateUi['notifyInstalled']>().mockResolvedValue(),
    notifyError: vi.fn<UpdateUi['notifyError']>().mockResolvedValue(),
  };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('GitHub Release update protocol', () => {
  it.each([
    ['8.14.2', '8.14.1', 1], ['8.14.1', '8.14.1', 0], ['8.9.9', '8.14.1', -1], ['9.0.0', '8.99.99', 1],
  ])('compares stable versions %s and %s', (a, b, expected) => expect(compareVersions(String(a), String(b))).toBe(expected));
  it.each(['1.0.0-beta', 'v1.0.0', '01.0.0', '1.2', '9007199254740992.0.0', '8.14.2\n'])('rejects unsupported versions %s', (value) => {
    expect(() => compareVersions(value, '8.14.1')).toThrow();
  });
  it('ignores draft, prerelease, equal and older releases', async () => {
    const f = await fixture();
    expect(parseLatestRelease({ ...f.raw, draft: true }, '8.14.1', NAME)).toBeUndefined();
    expect(parseLatestRelease({ ...f.raw, prerelease: true }, '8.14.1', NAME)).toBeUndefined();
    expect(parseLatestRelease(f.raw, VERSION, NAME)).toBeUndefined();
    expect(parseLatestRelease(f.raw, '9.0.0', NAME)).toBeUndefined();
  });
  it('requires unique matching VSIX/checksum assets from the exact repository', async () => {
    const f = await fixture();
    expect(() => parseLatestRelease({ ...f.raw, assets: [f.raw.assets[0]] }, '8.14.1', NAME)).toThrow();
    expect(() => parseLatestRelease({ ...f.raw, assets: [...f.raw.assets, f.raw.assets[0]] }, '8.14.1', NAME)).toThrow();
    expect(() => parseLatestRelease({ ...f.raw, html_url: 'https://example.com/release' }, '8.14.1', NAME)).toThrow();
    const wrong = { ...f.raw.assets[0], browser_download_url: f.raw.assets[0].browser_download_url.replace('Yueby/', 'other/') };
    expect(() => parseLatestRelease({ ...f.raw, assets: [wrong, f.raw.assets[1]] }, '8.14.1', NAME)).toThrow();
  });
  it('handles an unpublished repository without a download', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 404 }));
    expect(await checkLatestRelease(fetcher, '8.14.1', NAME, new AbortController().signal)).toBeUndefined();
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('uses only public headers and never forwards account credentials', async () => {
    const f = await fixture();
    await checkLatestRelease(f.fetcher, '8.14.1', NAME, new AbortController().signal);
    const init = f.fetcher.mock.calls[0][1];
    expect(Array.from(new Headers(init?.headers).keys()).sort()).toEqual(['accept', 'user-agent']);
    expect(init?.redirect).toBe('error');
  });
  it('downloads, hashes and validates before returning an owned temporary VSIX', async () => {
    const f = await fixture();
    const prepared = await prepareUpdate(f.release, ID, f.fetcher, new AbortController().signal, () => {});
    try { expect(await readFile(prepared.vsixPath)).toEqual(f.bytes); }
    finally { await prepared.dispose(); }
    await expect(access(prepared.vsixPath)).rejects.toThrow();
  });
  it('rejects a mismatching checksum before parsing or installing the archive', async () => {
    const f = await fixture();
    f.fetcher.mockImplementation(async (input) => String(input).endsWith('.sha256')
      ? new Response(`0000000000000000000000000000000000000000000000000000000000000000  ${f.release.vsix.name}\n`)
      : new Response(new Uint8Array(f.bytes)));
    await expect(prepareUpdate(f.release, ID, f.fetcher, new AbortController().signal, () => {})).rejects.toMatchObject({ code: 'checksum' });
  });
  it('rejects wrong checksum file names and incorrect actual lengths', async () => {
    const f = await fixture();
    f.fetcher.mockResolvedValue(new Response(f.checksum.toString().replace(f.release.vsix.name, 'other.vsix')));
    await expect(prepareUpdate(f.release, ID, f.fetcher, new AbortController().signal, () => {})).rejects.toThrow();
    const short = await fixture();
    short.fetcher.mockResolvedValue(new Response('short'));
    await expect(prepareUpdate(short.release, ID, short.fetcher, new AbortController().signal, () => {})).rejects.toMatchObject({ code: 'network' });
  });
  it.each(['http://github.com/file', 'https://evil.example/file', 'https://user:pass@github.com/file', 'https://github.com:444/file'])('rejects unsafe redirects %s', async (location) => {
    const f = await fixture();
    f.fetcher.mockResolvedValue(new Response(null, { status: 302, headers: { location } }));
    await expect(prepareUpdate(f.release, ID, f.fetcher, new AbortController().signal, () => {})).rejects.toMatchObject({ code: 'invalid-release' });
  });
  it('limits redirect chains and allows the standard GitHub asset host', async () => {
    const f = await fixture();
    f.fetcher.mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/file' } }));
    await expect(prepareUpdate(f.release, ID, f.fetcher, new AbortController().signal, () => {})).rejects.toMatchObject({ code: 'network' });
    expect(f.fetcher).toHaveBeenCalledTimes(4);
  });
  it('rejects oversized metadata before reading its body', async () => {
    const response = new Response('{}', { headers: { 'content-length': String(3 * 1024 * 1024) } });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    await expect(checkLatestRelease(fetcher, '8.14.1', NAME, new AbortController().signal)).rejects.toMatchObject({ code: 'network' });
  });
  it('bounds a stalled response body and cancels its reader', async () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    let pulled = 0, cancelled = false;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        if (pulled === 1) controller.enqueue(new TextEncoder().encode('{'));
        else markStarted?.();
      },
      cancel() { cancelled = true; },
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    const pending = checkLatestRelease(fetcher, '8.14.1', NAME, new AbortController().signal);
    await started;
    timeout.abort(new DOMException('Deadline', 'TimeoutError'));
    await expect(pending).rejects.toMatchObject({ code: 'network' });
    expect(cancelled).toBe(true);
  });
  it('honors cancellation before any request', async () => {
    const f = await fixture();
    const c = new AbortController(); c.abort();
    await expect(prepareUpdate(f.release, ID, f.fetcher, c.signal, () => {})).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});

describe('update confirmation and scheduling', () => {
  async function setup(production = false) {
    const f = await fixture(), view = ui(), install = vi.fn<(path: string) => Promise<void>>().mockResolvedValue();
    let leader = true, enabled = true, last = 0;
    const service = new ReleaseUpdateService({ extensionId: ID, version: '8.14.1', production, fetcher: f.fetcher, ui: view,
      isLeader: () => leader, automaticEnabled: () => enabled, lastCheck: () => last,
      recordCheck: async (time) => { last = time; }, install });
    return { ...f, view, install, service, setLeader: (v: boolean) => { leader = v; service.refreshScheduling(); }, setEnabled: (v: boolean) => { enabled = v; service.refreshScheduling(); }, last: () => last };
  }
  it('does not download or install when the offer is declined', async () => {
    const s = await setup(); s.view.offerUpdate.mockResolvedValue(false);
    try { await s.service.check(); expect(s.fetcher).toHaveBeenCalledOnce(); expect(s.install).not.toHaveBeenCalled(); }
    finally { s.service.dispose(); }
  });
  it('joins repeated commands and installs only after confirmation and validation', async () => {
    const s = await setup(); let installedPath = '';
    s.install.mockImplementation(async (path) => { installedPath = path; expect(await readFile(path)).toEqual(s.bytes); });
    try {
      await Promise.all([s.service.check(), s.service.check()]);
      expect(s.install).toHaveBeenCalledOnce(); expect(s.view.notifyInstalled).toHaveBeenCalledWith(VERSION);
      await expect(access(installedPath)).rejects.toThrow();
      await s.service.check(); expect(s.install).toHaveBeenCalledOnce(); expect(s.view.notifyNoUpdate).toHaveBeenCalledOnce();
    } finally { s.service.dispose(); }
  });
  it('stops an automatic offer after losing leadership, including late confirmation', async () => {
    const s = await setup(true); let confirm: ((value: boolean) => void) | undefined;
    s.view.offerUpdate.mockImplementation(() => new Promise<boolean>((resolve) => { confirm = resolve; }));
    const pending = s.service.check(false);
    await vi.waitFor(() => expect(s.view.offerUpdate).toHaveBeenCalledOnce());
    s.setLeader(false); await pending; confirm?.(true); await Promise.resolve();
    expect(s.install).not.toHaveBeenCalled(); expect(s.fetcher).toHaveBeenCalledOnce(); s.service.dispose();
  });
  it('checks automatically only in production, once per day, and honors the setting', async () => {
    const s = await setup(true), test = await setup(false);
    vi.useFakeTimers(); s.view.offerUpdate.mockResolvedValue(false);
    try {
      s.service.refreshScheduling(); await vi.advanceTimersByTimeAsync(30000);
      expect(s.fetcher).toHaveBeenCalledOnce(); expect(s.last()).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000); expect(s.fetcher).toHaveBeenCalledOnce();
      s.setEnabled(false); await vi.advanceTimersByTimeAsync(25 * 60 * 60 * 1000); expect(s.fetcher).toHaveBeenCalledOnce();
      await s.service.check(); expect(s.fetcher).toHaveBeenCalledTimes(2);
    } finally { s.service.dispose(); }
    test.service.refreshScheduling(); await vi.advanceTimersByTimeAsync(25 * 60 * 60 * 1000);
    expect(test.fetcher).not.toHaveBeenCalled(); test.service.dispose();
  });
  it('releases the operation guard while an installed notification awaits user choice', async () => {
    const s = await setup();
    s.view.notifyInstalled.mockImplementation(() => new Promise<void>(() => {}));
    try {
      await s.service.check();
      await s.service.check();
      expect(s.install).toHaveBeenCalledOnce();
      expect(s.view.notifyNoUpdate).toHaveBeenCalledOnce();
    } finally { s.service.dispose(); }
  });
  it('cleans the temporary package and reports static installation errors', async () => {
    const s = await setup(); let path = '';
    s.install.mockImplementation(async (value) => { path = value; throw Error('private internal detail'); });
    try { await s.service.check(); expect(s.view.notifyError).toHaveBeenCalledWith('install'); await expect(access(path)).rejects.toThrow(); }
    finally { s.service.dispose(); }
  });
});
