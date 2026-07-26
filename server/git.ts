import { execFile } from 'node:child_process';
import path from 'node:path';
import type { GitCommandRecord } from '../shared/types.ts';

/**
 * Every git invocation in this app goes through here.
 *
 * Two rules make the whole thing safe:
 *  1. We use execFile with an argv array — never a shell string — so a branch name
 *     like `foo; rm -rf /` is passed to git as a single literal argument.
 *  2. Subcommands are allowlisted. Anything that could reach a remote or destroy
 *     history is rejected here, not merely hidden in the UI.
 */

/** Read-only plumbing and porcelain. Safe to run at any time. */
const READ_SUBCOMMANDS = new Set([
  'rev-parse',
  'rev-list',
  'log',
  'cherry',
  'merge-base',
  'status',
  'diff',
  'show',
  'for-each-ref',
  'symbolic-ref',
  'merge-tree',
  'cat-file',
  'name-rev',
  'ls-files',
  'blame',
  'var',
]);

/** Mutating subcommands. Callers must pass `write: true` to reach these. */
const WRITE_SUBCOMMANDS = new Set([
  'merge',
  'cherry-pick',
  'checkout',
  'switch',
  'commit',
  'commit-tree',
  'update-ref',
  'read-tree',
  'reset',
  'clean',
  'add',
  'rm',
]);

/**
 * Anything that writes an index or a working tree must run in the app's own
 * disposable worktree. This is the rule that guarantees the user's checkout,
 * current branch and uncommitted work are never disturbed.
 */
const WORKTREE_ONLY_SUBCOMMANDS = new Set([
  'merge',
  'cherry-pick',
  'checkout',
  'switch',
  'commit',
  'add',
  'rm',
  'reset',
  'clean',
  'read-tree',
]);

/** Subcommands whose read/write nature depends on their flags. */
const DUAL_SUBCOMMANDS = new Set(['branch', 'worktree', 'config']);

/**
 * Rejected outright, whatever the flags. `push` is the headline: this app never
 * publishes anything. The rest either rewrite history or touch remotes.
 */
const DENIED_SUBCOMMANDS = new Set([
  'push',
  'pull',
  'fetch',
  'remote',
  'rebase',
  'filter-branch',
  'filter-repo',
  'am',
  'apply',
  'gc',
  'prune',
  'reflog',
  'replace',
  'notes',
  'submodule',
  'daemon',
  'send-email',
  'request-pull',
  'archive',
  'bundle',
  'svn',
  'p4',
]);

/** Only `git clean` is allowed to carry -f, and only inside the managed worktree. */
const FORCE_FLAGS = /^(--force|--force-with-lease|--force-if-includes|-f|-D)$/;

export const MANAGED_WORKTREE_DIRNAME = 'gcp-worktree';

export class GitPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitPolicyError';
  }
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly stdout: string,
    readonly stderr: string,
    readonly args: string[],
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export interface GitOptions {
  cwd: string;
  /** Required for any mutating subcommand. Forces callers to be deliberate. */
  write?: boolean;
  /**
   * Set when cwd is the app's disposable worktree. Unlocks `reset --hard` and
   * `clean -fd`, which are never permitted against the user's own checkout.
   */
  scratch?: boolean;
  /** Return the non-zero result instead of throwing. */
  allowFail?: boolean;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

const history: GitCommandRecord[] = [];
const HISTORY_LIMIT = 200;

export function commandHistory(): GitCommandRecord[] {
  return history.slice().reverse();
}

/**
 * The managed worktree always lives at `<git-common-dir>/gcp-worktree`, so we
 * require the segment to sit directly under a `.git` directory. Matching the
 * name alone would let a real checkout at `C:/work/gcp-worktree/app` pass as the
 * scratch area and unlock `reset --hard` against it.
 */
export function isInsideManagedWorktree(cwd: string): boolean {
  const parts = path.resolve(cwd).split(/[\\/]/);
  const i = parts.indexOf(MANAGED_WORKTREE_DIRNAME);
  return i > 0 && parts[i - 1] === '.git';
}

/**
 * Global options that take a separate value. `-c key=value` in particular would
 * otherwise leave `key=value` looking like the subcommand.
 */
const VALUE_TAKING_GLOBALS = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

/**
 * Options that redirect where git operates. These would defeat the working-tree
 * restriction entirely — `git -C /elsewhere cherry-pick` run with a cwd inside
 * the scratch worktree would pass the cwd check and then act somewhere else.
 * We never use them, and refusing them keeps the guard meaningful.
 */
const PATH_REDIRECTING_GLOBALS = /^(-C|--git-dir|--work-tree|--namespace|--exec-path)(=|$)/;

/** Splits argv into the global options and the subcommand that follows them. */
function splitArgs(args: string[]): { globals: string[]; sub?: string } {
  const globals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) return { globals, sub: arg };
    globals.push(arg);
    // Skip this option's value so it isn't mistaken for the subcommand.
    if (VALUE_TAKING_GLOBALS.has(arg)) i++;
  }
  return { globals };
}

/**
 * Enforces the policy described at the top of this file. Exported so tests can
 * assert the denials directly rather than by observing side effects.
 */
export function assertAllowed(args: string[], opts: GitOptions): void {
  const { globals, sub } = splitArgs(args);

  // Only global options — those before the subcommand — can redirect git. After
  // it the same spellings mean other things (`git commit -C <commit>` reuses a
  // message), so scope the check rather than banning the characters outright.
  for (const arg of globals) {
    if (PATH_REDIRECTING_GLOBALS.test(arg)) {
      throw new GitPolicyError(
        `Refusing global option ${arg}: redirecting git to another directory would bypass the ` +
          `working-tree restriction.`,
      );
    }
  }

  if (!sub) throw new GitPolicyError('No git subcommand supplied.');

  if (DENIED_SUBCOMMANDS.has(sub)) {
    throw new GitPolicyError(
      `git ${sub} is not permitted by this app (it touches remotes or rewrites history).`,
    );
  }

  const isRead = READ_SUBCOMMANDS.has(sub);
  const isWrite = WRITE_SUBCOMMANDS.has(sub);
  const isDual = DUAL_SUBCOMMANDS.has(sub);
  if (!isRead && !isWrite && !isDual) {
    throw new GitPolicyError(`git ${sub} is not on the allowlist.`);
  }

  if ((isWrite || isDual) && !opts.write) {
    // Dual subcommands are readable without the flag only when they carry no
    // mutating verb; `branch --list` is fine, `branch -d` is not.
    if (isDual && !hasMutatingDualFlag(sub, args)) {
      // fall through: treated as a read
    } else {
      throw new GitPolicyError(
        `git ${sub} mutates the repository; the caller must opt in with write: true.`,
      );
    }
  }

  for (const arg of args) {
    if (FORCE_FLAGS.test(arg)) {
      // `clean` and `rm` genuinely require -f to act on a modified or conflicted
      // file, and both are confined to the scratch worktree anyway. Every other
      // use of a force flag is refused.
      const legitimateForce =
        (sub === 'clean' || sub === 'rm') && (arg === '-f' || arg === '--force');
      if (!legitimateForce) {
        throw new GitPolicyError(`Refusing to run git ${sub} with ${arg}.`);
      }
    }
  }

  if (WORKTREE_ONLY_SUBCOMMANDS.has(sub) && !isInsideManagedWorktree(opts.cwd)) {
    throw new GitPolicyError(
      `git ${sub} touches a working tree, so it is only allowed inside the app's disposable ` +
        `worktree (${MANAGED_WORKTREE_DIRNAME}) — never your own checkout.`,
    );
  }

  if (sub === 'reset' || sub === 'clean') {
    // Doubly gated: destructive even within the scratch worktree, so the caller
    // has to say out loud that it knows where it is.
    if (!opts.scratch) {
      throw new GitPolicyError(
        `git ${sub} requires the caller to opt in with scratch: true.`,
      );
    }
  }

  if (sub === 'update-ref') {
    if (args.includes('-d') || args.includes('--delete')) {
      throw new GitPolicyError('Refusing to delete refs.');
    }

    // Collect the positional arguments, skipping options and their values, so
    // an added `-m <reason>` doesn't shift the ref out from under this check.
    const positional: string[] = [];
    for (let i = args.indexOf('update-ref') + 1; i < args.length; i++) {
      const arg = args[i];
      if (arg === '-m') {
        i++; // skip the reflog message
        continue;
      }
      if (arg.startsWith('-')) continue;
      positional.push(arg);
    }

    const [ref, , oldValue] = positional;
    if (!ref || !ref.startsWith('refs/heads/')) {
      throw new GitPolicyError('update-ref is restricted to refs/heads/*.');
    }
    // Requiring the old value makes the update a compare-and-swap: if anything
    // moved the branch since we read it, git refuses rather than clobbering.
    if (!oldValue) {
      throw new GitPolicyError('update-ref must supply the expected old value.');
    }
  }
}

function hasMutatingDualFlag(sub: string, args: string[]): boolean {
  if (sub === 'branch') {
    return args.some((a) => ['-d', '-D', '-m', '-M', '-c', '-C', '--delete', '--move'].includes(a));
  }
  if (sub === 'worktree') {
    return args.some((a) => ['add', 'remove', 'prune', 'move', 'repair', 'lock', 'unlock'].includes(a));
  }
  if (sub === 'config') {
    return !args.includes('--get') && !args.includes('--list') && !args.includes('--get-all');
  }
  return false;
}

const BASE_ENV: NodeJS.ProcessEnv = {
  // Never let git try to open an editor or prompt for credentials: this runs
  // headless behind an HTTP request and a prompt would hang the response.
  GIT_EDITOR: 'true',
  GIT_SEQUENCE_EDITOR: 'true',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
  GIT_PAGER: 'cat',
  GIT_OPTIONAL_LOCKS: '0',
};

export async function git(args: string[], opts: GitOptions): Promise<GitResult> {
  assertAllowed(args, opts);
  const started = Date.now();

  return new Promise<GitResult>((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd: opts.cwd,
        env: { ...process.env, ...BASE_ENV, ...opts.env },
        timeout: opts.timeoutMs ?? 60_000,
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'utf8',
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const code = err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0;
        const numericCode = typeof code === 'number' ? code : 1;
        record(args, opts.cwd, numericCode, Date.now() - started);

        if (err && !opts.allowFail) {
          reject(
            new GitError(
              `git ${args.join(' ')} failed (${numericCode}): ${String(stderr || err.message).trim()}`,
              numericCode,
              String(stdout ?? ''),
              String(stderr ?? ''),
              args,
            ),
          );
          return;
        }
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: numericCode });
      },
    );
  });
}

/** Convenience for the common "one line of output" case. */
export async function gitLine(args: string[], opts: GitOptions): Promise<string> {
  const { stdout } = await git(args, opts);
  return stdout.trim();
}

function record(args: string[], cwd: string, code: number, ms: number): void {
  history.push({ args, cwd, code, ms, at: new Date().toISOString() });
  if (history.length > HISTORY_LIMIT) history.shift();
}

/** Renders an argv array the way a user would type it, for the preview panel. */
export function renderCommand(args: string[]): string {
  return ['git', ...args]
    .map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a))
    .join(' ');
}
