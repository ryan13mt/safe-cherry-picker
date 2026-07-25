import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Builds a throwaway repo that exercises every case the classifier has to get
 * right. Nothing here goes through server/git.ts — this is raw git, so the
 * fixture is an independent check on the app rather than a mirror of it.
 *
 * Shape of the result:
 *
 *   prod      c0 only — nothing released
 *   stable    a placeholder commit, three cherry-picks (two plain, one -x)
 *             and a squash commit; two tickets left half-done
 *   develop   the whole feature branch merged, so everything is an ancestor
 *
 * feature/JIRA-900-mixed carries ten commits belonging to six tickets, two of
 * which are interleaved through the same file so a partial pick really does
 * conflict.
 */

// Recent, so the fixture looks like a live repo rather than ancient history.
let clock = Math.floor(Date.now() / 1000) - 30 * 86400;

function run(cwd, args, env = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commit(repo, message) {
  clock += 60;
  const stamp = `${clock} +0000`;
  run(repo, ['add', '-A']);
  run(repo, ['commit', '-m', message], {
    GIT_AUTHOR_DATE: stamp,
    GIT_COMMITTER_DATE: stamp,
  });
  return run(repo, ['rev-parse', 'HEAD']);
}

function write(repo, file, contents) {
  writeFileSync(path.join(repo, file), contents, 'utf8');
}

export function makeFixture(dir) {
  const repo = dir ?? mkdtempSync(path.join(tmpdir(), 'gcp-fixture-'));

  run(repo, ['init', '--initial-branch=prod', '--quiet']);
  run(repo, ['config', 'user.name', 'Fixture Bot']);
  run(repo, ['config', 'user.email', 'fixture@example.invalid']);
  run(repo, ['config', 'commit.gpgsign', 'false']);
  run(repo, ['config', 'core.autocrlf', 'false']);

  write(repo, 'base.txt', 'base\n');
  const c0 = commit(repo, 'initial commit');

  run(repo, ['branch', 'stable']);
  run(repo, ['branch', 'develop']);

  // ---- feature branch -----------------------------------------------------
  const branch = 'feature/JIRA-900-mixed';
  run(repo, ['checkout', '--quiet', '-b', branch, 'develop']);
  const sha = {};

  write(repo, 'export.txt', 'export module\n');
  sha.A = commit(repo, '[JIRA-412] add export module');

  write(repo, 'parser.txt', 'parse v1\n');
  sha.B = commit(repo, '[JIRA-388] fix null in parser');

  write(repo, 'export-csv.txt', 'csv writer\n');
  sha.C = commit(repo, '[JIRA-412] add csv writer');

  write(repo, 'parser-test.txt', 'regression test\n');
  sha.D = commit(repo, '[JIRA-388] add regression test');

  // No ticket in the subject: must fall back to the branch name (JIRA-900).
  write(repo, 'deps.txt', 'deps v2\n');
  sha.E = commit(repo, 'chore: bump deps');

  write(repo, 'audit.txt', 'audit log\n');
  sha.F = commit(repo, '[JIRA-401] audit log');

  // Mentions an id mid-subject. Strict matching must not read JIRA-555 as this
  // commit's ticket; it falls back to the branch name like any other unprefixed
  // commit.
  write(repo, 'misc.txt', 'feature version\n');
  sha.G = commit(repo, 'refactor similar to JIRA-555 handling');

  // Lowercase prefix must normalise to JIRA-777.
  write(repo, 'low.txt', 'lowercase\n');
  sha.H = commit(repo, '[jira-777] lowercase ticket');

  // J and I both touch parser.txt. Picking I while skipping J is the
  // interleaving case that has to be reported as a genuine conflict.
  write(repo, 'parser.txt', 'parse v1\ntweak\n');
  sha.J = commit(repo, '[JIRA-999] parser tweak');

  write(repo, 'parser.txt', 'parse v1\ntweak\ntighten\n');
  sha.I = commit(repo, '[JIRA-812] tighten parser');

  // ---- develop: whole branch merged, so every commit is an ancestor -------
  run(repo, ['checkout', '--quiet', 'develop']);
  clock += 60;
  run(repo, ['merge', '--no-ff', '--no-edit', '-m', `Merge branch '${branch}' into develop`, branch], {
    GIT_AUTHOR_DATE: `${clock} +0000`,
    GIT_COMMITTER_DATE: `${clock} +0000`,
  });

  // ---- a branch with no ticket in its name, to exercise Ungrouped ---------
  // Branched off develop *after* the merge above, so develop is well ahead of
  // stable and prod. That makes it the case where an earliest-merge-base would
  // wrongly attribute the whole feature branch to this spike.
  const plainBranch = 'spike/tidy-up';
  run(repo, ['checkout', '--quiet', '-b', plainBranch, 'develop']);

  write(repo, 'spike-a.txt', 'ticketed work\n');
  const plainTicketed = commit(repo, '[JIRA-333] ticketed spike work');

  write(repo, 'spike-b.txt', 'whitespace\n');
  const plainUngrouped = commit(repo, 'tidy up whitespace');

  // ...and merged straight back in. Now its merge-base with develop is its own
  // tip, so the fork point can only be recovered from the merge commit.
  run(repo, ['checkout', '--quiet', 'develop']);
  clock += 60;
  run(repo, ['merge', '--no-ff', '--no-edit', '-m', `Merge branch '${plainBranch}' into develop`, plainBranch], {
    GIT_AUTHOR_DATE: `${clock} +0000`,
    GIT_COMMITTER_DATE: `${clock} +0000`,
  });

  // ---- stable: a partial, mixed-method release ---------------------------
  run(repo, ['checkout', '--quiet', 'stable']);

  // Creates misc.txt independently so cherry-picking G is an add/add conflict.
  write(repo, 'misc.txt', 'stable version\n');
  commit(repo, 'chore: add misc placeholder');

  // Plain picks: SHA changes, patch-id still matches -> 'patch-id', high confidence.
  run(repo, ['cherry-pick', sha.A]);
  run(repo, ['cherry-pick', sha.C]);

  // Recorded pick: leaves a trailer -> 'traced', exact confidence.
  run(repo, ['cherry-pick', '-x', sha.B]);

  // Squash merge: different patch, but the body lists the original subject ->
  // 'squashed', low confidence. Content deliberately differs so patch-id cannot
  // match and we exercise the heuristic rather than accidentally the exact path.
  write(repo, 'audit.txt', 'audit log\nplus squash extras\n');
  commit(repo, '[JIRA-401] audit log rollup (#42)\n\n* [JIRA-401] audit log\n* misc tidy-up');

  // A branch off stable touching only a new file: merges cleanly by
  // construction, so merge mechanics can be tested without a conflict.
  const docsBranch = 'docs/tidy-readme';
  run(repo, ['checkout', '--quiet', '-b', docsBranch, 'stable']);
  write(repo, 'docs.txt', 'expanded docs\n');
  const docsCommit = commit(repo, 'docs: expand the readme');

  // Park HEAD on prod so stable and develop stay free for worktree operations.
  run(repo, ['checkout', '--quiet', 'prod']);

  // A hotfix straight onto prod: the classic case where the downstream branch
  // holds something the upstream ones never got back. This is what the pipeline
  // view's "behind" warning exists to surface.
  write(repo, 'hotfix.txt', 'urgent production fix\n');
  const hotfix = commit(repo, 'hotfix: patch production incident');

  return {
    repo,
    branch,
    base: c0,
    sha,
    /** Branch with no id in its name: its unprefixed commit lands in Ungrouped. */
    plain: { branch: plainBranch, ticketed: plainTicketed, ungrouped: plainUngrouped },
    /** Commit that exists only on prod, awaiting a back-merge. */
    hotfix,
    /** Branch off stable that merges back into it without conflict. */
    docs: { branch: docsBranch, sha: docsCommit },
    tickets: {
      'JIRA-412': [sha.A, sha.C], // fully released to stable
      'JIRA-388': [sha.B, sha.D], // PARTIAL on stable: B picked, D not
      'JIRA-401': [sha.F], // squash-matched only
      'JIRA-900': [sha.E, sha.G], // grouped by branch-name fallback
      'JIRA-777': [sha.H],
      'JIRA-999': [sha.J],
      'JIRA-812': [sha.I],
    },
  };
}

export function cleanupFixture(repo) {
  rmSync(repo, { recursive: true, force: true, maxRetries: 3 });
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('make-fixture.mjs')) {
  const target = process.argv[2];
  const result = makeFixture(target ? path.resolve(target) : undefined);
  console.log(JSON.stringify(result, null, 2));
}
