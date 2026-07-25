import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { newFixture, dropFixture, raw, checkoutSnapshot, type Fixture } from './helpers.ts';
import { cherryPick, merge, operationStatus, abortOperation, continueOperation } from '../server/services/ops.ts';
import { buildMatrix } from '../server/services/matrix.ts';

let fx: Fixture;

beforeEach(() => {
  fx = newFixture();
});
afterEach(() => dropFixture(fx));

describe('cherry-pick', () => {
  it('applies a commit and advances only the target branch', async () => {
    const before = checkoutSnapshot(fx.repo);
    const stableBefore = raw(fx.repo, ['rev-parse', 'stable']);
    const developBefore = raw(fx.repo, ['rev-parse', 'develop']);

    const result = await cherryPick({
      repoPath: fx.repo,
      target: 'stable',
      shas: [fx.sha.D],
      style: 'individual',
    });

    expect(result.ok).toBe(true);
    expect(raw(fx.repo, ['rev-parse', 'stable'])).toBe(result.newHead);
    expect(raw(fx.repo, ['rev-parse', 'stable'])).not.toBe(stableBefore);
    expect(raw(fx.repo, ['rev-parse', 'develop'])).toBe(developBefore);
    // The user's checkout is on prod and must be exactly as it was.
    expect(checkoutSnapshot(fx.repo)).toEqual(before);
  });

  it('records -x so the pick is exactly traceable afterwards', async () => {
    await cherryPick({ repoPath: fx.repo, target: 'stable', shas: [fx.sha.D], style: 'individual' });

    expect(raw(fx.repo, ['log', '-1', '--format=%B', 'stable'])).toContain(
      `cherry picked from commit ${fx.sha.D}`,
    );

    // And the classifier now sees it as exact rather than guessing.
    const matrix = await buildMatrix('test', fx.repo, fx.branch);
    const group = matrix.groups.find((g) => g.ticket === 'JIRA-388')!;
    expect(group.summary.stable.state).toBe('released');
    const commit = group.commits.find((c) => c.commit.sha === fx.sha.D)!;
    expect(commit.status.stable.method).toBe('traced');
  });

  it('leaves uncommitted work in the checkout untouched', async () => {
    const scratchFile = path.join(fx.repo, 'work-in-progress.txt');
    writeFileSync(scratchFile, 'half-finished thought\n', 'utf8');
    const dirtyBefore = raw(fx.repo, ['status', '--porcelain']);

    await cherryPick({ repoPath: fx.repo, target: 'stable', shas: [fx.sha.D], style: 'individual' });

    expect(existsSync(scratchFile)).toBe(true);
    expect(readFileSync(scratchFile, 'utf8')).toBe('half-finished thought\n');
    expect(raw(fx.repo, ['status', '--porcelain'])).toBe(dirtyBefore);
  });

  it('squashes a ticket into one commit when asked', async () => {
    const result = await cherryPick({
      repoPath: fx.repo,
      target: 'stable',
      shas: [fx.sha.J, fx.sha.I],
      style: 'squash',
    });

    expect(result.ok).toBe(true);
    const added = raw(fx.repo, ['rev-list', '--count', `${result.previousHead}..stable`]);
    expect(added).toBe('1');
    const body = raw(fx.repo, ['log', '-1', '--format=%B', 'stable']);
    expect(body).toContain(fx.sha.J);
    expect(body).toContain(fx.sha.I);
  });

  it('refuses to advance a branch that is checked out elsewhere', async () => {
    // The fixture parks HEAD on prod, so prod must be off limits.
    await expect(
      cherryPick({ repoPath: fx.repo, target: 'prod', shas: [fx.sha.D], style: 'individual' }),
    ).rejects.toThrow(/checked out/i);
    expect(raw(fx.repo, ['rev-parse', 'prod'])).toBe(raw(fx.repo, ['rev-parse', 'HEAD']));
  });

  it('previews commands without touching anything when dryRun is set', async () => {
    const before = raw(fx.repo, ['show-ref']);
    const result = await cherryPick({
      repoPath: fx.repo,
      target: 'stable',
      shas: [fx.sha.D],
      style: 'individual',
      dryRun: true,
    });

    expect(result.commands[0][0]).toBe('cherry-pick');
    expect(result.commands[0]).toContain('-x');
    expect(result.simulation?.clean).toBe(true);
    expect(raw(fx.repo, ['show-ref'])).toBe(before);
  });
});

describe('conflict handling', () => {
  it('stops on a conflict, reports the files, and leaves the branch where it was', async () => {
    const stableBefore = raw(fx.repo, ['rev-parse', 'stable']);
    const checkoutBefore = checkoutSnapshot(fx.repo);

    const result = await cherryPick({
      repoPath: fx.repo,
      target: 'stable',
      shas: [fx.sha.G],
      style: 'individual',
    });

    expect(result.ok).toBe(false);
    expect(result.status.inProgress).toBe(true);
    expect(result.status.conflicts).toContain('misc.txt');
    expect(result.status.worktreePath).toMatch(/gcp-worktree/);
    // Nothing published: the branch has not moved.
    expect(raw(fx.repo, ['rev-parse', 'stable'])).toBe(stableBefore);
    expect(checkoutSnapshot(fx.repo)).toEqual(checkoutBefore);

    const status = await operationStatus(fx.repo);
    expect(status.inProgress).toBe(true);
    expect(status.kind).toBe('cherry-pick');
    expect(status.target).toBe('stable');
  });

  it('restores the starting state on abort', async () => {
    const stableBefore = raw(fx.repo, ['rev-parse', 'stable']);
    await cherryPick({ repoPath: fx.repo, target: 'stable', shas: [fx.sha.G], style: 'individual' });

    const aborted = await abortOperation(fx.repo);
    expect(aborted.ok).toBe(true);
    expect(raw(fx.repo, ['rev-parse', 'stable'])).toBe(stableBefore);
    expect((await operationStatus(fx.repo)).inProgress).toBe(false);
  });

  it('completes the pick after the conflict is resolved', async () => {
    const stableBefore = raw(fx.repo, ['rev-parse', 'stable']);
    const started = await cherryPick({
      repoPath: fx.repo,
      target: 'stable',
      shas: [fx.sha.G],
      style: 'individual',
    });

    // Stand in for the user resolving the conflict in their editor.
    const wt = started.status.worktreePath!;
    writeFileSync(path.join(wt, 'misc.txt'), 'resolved by hand\n', 'utf8');

    const done = await continueOperation(fx.repo);
    expect(done.ok).toBe(true);
    expect(raw(fx.repo, ['rev-parse', 'stable'])).toBe(done.newHead);
    expect(raw(fx.repo, ['rev-parse', 'stable'])).not.toBe(stableBefore);
    expect(raw(fx.repo, ['show', 'stable:misc.txt'])).toBe('resolved by hand');
    expect((await operationStatus(fx.repo)).inProgress).toBe(false);
  });

  it('refuses a second operation while one is mid-flight', async () => {
    await cherryPick({ repoPath: fx.repo, target: 'stable', shas: [fx.sha.G], style: 'individual' });
    await expect(
      cherryPick({ repoPath: fx.repo, target: 'stable', shas: [fx.sha.D], style: 'individual' }),
    ).rejects.toThrow(/already in progress/i);
  });
});

describe('merge promotion', () => {
  it('merges a branch in and leaves the checkout alone', async () => {
    const before = checkoutSnapshot(fx.repo);
    const result = await merge({ repoPath: fx.repo, from: fx.docs.branch, into: 'stable' });

    expect(result.ok, result.message).toBe(true);
    expect(raw(fx.repo, ['rev-parse', 'stable'])).toBe(result.newHead);
    expect(() =>
      raw(fx.repo, ['merge-base', '--is-ancestor', fx.docs.branch, 'stable']),
    ).not.toThrow();
    expect(checkoutSnapshot(fx.repo)).toEqual(before);
  });

  it('back-merges a hotfix from prod down into stable', async () => {
    // prod carries a commit stable never received — the drift the pipeline view
    // flags as "behind".
    expect(() => raw(fx.repo, ['merge-base', '--is-ancestor', fx.hotfix, 'stable'])).toThrow();

    const result = await merge({ repoPath: fx.repo, from: 'prod', into: 'stable' });

    expect(result.ok, result.message).toBe(true);
    expect(() => raw(fx.repo, ['merge-base', '--is-ancestor', fx.hotfix, 'stable'])).not.toThrow();
  });

  it('stops on a promotion conflict without moving the target branch', async () => {
    // develop and stable each introduced misc.txt independently.
    const stableBefore = raw(fx.repo, ['rev-parse', 'stable']);
    const result = await merge({ repoPath: fx.repo, from: 'develop', into: 'stable' });

    expect(result.ok).toBe(false);
    expect(result.status.inProgress).toBe(true);
    expect(result.status.kind).toBe('merge');
    expect(result.status.conflicts).toContain('misc.txt');
    expect(raw(fx.repo, ['rev-parse', 'stable'])).toBe(stableBefore);

    const aborted = await abortOperation(fx.repo);
    expect(aborted.ok).toBe(true);
    expect(raw(fx.repo, ['rev-parse', 'stable'])).toBe(stableBefore);
  });
});
