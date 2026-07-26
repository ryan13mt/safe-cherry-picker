import path from 'node:path';
import { existsSync } from 'node:fs';
import { git, MANAGED_WORKTREE_DIRNAME } from '../git.ts';

/**
 * Every mutating operation runs in a worktree the app owns, so promotions never
 * disturb your checkout, your current branch, or your uncommitted work.
 *
 * The worktree is kept *detached*. Git only lets a branch be checked out in one
 * worktree at a time, so binding it to `stable` would stop you from checking out
 * `stable` yourself. Instead we apply commits on a detached HEAD and then move
 * the branch ref with a compare-and-swap `update-ref`.
 */

export async function gitCommonDir(repoPath: string): Promise<string> {
  const { stdout } = await git(['rev-parse', '--git-common-dir'], { cwd: repoPath });
  const dir = stdout.trim();
  return path.resolve(repoPath, dir);
}

export async function managedWorktreePath(repoPath: string): Promise<string> {
  return path.join(await gitCommonDir(repoPath), MANAGED_WORKTREE_DIRNAME);
}

export interface WorktreeEntry {
  path: string;
  head?: string;
  branch?: string;
  detached: boolean;
}

export async function listWorktrees(repoPath: string): Promise<WorktreeEntry[]> {
  const { stdout } = await git(['worktree', 'list', '--porcelain'], { cwd: repoPath });
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = { path: path.resolve(trimmed.slice('worktree '.length)), detached: false };
    } else if (!current) {
      continue;
    } else if (trimmed.startsWith('HEAD ')) {
      current.head = trimmed.slice('HEAD '.length);
    } else if (trimmed.startsWith('branch ')) {
      current.branch = trimmed.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (trimmed === 'detached') {
      current.detached = true;
    }
  }
  if (current) entries.push(current);
  return entries;
}

/**
 * A branch checked out somewhere else can't be safely advanced: moving the ref
 * would leave that worktree's index and files describing a commit it no longer
 * points at, which shows up as a pile of phantom changes. We refuse instead.
 */
export async function branchCheckedOutElsewhere(
  repoPath: string,
  branch: string,
): Promise<string | null> {
  const managed = await managedWorktreePath(repoPath);
  for (const entry of await listWorktrees(repoPath)) {
    if (entry.branch === branch && path.resolve(entry.path) !== path.resolve(managed)) {
      return entry.path;
    }
  }
  return null;
}

/** Creates the worktree if needed and parks it, clean, at `ref`. */
export async function prepareWorktree(repoPath: string, ref: string): Promise<string> {
  const wt = await managedWorktreePath(repoPath);
  const known = (await listWorktrees(repoPath)).some(
    (e) => path.resolve(e.path) === path.resolve(wt),
  );

  if (known && !existsSync(wt)) {
    // Registered but the directory is gone (deleted by hand, or a failed run).
    await git(['worktree', 'prune'], { cwd: repoPath, write: true });
  }

  if (!existsSync(wt)) {
    await git(['worktree', 'add', '--detach', wt, ref], { cwd: repoPath, write: true });
  }

  // Clear anything left behind by a previous run before we start. `--quit`
  // discards sequencer state without touching HEAD, and is the only thing that
  // clears a half-finished pick that no longer has CHERRY_PICK_HEAD. Callers
  // reach here only after preflight has refused genuinely in-flight work, so
  // anything still here is debris from a crash.
  if (await hasSequencerState(wt)) {
    await git(['cherry-pick', '--quit'], { cwd: wt, write: true, allowFail: true });
  }
  await git(['merge', '--abort'], { cwd: wt, write: true, allowFail: true });
  await git(['checkout', '--detach', ref], { cwd: wt, write: true, allowFail: true });
  await git(['reset', '--hard', ref], { cwd: wt, write: true, scratch: true });
  await git(['clean', '-fd'], { cwd: wt, write: true, scratch: true });

  return wt;
}

/**
 * True when a cherry-pick or merge is mid-flight in the managed worktree.
 *
 * CHERRY_PICK_HEAD alone is not enough. For a multi-commit pick git also keeps a
 * `sequencer/` directory holding the remaining todo list, and that can outlive
 * CHERRY_PICK_HEAD — for instance when a later commit in the sequence turns out
 * empty. In that state git refuses any new cherry-pick ("cherry-pick is already
 * in progress") while we would have happily reported everything clear and tried
 * to start one.
 */
export async function inFlightOperation(
  worktreePath: string,
): Promise<'cherry-pick' | 'merge' | null> {
  if (!existsSync(worktreePath)) return null;

  const pick = await git(['rev-parse', '--quiet', '--verify', 'CHERRY_PICK_HEAD'], {
    cwd: worktreePath,
    allowFail: true,
  });
  if (pick.code === 0 && pick.stdout.trim()) return 'cherry-pick';

  const merge = await git(['rev-parse', '--quiet', '--verify', 'MERGE_HEAD'], {
    cwd: worktreePath,
    allowFail: true,
  });
  if (merge.code === 0 && merge.stdout.trim()) return 'merge';

  if (await hasSequencerState(worktreePath)) return 'cherry-pick';
  return null;
}

/**
 * True while git is stopped *on a specific commit*. Distinguishes a pick paused
 * mid-commit from one that merely has a leftover sequencer, which matters
 * because only the former can be diagnosed as empty.
 */
export async function hasCherryPickHead(worktreePath: string): Promise<boolean> {
  if (!existsSync(worktreePath)) return false;
  const res = await git(['rev-parse', '--quiet', '--verify', 'CHERRY_PICK_HEAD'], {
    cwd: worktreePath,
    allowFail: true,
  });
  return res.code === 0 && res.stdout.trim().length > 0;
}

/** Leftover sequencer state, which makes git consider a pick still running. */
export async function hasSequencerState(worktreePath: string): Promise<boolean> {
  if (!existsSync(worktreePath)) return false;
  // `--git-path` resolves per-worktree paths correctly, which a hand-built
  // `.git/worktrees/<name>/sequencer` would not.
  const res = await git(['rev-parse', '--git-path', 'sequencer'], {
    cwd: worktreePath,
    allowFail: true,
  });
  if (res.code !== 0) return false;
  const dir = path.resolve(worktreePath, res.stdout.trim());
  return existsSync(path.join(dir, 'todo')) || existsSync(dir);
}

export async function conflictedFiles(worktreePath: string): Promise<string[]> {
  if (!existsSync(worktreePath)) return [];
  const res = await git(['diff', '--name-only', '--diff-filter=U'], {
    cwd: worktreePath,
    allowFail: true,
  });
  return res.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}
