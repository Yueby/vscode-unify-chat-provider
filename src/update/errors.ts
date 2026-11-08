export type UpdateErrorCode = 'network' | 'invalid-release' | 'checksum' | 'invalid-package' | 'install';

/** Static diagnostics only: remote bodies, signed URLs and credentials stay out of update errors. */
export class UpdateError extends Error {
  constructor(readonly code: UpdateErrorCode) {
    super(`GitHub update failed: ${code}`);
    this.name = 'UpdateError';
  }
}
