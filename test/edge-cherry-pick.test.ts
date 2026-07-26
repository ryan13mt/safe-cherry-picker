import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { RepoBuilder } from './repo-builder.ts';
import { hasSequencerState } from '../server/services/worktree.ts';
import {
  cherryPick,
  merge,
  operationStatus,
  continueOperation,
  abortOperation,
  skipOperation,
  conflictReport,
  resolveConflict,
} from '../server/services/ops.ts';
import { simulateCherryPick } from '../server/services/dryrun.ts';
import { logCommits } from '../server/services/commits.ts';

/**
 * Cherry-pick edge cases. Each test builds the smallest repo that produces the
 * situation, so the shape of the history is visible in the test itself.
 */

let repo: RepoBuilder;

beforeEach(() => {
  repo = new RepoBuilder('prod');
  repo.use(['develop', 'stable', 'prod']);
});
afterEach(() => repo.dispose());

/** A baseline: prod/stable/develop all at one commit, plus a work branch. */
function baseline() {
  repo.write('app.txt', 'line 1\n').commit('initial');
  repo.branch('stable').branch('develop');
  repo.checkout('work', 'develop');
}

describe('ordering', () => {
  it('applies commits oldest-first regardless of selection order', async () => {
    baseline();
    const a = repo.write('f.txt', 'a\n').commit('a');
    const b = repo.write('f.txt', 'a\nb\n').commit('b');
    const c = repo.write('f.txt', 'a\nb\nc\n').commit('c');
    repo.checkout('prod');

    // Deliberately reversed: applying c before a would conflict.
    const result = await cherryPick({
      repoPath: repo.path,
      target: 'stable',
      shas: [c, b, a],
      style: 'individual',
    });

    expect(result.ok, result.message).toBe(true);
    expect(repo.run(['show', 'stable:f.txt'])).toBe('a\nb\nc');
    const applied = repo.run(['log', '--format=%s', 'stable', '-3']).split('\n');
    expect(applied).toEqual(['c', 'b', 'a']); // newest-first log = a,b,c applied
  });

  it('orders topologically even when commit timestamps are out of order', async () => {
    baseline();
    // A later commit with an *earlier* timestamp: date sorting would invert
    // these two and the pick would fail to apply.
    const first = repo.write('f.txt', '1\n').commitAt('first', 1_700_000_000);
    const second = repo.write('f.txt', '1\n2\n').commitAt('second', 1_600_000_000);
    repo.checkout('prod');

    const result = await cherryPick({
      repoPath: repo.path,
      target: 'stable',
      shas: [second, first],
      style: 'individual',
    });

    expect(result.ok, result.message).toBe(true);
    expect(repo.run(['show', 'stable:f.txt'])).toBe('1\n2');
  });
});

describe('auditability', () => {
  it('writes a descriptive reflog entry rather than a blank one', async () => {
    baseline();
    const a = repo.write('f.txt', 'a\n').commit('a');
    repo.checkout('prod');

    await cherryPick({
      repoPath: repo.path,
      target: 'stable',
      shas: [a],
      style: 'individual',
      sourceBranch: 'work',
    });

    // update-ref without -m leaves an empty reflog message, which makes
    // everything the app did invisible to `git reflog`.
    const reflog = repo.run(['reflog', 'show', 'stable', '--format=%gs']);
    expect(reflog).toContain('git-cherry-picker: cherry-pick 1 commit(s) from work');
  });

  it('records the reason for a merge too', async () => {
    baseline();
    repo.checkout('develop');
    repo.write('d.txt', 'd\n').commit('develop work');
    repo.checkout('prod');

    await merge({ repoPath: repo.path, from: 'develop', into: 'stable' });
    expect(repo.run(['reflog', 'show', 'stable', '--format=%gs'])).toContain(
      'git-cherry-picker: merge develop into stable',
    );
  });
});

describe('empty and unpickable commits', () => {
  it('pauses on a commit whose changes are already on the target, and skips cleanly', async () => {
    baseline();
    const a = repo.write('f.txt', 'same\n').commit('add f');
    repo.checkout('prod');

    // Apply identical content to stable independently, so the pick is a no-op.
    repo.checkout('stable');
    repo.write('f.txt', 'same\n').commit('add f independently');
    repo.checkout('prod');

    const result = await cherryPick({
      repoPath: repo.path,
      target: 'stable',
      shas: [a],
      style: 'individual',
    });
    expect(result.ok).toBe(false);

    const status = await operationStatus(repo.path);
    expect(status.inProgress).toBe(true);
    expect(status.empty, 'an empty pick must be distinguished from a conflict').toBe(true);
    expect(status.conflicts).toEqual([]);

    const skipped = await skipOperation(repo.path);
    expect(skipped.ok, skipped.message).toBe(true);
    expect((await operationStatus(repo.path)).inProgress).toBe(false);
  });

  it('skips merge commits in a mixed selection and applies the rest', async () => {
    baseline();
    const a = repo.write('a.txt', 'a\n').commit('a');
    repo.checkout('side', 'work');
    repo.write('side.txt', 's\n').commit('side work');
    repo.checkout('work');
    repo.mergeInto('side');
    const mergeSha = repo.sha('HEAD');
    repo.checkout('prod');

    const result = await cherryPick({
      repoPath: repo.path,
      target: 'stable',
      shas: [a, mergeSha],
      style: 'individual',
    });

    expect(result.ok, result.message).toBe(true);
    expect(result.message).toContain('1 commit');
    expect(repo.tryRun(['cat-file', '-e', 'stable:a.txt']).ok).toBe(true);
  });

  it('refuses a selection made up entirely of merge commits', async () => {
    baseline();
    repo.checkout('side', 'work');
    repo.write('s.txt', 's\n').commit('side');
    repo.checkout('work');
    repo.mergeInto('side');
    const mergeSha = repo.sha('HEAD');
    repo.checkout('prod');

    await expect(
      cherryPick({ repoPath: repo.path, target: 'stable', shas: [mergeSha], style: 'individual' }),
    ).rejects.toThrow(/merge commits cannot be picked/i);
  });

  it('rejects a sha that does not exist', async () => {
    baseline();
    repo.checkout('prod');
    await expect(
      cherryPick({
        repoPath: repo.path,
        target: 'stable',
        shas: ['0123456789abcdef0123456789abcdef01234567'],
        style: 'individual',
      }),
    ).rejects.toThrow();
  });

  it('skips root commits when simulating, since they have no parent to diff against', async () => {
    baseline();
    const root = repo.sha('prod');
    const commits = await logCommits({ cwd: repo.path, revs: ['--no-walk', root] });
    const sim = await simulateCherryPick({ repoPath: repo.path, target: 'stable', commits });
    // Nothing applied, but no crash and no bogus conflict either.
    expect(sim.applied).toEqual([]);
    expect(sim.clean).toBe(true);
  });
});

describe('mid-sequence conflicts', () => {
  it('applies what it can, then pauses reporting done and remaining', async () => {
    baseline();
    const a = repo.write('clean.txt', 'clean\n').commit('a: independent file');
    const b = repo.write('shared.txt', 'from work\n').commit('b: touches shared');
    repo.checkout('prod');

    // stable already has a different shared.txt, so b conflicts but a does not.
    repo.checkout('stable');
    repo.write('shared.txt', 'from stable\n').commit('stable version of shared');
    repo.checkout('prod');
    const stableBefore = repo.sha('stable');

    const result = await cherryPick({
      repoPath: repo.path,
      target: 'stable',
      shas: [a, b],
      style: 'individual',
    });

    expect(result.ok).toBe(false);
    expect(result.status.done).toEqual([a]);
    expect(result.status.remaining).toEqual([b]);
    expect(result.status.conflicts).toContain('shared.txt');
    // Crucially the branch has not moved: partial work stays in the worktree.
    expect(repo.sha('stable')).toBe(stableBefore);

    await abortOperation(repo.path);
    expect(repo.sha('stable')).toBe(stableBefore);
  });

  it('refuses to continue while conflict markers remain', async () => {
    baseline();
    const b = repo.write('shared.txt', 'from work\n').commit('work version');
    repo.checkout('stable');
    repo.write('shared.txt', 'from stable\n').commit('stable version');
    repo.checkout('prod');

    const started = await cherryPick({
      repoPath: repo.path,
      target: 'stable',
      shas: [b],
      style: 'individual',
    });
    const wt = started.status.worktreePath!;

    // The file still has git's markers in it — the user hasn't resolved anything.
    expect(readFileSync(path.join(wt, 'shared.txt'), 'utf8')).toContain('<<<<<<<');

    const attempted = await continueOperation(repo.path);
    expect(attempted.ok).toBe(false);
    expect(attempted.message).toMatch(/conflict markers/i);
    expect((await operationStatus(repo.path)).inProgress).toBe(true);

    // Resolve properly and it goes through.
    writeFileSync(path.join(wt, 'shared.txt'), 'merged by hand\n', 'utf8');
    const done = await continueOperation(repo.path);
    expect(done.ok, done.message).toBe(true);
    expect(repo.run(['show', 'stable:shared.txt'])).toBe('merged by hand');
  });
});

describe('conflict kinds', () => {
  async function startConflict(setup: () => string) {
    const sha = setup();
    repo.checkout('prod');
    return cherryPick({ repoPath: repo.path, target: 'stable', shas: [sha], style: 'individual' });
  }

  it('reports a both-modified conflict with all three versions and the incoming diff', async () => {
    baseline();
    const sha = repo.write('app.txt', 'line 1\nwork change\n').commit('work edit');
    repo.checkout('stable');
    repo.write('app.txt', 'line 1\nstable change\n').commit('stable edit');
    repo.checkout('prod');

    await cherryPick({ repoPath: repo.path, target: 'stable', shas: [sha], style: 'individual' });
    const report = await conflictReport(repo.path);

    expect(report.inProgress).toBe(true);
    expect(report.kind).toBe('cherry-pick');
    expect(report.incoming?.subject).toBe('work edit');

    const file = report.files.find((f) => f.path === 'app.txt')!;
    expect(file.kind).toBe('both-modified');
    expect(file.base).toContain('line 1');
    expect(file.ours).toContain('stable change');
    expect(file.theirs).toContain('work change');
    expect(file.hunks.length).toBeGreaterThan(0);
    expect(file.hunks[0].ours.join('\n')).toContain('stable change');
    expect(file.hunks[0].theirs.join('\n')).toContain('work change');
    expect(file.incomingDiff).toContain('work change');
  });

  it('reports both-added when neither side has a common ancestor for the file', async () => {
    baseline();
    const sha = repo.write('new.txt', 'work version\n').commit('add new.txt on work');
    repo.checkout('stable');
    repo.write('new.txt', 'stable version\n').commit('add new.txt on stable');
    repo.checkout('prod');

    await cherryPick({ repoPath: repo.path, target: 'stable', shas: [sha], style: 'individual' });
    const file = (await conflictReport(repo.path)).files.find((f) => f.path === 'new.txt')!;

    expect(file.kind).toBe('both-added');
    expect(file.base).toBeUndefined();
  });

  it('reports a binary conflict without trying to show hunks', async () => {
    baseline();
    repo.binary('logo.png', 1).commit('add binary');
    repo.branch('stable-binary');
    const sha = repo.binary('logo.png', 2).commit('change binary on work');

    repo.checkout('stable');
    repo.run(['cherry-pick', repo.sha('work~1')]); // both sides have the original
    repo.binary('logo.png', 3).commit('change binary on stable');
    repo.checkout('prod');

    await cherryPick({ repoPath: repo.path, target: 'stable', shas: [sha], style: 'individual' });
    const file = (await conflictReport(repo.path)).files.find((f) => f.path === 'logo.png')!;

    expect(file.binary).toBe(true);
    expect(file.hunks).toEqual([]);
  });

  it('reports a modify/delete conflict and can accept the deletion', async () => {
    baseline();
    repo.write('doomed.txt', 'content\n').commit('add doomed.txt');
    repo.branch('stable-tmp');
    const sha = repo.remove('doomed.txt').commit('delete doomed.txt on work');

    repo.checkout('stable');
    repo.run(['cherry-pick', repo.sha('work~1')]); // stable gets the file
    repo.write('doomed.txt', 'content\nstable edit\n').commit('edit doomed.txt on stable');
    repo.checkout('prod');

    await cherryPick({ repoPath: repo.path, target: 'stable', shas: [sha], style: 'individual' });
    const report = await conflictReport(repo.path);
    const file = report.files.find((f) => f.path === 'doomed.txt')!;
    expect(file.kind).toBe('deleted-by-them');

    await resolveConflict(repo.path, 'doomed.txt', 'theirs'); // accept the deletion
    const done = await continueOperation(repo.path);
    expect(done.ok, done.message).toBe(true);
    expect(repo.tryRun(['cat-file', '-e', 'stable:doomed.txt']).ok).toBe(false);
  });

  it('can take either side of a content conflict from the UI', async () => {
    baseline();
    const sha = repo.write('app.txt', 'line 1\nwork\n').commit('work edit');
    repo.checkout('stable');
    repo.write('app.txt', 'line 1\nstable\n').commit('stable edit');
    repo.checkout('prod');

    await cherryPick({ repoPath: repo.path, target: 'stable', shas: [sha], style: 'individual' });
    await resolveConflict(repo.path, 'app.txt', 'theirs');

    const done = await continueOperation(repo.path);
    expect(done.ok, done.message).toBe(true);
    expect(repo.run(['show', 'stable:app.txt'])).toBe('line 1\nwork');
  });

  it('names both sides by branch, and attributes each line to the commit that added it', async () => {
    baseline();

    // Two distinct commits on the work branch touch the same file, so blame on
    // "theirs" must attribute the conflicting line to the second one.
    repo.write('app.txt', 'line 1\nshared base\n').commit('work: groundwork');
    const culprit = repo.write('app.txt', 'line 1\nwork wins\n').commit('work: the change that clashes');

    repo.checkout('stable');
    const stableCommit = repo.write('app.txt', 'line 1\nstable wins\n').commit('stable: competing change');
    repo.checkout('prod');

    await cherryPick({
      repoPath: repo.path,
      target: 'stable',
      shas: [culprit],
      style: 'individual',
      sourceBranch: 'work',
    });

    const report = await conflictReport(repo.path);

    // Column provenance, so the UI never has to say just "ours" and "theirs".
    expect(report.ours?.branch).toBe('stable');
    expect(report.theirs?.branch).toBe('work');
    expect(report.theirs?.commit?.short).toBe(culprit.slice(0, 7));

    const file = report.files.find((f) => f.path === 'app.txt')!;
    const hunk = file.hunks[0];

    // Line numbers within each side's own file, not the merged one.
    expect(hunk.oursStart).toBeGreaterThan(0);
    expect(hunk.theirsStart).toBeGreaterThan(0);

    // Blame: one entry per displayed line, naming the right commit each side.
    expect(hunk.oursBlame).toHaveLength(hunk.ours.length);
    expect(hunk.theirsBlame).toHaveLength(hunk.theirs.length);
    expect(hunk.oursBlame![0].sha).toBe(stableCommit);
    expect(hunk.oursBlame![0].summary).toBe('stable: competing change');
    expect(hunk.theirsBlame![0].sha).toBe(culprit);
    expect(hunk.theirsBlame![0].summary).toBe('work: the change that clashes');
    expect(hunk.theirsBlame![0].author).toBe('Edge Bot');
  });

  it('falls back to a containing branch when no source branch was recorded', async () => {
    baseline();
    const sha = repo.write('app.txt', 'line 1\nwork\n').commit('work edit');
    repo.checkout('stable');
    repo.write('app.txt', 'line 1\nstable\n').commit('stable edit');
    repo.checkout('prod');

    // No sourceBranch supplied — e.g. an API caller that didn't send one.
    await cherryPick({ repoPath: repo.path, target: 'stable', shas: [sha], style: 'individual' });

    const report = await conflictReport(repo.path);
    // 'work' contains the commit and isn't part of the promotion chain.
    expect(report.theirs?.branch).toBe('work');
  });

  it('sends the whole merged file so context can be widened without refetching', async () => {
    baseline();
    for (let i = 0; i < 30; i++) repo.write(`filler-${i}.txt`, `${i}\n`);
    repo.commit('bulk filler');
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    repo.write('big.txt', `${long}\n`).commit('add big file');
    repo.branch('stable-src');
    const sha = repo.write('big.txt', `${long}\nwork tail\n`).commit('work appends');

    repo.checkout('stable');
    repo.run(['cherry-pick', repo.sha('work~1')]);
    repo.write('big.txt', `${long}\nstable tail\n`).commit('stable appends');
    repo.checkout('prod');

    await cherryPick({ repoPath: repo.path, target: 'stable', shas: [sha], style: 'individual' });
    const file = (await conflictReport(repo.path)).files.find((f) => f.path === 'big.txt')!;

    // The client slices context out of this rather than asking the server again.
    expect(file.merged!.split('\n').length).toBeGreaterThan(40);
    expect(file.hunks[0].startLine).toBeGreaterThan(3);
  });

  it('rejects resolving a file that is not conflicted', async () => {
    baseline();
    const sha = repo.write('app.txt', 'line 1\nwork\n').commit('work edit');
    repo.checkout('stable');
    repo.write('app.txt', 'line 1\nstable\n').commit('stable edit');
    repo.checkout('prod');

    await cherryPick({ repoPath: repo.path, target: 'stable', shas: [sha], style: 'individual' });
    await expect(resolveConflict(repo.path, 'not-a-file.txt', 'ours')).rejects.toThrow(
      /not conflicted/i,
    );
  });
});

describe('unicode and unusual paths', () => {
  it('handles non-ascii filenames, subjects and content', async () => {
    baseline();
    const sha = repo
      .write('docs/naïve — café.txt', 'héllo wörld 😀\n')
      .commit('[JIRA-1] añadir documentación — 日本語');
    repo.checkout('prod');

    const result = await cherryPick({
      repoPath: repo.path,
      target: 'stable',
      shas: [sha],
      style: 'individual',
    });

    expect(result.ok, result.message).toBe(true);
    const subject = repo.run(['log', '-1', '--format=%s', 'stable']);
    expect(subject).toContain('añadir documentación');
    expect(subject).toContain('日本語');
  });

  it('handles branch names containing slashes and dots', async () => {
    baseline();
    repo.checkout('release/2.1.x', 'develop');
    const sha = repo.write('r.txt', 'release\n').commit('release work');
    repo.checkout('prod');

    const result = await merge({ repoPath: repo.path, from: 'release/2.1.x', into: 'stable' });
    expect(result.ok, result.message).toBe(true);
    expect(repo.tryRun(['merge-base', '--is-ancestor', sha, 'stable']).ok).toBe(true);
  });
});

describe('concurrency and interference', () => {
  it('serialises two operations issued at the same time', async () => {
    baseline();
    const a = repo.write('a.txt', 'a\n').commit('a');
    const b = repo.write('b.txt', 'b\n').commit('b');
    repo.checkout('prod');

    // Both start before either finishes; the lock must keep them from sharing
    // the single worktree.
    const [first, second] = await Promise.allSettled([
      cherryPick({ repoPath: repo.path, target: 'stable', shas: [a], style: 'individual' }),
      cherryPick({ repoPath: repo.path, target: 'stable', shas: [b], style: 'individual' }),
    ]);

    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('fulfilled');
    // Both landed, in order, without corrupting each other.
    expect(repo.tryRun(['cat-file', '-e', 'stable:a.txt']).ok).toBe(true);
    expect(repo.tryRun(['cat-file', '-e', 'stable:b.txt']).ok).toBe(true);
  });

  it('refuses to move the branch if it changed under us', async () => {
    baseline();
    const b = repo.write('shared.txt', 'work\n').commit('work version');
    repo.checkout('stable');
    repo.write('shared.txt', 'stable\n').commit('stable version');
    repo.checkout('prod');

    const started = await cherryPick({
      repoPath: repo.path,
      target: 'stable',
      shas: [b],
      style: 'individual',
    });
    const wt = started.status.worktreePath!;

    // Someone else advances stable while we sit on the conflict.
    repo.checkout('stable');
    repo.write('meanwhile.txt', 'other work\n').commit('concurrent commit on stable');
    const movedTo = repo.sha('stable');
    repo.checkout('prod');

    writeFileSync(path.join(wt, 'shared.txt'), 'resolved\n', 'utf8');

    // The compare-and-swap must refuse rather than discard the other commit.
    await expect(continueOperation(repo.path)).rejects.toThrow();
    expect(repo.sha('stable')).toBe(movedTo);
  });
});

describe('squash mode', () => {
  /**
   * The shape that produced "your local changes would be overwritten by
   * cherry-pick": the first commit *adds* a file and the second modifies it.
   * Implemented with `cherry-pick -n A B` this fails, because git needs a clean
   * tree before each pick and -n leaves the first pick uncommitted. Two commits
   * editing a pre-existing file happen to survive that, which is exactly why it
   * needs a test of its own.
   */
  it('squashes commits where the first adds a file the second then edits', async () => {
    baseline();
    const add = repo.write('feature.js', 'export const a = 1;\n').commit('add feature module');
    const edit = repo
      .write('feature.js', 'export const a = 1;\nexport const b = 2;\n')
      .commit('extend feature module');
    repo.checkout('prod');

    const result = await cherryPick({
      repoPath: repo.path,
      target: 'stable',
      shas: [add, edit],
      style: 'squash',
      sourceBranch: 'work',
    });

    expect(result.ok, result.message).toBe(true);
    expect(repo.run(['rev-list', '--count', `${result.previousHead}..stable`])).toBe('1');
    expect(repo.run(['show', 'stable:feature.js'])).toBe(
      'export const a = 1;\nexport const b = 2;',
    );

    // Both sources are still traceable from the single commit's message.
    const body = repo.run(['log', '-1', '--format=%B', 'stable']);
    expect(body).toContain(add);
    expect(body).toContain(edit);
  });

  it('squashes three commits including a delete', async () => {
    baseline();
    const one = repo.write('a.js', 'a\n').commit('add a');
    const two = repo.write('b.js', 'b\n').commit('add b');
    const three = repo.remove('a.js').commit('drop a again');
    repo.checkout('prod');

    const result = await cherryPick({
      repoPath: repo.path,
      target: 'stable',
      shas: [one, two, three],
      style: 'squash',
    });

    expect(result.ok, result.message).toBe(true);
    expect(repo.run(['rev-list', '--count', `${result.previousHead}..stable`])).toBe('1');
    expect(repo.tryRun(['cat-file', '-e', 'stable:a.js']).ok).toBe(false);
    expect(repo.tryRun(['cat-file', '-e', 'stable:b.js']).ok).toBe(true);
  });

  it('collapses into one commit after a conflict is resolved mid-sequence', async () => {
    baseline();
    const add = repo.write('shared.js', 'from work\n').commit('work adds shared');
    const edit = repo.write('shared.js', 'from work\nmore work\n').commit('work extends shared');

    repo.checkout('stable');
    repo.write('shared.js', 'from stable\n').commit('stable adds shared');
    repo.checkout('prod');

    const started = await cherryPick({
      repoPath: repo.path,
      target: 'stable',
      shas: [add, edit],
      style: 'squash',
    });
    expect(started.ok).toBe(false);
    expect(started.status.conflicts).toContain('shared.js');

    // Take the incoming version, so the second commit in the sequence still
    // applies onto the base it expects.
    await resolveConflict(repo.path, 'shared.js', 'theirs');
    const done = await continueOperation(repo.path);

    expect(done.ok, done.message).toBe(true);
    // Still exactly one commit, despite the pick having been interrupted.
    expect(repo.run(['rev-list', '--count', `${started.previousHead}..stable`])).toBe('1');
    expect(repo.run(['show', 'stable:shared.js'])).toBe('from work\nmore work');
  });

  it('reports nothing to do when every squashed pick turns out empty', async () => {
    baseline();
    const a = repo.write('same.js', 'identical\n').commit('work adds same.js');
    repo.checkout('stable');
    repo.write('same.js', 'identical\n').commit('stable adds same.js independently');
    repo.checkout('prod');

    const started = await cherryPick({
      repoPath: repo.path,
      target: 'stable',
      shas: [a],
      style: 'squash',
    });
    // The pick is empty, so it pauses rather than silently producing nothing.
    expect(started.ok).toBe(false);
    const status = await operationStatus(repo.path);
    expect(status.empty).toBe(true);

    const skipped = await skipOperation(repo.path);
    expect(skipped.ok, skipped.message).toBe(true);
    // Nothing was committed, and the branch is where it started.
    expect(repo.sha('stable')).toBe(started.previousHead);
  });

  it('previews the collapse commands, not a -n pick', async () => {
    baseline();
    const a = repo.write('f.js', 'a\n').commit('a');
    repo.checkout('prod');

    const preview = await cherryPick({
      repoPath: repo.path,
      target: 'stable',
      shas: [a],
      style: 'squash',
      dryRun: true,
    });

    const flat = preview.commands.map((c) => c.join(' '));
    expect(flat.some((c) => c.startsWith('cherry-pick -x'))).toBe(true);
    expect(flat.some((c) => c.startsWith('reset --soft'))).toBe(true);
    expect(flat.some((c) => c.startsWith('commit -m'))).toBe(true);
    expect(flat.join(' '), 'the -n approach is unreliable and must not come back').not.toContain('-n');
  });
});

describe('leftover sequencer state', () => {
  /**
   * The state that produced "error: cherry-pick is already in progress" in real
   * use: git keeps a `sequencer/` directory for a multi-commit pick, and it can
   * outlive CHERRY_PICK_HEAD. Detecting only CHERRY_PICK_HEAD meant the app
   * reported everything clear, offered no way out, and then failed on the next
   * pick because git disagreed.
   */
  /** The managed worktree's own git dir, where its CHERRY_PICK_HEAD lives. */
  const worktreeGitDir = () => path.join(repo.path, '.git', 'worktrees', 'gcp-worktree');

  async function wedgeWithSequencer() {
    baseline();
    const a = repo.write('one.txt', 'work one\n').commit('a');
    const b = repo.write('two.txt', 'work two\n').commit('b');
    repo.checkout('stable');
    repo.write('one.txt', 'stable one\n').commit('stable version of one');
    repo.checkout('prod');

    // A two-commit pick where the first conflicts, so git writes a sequencer.
    const started = await cherryPick({
      repoPath: repo.path,
      target: 'stable',
      shas: [a, b],
      style: 'individual',
    });
    const wt = started.status.worktreePath!;
    expect(await hasSequencerState(wt), 'expected git to write a sequencer').toBe(true);

    // Simulate the crash: CHERRY_PICK_HEAD disappears, sequencer remains.
    const headPath = path.join(worktreeGitDir(), 'CHERRY_PICK_HEAD');
    expect(existsSync(headPath)).toBe(true);
    rmSync(headPath);

    return { wt, a, b };
  }

  it('is still reported as in progress once CHERRY_PICK_HEAD is gone', async () => {
    const { wt } = await wedgeWithSequencer();

    expect(await hasSequencerState(wt)).toBe(true);
    const status = await operationStatus(repo.path);
    expect(status.inProgress, 'git considers a pick running, so we must too').toBe(true);
    expect(status.kind).toBe('cherry-pick');
  });

  it('does not claim the commit is empty when there is no current commit', async () => {
    const { wt } = await wedgeWithSequencer();
    void wt;
    const status = await operationStatus(repo.path);
    // Nothing is staged here either, but "skip it, it's already applied" would
    // be a guess — there is no commit to skip.
    expect(status.empty).toBe(false);
    expect(status.message).not.toMatch(/already on/i);
  });

  it('refuses a new pick instead of letting git fail with "already in progress"', async () => {
    const { b } = await wedgeWithSequencer();
    await expect(
      cherryPick({ repoPath: repo.path, target: 'stable', shas: [b], style: 'individual' }),
    ).rejects.toThrow(/already in progress/i);
  });

  it('clears it on abort, leaving the branch untouched', async () => {
    const { wt, b } = await wedgeWithSequencer();
    // The paused pick never moved the branch, so this is still the pre-op value.
    const stableBefore = repo.sha('stable');

    const aborted = await abortOperation(repo.path);
    expect(aborted.ok, aborted.message).toBe(true);
    expect(await hasSequencerState(wt)).toBe(false);
    expect((await operationStatus(repo.path)).inProgress).toBe(false);
    expect(repo.sha('stable')).toBe(stableBefore);

    // And the next pick works rather than inheriting the wedge. `b` touches a
    // file stable doesn't have, so it applies cleanly.
    const after = await cherryPick({
      repoPath: repo.path,
      target: 'stable',
      shas: [b],
      style: 'individual',
    });
    expect(after.ok, after.message).toBe(true);
  });

  it('reports an operation it has no record of as orphaned, not continuable', async () => {
    const { wt } = await wedgeWithSequencer();
    // Lose the app's own record too, as a crash between writes would.
    rmSync(path.join(repo.path, '.git', 'gcp-state.json'));

    const status = await operationStatus(repo.path);
    expect(status.inProgress).toBe(true);
    expect(status.orphaned).toBe(true);
    expect(status.message).toMatch(/no record/i);

    // Abort still rescues it.
    const aborted = await abortOperation(repo.path);
    expect(aborted.ok, aborted.message).toBe(true);
    expect(await hasSequencerState(wt)).toBe(false);
  });
});

describe('worktree isolation', () => {
  it('never touches the checkout, even across a conflict and abort', async () => {
    baseline();
    const sha = repo.write('app.txt', 'line 1\nwork\n').commit('work edit');
    repo.checkout('stable');
    repo.write('app.txt', 'line 1\nstable\n').commit('stable edit');
    repo.checkout('prod');

    repo.write('scratch.txt', 'my uncommitted notes\n');
    const before = {
      head: repo.sha('HEAD'),
      branch: repo.run(['rev-parse', '--abbrev-ref', 'HEAD']),
      status: repo.run(['status', '--porcelain']),
    };

    await cherryPick({ repoPath: repo.path, target: 'stable', shas: [sha], style: 'individual' });
    await abortOperation(repo.path);

    expect({
      head: repo.sha('HEAD'),
      branch: repo.run(['rev-parse', '--abbrev-ref', 'HEAD']),
      status: repo.run(['status', '--porcelain']),
    }).toEqual(before);
    expect(readFileSync(path.join(repo.path, 'scratch.txt'), 'utf8')).toBe(
      'my uncommitted notes\n',
    );
    expect(existsSync(path.join(repo.path, 'app.txt'))).toBe(true);
  });
});
