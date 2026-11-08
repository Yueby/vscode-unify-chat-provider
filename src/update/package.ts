import type { Readable } from 'node:stream';
import { open, type Entry, type ZipFile } from 'yauzl';
import { UpdateError } from './errors';

const MAX_ZIP_BYTES = 100 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MANIFEST_PATH = 'extension/package.json';

type Outcome = { ok: true } | { ok: false; error: unknown };

function isSize(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function matchesManifest(value: unknown, expected: { extensionId: string; version: string }): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const manifest = value as Record<string, unknown>;
  return typeof manifest.publisher === 'string' && manifest.publisher.length > 0
    && typeof manifest.name === 'string' && manifest.name.length > 0
    && `${manifest.publisher}.${manifest.name}`.toLowerCase() === expected.extensionId.toLowerCase()
    && typeof manifest.version === 'string' && manifest.version === expected.version
    && (manifest.extensionPack === undefined
      || (Array.isArray(manifest.extensionPack) && manifest.extensionPack.length === 0));
}

/** Validate the archive and its identity in memory, without extracting any entry. */
export async function validateUpdatePackage(
  filePath: string,
  expected: { extensionId: string; version: string },
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    let zip: ZipFile | undefined;
    let activeStream: Readable | undefined;
    let opening = true;
    let outcome: Outcome | undefined;
    let entries = 0;
    let totalSize = 0;
    let manifestRead = false;
    const paths = new Set<string>();

    const settle = (): void => {
      if (!outcome) return;
      if (outcome.ok) resolve();
      else reject(outcome.error);
    };
    const finish = (result: Outcome): void => {
      if (outcome) return;
      outcome = result;
      signal?.removeEventListener('abort', onAbort);
      activeStream?.destroy();
      // Wait for close (including pending reads) before publishing the result.
      // If open is still pending, its callback owns closing the arriving handle.
      if (zip) zip.close();
      else if (!opening) settle();
    };
    const invalid = (): void => finish({ ok: false, error: new UpdateError('invalid-package') });
    const onAbort = (): void => finish({
      ok: false,
      error: signal ? signal.reason : new DOMException('The operation was aborted.', 'AbortError'),
    });
    const next = (): void => {
      if (outcome) return;
      try {
        zip?.readEntry();
      } catch {
        invalid();
      }
    };

    const onEntry = (entry: Entry): void => {
      if (outcome || !zip) return;
      entries += 1;
      const path = entry.fileName.endsWith('/') ? entry.fileName.slice(0, -1) : entry.fileName;
      const foldedPath = path.toLowerCase();
      if (entries > MAX_ENTRIES
        || !isSize(entry.compressedSize) || !isSize(entry.uncompressedSize)
        || !isSize(entry.relativeOffsetOfLocalHeader)
        || entry.compressedSize > zip.fileSize
        || entry.uncompressedSize > MAX_UNCOMPRESSED_BYTES - totalSize
        || entry.isEncrypted() || ![0, 8].includes(entry.compressionMethod)
        || ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000
        || path.includes('\0') || path.includes(':') || path.split('/').some((segment) => !segment || /[. ]$/.test(segment))
        || paths.has(foldedPath)) {
        invalid();
        return;
      }
      paths.add(foldedPath);
      totalSize += entry.uncompressedSize;
      if (entry.fileName !== MANIFEST_PATH) {
        next();
        return;
      }
      if (manifestRead || entry.uncompressedSize > MAX_MANIFEST_BYTES) {
        invalid();
        return;
      }
      try {
        zip.openReadStream(entry, (error, stream) => {
          if (error) {
            invalid();
            return;
          }
          // A stream can arrive after cancellation while its local header was read.
          stream.on('error', invalid);
          if (outcome) {
            stream.destroy();
            return;
          }
          activeStream = stream;
          const chunks: Buffer[] = [];
          let bytes = 0;
          let ended = false;
          stream.on('data', (chunk: unknown) => {
            if (outcome) return;
            if (!Buffer.isBuffer(chunk) || chunk.length > MAX_MANIFEST_BYTES - bytes) {
              invalid();
              return;
            }
            bytes += chunk.length;
            chunks.push(chunk);
          });
          stream.once('close', () => {
            if (!ended && !outcome) invalid();
          });
          stream.once('end', () => {
            ended = true;
            activeStream = undefined;
            if (outcome) return;
            try {
              const manifest: unknown = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
              if (bytes !== entry.uncompressedSize || !matchesManifest(manifest, expected)) {
                invalid();
                return;
              }
              manifestRead = true;
              next();
            } catch {
              invalid();
            }
          });
        });
      } catch {
        invalid();
      }
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      open(filePath, {
        lazyEntries: true,
        autoClose: false,
        validateEntrySizes: true,
        strictFileNames: true,
      }, (error, openedZip) => {
        opening = false;
        if (error) {
          if (outcome) settle();
          else invalid();
          return;
        }
        zip = openedZip;
        zip.on('error', invalid);
        zip.once('close', () => {
          if (!outcome) invalid();
          settle();
        });
        if (outcome) {
          zip.close();
          return;
        }
        zip.on('entry', onEntry);
        zip.once('end', () => {
          if (manifestRead && entries === zip?.entryCount) finish({ ok: true });
          else invalid();
        });
        if (!isSize(zip.fileSize) || zip.fileSize > MAX_ZIP_BYTES
          || !isSize(zip.entryCount) || zip.entryCount > MAX_ENTRIES) {
          invalid();
          return;
        }
        next();
      });
    } catch {
      opening = false;
      if (outcome) settle();
      else invalid();
    }
  });
}
