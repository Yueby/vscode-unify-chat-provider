import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createUpdateUi } from '../../src/update/ui';
import type { ReleaseInfo } from '../../src/update/release';

const mockState = vi.hoisted(() => ({
  informationMessageChoice: undefined as string | undefined,
  onInformation: undefined as (() => void) | undefined,
  informationMessageArgs: [] as string[],
  errorMessageText: undefined as string | undefined,
  executedCommands: [] as string[],
  openedUrls: [] as string[],
  progressTitle: '',
  progressCancellable: false,
  progressLocation: 0,
  progressReports: [] as Array<{ increment?: number; message?: string }>,
  tokenInitiallyCancelled: false,
  cancellationDisposableDisposed: false,
}));

vi.mock('vscode', () => {
  class Disposable {
    constructor(private readonly callback: () => void = () => undefined) {}
    dispose(): void {
      this.callback();
    }
  }

  class EventEmitter<T> {
    private readonly listeners = new Set<(value: T) => void>();
    readonly event = (listener: (value: T) => void): Disposable => {
      this.listeners.add(listener);
      return new Disposable(() => this.listeners.delete(listener));
    };
    fire(value: T): void {
      for (const listener of this.listeners) listener(value);
    }
    dispose(): void {
      this.listeners.clear();
    }
  }

  return {
    Disposable,
    ProgressLocation: { Notification: 15 },
    Uri: {
      parse: (val: string) => ({ toString: () => val }),
    },
    env: {
      openExternal: (uri: { toString: () => string }) => {
        mockState.openedUrls.push(uri.toString());
        return Promise.resolve(true);
      },
    },
    commands: {
      executeCommand: (command: string) => {
        mockState.executedCommands.push(command);
        return Promise.resolve();
      },
    },
    window: {
      showInformationMessage: (message: string, ...items: string[]): Promise<string | undefined> => {
        mockState.informationMessageArgs = [message, ...items];
        mockState.onInformation?.();
        return Promise.resolve(mockState.informationMessageChoice);
      },
      showErrorMessage: (message: string): Promise<string | undefined> => {
        mockState.errorMessageText = message;
        return Promise.resolve(undefined);
      },
      withProgress: async <R>(
        options: { location: number; title?: string; cancellable?: boolean },
        task: (
          progress: { report: (value: { increment?: number; message?: string }) => void },
          token: { isCancellationRequested: boolean; onCancellationRequested: (listener: () => void) => Disposable },
        ) => Promise<R>,
      ): Promise<R> => {
        mockState.progressLocation = options.location;
        mockState.progressTitle = options.title ?? '';
        mockState.progressCancellable = options.cancellable ?? false;

        const emitter = new EventEmitter<void>();
        const token = {
          isCancellationRequested: mockState.tokenInitiallyCancelled,
          onCancellationRequested: (cb: () => void) => {
            const innerDisposable = emitter.event(cb);
            return new Disposable(() => {
              mockState.cancellationDisposableDisposed = true;
              innerDisposable.dispose();
            });
          },
        };
        const progress = {
          report: (value: { increment?: number; message?: string }) => {
            mockState.progressReports.push(value);
          },
        };
        return await task(progress, token);
      },
    },
    l10n: {
      t: (message: string, ...args: unknown[]) => {
        return message.replace(/\{(\d+)\}/g, (_match, index) => {
          const idx = Number(index);
          const arg = args[idx];
          return arg !== undefined ? String(arg) : '';
        });
      },
    },
  };
});

describe('github-update-ui', () => {
  const dummyRelease: ReleaseInfo = {
    version: '8.15.0',
    tag: 'v8.15.0',
    pageUrl: 'https://github.com/Yueby/vscode-unify-chat-provider/releases/tag/v8.15.0',
    vsix: {
      name: 'vscode-unify-chat-provider-8.15.0.vsix',
      url: 'https://github.com/Yueby/vscode-unify-chat-provider/releases/download/v8.15.0/vscode-unify-chat-provider-8.15.0.vsix',
      size: 1024,
    },
    checksum: {
      name: 'vscode-unify-chat-provider-8.15.0.vsix.sha256',
      url: 'https://github.com/Yueby/vscode-unify-chat-provider/releases/download/v8.15.0/vscode-unify-chat-provider-8.15.0.vsix.sha256',
      size: 64,
    },
  };

  beforeEach(() => {
    mockState.informationMessageChoice = undefined;
    mockState.onInformation = undefined;
    mockState.informationMessageArgs = [];
    mockState.errorMessageText = undefined;
    mockState.executedCommands = [];
    mockState.openedUrls = [];
    mockState.progressTitle = '';
    mockState.progressCancellable = false;
    mockState.progressLocation = 0;
    mockState.progressReports = [];
    mockState.tokenInitiallyCancelled = false;
    mockState.cancellationDisposableDisposed = false;
  });

  describe('offerUpdate', () => {
    it('returns false immediately when signal is already aborted', async () => {
      const ui = createUpdateUi();
      const controller = new AbortController();
      controller.abort();

      const result = await ui.offerUpdate(dummyRelease, controller.signal);
      expect(result).toBe(false);
      expect(mockState.informationMessageArgs.length).toBe(0);
    });

    it('returns true when user confirms Install Update and signal is still active', async () => {
      const ui = createUpdateUi();
      mockState.informationMessageChoice = 'Install Update';
      const controller = new AbortController();

      const result = await ui.offerUpdate(dummyRelease, controller.signal);
      expect(result).toBe(true);
      expect(mockState.informationMessageArgs[0]).toContain('v8.15.0');
      expect(mockState.openedUrls.length).toBe(0);
    });

    it('returns false when user confirms Install Update but signal aborts during interaction', async () => {
      const ui = createUpdateUi();
      const controller = new AbortController();
      mockState.informationMessageChoice = 'Install Update';

      mockState.onInformation = () => controller.abort();

      const result = await ui.offerUpdate(dummyRelease, controller.signal);
      expect(result).toBe(false);
    });

    it('opens notes and returns false when Release Notes is selected and signal is alive', async () => {
      const ui = createUpdateUi();
      mockState.informationMessageChoice = 'Release Notes';
      const controller = new AbortController();

      const result = await ui.offerUpdate(dummyRelease, controller.signal);
      expect(result).toBe(false);
      expect(mockState.openedUrls).toEqual([dummyRelease.pageUrl]);
    });

    it('does not open notes when Release Notes is selected but signal aborted', async () => {
      const ui = createUpdateUi();
      const controller = new AbortController();

      mockState.informationMessageChoice = 'Release Notes';
      mockState.onInformation = () => controller.abort();

      const result = await ui.offerUpdate(dummyRelease, controller.signal);
      expect(result).toBe(false);
      expect(mockState.openedUrls.length).toBe(0);
    });

    it('returns false when user selects Later or dismisses notification', async () => {
      const ui = createUpdateUi();
      const controller = new AbortController();

      mockState.informationMessageChoice = 'Later';
      expect(await ui.offerUpdate(dummyRelease, controller.signal)).toBe(false);

      mockState.informationMessageChoice = undefined;
      expect(await ui.offerUpdate(dummyRelease, controller.signal)).toBe(false);
      expect(mockState.openedUrls.length).toBe(0);
    });
  });

  describe('withProgress', () => {
    it('sets correct title, location and cancellable options, and reports monotonic progress', async () => {
      const ui = createUpdateUi();
      let receivedSignal: AbortSignal | undefined;

      const result = await ui.withProgress(async (signal, report) => {
        receivedSignal = signal;
        report(20);
        report(15); // should be ignored as non-monotonic
        report(50);
        report(100);
        report(120); // clamped to 100
        return 'ok';
      });

      expect(result).toBe('ok');
      expect(mockState.progressLocation).toBe(15);
      expect(mockState.progressTitle).toBe('Downloading and verifying update...');
      expect(mockState.progressCancellable).toBe(true);
      expect(receivedSignal?.aborted).toBe(false);
      expect(mockState.cancellationDisposableDisposed).toBe(true);
      expect(mockState.progressReports).toEqual([
        { increment: 20, message: '20%' },
        { increment: 30, message: '50%' },
        { increment: 50, message: '100%' },
      ]);
    });

    it('aborts bridged signal immediately if token is already cancelled', async () => {
      const ui = createUpdateUi();
      mockState.tokenInitiallyCancelled = true;

      let signalAborted = false;
      await ui.withProgress(async (signal) => {
        signalAborted = signal.aborted;
      });

      expect(signalAborted).toBe(true);
      expect(mockState.cancellationDisposableDisposed).toBe(true);
    });
  });

  describe('notifyNoUpdate', () => {
    it('shows non-assertive message indicating no published update available', async () => {
      const ui = createUpdateUi();
      await ui.notifyNoUpdate();
      expect(mockState.informationMessageArgs[0]).toBe('No published update available.');
    });
  });

  describe('notifyInstalled', () => {
    it('triggers reload only when user explicitly clicks Reload Window', async () => {
      const ui = createUpdateUi();

      mockState.informationMessageChoice = 'Later';
      await ui.notifyInstalled('8.15.0');
      expect(mockState.executedCommands).toEqual([]);

      mockState.informationMessageChoice = undefined;
      await ui.notifyInstalled('8.15.0');
      expect(mockState.executedCommands).toEqual([]);

      mockState.informationMessageChoice = 'Reload Window';
      await ui.notifyInstalled('8.15.0');
      expect(mockState.executedCommands).toEqual(['workbench.action.reloadWindow']);
    });
  });

  describe('notifyError', () => {
    it('maps all error codes to static localized messages without leaking raw details', async () => {
      const ui = createUpdateUi();

      await ui.notifyError('network');
      expect(mockState.errorMessageText).toBe('Update check failed: network connection error.');

      await ui.notifyError('invalid-release');
      expect(mockState.errorMessageText).toBe('Update check failed: invalid release format or manifest.');

      await ui.notifyError('checksum');
      expect(mockState.errorMessageText).toBe('Update check failed: SHA256 checksum mismatch.');

      await ui.notifyError('invalid-package');
      expect(mockState.errorMessageText).toBe('Update check failed: extension package verification failed.');

      await ui.notifyError('install');
      expect(mockState.errorMessageText).toBe('Update installation failed. Please try again later.');
    });
  });
});
