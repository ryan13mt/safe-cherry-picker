import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RepoBuilder } from './repo-builder.ts';
import { buildCleanupReport, deleteBranch } from '../server/services/cleanup.ts';
import type { BranchReport } from '../shared/types.ts';

let repo: RepoBuilder;

beforeEach(() => {
  repo = new RepoBuilder('prod');
  repo.use(['develop', 'stable', 'prod']);
});
afterEach(() => repo.dispose());

const find = (branches: BranchReport[], name: string): BranchReport =>
  branches.find((b) => b.name === name) ??
  (() => {
    throw new Error(`no report for ${name}; got ${branches.map((b) => b.name).join(', ')}`);
  })();

function base() {
  repo.write('app.txt', 'line 1\n').commit('initial');
  repo.branch('stable').branch('develop');
}

describe('branch classification', () => {
  it('marks a branch merged into prod as safe, with no force needed', async () => {
    base();
    repo.checkout('feature/done', 'develop');
    repo.write('done.txt', 'work\n').commit('finished work');
    repo.checkout('prod');
    repo.mergeInto('feature/done');

    const report = await buildCleanupReport(repo.path);
    const branch = find(report.branches, 'feature/done');

    expect(branch.safety).toBe('merged');
    expect(branch.releasedTo).toBe('prod');
    expect(branch.fastDelete).toBe(true);
  });

  it('recognises a branch that shipped by cherry-pick, which git branch --merged misses', async () => {
    base();
    repo.checkout('feature/picked', 'develop');
    const a = repo.write('picked.txt', 'work\n').commit('picked work');
    repo.checkout('prod');
    repo.run(['cherry-pick', a]);

    // git itself does not consider this merged...
    expect(repo.run(['branch', '--merged', 'prod'])).not.toContain('feature/picked');

    // ...but the classifier does, because the patch is identical.
    const branch = find((await buildCleanupReport(repo.path)).branches, 'feature/picked');
    expect(branch.safety).toBe('picked');
    expect(branch.releasedTo).toBe('prod');
    expect(branch.weakestMethod).toBe('patch-id');
    // Needs -D precisely because git only checks ancestry.
    expect(branch.fastDelete).toBe(false);
  });

  it('reports a partially shipped branch as outstanding, with a count', async () => {
    base();
    repo.checkout('feature/half', 'develop');
    const a = repo.write('one.txt', 'one\n').commit('first');
    repo.write('two.txt', 'two\n').commit('second');
    repo.checkout('prod');
    repo.run(['cherry-pick', a]);

    const branch = find((await buildCleanupReport(repo.path)).branches, 'feature/half');
    expect(branch.safety).toBe('unreleased');
    expect(branch.releasedTo).toBeUndefined();
    expect(branch.unreleasedCount).toBe(1);
    expect(branch.totalCommits).toBe(2);
  });

  it('treats a squash-only match as a guess, not a verdict', async () => {
    base();
    repo.checkout('feature/squashed', 'develop');
    repo.write('sq.txt', 'original\n').commit('[ACME-1] squashed work');
    repo.checkout('prod');
    // Same subject in the body, different content: only the heuristic can match.
    repo.write('sq.txt', 'rewritten\n');
    repo.commit('[ACME-1] rollup (#9)\n\n* [ACME-1] squashed work');

    const branch = find((await buildCleanupReport(repo.path)).branches, 'feature/squashed');
    expect(branch.safety).toBe('likely');
    expect(branch.fastDelete).toBe(false);
  });

  it('never proposes deleting a chain branch or the current one', async () => {
    base();
    repo.checkout('develop');

    const report = await buildCleanupReport(repo.path);
    for (const name of ['prod', 'stable', 'develop']) {
      const branch = find(report.branches, name);
      expect(branch.safety, name).toBe('skipped');
      expect(branch.note, name).toBeTruthy();
    }
    expect(find(report.branches, 'develop').note).toMatch(/chain/i);
  });

  it('skips a branch checked out in the working copy', async () => {
    base();
    repo.checkout('feature/current', 'develop');
    repo.write('c.txt', 'c\n').commit('work');

    const branch = find((await buildCleanupReport(repo.path)).branches, 'feature/current');
    expect(branch.safety).toBe('skipped');
    expect(branch.note).toMatch(/checked out/i);
  });

  it('reports staleness so old branches stand out', async () => {
    base();
    repo.checkout('feature/old', 'develop');
    // Roughly 200 days ago.
    repo.write('old.txt', 'old\n');
    repo.commitAt('ancient work', Math.floor(Date.now() / 1000) - 200 * 86400);
    repo.checkout('prod');
    repo.mergeInto('feature/old');

    const branch = find((await buildCleanupReport(repo.path)).branches, 'feature/old');
    expect(branch.ageDays).toBeGreaterThan(190);
    expect(branch.lastCommitSubject).toBe('ancient work');
  });

  it('puts the most deletable branches first', async () => {
    base();
    repo.checkout('feature/shipped', 'develop');
    repo.write('s.txt', 's\n').commit('shipped');
    repo.checkout('feature/wip', 'develop');
    repo.write('w.txt', 'w\n').commit('in progress');
    repo.checkout('prod');
    repo.mergeInto('feature/shipped');

    const names = (await buildCleanupReport(repo.path)).branches.map((b) => b.name);
    expect(names.indexOf('feature/shipped')).toBeLessThan(names.indexOf('feature/wip'));
  });
});

describe('deletion', () => {
  it('deletes a merged branch and returns the tip for recovery', async () => {
    base();
    repo.checkout('feature/done', 'develop');
    const tip = repo.write('d.txt', 'd\n').commit('done');
    repo.checkout('prod');
    repo.mergeInto('feature/done');

    const result = await deleteBranch(repo.path, 'feature/done');
    expect(result.deleted).toBe(tip);
    expect(repo.run(['branch', '--format=%(refname:short)'])).not.toContain('feature/done');

    // The tip is enough to put it back.
    repo.run(['branch', 'feature/done', result.deleted]);
    expect(repo.run(['rev-parse', 'feature/done'])).toBe(tip);
  });

  it('deletes a cherry-picked branch, which needs -D', async () => {
    base();
    repo.checkout('feature/picked', 'develop');
    const a = repo.write('p.txt', 'p\n').commit('picked');
    repo.checkout('prod');
    repo.run(['cherry-pick', a]);

    const result = await deleteBranch(repo.path, 'feature/picked');
    expect(result.commands[0]).toContain('-D');
    expect(repo.run(['branch', '--format=%(refname:short)'])).not.toContain('feature/picked');
  });

  it('refuses a branch with unreleased work', async () => {
    base();
    repo.checkout('feature/wip', 'develop');
    repo.write('w.txt', 'w\n').commit('unfinished');
    repo.checkout('prod');

    await expect(deleteBranch(repo.path, 'feature/wip')).rejects.toThrow(/unreleased commit/i);
    expect(repo.run(['branch', '--format=%(refname:short)'])).toContain('feature/wip');
  });

  it('refuses a branch backed only by a squash guess', async () => {
    base();
    repo.checkout('feature/squashed', 'develop');
    repo.write('sq.txt', 'original\n').commit('[ACME-1] squashed work');
    repo.checkout('prod');
    repo.write('sq.txt', 'rewritten\n');
    repo.commit('[ACME-1] rollup (#9)\n\n* [ACME-1] squashed work');

    await expect(deleteBranch(repo.path, 'feature/squashed')).rejects.toThrow(/guess/i);
    expect(repo.run(['branch', '--format=%(refname:short)'])).toContain('feature/squashed');
  });

  it('refuses a chain branch and the checked-out branch', async () => {
    base();
    repo.checkout('develop');
    await expect(deleteBranch(repo.path, 'prod')).rejects.toThrow();
    await expect(deleteBranch(repo.path, 'develop')).rejects.toThrow();
    expect(repo.run(['branch', '--format=%(refname:short)'])).toContain('prod');
  });

  it('re-checks rather than trusting the caller, so a stale page cannot delete live work', async () => {
    base();
    repo.checkout('feature/moving', 'develop');
    const a = repo.write('m.txt', 'm\n').commit('shipped work');
    repo.checkout('prod');
    repo.run(['cherry-pick', a]);

    // At this point the branch is deletable. Now it gains new work — as it would
    // if someone committed while the cleanup page sat open.
    repo.checkout('feature/moving');
    repo.write('m2.txt', 'new\n').commit('new work after the page loaded');
    repo.checkout('prod');

    await expect(deleteBranch(repo.path, 'feature/moving')).rejects.toThrow(/unreleased commit/i);
    expect(repo.run(['branch', '--format=%(refname:short)'])).toContain('feature/moving');
  });

  it('rejects an unknown branch', async () => {
    base();
    repo.checkout('prod');
    await expect(deleteBranch(repo.path, 'no-such-branch')).rejects.toThrow(/No such branch/);
  });
});
