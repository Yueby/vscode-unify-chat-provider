import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Entry, ZipFile } from 'yauzl';
import { UpdateError } from '../../src/update/errors';
import { validateUpdatePackage } from '../../src/update/package';

const MANIFEST = 'extension/package.json';
const MIB = 1024 * 1024;
const expected = { extensionId: 'Yueby.personal-extension', version: '1.2.3' };
const manifest = { publisher: 'Yueby', name: 'personal-extension', version: '1.2.3' };

async function archive(
  files: Record<string, string | Buffer> = { [MANIFEST]: JSON.stringify(manifest) },
  compression: 'STORE' | 'DEFLATE' = 'DEFLATE',
): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, data] of Object.entries(files)) zip.file(name, data, { createFolders: false });
  return zip.generateAsync({ type: 'nodebuffer', compression, platform: 'UNIX' });
}

async function withPackage(bytes: Buffer, run: (path: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'ucp-update-package-'));
  try {
    const path = join(root, 'fixture.vsix');
    await writeFile(path, bytes);
    await run(path);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

function centralEntries(bytes: Buffer): number[] {
  const end = bytes.length - 22; // JSZip fixtures have no archive comment.
  let offset = bytes.readUInt32LE(end + 16);
  const offsets: number[] = [];
  for (let i = 0; i < bytes.readUInt16LE(end + 10); i += 1) {
    offsets.push(offset);
    offset += 46 + bytes.readUInt16LE(offset + 28)
      + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  return offsets;
}

function patchEntry(bytes: Buffer, name: string, patch: (copy: Buffer, offset: number) => void): Buffer {
  const copy = Buffer.from(bytes);
  const offset = centralEntries(copy).find((position) =>
    copy.subarray(position + 46, position + 46 + copy.readUInt16LE(position + 28)).toString() === name);
  if (offset === undefined) throw new Error('Missing fixture entry');
  patch(copy, offset);
  return copy;
}

async function rejectsPackage(bytes: Buffer): Promise<void> {
  await withPackage(bytes, async (path) => {
    const result = validateUpdatePackage(path, expected);
    await expect(result).rejects.toBeInstanceOf(UpdateError);
    await expect(result).rejects.toMatchObject({
      name: 'UpdateError', code: 'invalid-package', message: 'GitHub update failed: invalid-package',
    });
  });
}

function changeEntry(change: (entry: Entry) => void): void {
  const readEntry = ZipFile.prototype.readEntry;
  vi.spyOn(ZipFile.prototype, 'readEntry').mockImplementation(function (this: ZipFile) {
    this.prependOnceListener('entry', change);
    readEntry.call(this);
  });
}

afterEach(() => vi.restoreAllMocks());

describe('validateUpdatePackage', () => {
  it.each(['STORE', 'DEFLATE'] as const)('accepts a valid %s archive and closes it before resolving', async (compression) => {
    const close = vi.spyOn(ZipFile.prototype, 'close');
    let closed = false;
    const readEntry = ZipFile.prototype.readEntry;
    vi.spyOn(ZipFile.prototype, 'readEntry').mockImplementation(function (this: ZipFile) {
      this.once('close', () => { closed = true; });
      readEntry.call(this);
    });
    await withPackage(await archive(undefined, compression), async (path) => {
      await expect(validateUpdatePackage(path, expected)).resolves.toBeUndefined();
      expect(close).toHaveBeenCalledTimes(1);
      expect(closed).toBe(true);
    });
  });

  it('compares publisher and name case-insensitively and accepts an empty extensionPack', async () => {
    await withPackage(await archive({ [MANIFEST]: JSON.stringify({
      ...manifest, publisher: 'yUEBY', name: 'PERSONAL-EXTENSION', extensionPack: [], extra: { arbitrary: true },
    }) }), async (path) => {
      await expect(validateUpdatePackage(path, expected)).resolves.toBeUndefined();
    });
  });

  it.each([
    { ...manifest, publisher: 'someone-else' },
    { ...manifest, name: 'another-extension' },
    { ...manifest, version: '1.2.4' },
    { ...manifest, version: 'v1.2.3' },
    { ...manifest, version: 123 },
    { ...manifest, publisher: null },
    { ...manifest, name: [] },
    { version: '1.2.3' },
    null, [], 'manifest', 17,
  ].map((value) => ({ value })))('rejects invalid identity or manifest shape %#', async ({ value }) => {
    await rejectsPackage(await archive({ [MANIFEST]: JSON.stringify(value) }));
  });

  it.each([['another.extension'], [''], 'another.extension', {}, null, false].map((extensionPack) => ({ extensionPack })))(
    'rejects nonempty or malformed extensionPack %#', async ({ extensionPack }) => {
      await rejectsPackage(await archive({ [MANIFEST]: JSON.stringify({ ...manifest, extensionPack }) }));
    },
  );

  it.each(['{} trailing', '{', '', '{"publisher":'])('rejects malformed JSON %#', async (json) => {
    await rejectsPackage(await archive({ [MANIFEST]: json }));
  });

  it('rejects a missing manifest', async () => {
    await rejectsPackage(await archive({ 'extension/README.md': 'readme' }));
    await rejectsPackage(await archive({}));
  });

  it('requires the exact manifest path', async () => {
    await rejectsPackage(await archive({ 'Extension/Package.json': JSON.stringify(manifest) }));
  });

  it('rejects case-insensitive duplicate manifest paths', async () => {
    await rejectsPackage(await archive({
      [MANIFEST]: JSON.stringify(manifest), 'EXTENSION/PACKAGE.JSON': JSON.stringify(manifest),
    }));
  });

  it('rejects exact duplicate manifest paths', async () => {
    const bytes = await archive({ [MANIFEST]: JSON.stringify(manifest), 'extension/packagE.json': '{}' });
    await rejectsPackage(patchEntry(bytes, 'extension/packagE.json', (copy, offset) => {
      copy.write(MANIFEST, offset + 46);
      copy.write(MANIFEST, copy.readUInt32LE(offset + 42) + 30);
    }));
  });

  it('rejects case-insensitive duplicates outside the manifest', async () => {
    await rejectsPackage(await archive({ [MANIFEST]: JSON.stringify(manifest), 'extension/a.js': '', 'Extension/A.js': '' }));
  });

  it.each([
    'extension/file.', 'extension/file ', 'extension/dir./file', 'extension/dir /file',
    'extension/dir./', 'extension/../escape', '/absolute', 'C:/absolute', 'extension\\file',
    'extension/package.json:$DATA', 'extension/name:stream',
  ])('rejects hazardous path %s even after reading the manifest', async (name) => {
    await rejectsPackage(await archive({ [MANIFEST]: JSON.stringify(manifest), [name]: 'fixture' }));
  });

  it('rejects symbolic links', async () => {
    const bytes = await archive({ [MANIFEST]: JSON.stringify(manifest), 'extension/link': 'target' });
    await rejectsPackage(patchEntry(bytes, 'extension/link', (copy, offset) => {
      copy.writeUInt32LE((0xa1ff << 16) >>> 0, offset + 38);
    }));
  });

  it.each([1, 0x40])('rejects encrypted entries (flag %i)', async (flag) => {
    const bytes = await archive({ [MANIFEST]: JSON.stringify(manifest), 'extension/code': 'fixture' });
    await rejectsPackage(patchEntry(bytes, 'extension/code', (copy, offset) => copy.writeUInt16LE(flag, offset + 8)));
  });

  it('rejects unsupported compression outside the manifest', async () => {
    const bytes = await archive({ [MANIFEST]: JSON.stringify(manifest), 'extension/code': 'fixture' });
    await rejectsPackage(patchEntry(bytes, 'extension/code', (copy, offset) => copy.writeUInt16LE(99, offset + 10)));
  });

  it('rejects a declared manifest larger than 1 MiB without opening its stream', async () => {
    const openStream = vi.spyOn(ZipFile.prototype, 'openReadStream');
    await rejectsPackage(patchEntry(await archive(), MANIFEST, (copy, offset) => {
      copy.writeUInt32LE(MIB + 1, offset + 24);
    }));
    expect(openStream).not.toHaveBeenCalled();
  });

  it('accepts a manifest of exactly 1 MiB', async () => {
    const json = JSON.stringify(manifest);
    const content = json + ' '.repeat(MIB - Buffer.byteLength(json));
    await withPackage(await archive({ [MANIFEST]: content }), async (path) => {
      await expect(validateUpdatePackage(path, expected)).resolves.toBeUndefined();
    });
  });

  it('rejects actual manifest bytes exceeding their declaration', async () => {
    const json = JSON.stringify(manifest);
    const bytes = await archive({ [MANIFEST]: json + ' '.repeat(MIB + 1 - json.length) });
    await rejectsPackage(patchEntry(bytes, MANIFEST, (copy, offset) => copy.writeUInt32LE(MIB, offset + 24)));
  });

  it('enforces the actual byte cap independently of size metadata', async () => {
    const stream = new PassThrough();
    vi.spyOn(ZipFile.prototype, 'openReadStream').mockImplementation((_entry, callback) => {
      callback(null, stream);
      stream.write(Buffer.alloc(MIB, 32));
      stream.write(Buffer.from(' '));
    });
    await rejectsPackage(await archive());
    expect(stream.destroyed).toBe(true);
  });

  it('enforces the aggregate declared uncompressed size without expanding large data', async () => {
    const bytes = await archive({ 'extension/a': 'a', 'extension/b': 'b', [MANIFEST]: JSON.stringify(manifest) });
    const patched = patchEntry(patchEntry(bytes, 'extension/a', (copy, offset) => {
      copy.writeUInt32LE(256 * MIB, offset + 24);
    }), 'extension/b', (copy, offset) => copy.writeUInt32LE(256 * MIB + 1, offset + 24));
    await rejectsPackage(patched);
  });

  it('accepts exactly 512 MiB of declared data without reading non-manifest payloads', async () => {
    const json = JSON.stringify(manifest);
    const bytes = await archive({ [MANIFEST]: json, 'extension/data': 'fixture' });
    const patched = patchEntry(bytes, 'extension/data', (copy, offset) => {
      copy.writeUInt32LE(512 * MIB - Buffer.byteLength(json), offset + 24);
    });
    const openStream = vi.spyOn(ZipFile.prototype, 'openReadStream');
    await withPackage(patched, async (path) => {
      await expect(validateUpdatePackage(path, expected)).resolves.toBeUndefined();
    });
    expect(openStream).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['compressedSize', Number.MAX_SAFE_INTEGER + 1], ['uncompressedSize', Number.MAX_SAFE_INTEGER + 1],
    ['compressedSize', -1], ['uncompressedSize', NaN], ['uncompressedSize', 0.5],
    ['relativeOffsetOfLocalHeader', Infinity],
  ] as const)('rejects unsafe entry metadata %s=%s', async (field, value) => {
    changeEntry((entry) => { entry[field] = value; });
    await rejectsPackage(await archive());
  });

  it.each([100 * MIB, 100 * MIB + 1])('enforces the ZIP byte boundary at %i using bounded metadata', async (size) => {
    // Update metadata before validation, without allocating a 100 MiB archive.
    const on = ZipFile.prototype.on;
    vi.spyOn(ZipFile.prototype, 'on').mockImplementation(function (this: ZipFile, event, listener) {
      this.fileSize = size;
      return on.call(this, event, listener);
    });
    await withPackage(await archive(), async (path) => {
      const result = validateUpdatePackage(path, expected);
      if (size === 100 * MIB) await expect(result).resolves.toBeUndefined();
      else await expect(result).rejects.toEqual(new UpdateError('invalid-package'));
    });
  });

  it.each([
    ['fileSize', NaN], ['fileSize', -1], ['fileSize', Number.MAX_SAFE_INTEGER + 1],
    ['entryCount', -1], ['entryCount', 0.5], ['entryCount', Number.MAX_SAFE_INTEGER + 1],
  ] as const)('rejects unsafe archive metadata %s=%s', async (field, value) => {
    const on = ZipFile.prototype.on;
    vi.spyOn(ZipFile.prototype, 'on').mockImplementation(function (this: ZipFile, event, listener) {
      this[field] = value;
      return on.call(this, event, listener);
    });
    await rejectsPackage(await archive());
  });

  it.each([10_000, 10_001])('enforces the entry count boundary at %i', async (count) => {
    const files: Record<string, string> = { [MANIFEST]: JSON.stringify(manifest) };
    for (let i = 1; i < count; i += 1) files[`extension/f${i}`] = '';
    await withPackage(await archive(files, 'STORE'), async (path) => {
      const result = validateUpdatePackage(path, expected);
      if (count === 10_000) await expect(result).resolves.toBeUndefined();
      else await expect(result).rejects.toEqual(new UpdateError('invalid-package'));
    });
  }, 15_000);

  it('rejects a corrupted central directory after a valid manifest', async () => {
    const bytes = await archive({ [MANIFEST]: JSON.stringify(manifest), 'extension/last': 'data' });
    await rejectsPackage(patchEntry(bytes, 'extension/last', (copy, offset) => copy.writeUInt32LE(0, offset)));
  });

  it('rejects a corrupted local header', async () => {
    await rejectsPackage(patchEntry(await archive(), MANIFEST, (copy, offset) => {
      copy.writeUInt32LE(0, copy.readUInt32LE(offset + 42));
    }));
  });

  it('rejects corrupted deflate data', async () => {
    await rejectsPackage(patchEntry(await archive(), MANIFEST, (copy, offset) => {
      const local = copy.readUInt32LE(offset + 42);
      const start = local + 30 + copy.readUInt16LE(local + 26) + copy.readUInt16LE(local + 28);
      copy.fill(0xff, start, start + copy.readUInt32LE(offset + 20));
    }));
  });

  it.each([Buffer.from('not a zip'), Buffer.alloc(0)])('rejects an invalid ZIP %#', async (bytes) => {
    await rejectsPackage(bytes);
  });

  it('returns static diagnostics for file errors', async () => {
    await withPackage(await archive(), async (path) => {
      await expect(validateUpdatePackage(`${path}.missing`, expected)).rejects.toEqual(new UpdateError('invalid-package'));
    });
  });

  it('preserves the default AbortError for a pre-aborted caller without opening a ZIP', async () => {
    const controller = new AbortController();
    controller.abort();
    const readEntry = vi.spyOn(ZipFile.prototype, 'readEntry');
    await expect(validateUpdatePackage('unused', expected, controller.signal)).rejects.toBe(controller.signal.reason);
    expect(controller.signal.reason).toMatchObject({ name: 'AbortError' });
    expect(readEntry).not.toHaveBeenCalled();
  });

  it.each([new Error('caller cancellation'), 'cancelled', null])('preserves a custom pre-abort reason %#', async (reason) => {
    const controller = new AbortController();
    controller.abort(reason);
    await expect(validateUpdatePackage('unused', expected, controller.signal)).rejects.toBe(reason);
  });

  it('closes a handle arriving after cancellation during open', async () => {
    const close = vi.spyOn(ZipFile.prototype, 'close');
    await withPackage(await archive(), async (path) => {
      const controller = new AbortController();
      const reason = new Error('cancel open');
      const result = validateUpdatePackage(path, expected, controller.signal);
      controller.abort(reason);
      await expect(result).rejects.toBe(reason);
      expect(close).toHaveBeenCalledTimes(1);
    });
  });

  it('destroys an active manifest stream and waits for ZIP close on caller abort', async () => {
    const controller = new AbortController();
    const reason = new Error('cancel read');
    const openReadStream = ZipFile.prototype.openReadStream;
    let active: Readable | undefined;
    let closed = false;
    vi.spyOn(ZipFile.prototype, 'openReadStream').mockImplementation(function (this: ZipFile, entry, callback) {
      this.once('close', () => { closed = true; });
      openReadStream.call(this, entry, (error, stream) => {
        if (!error) {
          active = stream;
          stream.once('data', () => controller.abort(reason));
        }
        callback(error, stream);
      });
    });
    await withPackage(await archive(), async (path) => {
      await expect(validateUpdatePackage(path, expected, controller.signal)).rejects.toBe(reason);
      expect(active?.destroyed).toBe(true);
      expect(closed).toBe(true);
    });
  });

  it('destroys a stream arriving after abort while the local header was pending', async () => {
    const controller = new AbortController();
    const reason = new DOMException('Cancelled pending stream', 'AbortError');
    const openReadStream = ZipFile.prototype.openReadStream;
    let active: Readable | undefined;
    vi.spyOn(ZipFile.prototype, 'openReadStream').mockImplementation(function (this: ZipFile, entry, callback) {
      openReadStream.call(this, entry, (error, stream) => {
        active = stream;
        callback(error, stream);
      });
      controller.abort(reason);
    });
    await withPackage(await archive(), async (path) => {
      await expect(validateUpdatePackage(path, expected, controller.signal)).rejects.toBe(reason);
      expect(active?.destroyed).toBe(true);
    });
  });

  it('preserves cancellation when a late stream error arrives and closes only once', async () => {
    const controller = new AbortController();
    const reason = new Error('cancel stream');
    const stream = new PassThrough();
    const close = vi.spyOn(ZipFile.prototype, 'close');
    vi.spyOn(ZipFile.prototype, 'openReadStream').mockImplementation((_entry, callback) => {
      callback(null, stream);
      controller.abort(reason);
      stream.emit('error', new Error('late read error'));
    });
    await withPackage(await archive(), async (path) => {
      await expect(validateUpdatePackage(path, expected, controller.signal)).rejects.toBe(reason);
      expect(stream.destroyed).toBe(true);
      expect(close).toHaveBeenCalledTimes(1);
    });
  });

  it('closes the ZIP handle before rejecting malformed JSON', async () => {
    let closed = false;
    const readEntry = ZipFile.prototype.readEntry;
    vi.spyOn(ZipFile.prototype, 'readEntry').mockImplementation(function (this: ZipFile) {
      this.once('close', () => { closed = true; });
      readEntry.call(this);
    });
    await rejectsPackage(await archive({ [MANIFEST]: '{' }));
    expect(closed).toBe(true);
  });

  it.each(['error', 'close'] as const)('rejects a manifest stream that emits premature %s', async (event) => {
    const stream = new PassThrough();
    vi.spyOn(ZipFile.prototype, 'openReadStream').mockImplementation((_entry, callback) => {
      callback(null, stream);
      if (event === 'error') stream.emit('error', new Error('private underlying error'));
      else stream.destroy();
    });
    await rejectsPackage(await archive());
    expect(stream.destroyed).toBe(true);
  });
});
