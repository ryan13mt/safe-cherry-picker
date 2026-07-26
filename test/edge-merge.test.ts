import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { RepoBuilder } from './repo-builder.ts';
import {
  merge,
  operationStatus,
  continueOperation,
  abortOperation,
  conflictReport,
} from '../server/services/ops.ts';
import { simulateMerge } from '../server/services/dryrun.ts';
import { buildPipeline } from '../server/services/pipeline.ts';

/** Merge edge cases across the promotion chain. */

let repo: RepoBuilder;

beforeEach(() => {
  repo = new RepoBuilder('prod');
  repo.use(['develop', 'stable', 'prod']);
});
afterEach(() => repo.dispose());

function baseline() {
  repo.write('app.txt', 'line 1\n').commit('initial');
  repo.branch('stable').branch('develop');
}

describe('trivial merges', () => {
  it('reports already-up-to-date without moving the branch', async () => {
    baseline();
    // develop is identical to stable, so there is nothing to promote.
    const before = repo.sha('stable');
    const result = await merge({ repoPath: repo.path, from: 'develop', into: 'stable' });

    expect(result.ok, result.message).toBe(true);
    expect(repo.sha('stable')).toBe(before);
    expect(result.newHead).toBe(before);
  });

  it('treats merging a branch into itself as a no-op', async () => {
    baseline();
    const before = repo.sha('stable');
    const result = await merge({ repoPath: repo.path, from: 'stable', into: 'stable' });
    expect(result.ok, result.message).toBe(true);
    expect(repo.sha('stable')).toBe(before);
  });

  it('creates a merge commit even when a fast-forward was possible', async () => {
    baseline();
    repo.checkout('develop');
    repo.write('f.txt', 'work\n').commit('develop work');
    repo.checkout('prod');

    const result = await merge({ repoPath: repo.path, from: 'develop', into: 'stable', noFf: true });

    expect(result.ok, result.message).toBe(true);
    const parents = repo.run(['rev-list', '--parents', '-1', 'stable']).split(/\s+/);
    expect(parents.length, 'expected two parents on the merge commit').toBe(3);
    expect(repo.subject('stable')).toContain('Merge branch');
  });

  it('fast-forwards when noFf is off', async () => {
    baseline();
    repo.checkout('develop');
    repo.write('f.txt', 'work\n').commit('develop work');
    const developHead = repo.sha('develop');
    repo.checkout('prod');

    const result = await merge({
      repoPath: repo.path,
      from: 'develop',
      into: 'stable',
      noFf: false,
    });

    expect(result.ok, result.message).toBe(true);
    expect(repo.sha('stable')).toBe(developHead);
  });
});

describe('refusals', () => {
  it('refuses to merge into a branch checked out in your working copy', async () => {
    baseline();
    repo.checkout('develop');
    repo.write('f.txt', 'work\n').commit('develop work');
    repo.checkout('stable'); // now stable is the user's checkout

    await expect(merge({ repoPath: repo.path, from: 'develop', into: 'stable' })).rejects.toThrow(
      /checked out/i,
    );
  });

  it('reports a clear failure for a branch that does not exist', async () => {
    baseline();
    repo.checkout('prod');
    const result = await merge({ repoPath: repo.path, from: 'no-such-branch', into: 'stable' });
    expect(result.ok).toBe(false);
    expect(result.message).toBeTruthy();
  });

  it('refuses unrelated histories rather than inventing a merge', async () => {
    baseline();
    repo.orphan('imported');
    repo.write('other.txt', 'from another project\n').commit('unrelated root');
    repo.checkout('prod');

    const result = await merge({ repoPath: repo.path, from: 'imported', into: 'stable' });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/unrelated histories/i);

    // And the simulation says so up front rather than promising a clean merge.
    const sim = await simulateMerge({ repoPath: repo.path, target: 'stable', from: 'imported' });
    expect(sim.clean).toBe(false);
  });
});

describe('merge conflicts', () => {
  function divergeOnSharedFile() {
    baseline();
    repo.checkout('develop');
    repo.write('app.txt', 'line 1\ndevelop change\n').commit('develop edit');
    repo.checkout('stable');
    repo.write('app.txt', 'line 1\nstable change\n').commit('stable edit');
    repo.checkout('prod');
  }

  it('predicts the conflict before running anything', async () => {
    divergeOnSharedFile();
    const before = repo.run(['show-ref']);

    const preview = await merge({
      repoPath: repo.path,
      from: 'develop',
      into: 'stable',
      dryRun: true,
    });

    expect(preview.ok).toBe(false);
    expect(preview.simulation?.clean).toBe(false);
    expect(preview.simulation?.conflicts).toContain('app.txt');
    // A dry run must leave the repo exactly as it found it.
    expect(repo.run(['show-ref'])).toBe(before);
  });

  it('predicts a clean merge when the branches touch different files', async () => {
    baseline();
    repo.checkout('develop');
    repo.write('only-develop.txt', 'x\n').commit('develop work');
    repo.checkout('prod');

    const preview = await merge({
      repoPath: repo.path,
      from: 'develop',
      into: 'stable',
      dryRun: true,
    });
    expect(preview.ok).toBe(true);
    expect(preview.simulation?.clean).toBe(true);
  });

  it('pauses on conflict, exposes it through the viewer, and can be resolved', async () => {
    divergeOnSharedFile();
    const stableBefore = repo.sha('stable');

    const result = await merge({ repoPath: repo.path, from: 'develop', into: 'stable' });
    expect(result.ok).toBe(false);
    expect(repo.sha('stable')).toBe(stableBefore);

    const report = await conflictReport(repo.path);
    expect(report.inProgress).toBe(true);
    expect(report.kind).toBe('merge');
    const file = report.files.find((f) => f.path === 'app.txt')!;
    expect(file.kind).toBe('both-modified');
    expect(file.ours).toContain('stable change');
    expect(file.theirs).toContain('develop change');

    const wt = report.worktreePath!;
    writeFileSync(path.join(wt, 'app.txt'), 'line 1\nboth changes\n', 'utf8');
    const done = await continueOperation(repo.path);

    expect(done.ok, done.message).toBe(true);
    expect(repo.run(['show', 'stable:app.txt'])).toBe('line 1\nboth changes');
    expect(repo.sha('stable')).not.toBe(stableBefore);
  });

  it('restores the branch exactly on abort', async () => {
    divergeOnSharedFile();
    const stableBefore = repo.sha('stable');

    await merge({ repoPath: repo.path, from: 'develop', into: 'stable' });
    const aborted = await abortOperation(repo.path);

    expect(aborted.ok).toBe(true);
    expect(repo.sha('stable')).toBe(stableBefore);
    expect((await operationStatus(repo.path)).inProgress).toBe(false);
  });

  it('cannot skip a merge — only continue or abort', async () => {
    divergeOnSharedFile();
    await merge({ repoPath: repo.path, from: 'develop', into: 'stable' });
    const { skipOperation } = await import('../server/services/ops.ts');
    await expect(skipOperation(repo.path)).rejects.toThrow(/only a cherry-pick/i);
    await abortOperation(repo.path);
  });
});

describe('pipeline drift after merges', () => {
  it('shows a promotion clearing the ahead count and creating a behind count', async () => {
    baseline();
    repo.checkout('develop');
    repo.write('f.txt', 'work\n').commit('develop work');
    repo.checkout('prod');

    const before = await buildPipeline(repo.path);
    const legBefore = before.legs.find((l) => l.upstream === 'develop')!;
    expect(legBefore.ahead).toHaveLength(1);
    expect(legBefore.behind).toHaveLength(0);

    await merge({ repoPath: repo.path, from: 'develop', into: 'stable' });

    const after = await buildPipeline(repo.path);
    const legAfter = after.legs.find((l) => l.upstream === 'develop')!;
    expect(legAfter.ahead).toHaveLength(0);
    // The merge commit itself now sits on stable and not on develop, which is
    // exactly the "needs back-merge" signal.
    expect(legAfter.behind).toHaveLength(1);
  });
});
