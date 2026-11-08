import * as vscode from 'vscode';
import { t } from '../i18n';
import type { UpdateErrorCode } from './errors';
import type { ReleaseInfo } from './release';
import type { UpdateUi } from './types';

export function createUpdateUi(): UpdateUi {
  return {
    async offerUpdate(release: ReleaseInfo, signal: AbortSignal): Promise<boolean> {
      if (signal.aborted) {
        return false;
      }

      const btnInstall = t('Install Update');
      const btnNotes = t('Release Notes');
      const btnLater = t('Later');

      const message = t('A new version of Unify Chat Provider is available: v{0}', release.version);
      const choice = await vscode.window.showInformationMessage(message, btnInstall, btnNotes, btnLater);

      if (signal.aborted) {
        return false;
      }

      if (choice === btnNotes) {
        try {
          await vscode.env.openExternal(vscode.Uri.parse(release.pageUrl));
        } catch {
          // 静默降级
        }
        return false;
      }

      if (choice === btnInstall) {
        return true;
      }

      return false;
    },

    async withProgress<T>(
      task: (signal: AbortSignal, report: (percent: number) => void) => Promise<T>,
    ): Promise<T> {
      return await vscode.window.withProgress<T>(
        {
          location: vscode.ProgressLocation.Notification,
          title: t('Downloading and verifying update...'),
          cancellable: true,
        },
        async (progress, token) => {
          const controller = new AbortController();

          if (token.isCancellationRequested) {
            controller.abort();
          }

          const registration = token.onCancellationRequested(() => {
            controller.abort();
          });

          let lastPercent = 0;
          const report = (percent: number): void => {
            const clamped = Math.max(0, Math.min(100, Math.floor(percent)));
            if (clamped > lastPercent) {
              const increment = clamped - lastPercent;
              lastPercent = clamped;
              progress.report({ increment, message: `${clamped}%` });
            }
          };

          try {
            return await task(controller.signal, report);
          } finally {
            registration.dispose();
          }
        },
      );
    },

    async notifyNoUpdate(): Promise<void> {
      await vscode.window.showInformationMessage(t('No published update available.'));
    },

    async notifyInstalled(version: string): Promise<void> {
      const btnReload = t('Reload Window');
      const btnLater = t('Later');
      const choice = await vscode.window.showInformationMessage(
        t('Update installed (v{0}). Reload to apply changes.', version),
        btnReload,
        btnLater,
      );
      if (choice === btnReload) {
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    },

    async notifyError(code: UpdateErrorCode): Promise<void> {
      const messageMap: Record<UpdateErrorCode, string> = {
        network: t('Update check failed: network connection error.'),
        'invalid-release': t('Update check failed: invalid release format or manifest.'),
        checksum: t('Update check failed: SHA256 checksum mismatch.'),
        'invalid-package': t('Update check failed: extension package verification failed.'),
        install: t('Update installation failed. Please try again later.'),
      };
      const message = messageMap[code];
      if (message) {
        await vscode.window.showErrorMessage(message);
      }
    },
  };
}
