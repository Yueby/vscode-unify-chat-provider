import { UpdateError } from './errors';
import { checkLatestRelease, prepareUpdate, abortable } from './transfer';
import type { UpdateUi } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;
export interface UpdateServiceOptions {
  readonly extensionId: string;
  readonly version: string;
  readonly production: boolean;
  readonly fetcher: typeof fetch;
  readonly ui: UpdateUi;
  readonly isLeader: () => boolean;
  readonly automaticEnabled: () => boolean;
  readonly lastCheck: () => number;
  readonly recordCheck: (time: number) => Promise<void>;
  readonly install: (vsixPath: string) => Promise<void>;
}

/** One local operation through confirmation and installation; only leaders schedule automatic checks. */
export class ReleaseUpdateService {
  private startupTimer?: ReturnType<typeof setTimeout>;
  private interval?: ReturnType<typeof setInterval>;
  private active?: { controller: AbortController; automatic: boolean };
  private inFlight?: Promise<void>;
  private disposed = false;
  private installedVersion: string;

  constructor(private readonly options: UpdateServiceOptions) {
    this.installedVersion = options.version;
  }

  refreshScheduling(): void {
    const enabled = !this.disposed && this.options.production && this.options.isLeader() && this.options.automaticEnabled();
    if (!enabled) {
      if (this.startupTimer) clearTimeout(this.startupTimer);
      if (this.interval) clearInterval(this.interval);
      this.startupTimer = undefined;
      this.interval = undefined;
      if (this.active?.automatic) this.active.controller.abort();
      return;
    }
    if (this.interval) return;
    this.startupTimer = setTimeout(() => {
      this.startupTimer = undefined;
      void this.check(false);
    }, 30000);
    this.interval = setInterval(() => { void this.check(false); }, 60 * 60 * 1000);
  }

  check(manual = true): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    if (!manual) {
      if (!this.options.production || !this.options.isLeader() || !this.options.automaticEnabled()) return Promise.resolve();
      const previous = this.options.lastCheck();
      const now = Date.now();
      if (Number.isFinite(previous) && previous > 0 && now >= previous && now - previous < DAY_MS) return Promise.resolve();
    }
    const controller = new AbortController();
    this.active = { controller, automatic: !manual };
    const work = this.perform(manual, controller.signal).catch(() => {
      // Notification failures must not turn a background timer into an unhandled rejection.
      console.warn('[UCP update] operation failed');
    }).finally(() => {
      if (this.inFlight === work) {
        this.inFlight = undefined;
        this.active = undefined;
      }
    });
    this.inFlight = work;
    return work;
  }

  private async perform(manual: boolean, signal: AbortSignal): Promise<void> {
    let download: Awaited<ReturnType<typeof prepareUpdate>> | undefined;
    let installing = false;
    let userConfirmed = false;
    try {
      await this.options.recordCheck(Date.now());
      signal.throwIfAborted();
      const name = this.options.extensionId.slice(this.options.extensionId.indexOf('.') + 1);
      const release = await checkLatestRelease(this.options.fetcher, this.installedVersion, name, signal);
      signal.throwIfAborted();
      if (!manual && (!this.options.isLeader() || !this.options.automaticEnabled())) return;
      if (!release) {
        if (manual) await this.options.ui.notifyNoUpdate();
        return;
      }
      const confirmed = await abortable(this.options.ui.offerUpdate(release, signal), signal);
      signal.throwIfAborted();
      if (!confirmed || (!manual && (!this.options.isLeader() || !this.options.automaticEnabled()))) return;
      userConfirmed = true;
      const prepared = await this.options.ui.withProgress(async (uiSignal, report) => {
        const combined = AbortSignal.any([signal, uiSignal]);
        return { download: await prepareUpdate(release, this.options.extensionId, this.options.fetcher, combined, report), signal: combined };
      });
      download = prepared.download;
      prepared.signal.throwIfAborted();
      signal.throwIfAborted();
      if (!manual && (!this.options.isLeader() || !this.options.automaticEnabled())) return;
      // The native install command is not cancellable. The cancellable progress ends before it starts.
      installing = true;
      await this.options.install(download.vsixPath);
      this.installedVersion = release.version;
      await download.dispose();
      download = undefined;
      if (!this.disposed) {
        void this.options.ui.notifyInstalled(release.version).catch(() => console.warn('[UCP update] notification failed'));
      }
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) return;
      const code = error instanceof UpdateError ? error.code : installing ? 'install' : 'network';
      if (manual || userConfirmed) await this.options.ui.notifyError(code);
      else console.warn(`[UCP update] ${code}`);
    } finally {
      if (download) await download.dispose();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.refreshScheduling();
    this.active?.controller.abort();
  }
}
