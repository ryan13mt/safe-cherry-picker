import { git, GitError } from '../git.ts';
import type { CommitInfo, SimulationResult } from '../../shared/types.ts';

/**
 * Will this cherry-pick actually conflict?
 *
 * Picking one ticket out of a branch means skipping the other tickets' commits
 * interleaved with it, which is exactly when picks blow up. Rather than guess
 * from file overlap, we replay the pick for real using `git merge-tree
 * --write-tree` (git >= 2.38), which performs a full three-way merge purely in
 * the object database.
 *
 * Cherry-picking C onto T is the three-way merge of T and C with base C^:
 *
 *     git merge-tree --write-tree --merge-base=<C^> <T> <C>
 *
 * Exit 0 means clean and stdout holds the resulting tree; exit 1 means conflict
 * and stdout also lists the conflicted paths. To simulate a *sequence* we wrap
 * each resulting tree in a throwaway commit and feed it forward as the next
 * "ours".
 *
 * Caveat, stated plainly: this writes a handful of unreferenced objects to the
 * object database (the trees and the throwaway commits). Nothing else is
 * touched — no ref moves, no index, no working tree — and git prunes dangling
 * objects during routine gc.
 */

const SIM_ENV = {
  GIT_AUTHOR_NAME: 'gcp-simulation',
  GIT_AUTHOR_EMAIL: 'simulation@git-cherry-picker.local',
  GIT_COMMITTER_NAME: 'gcp-simulation',
  GIT_COMMITTER_EMAIL: 'simulation@git-cherry-picker.local',
};

export async function supportsMergeTree(repoPath: string): Promise<boolean> {
  const res = await git(['merge-tree', '--write-tree', '-h'], { cwd: repoPath, allowFail: true });
  return /--write-tree/.test(res.stdout + res.stderr);
}

/**
 * Splits `merge-tree -z` output. Documented shape:
 *   <tree oid> NUL [<conflicted path> NUL ...] NUL <informational messages>
 * The empty field terminates the conflicted-path section.
 */
export function parseMergeTreeOutput(stdout: string): { tree: string; conflicts: string[] } {
  const fields = stdout.split('\0');
  const tree = (fields[0] ?? '').trim();
  const conflicts: string[] = [];
  for (let i = 1; i < fields.length && conflicts.length < 500; i++) {
    const field = fields[i];
    if (field === '') break; // end of the conflicted-file section
    conflicts.push(field.replace(/\n$/, ''));
  }
  return { tree, conflicts: [...new Set(conflicts)] };
}

/**
 * The merge equivalent of the cherry-pick simulation. `merge-tree` works out
 * the merge base itself here, so this is a single call with no chaining.
 */
export async function simulateMerge(input: {
  repoPath: string;
  target: string;
  from: string;
}): Promise<SimulationResult> {
  const { repoPath, target, from } = input;
  const result: SimulationResult = {
    target,
    clean: true,
    applied: [],
    conflicts: [],
    skippedMerges: [],
  };

  const res = await git(['merge-tree', '--write-tree', '-z', '--name-only', target, from], {
    cwd: repoPath,
    allowFail: true,
  });

  if (res.code !== 0 && res.code !== 1) {
    result.clean = false;
    // Unrelated histories are the common case here, and git's own wording is
    // clearer than anything we'd invent.
    result.error = (res.stderr || res.stdout).trim() || `merge-tree exited ${res.code}`;
    return result;
  }

  if (res.code === 1) {
    result.clean = false;
    result.conflicts = parseMergeTreeOutput(res.stdout).conflicts;
  }
  return result;
}

export interface SimulateInput {
  repoPath: string;
  target: string;
  /** Commits to apply, in the order they will be applied (oldest first). */
  commits: CommitInfo[];
}

export async function simulateCherryPick(input: SimulateInput): Promise<SimulationResult> {
  const { repoPath, target, commits } = input;
  const result: SimulationResult = {
    target,
    clean: true,
    applied: [],
    conflicts: [],
    skippedMerges: [],
  };

  const pickable = commits.filter((c) => {
    if (c.isMerge) {
      result.skippedMerges.push(c.sha);
      return false;
    }
    return c.parents.length === 1;
  });

  if (pickable.length === 0) return result;

  try {
    let head = (await git(['rev-parse', `${target}^{commit}`], { cwd: repoPath })).stdout.trim();

    for (const commit of pickable) {
      const base = commit.parents[0];
      const res = await git(
        [
          'merge-tree',
          '--write-tree',
          '-z',
          '--name-only',
          `--merge-base=${base}`,
          head,
          commit.sha,
        ],
        { cwd: repoPath, allowFail: true },
      );

      // Anything other than 0/1 is a real error (bad object, unrelated history).
      if (res.code !== 0 && res.code !== 1) {
        result.clean = false;
        result.error = (res.stderr || res.stdout).trim() || `merge-tree exited ${res.code}`;
        result.failedAt = { sha: commit.sha, short: commit.short, subject: commit.subject };
        return result;
      }

      const { tree, conflicts } = parseMergeTreeOutput(res.stdout);

      if (res.code === 1) {
        result.clean = false;
        result.conflicts = conflicts;
        result.failedAt = { sha: commit.sha, short: commit.short, subject: commit.subject };
        return result;
      }

      result.applied.push(commit.sha);

      // Carry the merged tree forward as the next "ours".
      const next = await git(
        ['commit-tree', tree, '-p', head, '-m', `simulated pick ${commit.short}`],
        { cwd: repoPath, write: true, env: SIM_ENV },
      );
      head = next.stdout.trim();
    }
  } catch (err) {
    result.clean = false;
    result.error = err instanceof GitError ? err.stderr.trim() || err.message : String(err);
  }

  return result;
}
