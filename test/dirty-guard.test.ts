import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { RepoBuilder } from './repo-builder.ts';
import { setConfig } from '../server/config.ts';
import { workingTreeStatus, summarise, repoId } from '../server/services/discover.ts';
import {
  cherryPick,
  merge,
  continueOperation,
  abortOperation,
  skipOperation,
  resolveConflict,
} from '../server/services/ops.ts';

/**
 * Operations are refused while the checkout has uncommitted changes.
 *
 * Note what is *not* blocked: continue, skip, abort and resolve. Blocking those
 * would let a single stray file trap a paused cherry-pick with no way to finish
 * it or unwind it.
 */

let repo: RepoBuilder;

beforeEach(() => {
  repo = new RepoBuilder('prod');
  repo.use(['develop', 'stable', 'prod']);
  setConfig({ blockOnDirty: 'any' });
});
afterEach(() => {
  setConfig({ blockOnDirty: 'any' });
  repo.dispose();
});

function baseline() {
  repo.write('app.txt', 'line 1\n').commit('initial');
  repo.branch('stable').branch('develop');
  repo.checkout('work', 'develop');
  const sha = repo.write('f.txt', 'work\n').commit('work commit');
  repo.checkout('prod');
  return sha;
}

describe('working tree status', () => {
  it('separates modified files from untracked ones', async () => {
    baseline();
    repo.write('app.txt', 'line 1\nmodified\n');
    repo.write('brand-new.txt', 'untracked\n');

    const status = await workingTreeStatus(repo.path);
    expect(status.dirty).toBe(true);
    expect(status.tracked).toContain('app.txt');
    expect(status.untracked).toContain('brand-new.txt');
    expect(status.count).toBe(2);
  });

  it('reports a clean tree as clean', async () => {
    baseline();
    const status = await workingTreeStatus(repo.path);
    expect(status.dirty).toBe(false);
    expect(status.count).toBe(0);
  });

  it('handles a rename, which reports two paths in one record', async () => {
    baseline();
    repo.run(['mv', 'app.txt', 'renamed.txt']);
    const status = await workingTreeStatus(repo.path);
    // The old path must not leak in as a phantom extra entry.
    expect(status.tracked).toContain('renamed.txt');
    expect(status.count).toBe(1);
  });
});

describe('blocking operations', () => {
  it('refuses a cherry-pick when a tracked file is modified', async () => {
    const sha = baseline();
    repo.write('app.txt', 'line 1\nwip\n');

    await expect(
      cherryPick({ repoPath: repo.path, target: 'stable', shas: [sha], style: 'individual' }),
    ).rejects.toThrow(/uncommitted change/i);
  });

  it('names the offending files so the message is actionable', async () => {
    const sha = baseline();
    repo.write('app.txt', 'line 1\nwip\n');
    await expect(
      cherryPick({ repoPath: repo.path, target: 'stable', shas: [sha], style: 'individual' }),
    ).rejects.toThrow(/app\.txt/);
  });

  it('refuses a merge too', async () => {
    baseline();
    repo.write('app.txt', 'line 1\nwip\n');
    await expect(merge({ repoPath: repo.path, from: 'develop', into: 'stable' })).rejects.toThrow(
      /uncommitted change/i,
    );
  });

  it('blocks on an untracked file by default', async () => {
    const sha = baseline();
    repo.write('stray-note.txt', 'just a note\n');
    await expect(
      cherryPick({ repoPath: repo.path, target: 'stable', shas: [sha], style: 'individual' }),
    ).rejects.toThrow(/uncommitted change/i);
  });

  it('allows a dry run, which touches nothing', async () => {
    const sha = baseline();
    repo.write('app.txt', 'line 1\nwip\n');
    const preview = await cherryPick({
      repoPath: repo.path,
      target: 'stable',
      shas: [sha],
      style: 'individual',
      dryRun: true,
    });
    expect(preview.commands.length).toBeGreaterThan(0);
  });

  it('lets the work through once the change is committed', async () => {
    const sha = baseline();
    repo.write('app.txt', 'line 1\nwip\n');
    repo.commit('commit the wip');

    const result = await cherryPick({
      repoPath: repo.path,
      target: 'stable',
      shas: [sha],
      style: 'individual',
    });
    expect(result.ok, result.message).toBe(true);
  });
});

describe('blockOnDirty settings', () => {
  it("'tracked' tolerates untracked files but not modifications", async () => {
    const sha = baseline();
    setConfig({ blockOnDirty: 'tracked' });

    repo.write('stray-note.txt', 'ignored by this setting\n');
    const ok = await cherryPick({
      repoPath: repo.path,
      target: 'stable',
      shas: [sha],
      style: 'individual',
    });
    expect(ok.ok, ok.message).toBe(true);

    repo.write('app.txt', 'line 1\nwip\n');
    await expect(
      merge({ repoPath: repo.path, from: 'develop', into: 'stable' }),
    ).rejects.toThrow(/uncommitted change/i);
  });

  it("'off' disables the check entirely", async () => {
    const sha = baseline();
    setConfig({ blockOnDirty: 'off' });
    repo.write('app.txt', 'line 1\nwip\n');

    const result = await cherryPick({
      repoPath: repo.path,
      target: 'stable',
      shas: [sha],
      style: 'individual',
    });
    expect(result.ok, result.message).toBe(true);
    // And the uncommitted work is still sitting there untouched.
    expect(repo.run(['status', '--porcelain'])).toContain('app.txt');
  });
});

describe('an in-flight operation is never trapped', () => {
  /** Pauses a pick on a conflict, then dirties the checkout. */
  async function pausedThenDirty() {
    baseline();
    const conflicting = repo.write('app.txt', 'line 1\nfrom work\n').commit('work edits app');
    repo.checkout('stable');
    repo.write('app.txt', 'line 1\nfrom stable\n').commit('stable edits app');
    repo.checkout('prod');

    const started = await cherryPick({
      repoPath: repo.path,
      target: 'stable',
      shas: [conflicting],
      style: 'individual',
    });
    expect(started.ok).toBe(false);

    // Now the user has uncommitted work, and a paused operation to deal with.
    repo.write('unrelated-wip.txt', 'written while resolving\n');
    return started;
  }

  it('can still be resolved and continued', async () => {
    const started = await pausedThenDirty();
    await resolveConflict(repo.path, 'app.txt', 'theirs');
    const done = await continueOperation(repo.path);
    expect(done.ok, done.message).toBe(true);
  });

  it('can still be aborted', async () => {
    const started = await pausedThenDirty();
    const aborted = await abortOperation(repo.path);
    expect(aborted.ok, aborted.message).toBe(true);
    expect(repo.sha('stable')).toBe(started.previousHead);
  });

  it('can still be skipped', async () => {
    await pausedThenDirty();
    // Skip is allowed even though the tree is dirty; it may report the next
    // problem, but it must not be refused outright for dirtiness.
    await expect(skipOperation(repo.path)).resolves.toBeTruthy();
  });

  it('but a *new* operation is still refused', async () => {
    await pausedThenDirty();
    await expect(
      merge({ repoPath: repo.path, from: 'develop', into: 'develop' }),
    ).rejects.toThrow(/uncommitted change/i);
  });
});

describe('repo summary', () => {
  it('reports the block and its reason so the UI can explain itself', async () => {
    baseline();
    repo.write('app.txt', 'line 1\nwip\n');
    repo.write('another.txt', 'untracked\n');

    const summary = await summarise({ id: repoId(repo.path), name: 'r', path: repo.path });
    expect(summary.dirty).toBe(true);
    expect(summary.blocked).toBe(true);
    expect(summary.blockedReason).toMatch(/uncommitted change/i);
    expect(summary.uncommitted.tracked).toContain('app.txt');
    expect(summary.uncommitted.untracked).toContain('another.txt');
  });

  it('is not blocked when clean', async () => {
    baseline();
    const summary = await summarise({ id: repoId(repo.path), name: 'r', path: repo.path });
    expect(summary.blocked).toBe(false);
    expect(summary.blockedReason).toBeUndefined();
  });
});
