import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { EXTENSION_ID } from '../../src/extension-identity';

const state = vi.hoisted(() => ({ getExtension: vi.fn() }));
vi.mock('vscode', () => ({
  env: { language: 'en' },
  workspace: { getConfiguration: () => ({ get: () => undefined }) },
  extensions: { getExtension: state.getExtension },
}));
vi.mock('../../src/i18n', () => ({ t: (message: string) => message }));
vi.mock('../../src/client/definitions', () => ({ FeatureId: {}, FEATURES: {}, PROVIDER_TYPES: {} }));
vi.mock('../../src/utils', () => ({}));

function manifest(): { publisher: string; name: string; version: string } {
  const raw: unknown = JSON.parse(readFileSync('package.json', 'utf8'));
  if (!raw || typeof raw !== 'object') throw new Error('Expected package manifest');
  const publisher: unknown = Reflect.get(raw, 'publisher');
  const name: unknown = Reflect.get(raw, 'name');
  const version: unknown = Reflect.get(raw, 'version');
  if (typeof publisher !== 'string' || typeof name !== 'string' || typeof version !== 'string') {
    throw new Error('Expected manifest identity');
  }
  return { publisher, name, version };
}

describe('personal extension identity', () => {
  it('matches the runtime identity to the package publisher and name', () => {
    const pkg = manifest();
    expect(pkg.publisher).toBe('Yueby');
    expect(pkg.name).toBe('vscode-unify-chat-provider');
    expect(EXTENSION_ID).toBe(`${pkg.publisher}.${pkg.name}`);
  });

  it('reads the installed personal extension version for unified request metadata', async () => {
    state.getExtension.mockReturnValue({ packageJSON: { version: manifest().version } });
    const { getUnifiedUserAgent } = await import('../../src/client/utils');
    expect(getUnifiedUserAgent()).toBe(`ucp/${manifest().version}`);
    expect(state.getExtension).toHaveBeenCalledWith(EXTENSION_ID);
  });

  it('keeps development and E2E proposal arguments aligned with the package identity', () => {
    for (const path of ['.vscode/launch.json', 'test/e2e/run.ts']) {
      const text = readFileSync(path, 'utf8');
      expect(text).toContain(`--enable-proposed-api=${EXTENSION_ID}`);
      expect(text).not.toContain('--enable-proposed-api=SmallMain.vscode-unify-chat-provider');
    }
    expect(readFileSync('test/e2e/suite/index.ts', 'utf8')).toContain(EXTENSION_ID);
  });
});
