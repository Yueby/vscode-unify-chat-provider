import * as vscode from 'vscode';
import { createCustomFetch } from '../client/utils';
import { resolveChatNetwork } from '../utils';
import { mainInstance } from '../main-instance';
import { ReleaseUpdateService } from './service';
import { createUpdateUi } from './ui';
import { UpdateError } from './errors';

export const CHECK_UPDATE_COMMAND = 'unifyChatProvider.checkForUpdates';
const AUTO_CHECK_SETTING = 'unifyChatProvider.updates.checkAutomatically';
const LAST_CHECK_KEY = 'githubReleaseUpdate.lastCheck';

/** Application proxy routing with mandatory certificate verification for executable updates. */
export function createReleaseFetcher(): typeof fetch {
  return (input, init) => {
    const proxy = resolveChatNetwork(undefined).proxy;
    const strictSSL = vscode.workspace.getConfiguration('http').get<boolean>('proxyStrictSSL', true);
    if (!strictSSL || proxy?.strictSSL === false || process.env['NODE_TLS_REJECT_UNAUTHORIZED'] === '0') {
      // Update authenticity depends on HTTPS; relaxed chat TLS settings must not weaken code updates.
      console.warn('[UCP update] TLS certificate validation is required');
      return Promise.reject(new UpdateError('network'));
    }
    return createCustomFetch({
      type: 'normal', proxy,
      connectionTimeoutMs: 8000, responseTimeoutMs: 30000, retryConfig: { maxRetries: 0 },
    })(input, init);
  };
}

export function registerReleaseUpdates(context: vscode.ExtensionContext): void {
  const manifest: unknown = context.extension.packageJSON;
  const version: unknown = typeof manifest === 'object' && manifest !== null ? Reflect.get(manifest, 'version') : undefined;
  if (typeof version !== 'string') return;
  const fetcher = createReleaseFetcher();
  const service = new ReleaseUpdateService({
    extensionId: context.extension.id, version,
    production: context.extensionMode === vscode.ExtensionMode.Production,
    fetcher, ui: createUpdateUi(),
    isLeader: () => mainInstance.isLeader(),
    automaticEnabled: () => vscode.workspace.getConfiguration().get<boolean>(AUTO_CHECK_SETTING, true),
    lastCheck: () => context.globalState.get<number>(LAST_CHECK_KEY, 0),
    recordCheck: async (time) => { await context.globalState.update(LAST_CHECK_KEY, time); },
    install: async (vsixPath) => {
      await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(vsixPath));
    },
  });
  context.subscriptions.push(
    service,
    vscode.commands.registerCommand(CHECK_UPDATE_COMMAND, () => service.check(true)),
    mainInstance.onDidChangeRole(() => service.refreshScheduling()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(AUTO_CHECK_SETTING)) service.refreshScheduling();
    }),
  );
  service.refreshScheduling();
}
