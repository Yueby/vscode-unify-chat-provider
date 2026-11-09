import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/release.yml', 'utf8').replace(/\r\n/g, '\n');

describe('tag-driven GitHub release workflow', () => {
  it('triggers version tags rather than ordinary branch pushes', () => {
    expect(workflow).toContain("  push:\n    tags:\n      - 'v[0-9]*'");
    const push = workflow.split('  push:\n')[1]?.split('  workflow_dispatch:')[0];
    expect(push).not.toContain('branches:');
    expect(workflow).toContain('  workflow_dispatch:');
    expect(workflow).toContain('  contents: write');
  });

  it('validates stable tags against the checked-out package version', () => {
    const match = /node - <<'JS'\n([\s\S]*?)\n          JS/.exec(workflow);
    if (!match) throw Error('Expected Node validation block');
    const script = match[1].split('\n').map((line) => line.replace(/^          /, '')).join('\n');
    const root = mkdtempSync(join(tmpdir(), 'ucp-tag-workflow-'));
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '8.14.1' }));
      expect(() => execFileSync(process.execPath, ['-e', script], { cwd: root, env: { ...process.env, RELEASE_TAG: 'v8.14.1' }, stdio: 'pipe' })).not.toThrow();
      for (const tag of ['v8.14.2', 'v8.14.1-beta.1', '8.14.1', 'v08.14.1', 'v8.14.1\n']) {
        expect(() => execFileSync(process.execPath, ['-e', script], { cwd: root, env: { ...process.env, RELEASE_TAG: tag }, stdio: 'pipe' })).toThrow();
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('runs checks and installed-version E2E before publishing both automatic and recovery releases', () => {
    for (const step of ['Run checks', 'Provision VS Code on CI runner', 'Run extension host tests']) {
      expect(workflow).toContain(`- name: ${step}\n        if: \u0024{{ github.event_name == 'push' || !inputs.dry_run }}`);
    }
    expect(workflow.indexOf('- name: Run extension host tests')).toBeLessThan(workflow.indexOf('- name: Run release script'));
  });

  it('forces GitHub-only automatic releases with automatic commit notes', () => {
    expect(workflow).toContain("PUBLISH_TO_MARKETPLACE: \u0024{{ github.event_name != 'push' && inputs.publish_to_marketplace }}");
    expect(workflow).toContain("CREATE_GITHUB_RELEASE: \u0024{{ github.event_name == 'push' || inputs.create_github_release }}");
    expect(workflow).toContain("UPLOAD_VSIX_TO_GITHUB: \u0024{{ github.event_name == 'push' || inputs.upload_vsix_to_github }}");
    expect(workflow).toContain('args+=(--resume-from-tag "${RELEASE_TAG}" --auto-notes)');
    expect(workflow).not.toMatch(/&&\s*false\s*\|\|/);
  });

  it('stages and verifies artifacts before automatically publishing, with recovery for already-public releases', () => {
    expect(workflow).toContain('build_draft=true');
    expect(workflow).toContain('gh release view "${RELEASE_TAG}" --json isDraft');
    expect(workflow).toContain('RELEASE_BUILD_DRAFT=${build_draft}');
    expect(workflow.indexOf('- name: Publish completed GitHub Release')).toBeGreaterThan(workflow.indexOf('- name: Run release script'));
    expect(workflow).toContain('gh release edit "${tag}" --draft=false "--latest=${make_latest}"');
    expect(workflow).toContain('target[i] > existing[i]');
    expect(workflow).toContain('elif [ "${draft}" != "false" ]');
  });
});
