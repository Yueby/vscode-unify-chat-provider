import type { ReleaseInfo } from './release';
import type { UpdateErrorCode } from './errors';

export interface UpdateUi {
  offerUpdate(release: ReleaseInfo, signal: AbortSignal): Promise<boolean>;
  withProgress<T>(task: (signal: AbortSignal, report: (percent: number) => void) => Promise<T>): Promise<T>;
  notifyNoUpdate(): Promise<void>;
  notifyInstalled(version: string): Promise<void>;
  notifyError(code: UpdateErrorCode): Promise<void>;
}
