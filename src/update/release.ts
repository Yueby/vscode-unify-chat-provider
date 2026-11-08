import { UpdateError } from './errors';

export const UPDATE_REPOSITORY = 'Yueby/vscode-unify-chat-provider';
export const LATEST_RELEASE_URL = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`;
export const MAX_VSIX_BYTES = 100 * 1024 * 1024;

export interface ReleaseAsset {
  readonly name: string;
  readonly url: string;
  readonly size: number;
}
export interface ReleaseInfo {
  readonly version: string;
  readonly tag: string;
  readonly pageUrl: string;
  readonly vsix: ReleaseAsset;
  readonly checksum: ReleaseAsset;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function stableVersion(value: string): number[] {
  if (value.trim() !== value || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw new UpdateError('invalid-release');
  const parts = value.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new UpdateError('invalid-release');
  return parts;
}
export function compareVersions(left: string, right: string): number {
  const a = stableVersion(left), b = stableVersion(right);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

export function checkedUrl(raw: string, kind: 'page' | 'asset' | 'redirect'): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new UpdateError('invalid-release'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || url.hash) {
    throw new UpdateError('invalid-release');
  }
  if (kind !== 'redirect') {
    const prefix = kind === 'page' ? `/${UPDATE_REPOSITORY}/releases/tag/` : `/${UPDATE_REPOSITORY}/releases/download/`;
    if (url.hostname !== 'github.com' || !url.pathname.startsWith(prefix) || url.search) throw new UpdateError('invalid-release');
  } else if (!['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)) {
    throw new UpdateError('invalid-release');
  }
  return url;
}

export function parseLatestRelease(raw: unknown, currentVersion: string, extensionName: string): ReleaseInfo | undefined {
  stableVersion(currentVersion);
  if (!record(raw)) throw new UpdateError('invalid-release');
  if (raw['draft'] === true || raw['prerelease'] === true) return undefined;
  if (raw['draft'] !== false || raw['prerelease'] !== false || typeof raw['tag_name'] !== 'string') throw new UpdateError('invalid-release');
  const tag = raw['tag_name'];
  if (!tag.startsWith('v')) throw new UpdateError('invalid-release');
  const version = tag.slice(1);
  if (compareVersions(version, currentVersion) <= 0) return undefined;
  const pageUrl = `https://github.com/${UPDATE_REPOSITORY}/releases/tag/${tag}`;
  const assets: unknown = raw['assets'];
  if (raw['html_url'] !== pageUrl || !Array.isArray(assets)) throw new UpdateError('invalid-release');
  checkedUrl(pageUrl, 'page');
  const expectedName = `${extensionName}-${version}.vsix`;
  const asset = (name: string, max: number): ReleaseAsset => {
    const matches = assets.filter((item: unknown) => record(item) && item['name'] === name);
    if (matches.length !== 1 || !record(matches[0])) throw new UpdateError('invalid-release');
    const value = matches[0];
    if (typeof value['browser_download_url'] !== 'string' || !Number.isSafeInteger(value['size']) ||
      typeof value['size'] !== 'number' || value['size'] <= 0 || value['size'] > max) throw new UpdateError('invalid-release');
    const url = checkedUrl(value['browser_download_url'], 'asset');
    if (url.pathname !== `/${UPDATE_REPOSITORY}/releases/download/${tag}/${name}`) throw new UpdateError('invalid-release');
    return { name, url: url.toString(), size: value['size'] };
  };
  return { version, tag, pageUrl, vsix: asset(expectedName, MAX_VSIX_BYTES), checksum: asset(`${expectedName}.sha256`, 4096) };
}
