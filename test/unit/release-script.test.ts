import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';

type TestRepository = {
  root: string;
  origin: string;
  release: string;
  rival: string;
};

type ToolCall = {
  tool: string;
  args: string[];
};

const releaseScript = resolve(process.cwd(), 'scripts/release.mts');
const realVsce = resolve(process.cwd(), 'node_modules/@vscode/vsce/vsce');
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe('release script coordination', () => {
  it(
    'stops before external publishing when origin/main advances before the atomic push',
    async () => {
      const repository = await createRepository();
      const toolsDirectory = join(repository.root, 'tools');
      const callLog = join(repository.root, 'tool-calls.jsonl');
      await mkdir(toolsDirectory, { recursive: true });
      await installFakeTools(toolsDirectory);

      const result = runRelease(
        repository.release,
        ['--yes', '--version', '1.1.0'],
        {
          PATH: `${toolsDirectory}:${process.env.PATH ?? ''}`,
          REAL_VSCE: realVsce,
          RELEASE_TEST_CALL_LOG: callLog,
          RELEASE_TEST_ADVANCE_REPO: repository.rival,
        },
      );

      expect(result.status).not.toBe(0);
      expect(`${result.stderr}\n${result.stdout}`).toContain(
        'failed to push some refs',
      );

      const calls = await readToolCalls(callLog);
      expect(calls.some((call) => call.tool === 'vsce' && call.args[0] === 'show')).toBe(true);
      expect(calls.some((call) => call.tool === 'vsce' && call.args[0] === 'package')).toBe(true);
      expect(calls.some((call) => call.tool === 'vsce' && call.args[0] === 'publish')).toBe(false);
      expect(calls.some((call) => call.tool === 'gh' && call.args[1] === 'create')).toBe(false);
      expect(calls.some((call) => call.tool === 'gh' && call.args[1] === 'upload')).toBe(false);

      expect(
        run('git', ['ls-remote', '--tags', repository.origin, 'v1.1.0'], repository.release).stdout.trim(),
      ).toBe('');
      expect(
        run('git', ['log', '-1', '--format=%s', 'refs/remotes/origin/main'], repository.rival).stdout.trim(),
      ).toBe('rival advance');
    },
    60_000,
  );

  it(
    'reconciles ambiguous external responses by matching remote VSIX hashes',
    async () => {
      const repository = await createRepository();
      const toolsDirectory = join(repository.root, 'tools');
      const callLog = join(repository.root, 'tool-calls.jsonl');
      const marketplaceState = join(repository.root, 'marketplace.json');
      const githubState = join(repository.root, 'github-release.json');
      await mkdir(toolsDirectory, { recursive: true });
      await installFakeTools(toolsDirectory);

      const result = runRelease(
        repository.release,
        ['--yes', '--version', '1.1.0'],
        {
          ...process.env,
          PATH: `${toolsDirectory}:${process.env.PATH ?? ''}`,
          REAL_VSCE: realVsce,
          RELEASE_TEST_CALL_LOG: callLog,
          RELEASE_TEST_MARKETPLACE_STATE: marketplaceState,
          RELEASE_TEST_GITHUB_STATE: githubState,
          RELEASE_TEST_AMBIGUOUS_RESPONSES: 'true',
          RELEASE_TEST_DELAYED_MARKETPLACE_VISIBILITY: 'true',
        },
      );

      expect(`${result.stderr}\n${result.stdout}`).not.toContain('failed (attempt');
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        'VS Code Marketplace publication verified: TestPublisher.test-extension@1.1.0.',
      );
      expect(result.stdout).toContain(
        'GitHub Release publication verified: v1.1.0.',
      );
      expect(result.stdout).toContain(
        'Release reconciliation succeeded for v1.1.0',
      );
      expect(result.stdout).toContain(
        'despite an ambiguous create response',
      );
      expect(result.stdout).toContain(
        'despite an ambiguous upload response',
      );
      expect(`${result.stderr}\n${result.stdout}`).toContain(
        'switching to read-only reconciliation',
      );

      const remoteTag = run(
        'git',
        ['ls-remote', repository.origin, 'refs/tags/v1.1.0^{}'],
        repository.release,
      ).stdout.trim();
      expect(remoteTag).not.toBe('');

      const calls = await readToolCalls(callLog);
      expect(calls.some((call) => call.tool === 'vsce' && call.args[0] === 'publish')).toBe(true);
      expect(calls.some((call) => call.tool === 'gh' && call.args[1] === 'create')).toBe(true);
      const assetPath = join(repository.release, 'test-extension-1.1.0.vsix');
      expect(calls.filter((call) => call.tool === 'gh' && call.args[1] === 'upload')
        .map((call) => call.args[3])).toEqual([assetPath, `${assetPath}.sha256`]);
      await expectChecksum(assetPath);
      expect(JSON.parse(await readFile(githubState, 'utf8'))).toMatchObject({
        assets: [
          { name: 'test-extension-1.1.0.vsix' },
          { name: 'test-extension-1.1.0.vsix.sha256' },
        ],
      });
    },
    60_000,
  );

  it('rejects resume when the tag and package version disagree', async () => {
    const repository = await createRepository();
    runOk('git', ['tag', '-a', 'v1.1.0', '-m', 'v1.1.0'], repository.release);
    runOk('git', ['push', 'origin', 'v1.1.0'], repository.release);
    runOk('git', ['checkout', '--detach', 'v1.1.0'], repository.release);

    const result = runRelease(repository.release, [
      '--yes',
      '--resume-from-tag',
      'v1.1.0',
      '--skip-publish',
      '--skip-github',
    ]);

    expect(result.status).not.toBe(0);
    expect(`${result.stderr}\n${result.stdout}`).toContain(
      'Tag/package version mismatch: v1.1.0 contains package version 1.0.0.',
    );
  }, 60_000);

  it('keeps the repository unchanged during a full dry-run', async () => {
    const repository = await createRepository();
    const before = run('git', ['rev-parse', 'HEAD'], repository.release).stdout.trim();

    const result = runRelease(repository.release, [
      '--yes',
      '--dry-run',
      '--version',
      '1.1.0',
      '--skip-publish',
      '--skip-github',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'Dry-run: no repository files modified and no mutating commands executed.',
    );
    expect(run('git', ['rev-parse', 'HEAD'], repository.release).stdout.trim()).toBe(before);
    expect(run('git', ['status', '--porcelain'], repository.release).stdout.trim()).toBe('');
    expect(run('git', ['tag', '--list', 'v1.1.0'], repository.release).stdout.trim()).toBe('');
    const packageJson: unknown = JSON.parse(
      await readFile(join(repository.release, 'package.json'), 'utf8'),
    );
    expect(packageJson).toMatchObject({ version: '1.0.0' });
  }, 60_000);

  it('rejects a full version that does not increase package.json', async () => {
    const repository = await createRepository();
    const result = runRelease(repository.release, [
      '--yes',
      '--dry-run',
      '--version',
      '0.9.0',
      '--skip-publish',
      '--skip-github',
    ]);

    expect(result.status).not.toBe(0);
    expect(`${result.stderr}\n${result.stdout}`).toContain(
      'Full release version must be greater than package.json (1.0.0): 0.9.0',
    );
  }, 60_000);
});

describe('automatic GitHub release notes', () => {
  it('uses the highest reachable stable base and stops at the target tag', async () => {
    const fixture = await createGitHubFixture();
    const cwd = fixture.repository.release;
    const changelog = await readFile(join(cwd, 'CHANGELOG.md'), 'utf8');
    runOk('git', ['checkout', '-b', 'unrelated'], cwd);
    runOk('git', ['commit', '--allow-empty', '-m', 'feat: unrelated branch'], cwd);
    runOk('git', ['tag', 'v1.0.9'], cwd);
    runOk('git', ['checkout', 'main'], cwd);
    runOk('git', ['commit', '--allow-empty', '-m', 'feat: before selected base'], cwd);
    runOk('git', ['tag', '-a', 'v1.0.5', '-m', 'base'], cwd);
    runOk('git', ['commit', '--allow-empty', '-m', 'feat(chat): tagged feature'], cwd);
    // A nearer, lower version and non-stable/invalid/future tags cannot replace the base.
    for (const tag of ['v0.9.0', 'v1.0.8-beta.1', 'v01.0.8', 'v9.0.0']) {
      runOk('git', ['tag', tag], cwd);
    }
    const packagePath = join(cwd, 'package.json');
    await writeFile(packagePath, (await readFile(packagePath, 'utf8')).replace('"version": "1.0.0"', '"version": "1.1.0"'));
    runOk('git', ['add', 'package.json'], cwd);
    runOk('git', ['commit', '-m', 'fix: tagged repair'], cwd, {
      ...process.env, GIT_AUTHOR_DATE: '2026-01-01T23:30:00-05:00', GIT_COMMITTER_DATE: '2026-01-01T23:30:00-05:00',
    });
    const target = runOk('git', ['rev-parse', 'HEAD'], cwd).stdout.trim();
    runOk('git', ['tag', '-a', 'v1.1.0', '-m', 'target'], cwd);
    runOk('git', ['push', 'origin', 'v1.1.0'], cwd);
    runOk('git', ['commit', '--allow-empty', '-m', 'feat: after target on main'], cwd);
    const status = runOk('git', ['status', '--porcelain'], cwd).stdout;
    const args = ['--yes', '--github-tag', 'v1.1.0', '--auto-notes', '--skip-github-upload'];
    const result = runRelease(cwd, args, fixture.env);

    expect(`${result.stderr}\n${result.stdout}`).not.toContain('failed (attempt');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('auto (v1.0.5..v1.1.0)');
    const state = JSON.parse(await readFile(fixture.githubState, 'utf8'));
    expect(state).toMatchObject({ targetCommitish: target, isDraft: false });
    expect(state.body).toContain('## v1.1.0 (2026-01-02)');
    expect(state.body).toContain('### Features\n- chat: tagged feature');
    expect(state.body).toContain('### Fixes\n- tagged repair');
    for (const excluded of ['initial release', 'before selected base', 'after target', 'unrelated branch']) {
      expect(state.body).not.toContain(excluded);
    }
    expect(await readFile(join(cwd, 'CHANGELOG.md'), 'utf8')).toBe(changelog);
    expect(runOk('git', ['status', '--porcelain'], cwd).stdout).toBe(status);

    const before = await readFile(fixture.githubState, 'utf8');
    await writeFile(fixture.callLog, '');
    const resumed = runRelease(cwd, args, { ...fixture.env, RELEASE_TEST_NOW: '2026-01-04T12:00:00Z' });
    expect(resumed.status).toBe(0);
    expect(await readFile(fixture.githubState, 'utf8')).toBe(before);
    expect(gitHubMutations(await readToolCalls(fixture.callLog))).toEqual([]);
  }, 60_000);

  it('finds the previous stable release through every parent of a tagged merge', async () => {
    const fixture = await createGitHubFixture();
    const cwd = fixture.repository.release;
    runOk('git', ['checkout', '-b', 'released-side'], cwd);
    runOk('git', ['commit', '--allow-empty', '-m', 'feat: already published side feature'], cwd);
    runOk('git', ['tag', 'v1.0.5'], cwd);
    runOk('git', ['checkout', 'main'], cwd);
    const packagePath = join(cwd, 'package.json');
    await writeFile(packagePath, (await readFile(packagePath, 'utf8')).replace('"version": "1.0.0"', '"version": "1.1.0"'));
    runOk('git', ['add', 'package.json'], cwd);
    runOk('git', ['commit', '-m', 'fix: unreleased main repair'], cwd);
    runOk('git', ['merge', '--no-ff', 'released-side', '-m', 'merge release ancestry'], cwd);
    runOk('git', ['tag', 'v1.1.0'], cwd);
    runOk('git', ['push', 'origin', 'v1.1.0'], cwd);
    const result = runRelease(cwd, ['--yes', '--github-tag', 'v1.1.0', '--auto-notes', '--skip-github-upload'], fixture.env);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('auto (v1.0.5..v1.1.0)');
    const state = JSON.parse(await readFile(fixture.githubState, 'utf8'));
    expect(state.body).toContain('unreleased main repair');
    expect(state.body).not.toContain('already published side feature');
  }, 60_000);

  it.each([true, false])('collects full history without a base (root target: %s) and resumes with a fixed UTC date', async (rootTarget) => {
    const fixture = await createGitHubFixture({ changelog: null, commitDate: '2026-02-03T00:30:00+09:00' });
    const cwd = fixture.repository.release;
    if (!rootTarget) {
      runOk('git', ['tag', '-d', 'v1.0.0'], cwd);
      runOk('git', ['push', 'origin', ':refs/tags/v1.0.0'], cwd);
      runOk('git', ['commit', '--allow-empty', '-m', 'fix: first release repair'], cwd, {
        ...process.env, GIT_AUTHOR_DATE: '2026-02-03T00:30:00+09:00', GIT_COMMITTER_DATE: '2026-02-03T00:30:00+09:00',
      });
      runOk('git', ['tag', 'v1.0.0'], cwd);
      runOk('git', ['push', 'origin', 'v1.0.0'], cwd);
    }
    const args = ['--yes', '--resume-from-tag', 'v1.0.0', '--auto-notes', '--skip-publish', '--skip-github-upload'];
    const result = runRelease(cwd, args, { ...fixture.env, RELEASE_TEST_NOW: '2026-03-01T00:00:00Z' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('auto (v1.0.0, full history)');
    const before = await readFile(fixture.githubState, 'utf8');
    const state = JSON.parse(before);
    expect(state.body).toContain('## v1.0.0 (2026-02-02)');
    expect(state.body).toContain('### Features\n- initial release');
    if (!rootTarget) expect(state.body).toContain('### Fixes\n- first release repair');
    await writeFile(fixture.callLog, '');
    const resumed = runRelease(cwd, args, { ...fixture.env, RELEASE_TEST_NOW: '2026-03-02T00:00:00Z' });
    expect(resumed.status).toBe(0);
    expect(await readFile(fixture.githubState, 'utf8')).toBe(before);
    expect(gitHubMutations(await readToolCalls(fixture.callLog))).toEqual([]);
    await expect(readFile(join(cwd, 'CHANGELOG.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 60_000);

  it.each(['--resume-from-tag', '--github-tag'])('rejects combining --auto-notes and --github-notes-file in %s mode', async (mode) => {
    const fixture = await createGitHubFixture();
    const result = runRelease(fixture.repository.release, [
      ...fixture.args.map((arg) => arg === '--resume-from-tag' ? mode : arg), '--auto-notes',
    ], fixture.env);
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}\n${result.stdout}`).toContain('Use either --auto-notes or --github-notes-file, not both.');
    await expect(readFile(fixture.callLog)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 60_000);

  it('rejects --auto-notes in full mode before changing files', async () => {
    const repository = await createRepository();
    const result = runRelease(repository.release, ['--yes', '--auto-notes', '--version', '1.1.0']);
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}\n${result.stdout}`).toContain('--auto-notes requires --resume-from-tag or --github-tag.');
    expect(runOk('git', ['status', '--porcelain'], repository.release).stdout).toBe('');
  }, 60_000);

  it('preserves the tagged CHANGELOG notes when --auto-notes is absent', async () => {
    const fixture = await createGitHubFixture();
    const result = runRelease(fixture.repository.release, [
      '--yes', '--github-tag', 'v1.0.0', '--skip-github-upload',
    ], fixture.env);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('CHANGELOG.md (v1.0.0)');
    expect(JSON.parse(await readFile(fixture.githubState, 'utf8')).body).toBe('## v1.0.0 (2026-01-01)\n\n- Initial.\n');
  }, 60_000);
});

describe('GitHub mutation authorization failures', () => {
  const permanentErrors = [
    'HTTP 401: Unauthorized',
    'HTTP 403: Bad credentials',
    'HTTP 403: Resource not accessible by integration',
    'refusing to allow an OAuth App to create or update workflow .github/workflows/release.yml without workflow scope',
  ];
  const operations = ['create', 'upload'] as const;

  it.each(operations.flatMap((operation) => permanentErrors.map((output) => ({ operation, output }))))(
    'fails fast for $operation: $output', async ({ operation, output }) => {
      const fixture = await createGitHubFixture();
      if (operation === 'upload') await writeGitHubState(fixture, []);
      const result = runRelease(fixture.repository.release, fixture.args, {
        ...fixture.env,
        RELEASE_TEST_GITHUB_FAIL_OPERATION: operation,
        RELEASE_TEST_GITHUB_FAILURE_OUTPUT: output,
        RELEASE_TEST_FAST_RETRIES: 'true',
      });
      expect(result.status).not.toBe(0);
      expect(`${result.stderr}\n${result.stdout}`).toContain('NonRetryableReleaseError');
      expect(`${result.stderr}\n${result.stdout}`).toContain(output);
      const calls = await readToolCalls(fixture.callLog);
      expect(gitHubMutations(calls).map((call) => call.args[1])).toEqual([operation]);
      expect(calls.filter((call) => call.tool === 'gh').every((call) =>
        call.args[0] === '--version' || (call.args[0] === 'release' && ['view', 'create', 'upload'].includes(call.args[1] ?? '')),
      )).toBe(true);
    }, 60_000,
  );

  it.each(operations)('fails fast when %s authorization also prevents read-only reconciliation', async (operation) => {
    const fixture = await createGitHubFixture();
    if (operation === 'upload') await writeGitHubState(fixture, []);
    const result = runRelease(fixture.repository.release, fixture.args, {
      ...fixture.env,
      RELEASE_TEST_GITHUB_FAIL_OPERATION: operation,
      RELEASE_TEST_GITHUB_FAILURE_OUTPUT: 'HTTP401: Unauthorized',
      RELEASE_TEST_GITHUB_RECONCILIATION_ERROR: 'HTTP 401: Bad credentials',
      RELEASE_TEST_FAST_RETRIES: 'true',
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}\n${result.stdout}`).toContain('NonRetryableReleaseError');
    expect(`${result.stderr}\n${result.stdout}`).toContain('Reconciliation failed:');
    expect(gitHubMutations(await readToolCalls(fixture.callLog)).map((call) => call.args[1])).toEqual([operation]);
  }, 60_000);

  it.each(operations)('reconciles a matching remote %s despite a permanent-looking client error', async (operation) => {
    const fixture = await createGitHubFixture();
    if (operation === 'upload') await writeGitHubState(fixture, []);
    const result = runRelease(fixture.repository.release, fixture.args, {
      ...fixture.env,
      RELEASE_TEST_GITHUB_FAIL_OPERATION: operation,
      RELEASE_TEST_GITHUB_FAILURE_OUTPUT: 'HTTP 401: Bad credentials',
      RELEASE_TEST_GITHUB_ERROR_AFTER_WRITE: 'true',
    });
    expect(result.status).toBe(0);
    expect(`${result.stderr}\n${result.stdout}`).not.toContain('failed (attempt');
    expect(gitHubMutations(await readToolCalls(fixture.callLog)).filter((call) => call.args[1] === operation))
      .toHaveLength(operation === 'upload' ? 2 : 1);
  }, 60_000);

  it.each(operations.flatMap((operation) => [
    'HTTP 429: Too Many Requests',
    'HTTP 403: API rate limit exceeded',
    'HTTP 403: secondary rate limit exceeded',
    'HTTP 503: temporary failure',
  ].map((output) => ({ operation, output }))))('retains eight transient attempts for $operation: $output', async ({ operation, output }) => {
    const fixture = await createGitHubFixture();
    if (operation === 'upload') await writeGitHubState(fixture, []);
    const result = runRelease(fixture.repository.release, fixture.args, {
      ...fixture.env,
      RELEASE_TEST_GITHUB_FAIL_OPERATION: operation,
      RELEASE_TEST_GITHUB_FAILURE_OUTPUT: output,
      RELEASE_TEST_FAST_RETRIES: 'true',
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}\n${result.stdout}`).toContain('attempt 8/8');
    expect(`${result.stderr}\n${result.stdout}`).not.toContain('NonRetryableReleaseError');
    expect(gitHubMutations(await readToolCalls(fixture.callLog)).map((call) => call.args[1])).toEqual(Array(8).fill(operation));
  }, 60_000);
});

describe('GitHub release checksums', () => {
  it('uploads the VSIX and its standard ASCII SHA-256 sidecar to a draft release', async () => {
    const fixture = await createGitHubFixture();
    const result = runRelease(fixture.repository.release, fixture.args, fixture.env);

    expect(`${result.stderr}\n${result.stdout}`).not.toContain('failed (attempt');
    expect(result.status).toBe(0);
    await expectChecksum(fixture.assetPath);
    const calls = await readToolCalls(fixture.callLog);
    expect(gitHubMutations(calls).map((call) => call.args[1])).toEqual([
      'create', 'upload', 'upload',
    ]);
    expect(gitHubMutations(calls)[0]?.args).toContain('--draft');
    expect(gitHubMutations(calls).some((call) => call.args.includes('--clobber'))).toBe(false);
    expect(JSON.parse(await readFile(fixture.githubState, 'utf8'))).toMatchObject({
      isDraft: true,
      assets: [
        { name: basename(fixture.assetPath), digest: `sha256:${await sha256(fixture.assetPath)}` },
        { name: `${basename(fixture.assetPath)}.sha256`, digest: `sha256:${await sha256(`${fixture.assetPath}.sha256`)}` },
      ],
    });
  }, 60_000);

  it('resumes an existing VSIX by uploading only its missing checksum, then remains idempotent', async () => {
    const fixture = await createGitHubFixture();
    await writeGitHubState(fixture, [
      { name: basename(fixture.assetPath), digest: `sha256:${await sha256(fixture.assetPath)}` },
    ]);
    const args = [...fixture.args, '--skip-github-create'];
    const result = runRelease(fixture.repository.release, args, fixture.env);

    expect(result.status).toBe(0);
    await expectChecksum(fixture.assetPath);
    expect(gitHubMutations(await readToolCalls(fixture.callLog)).map((call) => call.args))
      .toEqual([['release', 'upload', 'v1.0.0', `${fixture.assetPath}.sha256`]]);

    await writeFile(fixture.callLog, '', 'utf8');
    const resumed = runRelease(fixture.repository.release, args, fixture.env);
    expect(resumed.status).toBe(0);
    expect(gitHubMutations(await readToolCalls(fixture.callLog))).toEqual([]);
  }, 60_000);

  it.each(['conflicting', 'unverifiable'])('refuses an existing %s checksum without overwriting it', async (kind) => {
    const fixture = await createGitHubFixture();
    const assets = [
      { name: basename(fixture.assetPath), digest: `sha256:${await sha256(fixture.assetPath)}` },
      { name: `${basename(fixture.assetPath)}.sha256`, digest: kind === 'conflicting' ? `sha256:${'0'.repeat(64)}` : null },
    ];
    await writeGitHubState(fixture, assets);
    const before = await readFile(fixture.githubState, 'utf8');
    const result = runRelease(fixture.repository.release, fixture.args, fixture.env);

    expect(result.status).not.toBe(0);
    expect(`${result.stderr}\n${result.stdout}`).toContain(
      kind === 'conflicting' ? 'Refusing to treat this as an idempotent resume' : 'Refusing to overwrite it',
    );
    expect(`${result.stderr}\n${result.stdout}`).toContain(`${basename(fixture.assetPath)}.sha256`);
    expect(gitHubMutations(await readToolCalls(fixture.callLog))).toEqual([]);
    expect(await readFile(fixture.githubState, 'utf8')).toBe(before);
  }, 60_000);

  it('still refuses a conflicting VSIX before uploading its checksum', async () => {
    const fixture = await createGitHubFixture();
    await writeGitHubState(fixture, [
      { name: basename(fixture.assetPath), digest: `sha256:${'0'.repeat(64)}` },
    ]);
    const result = runRelease(fixture.repository.release, fixture.args, fixture.env);
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}\n${result.stdout}`).toContain('Refusing to treat this as an idempotent resume');
    expect(gitHubMutations(await readToolCalls(fixture.callLog))).toEqual([]);
  }, 60_000);

  it('keeps tag target validation when creation is skipped', async () => {
    const fixture = await createGitHubFixture();
    await writeGitHubState(fixture, [], 'wrong-target');
    const result = runRelease(fixture.repository.release, [...fixture.args, '--skip-github-create'], fixture.env);
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}\n${result.stdout}`).toContain('target');
    expect(gitHubMutations(await readToolCalls(fixture.callLog))).toEqual([]);
  }, 60_000);

  it('requires an existing release when creation is skipped', async () => {
    const fixture = await createGitHubFixture();
    const result = runRelease(fixture.repository.release, [...fixture.args, '--skip-github-create'], fixture.env);
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}\n${result.stdout}`).toContain('does not exist and creation was skipped');
    expect(gitHubMutations(await readToolCalls(fixture.callLog))).toEqual([]);
  }, 60_000);

  it.each([false, true])('does not write checksum files during a resume dry-run (existing: %s)', async (existing) => {
    const fixture = await createGitHubFixture();
    const checksumPath = `${fixture.assetPath}.sha256`;
    if (existing) await writeFile(checksumPath, 'preserved checksum\n', 'ascii');
    const before = runOk('git', ['status', '--porcelain'], fixture.repository.release).stdout;
    const result = runRelease(fixture.repository.release, [...fixture.args, '--dry-run'], fixture.env);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Dry-run: no mutating commands executed.');
    expect(runOk('git', ['status', '--porcelain'], fixture.repository.release).stdout).toBe(before);
    if (existing) {
      expect(await readFile(checksumPath, 'ascii')).toBe('preserved checksum\n');
    } else {
      await expect(readFile(checksumPath)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    await expect(readFile(fixture.callLog)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 60_000);

  it.each([false, true])('skips checksum generation and upload when upload is skipped (skip create: %s)', async (skipCreate) => {
    const fixture = await createGitHubFixture();
    // Creation-only mode must not even require the local VSIX.
    await rm(fixture.assetPath);
    const args = [...fixture.args, '--skip-github-upload'];
    if (skipCreate) args.push('--skip-github-create');
    const result = runRelease(fixture.repository.release, args, fixture.env);

    expect(result.status).toBe(0);
    await expect(readFile(`${fixture.assetPath}.sha256`)).rejects.toMatchObject({ code: 'ENOENT' });
    if (skipCreate) {
      await expect(readFile(fixture.callLog)).rejects.toMatchObject({ code: 'ENOENT' });
    } else {
      expect(gitHubMutations(await readToolCalls(fixture.callLog)).map((call) => call.args[1]))
        .toEqual(['create']);
    }
  }, 60_000);

  it('preserves full-release collision checks before modifying repository files', async () => {
    const fixture = await createGitHubFixture();
    await writeGitHubState(fixture, []);
    const head = runOk('git', ['rev-parse', 'HEAD'], fixture.repository.release).stdout;
    const status = runOk('git', ['status', '--porcelain'], fixture.repository.release).stdout;
    const result = runRelease(fixture.repository.release, [
      '--yes', '--allow-dirty', '--version', '1.1.0', '--skip-publish',
    ], fixture.env);

    expect(result.status).not.toBe(0);
    expect(`${result.stderr}\n${result.stdout}`).toContain('GitHub Release');
    expect(runOk('git', ['rev-parse', 'HEAD'], fixture.repository.release).stdout).toBe(head);
    expect(runOk('git', ['status', '--porcelain'], fixture.repository.release).stdout).toBe(status);
    expect(gitHubMutations(await readToolCalls(fixture.callLog))).toEqual([]);
  }, 60_000);
});

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function expectChecksum(assetPath: string): Promise<void> {
  const content = await readFile(`${assetPath}.sha256`);
  expect(content.toString('ascii')).toBe(`${await sha256(assetPath)}  ${basename(assetPath)}\n`);
  expect(content.every((byte) => byte < 128)).toBe(true);
}

function gitHubMutations(calls: ToolCall[]): ToolCall[] {
  return calls.filter((call) => call.tool === 'gh' && ['create', 'upload'].includes(call.args[1] ?? ''));
}

async function createGitHubFixture(options: { changelog?: string | null; commitDate?: string } = {}) {
  const repository = await createRepository(options);
  const toolsDirectory = join(repository.root, 'tools');
  const callLog = join(repository.root, 'tool-calls.jsonl');
  const githubState = join(repository.root, 'github-release.json');
  const notesPath = join(repository.root, 'notes.md');
  const notes = 'Test release notes.\n';
  await mkdir(toolsDirectory, { recursive: true });
  await installFakeTools(toolsDirectory);
  await writeFile(notesPath, notes, 'utf8');
  const assetPath = join(repository.release, 'test-extension-1.0.0.vsix');
  const archive = new JSZip();
  archive.file('extension/package.json', await readFile(join(repository.release, 'package.json')));
  await writeFile(assetPath, await archive.generateAsync({ type: 'nodebuffer' }));
  const targetCommitish = runOk('git', ['rev-parse', 'HEAD'], repository.release).stdout.trim();
  return {
    repository, callLog, githubState, assetPath, targetCommitish, notes,
    args: ['--yes', '--resume-from-tag', 'v1.0.0', '--skip-publish', '--draft', '--github-notes-file', notesPath],
    env: {
      ...process.env,
      RELEASE_TEST_CALL_LOG: callLog,
      RELEASE_TEST_GITHUB_STATE: githubState,
    },
  };
}

async function writeGitHubState(
  fixture: Awaited<ReturnType<typeof createGitHubFixture>>,
  assets: { name: string; digest: string | null }[],
  targetCommitish = fixture.targetCommitish,
): Promise<void> {
  await writeFile(fixture.githubState, JSON.stringify({
    tagName: 'v1.0.0', targetCommitish, name: 'v1.0.0', body: fixture.notes, isDraft: true, assets,
  }), 'utf8');
}

async function createRepository(options: { changelog?: string | null; commitDate?: string } = {}): Promise<TestRepository> {
  const root = await mkdtemp(join(tmpdir(), 'ucp-release-script-'));
  temporaryRoots.push(root);
  const seed = join(root, 'seed');
  const origin = join(root, 'origin.git');
  const release = join(root, 'release');
  const rival = join(root, 'rival');

  runOk('git', ['init', '--initial-branch=main', seed], root);
  configureGit(seed);
  await writeFile(
    join(seed, 'package.json'),
    `${JSON.stringify(
      {
        name: 'test-extension',
        displayName: 'Test Extension',
        description: 'Release coordination fixture.',
        publisher: 'TestPublisher',
        version: '1.0.0',
        engines: { vscode: '^1.80.0' },
        main: './extension.js',
        activationEvents: [],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await writeFile(
    join(seed, 'package-lock.json'),
    `${JSON.stringify(
      {
        name: 'test-extension',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': {
            name: 'test-extension',
            version: '1.0.0',
          },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  if (options.changelog !== null) {
    await writeFile(
      join(seed, 'CHANGELOG.md'),
      options.changelog ?? '# Changelog\n\n## v1.0.0 - 2026-01-01\n\n- Initial.\n',
      'utf8',
    );
  }
  await writeFile(join(seed, 'README.md'), '# Test Extension\n', 'utf8');
  await writeFile(join(seed, 'extension.js'), 'module.exports = {};\n', 'utf8');
  runOk('git', ['add', '.'], seed);
  runOk('git', ['commit', '-m', 'feat: initial release'], seed, options.commitDate ? {
    ...process.env, GIT_AUTHOR_DATE: options.commitDate, GIT_COMMITTER_DATE: options.commitDate,
  } : process.env);
  runOk('git', ['tag', '-a', 'v1.0.0', '-m', 'v1.0.0'], seed);
  runOk('git', ['clone', '--bare', seed, origin], root);
  runOk('git', ['clone', origin, release], root);
  runOk('git', ['clone', origin, rival], root);
  configureGit(release);
  configureGit(rival);
  return { root, origin, release, rival };
}

function configureGit(repository: string): void {
  runOk('git', ['config', 'user.name', 'Release Test'], repository);
  runOk('git', ['config', 'user.email', 'release-test@example.com'], repository);
}

async function installFakeTools(directory: string): Promise<void> {
  const vscePath = join(directory, 'vsce');
  const ghPath = join(directory, 'gh');
  await writeFile(
    vscePath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.RELEASE_TEST_CALL_LOG, JSON.stringify({ tool: 'vsce', args }) + '\\n');
if (args[0] === 'show') {
  const state = process.env.RELEASE_TEST_MARKETPLACE_STATE;
  const pendingState = state ? state + '.pending' : '';
  if (pendingState && fs.existsSync(pendingState)) {
    const visibilityMarker = pendingState + '.queried';
    if (fs.existsSync(visibilityMarker)) {
      fs.renameSync(pendingState, state);
    } else {
      fs.writeFileSync(visibilityMarker, 'queried');
    }
  }
  if (state && fs.existsSync(state)) {
    process.stdout.write(fs.readFileSync(state, 'utf8'));
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({ publisher: { publisherName: 'TestPublisher' }, extensionName: 'test-extension', versions: [] }));
  process.exit(0);
}
if (args[0] === 'package') {
  const packaged = spawnSync(process.execPath, [process.env.REAL_VSCE, ...args], { cwd: process.cwd(), env: process.env, stdio: 'inherit' });
  if (packaged.status !== 0) process.exit(packaged.status ?? 1);
  const rival = process.env.RELEASE_TEST_ADVANCE_REPO;
  if (rival) {
    const committed = spawnSync('git', ['commit', '--allow-empty', '-m', 'rival advance'], { cwd: rival, encoding: 'utf8' });
    if (committed.status !== 0) process.exit(committed.status ?? 1);
    const pushed = spawnSync('git', ['push', 'origin', 'main'], { cwd: rival, encoding: 'utf8' });
    if (pushed.status !== 0) process.exit(pushed.status ?? 1);
  }
  process.exit(0);
}
if (args[0] === 'publish') {
  const asset = args[args.indexOf('--packagePath') + 1];
  const state = process.env.RELEASE_TEST_MARKETPLACE_STATE;
  if (state) {
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(asset)).digest('hex');
    const metadata = JSON.stringify({
      publisher: { publisherName: 'TestPublisher' },
      extensionName: 'test-extension',
      versions: [{
        version: '1.1.0',
        properties: [{ key: 'Microsoft.VisualStudio.Services.VsixSha256', value: sha256 }],
      }],
    });
    const outputState = process.env.RELEASE_TEST_DELAYED_MARKETPLACE_VISIBILITY
      ? state + '.pending'
      : state;
    fs.writeFileSync(outputState, metadata);
    if (process.env.RELEASE_TEST_DELAYED_MARKETPLACE_VISIBILITY) {
      process.stderr.write('version already exists\\n');
    }
  }
  process.exit(process.env.RELEASE_TEST_AMBIGUOUS_RESPONSES ? 1 : 0);
}
process.exit(1);
`,
    'utf8',
  );
  await writeFile(
    ghPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.RELEASE_TEST_CALL_LOG, JSON.stringify({ tool: 'gh', args }) + '\\n');
if (args[0] === '--version') {
  process.stdout.write('gh version test\\n');
  process.exit(0);
}
if (args[0] === 'release' && args[1] === 'view') {
  const state = process.env.RELEASE_TEST_GITHUB_STATE;
  if (state && fs.existsSync(state + '.mutation-failed')) {
    process.stderr.write(process.env.RELEASE_TEST_GITHUB_RECONCILIATION_ERROR + '\\n');
    process.exit(1);
  }
  if (state && fs.existsSync(state)) {
    process.stdout.write(fs.readFileSync(state, 'utf8'));
    process.exit(0);
  }
  process.stderr.write('release not found\\n');
  process.exit(1);
}
const mutationError = args[0] === 'release' && args[1] === process.env.RELEASE_TEST_GITHUB_FAIL_OPERATION
  ? process.env.RELEASE_TEST_GITHUB_FAILURE_OUTPUT
  : undefined;
if (mutationError && !process.env.RELEASE_TEST_GITHUB_ERROR_AFTER_WRITE) {
  if (process.env.RELEASE_TEST_GITHUB_RECONCILIATION_ERROR) {
    fs.writeFileSync(process.env.RELEASE_TEST_GITHUB_STATE + '.mutation-failed', 'failed');
  }
  process.stderr.write(mutationError + '\\n');
  process.exit(1);
}
if (args[0] === 'release' && args[1] === 'create') {
  const state = process.env.RELEASE_TEST_GITHUB_STATE;
  if (state) {
    const valueAfter = (name) => args[args.indexOf(name) + 1];
    fs.writeFileSync(state, JSON.stringify({
      tagName: args[2],
      targetCommitish: valueAfter('--target'),
      name: valueAfter('--title'),
      body: fs.readFileSync(valueAfter('--notes-file'), 'utf8'),
      isDraft: args.includes('--draft'),
      assets: [],
    }));
  }
  if (mutationError) process.stderr.write(mutationError + '\\n');
  process.exit(process.env.RELEASE_TEST_AMBIGUOUS_RESPONSES || mutationError ? 1 : 0);
}
if (args[0] === 'release' && args[1] === 'upload') {
  const state = process.env.RELEASE_TEST_GITHUB_STATE;
  if (state) {
    const asset = args[3];
    const metadata = JSON.parse(fs.readFileSync(state, 'utf8'));
    if (metadata.assets.some((existing) => existing.name === path.basename(asset))) {
      process.stderr.write('asset already exists; refusing to overwrite\\n');
      process.exit(1);
    }
    metadata.assets.push({
      name: path.basename(asset),
      digest: 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(asset)).digest('hex'),
    });
    fs.writeFileSync(state, JSON.stringify(metadata));
  }
  if (mutationError) process.stderr.write(mutationError + '\\n');
  process.exit(process.env.RELEASE_TEST_AMBIGUOUS_RESPONSES || mutationError ? 1 : 0);
}
process.exit(0);
`,
    'utf8',
  );
  await chmod(vscePath, 0o755);
  await chmod(ghPath, 0o755);
  // Route only the external publication tools to Node fixtures on every OS.
  await writeFile(
    join(directory, 'preload.mjs'),
    `import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
if (process.env.RELEASE_TEST_FAST_RETRIES) {
  const setTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => setTimeout(callback, 0, ...args);
}
if (process.env.RELEASE_TEST_NOW) {
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      if (args.length) super(...args);
      else super(process.env.RELEASE_TEST_NOW);
    }
    static now() { return new RealDate(process.env.RELEASE_TEST_NOW).getTime(); }
  };
}
const spawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  if (command === 'gh' || command === 'vsce') {
    return spawn(process.execPath, [fileURLToPath(new URL(command, import.meta.url)), ...args], options);
  }
  return spawn(command, args, options);
};
syncBuiltinESMExports();
`,
    'utf8',
  );
}

function runRelease(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): SpawnSyncReturns<string> {
  const callLog = env.RELEASE_TEST_CALL_LOG;
  const preloadArgs = callLog
    ? ['--import', pathToFileURL(join(dirname(callLog), 'tools', 'preload.mjs')).href]
    : [];
  return run(process.execPath, [...preloadArgs, releaseScript, ...args], cwd, env);
}

function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): SpawnSyncReturns<string> {
  return spawnSync(command, args, { cwd, env, encoding: 'utf8' });
}

function runOk(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): SpawnSyncReturns<string> {
  const result = run(command, args, cwd, env);
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`,
    );
  }
  return result;
}

async function readToolCalls(path: string): Promise<ToolCall[]> {
  const text = await readFile(path, 'utf8');
  return text
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line): ToolCall => {
      const value: unknown = JSON.parse(line);
      if (
        typeof value !== 'object' ||
        value === null ||
        !('tool' in value) ||
        !('args' in value) ||
        typeof value.tool !== 'string' ||
        !Array.isArray(value.args) ||
        !value.args.every((arg) => typeof arg === 'string')
      ) {
        throw new Error(`Invalid tool call log entry: ${line}`);
      }
      return { tool: value.tool, args: value.args };
    });
}
