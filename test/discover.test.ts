import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setConfig } from '../server/config.ts';
import { discoverRepos, resolveRepo, clearRepoCache } from '../server/services/discover.ts';

let root: string;

function init(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: dir });
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'gcp-scan-'));
  // The scan root is itself a repo *and* contains the repos we care about —
  // exactly the layout that made discovery return only the root.
  init(root);
  init(path.join(root, 'alpha'));
  init(path.join(root, 'nested', 'beta'));

  mkdirSync(path.join(root, 'plain-folder'), { recursive: true });

  // A .git directory with no HEAD is not a repo.
  mkdirSync(path.join(root, 'broken', '.git'), { recursive: true });
  writeFileSync(path.join(root, 'broken', 'readme.txt'), 'not a repo\n');

  setConfig({ scanRoot: root, scanDepth: 3 });
  clearRepoCache();
});

afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));

describe('repo discovery', () => {
  it('finds repos beneath a scan root that is itself a repo', async () => {
    const names = (await discoverRepos(true)).map((r) => r.name).sort();
    expect(names).toContain('alpha');
    expect(names).toContain('beta');
    expect(names).toContain(path.basename(root));
  });

  it('ignores a .git directory with no HEAD', async () => {
    const names = (await discoverRepos(true)).map((r) => r.name);
    expect(names).not.toContain('broken');
    expect(names).not.toContain('plain-folder');
  });

  it('refuses an unknown repo id', async () => {
    await expect(resolveRepo('deadbeef1234')).rejects.toThrow(/Unknown repo/);
  });

  it('resolves a known id back to its path', async () => {
    const repos = await discoverRepos(true);
    const alpha = repos.find((r) => r.name === 'alpha')!;
    expect((await resolveRepo(alpha.id)).path).toBe(alpha.path);
  });
});
