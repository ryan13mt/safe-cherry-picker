import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { newFixture, dropFixture, raw, type Fixture } from './helpers.ts';
import { simulateCherryPick, supportsMergeTree, parseMergeTreeOutput } from '../server/services/dryrun.ts';
import { logCommits } from '../server/services/commits.ts';
import type { CommitInfo } from '../shared/types.ts';

let fx: Fixture;

beforeAll(() => {
  fx = newFixture();
});
afterAll(() => dropFixture(fx));

/** Loads commits in the order they would actually be applied (oldest first). */
async function pick(shas: string[]): Promise<CommitInfo[]> {
  const commits = await logCommits({ cwd: fx.repo, revs: ['--no-walk', ...shas] });
  return commits.sort((a, b) => a.date.localeCompare(b.date));
}

describe('conflict dry-run', () => {
  it('is supported by the installed git', async () => {
    expect(await supportsMergeTree(fx.repo)).toBe(true);
  });

  it('reports a clean pick when the commits do not collide', async () => {
    const result = await simulateCherryPick({
      repoPath: fx.repo,
      target: 'stable',
      commits: await pick([fx.sha.D]),
    });
    expect(result.clean).toBe(true);
    expect(result.conflicts).toEqual([]);
    expect(result.applied).toEqual([fx.sha.D]);
  });

  it('is clean when an interleaved ticket is picked together with its neighbour', async () => {
    // J and I both edit parser.txt; taken together they apply in order.
    const result = await simulateCherryPick({
      repoPath: fx.repo,
      target: 'stable',
      commits: await pick([fx.sha.J, fx.sha.I]),
    });
    expect(result.clean).toBe(true);
    expect(result.applied).toEqual([fx.sha.J, fx.sha.I]);
  });

  it('detects the real conflict when an interleaved commit is skipped', async () => {
    // Picking I alone skips J, which I builds on — this is exactly the
    // "QA cleared one ticket" hazard the feature exists to catch.
    const result = await simulateCherryPick({
      repoPath: fx.repo,
      target: 'stable',
      commits: await pick([fx.sha.I]),
    });
    expect(result.clean).toBe(false);
    expect(result.conflicts).toContain('parser.txt');
    expect(result.failedAt?.sha).toBe(fx.sha.I);
  });

  it('detects an add/add conflict', async () => {
    const result = await simulateCherryPick({
      repoPath: fx.repo,
      target: 'stable',
      commits: await pick([fx.sha.G]),
    });
    expect(result.clean).toBe(false);
    expect(result.conflicts).toContain('misc.txt');
  });

  it('reports which commit in a sequence fails, not just that one did', async () => {
    const result = await simulateCherryPick({
      repoPath: fx.repo,
      target: 'stable',
      commits: await pick([fx.sha.D, fx.sha.G]),
    });
    expect(result.clean).toBe(false);
    expect(result.applied).toEqual([fx.sha.D]); // D landed before G blew up
    expect(result.failedAt?.sha).toBe(fx.sha.G);
  });

  it('leaves no trace on refs, HEAD or the working tree', async () => {
    const before = {
      refs: raw(fx.repo, ['show-ref']),
      head: raw(fx.repo, ['rev-parse', 'HEAD']),
      branch: raw(fx.repo, ['rev-parse', '--abbrev-ref', 'HEAD']),
      status: raw(fx.repo, ['status', '--porcelain']),
    };

    await simulateCherryPick({ repoPath: fx.repo, target: 'stable', commits: await pick([fx.sha.I]) });
    await simulateCherryPick({
      repoPath: fx.repo,
      target: 'prod',
      commits: await pick([fx.sha.A, fx.sha.B, fx.sha.C]),
    });

    expect({
      refs: raw(fx.repo, ['show-ref']),
      head: raw(fx.repo, ['rev-parse', 'HEAD']),
      branch: raw(fx.repo, ['rev-parse', '--abbrev-ref', 'HEAD']),
      status: raw(fx.repo, ['status', '--porcelain']),
    }).toEqual(before);
  });
});

describe('parseMergeTreeOutput', () => {
  it('reads the tree id when there are no conflicts', () => {
    expect(parseMergeTreeOutput('abc123\0')).toEqual({ tree: 'abc123', conflicts: [] });
  });

  it('reads conflicted paths and stops at the section terminator', () => {
    const out = 'abc123\0src/a.ts\0src/b.ts\0\0CONFLICT (content)\0';
    expect(parseMergeTreeOutput(out)).toEqual({
      tree: 'abc123',
      conflicts: ['src/a.ts', 'src/b.ts'],
    });
  });
});
