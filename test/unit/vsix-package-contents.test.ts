import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const workspaceRoot = process.cwd();
const vsce = resolve(workspaceRoot, 'node_modules/@vscode/vsce/vsce');
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ucp-vsix-contents-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('VSIX package contents', () => {
  it('excludes test-only runtime modules while retaining production entrypoints and assets', async () => {
    const production = [
      'out/extension.js',
      'out/client/openai/responses-client.js',
      'out/client/zed/chat-codecs.js',
      'out/secret/secret-store.js',
      'dist/chat-lib-parser.cjs',
      'dist/chat-lib-diff.cjs',
      'dist/tree-sitter.wasm',
    ];
    const testModules = [
      'out/auth/test-control',
      'out/completion/test-control',
      'out/completion/test-harness',
      'out/completion/model/testing-resolver',
      'out/secret/e2e-file-secret-storage',
    ].flatMap((file) => [`${file}.js`, `${file}.js.map`]);
    const excluded = [
      ...testModules,
      'src/extension.ts',
      'test/unit/fixture.test.ts',
      'out-test/e2e/run.js',
      'scripts/fixture.ts',
      '.env.package-fixture',
    ];
    await writeFile(join(root, 'package.json'), JSON.stringify({
      name: 'ucp-package-fixture', publisher: 'ucp-e2e', version: '1.0.0',
      engines: { vscode: '^1.115.0' }, main: './out/extension.js',
      activationEvents: ['onStartupFinished'],
    }));
    await writeFile(join(root, '.vscodeignore'), await readFile(join(workspaceRoot, '.vscodeignore')));
    await Promise.all([...production, ...excluded].map(async (file) => {
      const target = join(root, file);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, 'fixture\n');
    }));

    const { stdout } = await execute(process.execPath, [vsce, 'ls', '--no-dependencies'], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 25000,
    });
    const files = stdout.split(/\r?\n/).filter(Boolean)
      .map((file) => file.replaceAll(String.fromCharCode(92), '/'));
    expect(files).toEqual(expect.arrayContaining(['package.json', ...production]));
    expect(excluded.filter((file) => files.includes(file))).toEqual([]);
  }, 30000);
});
