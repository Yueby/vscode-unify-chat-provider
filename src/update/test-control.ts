import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import * as vscode from 'vscode';
import type { UpdateErrorCode } from './errors';
import { LATEST_RELEASE_URL, UPDATE_REPOSITORY } from './release';
import { ReleaseUpdateService } from './service';

const FIXTURE_ID = 'Yueby.ucp-update-e2e-fixture';
const FIXTURE_VERSION = '0.0.2';

function isTemporaryPath(value: string): boolean {
  const child = relative(tmpdir(), value);
  return isAbsolute(value) && child.length > 0 && child !== '..'
    && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

async function isMissing(file: string): Promise<boolean> {
  try {
    await access(file);
    return false;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return true;
    throw error;
  }
}

/** Loaded only by the ExtensionMode.Test activation hook; never packaged. */
export function registerUpdateTestCommands(context: vscode.ExtensionContext): void {
  if (context.extensionMode !== vscode.ExtensionMode.Test) return;
  context.subscriptions.push(vscode.commands.registerCommand(
    'unifyChatProvider.update.test.run',
    async (vsixPath: unknown, extensionsDir: unknown) => {
      if (typeof vsixPath !== 'string' || typeof extensionsDir !== 'string'
        || !isTemporaryPath(vsixPath) || !isTemporaryPath(extensionsDir)
        || extensionsDir !== process.env['UCP_E2E_EXTENSIONS_DIR']) {
        throw new Error('Update E2E requires fixture paths in the isolated temporary runner.');
      }
      const bytes = await readFile(vsixPath);
      const name = `ucp-update-e2e-fixture-${FIXTURE_VERSION}.vsix`;
      const digest = createHash('sha256').update(bytes).digest('hex');
      const checksum = `${digest}  ${name}\n`;
      const base = `https://github.com/${UPDATE_REPOSITORY}/releases`;
      const assetUrl = `${base}/download/v${FIXTURE_VERSION}/${name}`;
      const releaseJSON = {
        draft: false,
        prerelease: false,
        tag_name: `v${FIXTURE_VERSION}`,
        html_url: `${base}/tag/v${FIXTURE_VERSION}`,
        assets: [
          { name, browser_download_url: assetUrl, size: bytes.length },
          { name: `${name}.sha256`, browser_download_url: `${assetUrl}.sha256`, size: Buffer.byteLength(checksum) },
        ],
      };
      let requestCount = 0;
      const fetcher: typeof fetch = async (input, init) => {
        init?.signal?.throwIfAborted();
        requestCount += 1;
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url === LATEST_RELEASE_URL) return new Response(JSON.stringify(releaseJSON));
        if (url === `${assetUrl}.sha256`) return new Response(checksum);
        if (url === assetUrl) return new Response(new Uint8Array(bytes));
        throw new Error('Unexpected update E2E request.');
      };
      let confirmCount = 0;
      let progressCount = 0;
      let installCount = 0;
      let installedCount = 0;
      let noUpdateCount = 0;
      let downloadedPath: string | undefined;
      const errors: UpdateErrorCode[] = [];
      const service = new ReleaseUpdateService({
        extensionId: FIXTURE_ID,
        version: '0.0.1',
        production: false,
        fetcher,
        isLeader: () => true,
        automaticEnabled: () => false,
        lastCheck: () => 0,
        recordCheck: async () => {},
        ui: {
          offerUpdate: async () => { confirmCount += 1; return true; },
          withProgress: async (task) => task(new AbortController().signal, () => { progressCount += 1; }),
          notifyNoUpdate: async () => { noUpdateCount += 1; },
          notifyInstalled: async () => { installedCount += 1; },
          notifyError: async (code) => { errors.push(code); },
        },
        install: async (tempDownloadedVsix) => {
          downloadedPath = tempDownloadedVsix;
          installCount += 1;
          await vscode.commands.executeCommand(
            'workbench.extensions.installExtension', vscode.Uri.file(tempDownloadedVsix),
          );
        },
      });
      try {
        await service.check();
        const manifestPath = join(extensionsDir, 'yueby.ucp-update-e2e-fixture-0.0.2', 'package.json');
        let installedManifestMatches = false;
        if (!await isMissing(manifestPath)) {
          const manifest: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
          installedManifestMatches = typeof manifest === 'object' && manifest !== null
            && 'publisher' in manifest && manifest.publisher === 'Yueby'
            && 'name' in manifest && manifest.name === 'ucp-update-e2e-fixture'
            && 'version' in manifest && manifest.version === FIXTURE_VERSION;
        }
        return {
          requestCount, confirmCount, progressCount, installCount, installedCount, noUpdateCount,
          errorCount: errors.length,
          installedManifestMatches,
          downloadRemoved: downloadedPath !== undefined && await isMissing(downloadedPath),
        };
      } finally {
        service.dispose();
      }
    },
  ));
}
