import path from 'node:path';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { simulateMerge } from './dryrun.ts';
import { git, renderCommand, GitError } from '../git.ts';
import { loadConfig } from '../config.ts';
import { logCommits } from './commits.ts';
import {
  prepareWorktree,
  managedWorktreePath,
  gitCommonDir,
  branchCheckedOutElsewhere,
  inFlightOperation,
  hasSequencerState,
  hasCherryPickHead,
  conflictedFiles,
} from './worktree.ts';
import { workingTreeStatus, dirtyBlockReason } from './discover.ts';
import { simulateCherryPick } from './dryrun.ts';
import { describeConflicts, resolveFile, type Resolution } from './conflicts.ts';
import type {
  CommitInfo,
  ConflictReport,
  OpResult,
  OpStatus,
  SimulationResult,
} from '../../shared/types.ts';

/**
 * The mutating half of the app. Two invariants hold throughout:
 *
 *  1. Work happens on a detached HEAD in the managed worktree; the branch ref is
 *     only moved at the end via a compare-and-swap `update-ref`. If anything else
 *     moved the branch while we worked, git rejects the update instead of
 *     clobbering it.
 *  2. Nothing is ever pushed. The git layer refuses `push` outright.
 */

interface PersistedOp {
  kind: 'cherry-pick' | 'merge';
  target: string;
  previousHead: string;
  shas: string[];
  style?: 'individual' | 'squash';
  message?: string;
  /**
   * Branch the work came from. Recorded so a paused conflict can name both
   * sides — otherwise "theirs" is all we could honestly call it, since a commit
   * can sit on any number of branches.
   */
  source?: string;
  startedAt: string;
}

async function stateFile(repoPath: string): Promise<string> {
  return path.join(await gitCommonDir(repoPath), 'gcp-state.json');
}

async function readState(repoPath: string): Promise<PersistedOp | null> {
  const file = await stateFile(repoPath);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as PersistedOp;
  } catch {
    return null;
  }
}

async function writeState(repoPath: string, op: PersistedOp): Promise<void> {
  writeFileSync(await stateFile(repoPath), JSON.stringify(op, null, 2), 'utf8');
}

async function clearState(repoPath: string): Promise<void> {
  const file = await stateFile(repoPath);
  if (existsSync(file)) rmSync(file);
}

async function revParse(repoPath: string, ref: string): Promise<string> {
  const { stdout } = await git(['rev-parse', `${ref}^{commit}`], { cwd: repoPath });
  return stdout.trim();
}

/**
 * Serialises operations per repo. Without this, a double-clicked button can run
 * two cherry-picks through the same single worktree at once, and the second one
 * resets the tree out from under the first.
 */
const repoLocks = new Map<string, Promise<unknown>>();

function withRepoLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(repoPath).toLowerCase();
  const previous = repoLocks.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  // Keep the chain alive but swallow rejections so one failure doesn't poison
  // every later operation on this repo.
  repoLocks.set(
    key,
    run.catch(() => undefined),
  );
  return run;
}

/**
 * Blocks operations that would be unsafe — or unwanted — before we touch
 * anything.
 *
 * Called only when *starting* work. Continue, skip, abort and resolve
 * deliberately skip these checks: a stray uncommitted file must never be able to
 * trap a paused operation with no way to finish or unwind it.
 */
async function preflight(repoPath: string, target: string): Promise<void> {
  // Checked fresh rather than from the cached repo list, so committing or
  // stashing and retrying works immediately.
  const blocked = dirtyBlockReason(await workingTreeStatus(repoPath));
  if (blocked) throw new Error(blocked);

  const elsewhere = await branchCheckedOutElsewhere(repoPath, target);
  if (elsewhere) {
    throw new Error(
      `'${target}' is checked out at ${elsewhere}. Advancing it would leave that working ` +
        `copy inconsistent, so switch it to another branch first.`,
    );
  }
  const wt = await managedWorktreePath(repoPath);
  const inFlight = await inFlightOperation(wt);
  if (inFlight) {
    throw new Error(
      `A ${inFlight} is already in progress and waiting on conflict resolution. ` +
        `Resolve and continue, or abort it, before starting another operation.`,
    );
  }
  // A state file with nothing actually in flight is debris from a crash or a
  // run that failed before git got involved. Clear it rather than letting it
  // confuse a later continue/abort.
  if (await readState(repoPath)) await clearState(repoPath);
}

/** True when the file still contains git's conflict markers. */
function hasConflictMarkers(file: string): boolean {
  try {
    const text = readFileSync(file, 'utf8');
    return /^<{7}( |$)/m.test(text) && /^>{7}( |$)/m.test(text);
  } catch {
    return false; // deleted or binary — nothing to warn about
  }
}

/**
 * Moves the branch to `newHead`, refusing if it moved under us.
 *
 * The `-m` matters: without it `update-ref` writes an empty reflog entry, so
 * `git reflog stable` shows blank lines for everything the app did and there's
 * no way to audit it afterwards.
 */
async function advanceBranch(
  repoPath: string,
  target: string,
  newHead: string,
  previousHead: string,
  reason: string,
): Promise<void> {
  await git(
    ['update-ref', '-m', `git-cherry-picker: ${reason}`, `refs/heads/${target}`, newHead, previousHead],
    { cwd: repoPath, write: true },
  );
}

async function commitsForShas(repoPath: string, shas: string[]): Promise<CommitInfo[]> {
  if (shas.length === 0) return [];
  const commits = await logCommits({ cwd: repoPath, revs: ['--no-walk', ...shas] });
  // `--no-walk` returns them in the order given; we want oldest-first for picking.
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  const ordered = shas.map((s) => bySha.get(s)).filter((c): c is CommitInfo => Boolean(c));
  return ordered;
}

/**
 * Orders the requested commits oldest-first. Applying picks in any other order
 * is a reliable way to manufacture conflicts.
 *
 * Note the deliberate absence of `--no-walk`: it makes rev-list ignore
 * `--topo-order` and fall back to sorting by commit *date*, which is wrong the
 * moment timestamps are skewed or equal (rebases, imports, fast commits in a
 * script). Walking the ancestry and filtering costs one extra rev-list but gives
 * a genuinely topological order.
 */
async function orderOldestFirst(repoPath: string, shas: string[]): Promise<CommitInfo[]> {
  const commits = await commitsForShas(repoPath, shas);
  const wanted = new Set(commits.map((c) => c.sha));

  const res = await git(['rev-list', '--topo-order', '--reverse', ...shas], {
    cwd: repoPath,
    allowFail: true,
  });

  if (res.code === 0) {
    const bySha = new Map(commits.map((c) => [c.sha, c]));
    const ordered = res.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((sha) => wanted.has(sha))
      .map((sha) => bySha.get(sha)!)
      .filter(Boolean);
    if (ordered.length === commits.length) return ordered;
  }

  // Unrelated histories or a rev-list failure: date order is the best guess left.
  return commits.slice().sort((a, b) => a.date.localeCompare(b.date));
}

export interface CherryPickInput {
  repoPath: string;
  target: string;
  shas: string[];
  style: 'individual' | 'squash';
  /** Required for squash mode; ignored otherwise. */
  message?: string;
  /** Branch the commits were selected from, used to label a conflict's sides. */
  sourceBranch?: string;
  dryRun?: boolean;
}

export function cherryPick(
  input: CherryPickInput,
): Promise<OpResult & { simulation?: SimulationResult }> {
  // Dry runs are read-only, so they don't need to queue behind a live operation.
  return input.dryRun ? runCherryPick(input) : withRepoLock(input.repoPath, () => runCherryPick(input));
}

async function runCherryPick(
  input: CherryPickInput,
): Promise<OpResult & { simulation?: SimulationResult }> {
  const { repoPath, target, style, dryRun } = input;
  const ordered = await orderOldestFirst(repoPath, input.shas);
  const pickable = ordered.filter((c) => !c.isMerge);
  const shas = pickable.map((c) => c.sha);

  if (shas.length === 0) {
    throw new Error('Nothing to cherry-pick (merge commits cannot be picked without a mainline).');
  }

  const message = input.message ?? defaultSquashMessage(pickable);

  // Squashing is done by picking normally and collapsing afterwards — see
  // finaliseSquash for why `cherry-pick -n` across several commits cannot work.
  const previousHead = await revParse(repoPath, target);
  const commands: string[][] = [['cherry-pick', '-x', ...shas]];
  if (style === 'squash') {
    commands.push(['reset', '--soft', previousHead], ['commit', '-m', message]);
  }

  if (dryRun) {
    const simulation = await simulateCherryPick({ repoPath, target, commits: pickable });
    return {
      ok: simulation.clean,
      commands,
      simulation,
      status: { inProgress: false, conflicts: simulation.conflicts },
      message: simulation.clean
        ? `${shas.length} commit(s) apply cleanly to ${target}.`
        : `Conflict on ${simulation.failedAt?.short ?? 'an early commit'} in ${simulation.conflicts.length} file(s).`,
    };
  }

  await preflight(repoPath, target);
  const wt = await prepareWorktree(repoPath, target);

  const op: PersistedOp = {
    kind: 'cherry-pick',
    target,
    previousHead,
    shas,
    style,
    message,
    source: input.sourceBranch,
    startedAt: new Date().toISOString(),
  };
  await writeState(repoPath, op);

  const pick = await git(['cherry-pick', '-x', ...shas], { cwd: wt, write: true, allowFail: true });
  if (pick.code !== 0) {
    return {
      ok: false,
      commands,
      status: await statusFor(repoPath, op),
      previousHead,
      message: (pick.stderr || pick.stdout).trim(),
    };
  }

  await finaliseSquash(wt, op);

  const newHead = await revParse(wt, 'HEAD');
  await advanceBranch(
    repoPath,
    target,
    newHead,
    previousHead,
    `cherry-pick ${shas.length} commit(s)${input.sourceBranch ? ` from ${input.sourceBranch}` : ''}`,
  );
  await clearState(repoPath);

  return {
    ok: true,
    commands,
    status: { inProgress: false, conflicts: [] },
    newHead,
    previousHead,
    message: `Applied ${shas.length} commit(s) to ${target}.`,
  };
}

/**
 * Collapses the commits a squash-mode pick has just made into a single one.
 *
 * The obvious implementation — `git cherry-pick -n A B C`, then one commit —
 * does not work. Git insists on a clean tree before each pick in a sequence, and
 * `-n` guarantees the tree is dirty from the second pick onwards; it fails with
 * "your local changes would be overwritten by cherry-pick". Notably it only
 * fails for some shapes (an added file is enough; several edits to a file that
 * already exists can slip through), which makes it a nasty thing to rely on.
 *
 * So each pick commits normally — clean tree every time, and conflicts resume
 * through the ordinary `--continue` path — and we squash at the end.
 */
async function finaliseSquash(wt: string, op: PersistedOp): Promise<string[][]> {
  if (op.style !== 'squash') return [];

  const commands: string[][] = [['reset', '--soft', op.previousHead]];
  await git(['reset', '--soft', op.previousHead], { cwd: wt, write: true, scratch: true });

  // Every pick turned out empty: there is nothing to squash, and committing
  // would fail.
  const staged = await git(['diff', '--cached', '--quiet'], { cwd: wt, allowFail: true });
  if (staged.code === 0) return commands;

  const message = op.message ?? 'squashed cherry-pick';
  commands.push(['commit', '-m', message]);
  await git(['commit', '-m', message], { cwd: wt, write: true });
  return commands;
}

function defaultSquashMessage(commits: CommitInfo[]): string {
  const tickets = [...new Set(commits.map((c) => /^\s*\[([A-Za-z][A-Za-z0-9]*-\d+)\]/.exec(c.subject)?.[1]?.toUpperCase()).filter(Boolean))];
  const title = tickets.length ? `[${tickets.join('][')}] ` : '';
  const lines = commits.map((c) => `* ${c.subject}`);
  const sources = commits.map((c) => `(cherry picked from commit ${c.sha})`);
  return [
    `${title}squashed ${commits.length} commit(s)`,
    '',
    ...lines,
    '',
    ...sources,
  ].join('\n');
}

export interface MergeInput {
  repoPath: string;
  from: string;
  into: string;
  noFf?: boolean;
  message?: string;
  dryRun?: boolean;
}

export function merge(input: MergeInput): Promise<OpResult & { simulation?: SimulationResult }> {
  return input.dryRun ? runMerge(input) : withRepoLock(input.repoPath, () => runMerge(input));
}

async function runMerge(input: MergeInput): Promise<OpResult & { simulation?: SimulationResult }> {
  const { repoPath, from, into, noFf = true, dryRun } = input;
  const message = input.message ?? `Merge branch '${from}' into ${into}`;
  const args = ['merge', ...(noFf ? ['--no-ff'] : []), '--no-edit', '-m', message, from];
  const commands = [args];

  if (dryRun) {
    // Promotions deserve the same honest answer cherry-picks get: replay the
    // merge in the object database and report what would actually conflict.
    const simulation = await simulateMerge({ repoPath, target: into, from });
    return {
      ok: simulation.clean,
      commands,
      simulation,
      status: { inProgress: false, conflicts: simulation.conflicts },
      message: simulation.clean
        ? `${from} merges into ${into} cleanly.`
        : `Merging ${from} into ${into} conflicts in ${simulation.conflicts.length} file(s).`,
    };
  }

  await preflight(repoPath, into);
  const previousHead = await revParse(repoPath, into);
  const wt = await prepareWorktree(repoPath, into);

  const op: PersistedOp = {
    kind: 'merge',
    target: into,
    previousHead,
    shas: [],
    message,
    source: from,
    startedAt: new Date().toISOString(),
  };
  await writeState(repoPath, op);

  const res = await git(args, { cwd: wt, write: true, allowFail: true });
  if (res.code !== 0) {
    return {
      ok: false,
      commands,
      status: await statusFor(repoPath, op),
      previousHead,
      message: (res.stderr || res.stdout).trim(),
    };
  }

  const newHead = await revParse(wt, 'HEAD');
  await advanceBranch(repoPath, into, newHead, previousHead, `merge ${from} into ${into}`);
  await clearState(repoPath);

  return {
    ok: true,
    commands,
    status: { inProgress: false, conflicts: [] },
    newHead,
    previousHead,
    message: `Merged ${from} into ${into}.`,
  };
}

async function statusFor(repoPath: string, op: PersistedOp | null): Promise<OpStatus> {
  const wt = await managedWorktreePath(repoPath);
  const kind = await inFlightOperation(wt);
  if (!kind) {
    return { inProgress: false, conflicts: [] };
  }

  // Git state without our own record of it — a crash, or a pick driven by hand
  // in the worktree. Surface it anyway: leaving it invisible means git refuses
  // every later operation and the UI offers no way out.
  if (!op) {
    return {
      inProgress: true,
      orphaned: true,
      kind,
      worktreePath: wt,
      conflicts: await conflictedFiles(wt),
      message:
        `A ${kind} is in progress in the app's worktree but there is no record of what ` +
        `started it, so it can't be continued. Abort to clear it — no branch has been moved.`,
    };
  }

  const conflicts = await conflictedFiles(wt);

  // How far the sequencer got: count commits made since we started.
  let doneCount = 0;
  try {
    const { stdout } = await git(['rev-list', '--count', `${op.previousHead}..HEAD`], { cwd: wt });
    doneCount = Number(stdout.trim()) || 0;
  } catch {
    doneCount = 0;
  }

  // A pick stopped *on a commit* with nothing conflicted and nothing staged is
  // empty: its changes are already on the target, so it can only be skipped.
  // Requiring CHERRY_PICK_HEAD matters — a leftover sequencer with no current
  // commit also has nothing staged, and calling that "empty" would tell the user
  // to skip when the right move is to continue or abort.
  let empty = false;
  if (kind === 'cherry-pick' && conflicts.length === 0 && (await hasCherryPickHead(wt))) {
    const staged = await git(['diff', '--cached', '--quiet'], { cwd: wt, allowFail: true });
    empty = staged.code === 0;
  }

  return {
    inProgress: true,
    kind,
    target: op.target,
    worktreePath: wt,
    conflicts,
    empty,
    done: op.shas.slice(0, doneCount),
    remaining: op.shas.slice(doneCount),
    message: empty
      ? `This commit is already on ${op.target} — its changes are a no-op here. Skip it to carry on.`
      : `Resolve the conflicted files in ${wt}, then continue. Your own checkout is untouched.`,
  };
}

export async function operationStatus(repoPath: string): Promise<OpStatus> {
  return statusFor(repoPath, await readState(repoPath));
}

/**
 * The full picture of a paused operation: which file is fighting with what, the
 * three versions git is holding, the conflict hunks, and the diff the incoming
 * commit was trying to apply.
 */
export async function conflictReport(repoPath: string): Promise<ConflictReport> {
  const op = await readState(repoPath);
  const wt = await managedWorktreePath(repoPath);
  const kind = await inFlightOperation(wt);
  if (!kind || !op) return { inProgress: false, files: [] };

  // For a cherry-pick, CHERRY_PICK_HEAD names the commit that stopped us. For a
  // merge, MERGE_HEAD names the branch tip being merged in.
  const headRef = kind === 'cherry-pick' ? 'CHERRY_PICK_HEAD' : 'MERGE_HEAD';
  const res = await git(['rev-parse', '--quiet', '--verify', headRef], {
    cwd: wt,
    allowFail: true,
  });
  const incomingSha = res.code === 0 ? res.stdout.trim() : undefined;

  let incoming: ConflictReport['incoming'];
  if (incomingSha) {
    const [found] = await logCommits({ cwd: wt, revs: ['--no-walk', incomingSha] });
    if (found) incoming = { sha: found.sha, short: found.short, subject: found.subject };
  }

  // Name both columns. "ours" is always the target branch; "theirs" is the
  // source branch when we recorded one, falling back to any branch that
  // contains the commit, and finally to the commit alone.
  const theirsBranch = op.source ?? (incomingSha ? await branchContaining(repoPath, incomingSha, op.target) : undefined);

  return {
    inProgress: true,
    kind,
    target: op.target,
    worktreePath: wt,
    incoming,
    ours: { branch: op.target, label: op.target },
    theirs: {
      branch: theirsBranch,
      commit: incoming,
      label:
        theirsBranch && incoming && kind === 'cherry-pick'
          ? `${theirsBranch} · ${incoming.short}`
          : (theirsBranch ?? incoming?.short ?? 'incoming'),
    },
    files: await describeConflicts({ worktree: wt, incomingSha }),
  };
}

/**
 * Best-effort branch name for a commit. A commit can live on many branches, so
 * this prefers one that isn't part of the promotion chain — a feature branch is
 * a far more useful label than "develop".
 */
async function branchContaining(
  repoPath: string,
  sha: string,
  exclude: string,
): Promise<string | undefined> {
  const res = await git(
    ['branch', '--contains', sha, '--format=%(refname:short)'],
    { cwd: repoPath, allowFail: true },
  );
  if (res.code !== 0) return undefined;

  const chain = new Set(loadConfig().chain);
  const names = res.stdout.split('\n').map((l) => l.trim()).filter((n) => n && n !== exclude);
  return names.find((n) => !chain.has(n)) ?? names[0];
}

/** Takes one side of a single conflicted file and stages the result. */
export function resolveConflict(
  repoPath: string,
  file: string,
  choice: Resolution,
): Promise<OpResult> {
  return withRepoLock(repoPath, async () => {
    const op = await readState(repoPath);
    if (!op) throw new Error('No operation is in progress.');
    const wt = await managedWorktreePath(repoPath);
    const commands = await resolveFile(wt, file, choice);
    return {
      ok: true,
      commands,
      status: await statusFor(repoPath, op),
      message: `Took "${choice}" for ${file}.`,
    };
  });
}

export function continueOperation(repoPath: string): Promise<OpResult> {
  return withRepoLock(repoPath, () => runContinue(repoPath));
}

async function runContinue(repoPath: string): Promise<OpResult> {
  const op = await readState(repoPath);
  if (!op) throw new Error('No operation is in progress.');
  const wt = await managedWorktreePath(repoPath);
  const kind = await inFlightOperation(wt);

  const commands: string[][] = [];
  if (kind) {
    // `git add -A` will happily stage a file that still contains conflict
    // markers, and --continue will commit it. Refuse instead: silently shipping
    // "<<<<<<< HEAD" into a release branch is far worse than an error here.
    const unresolved = (await conflictedFiles(wt)).filter((f) =>
      hasConflictMarkers(path.join(wt, f)),
    );
    if (unresolved.length > 0) {
      return {
        ok: false,
        commands,
        status: await statusFor(repoPath, op),
        message:
          `Still unresolved — these files contain conflict markers: ${unresolved.join(', ')}. ` +
          `Remove the <<<<<<< / ======= / >>>>>>> lines, then continue.`,
      };
    }

    // Stage whatever the user resolved, then let git carry on.
    commands.push(['add', '-A'], [op.kind, '--continue']);
    await git(['add', '-A'], { cwd: wt, write: true });
    const res = await git([op.kind, '--continue'], { cwd: wt, write: true, allowFail: true });
    if (res.code !== 0) {
      return {
        ok: false,
        commands,
        status: await statusFor(repoPath, op),
        message: (res.stderr || res.stdout).trim(),
      };
    }
  }

  // A squash-mode pick still has to be collapsed once every pick has landed.
  commands.push(...(await finaliseSquash(wt, op)));

  const newHead = await revParse(wt, 'HEAD');
  await advanceBranch(
    repoPath,
    op.target,
    newHead,
    op.previousHead,
    `${op.kind} completed after conflict resolution${op.source ? ` (from ${op.source})` : ''}`,
  );
  await clearState(repoPath);

  return {
    ok: true,
    commands,
    status: { inProgress: false, conflicts: [] },
    newHead,
    previousHead: op.previousHead,
    message: `${op.kind} completed; ${op.target} now at ${newHead.slice(0, 7)}.`,
  };
}

/**
 * Drops the current commit and carries on with the rest of the sequence. Used
 * when a pick turns out to be empty, and available whenever the user decides a
 * particular commit isn't wanted after all.
 */
export function skipOperation(repoPath: string): Promise<OpResult> {
  return withRepoLock(repoPath, () => runSkip(repoPath));
}

async function runSkip(repoPath: string): Promise<OpResult> {
  const op = await readState(repoPath);
  if (!op) throw new Error('No operation is in progress.');
  if (op.kind !== 'cherry-pick') {
    throw new Error('Only a cherry-pick can skip a commit; a merge can only be continued or aborted.');
  }

  const wt = await managedWorktreePath(repoPath);
  const commands: string[][] = [['cherry-pick', '--skip']];
  const res = await git(['cherry-pick', '--skip'], { cwd: wt, write: true, allowFail: true });

  if (res.code !== 0 && (await inFlightOperation(wt))) {
    return {
      ok: false,
      commands,
      status: await statusFor(repoPath, op),
      message: (res.stderr || res.stdout).trim(),
    };
  }

  // Still paused? The next commit in the sequence hit its own conflict.
  if (await inFlightOperation(wt)) {
    return {
      ok: false,
      commands,
      status: await statusFor(repoPath, op),
      message: 'Skipped. The next commit in the sequence needs attention.',
    };
  }

  commands.push(...(await finaliseSquash(wt, op)));

  const newHead = await revParse(wt, 'HEAD');
  await advanceBranch(
    repoPath,
    op.target,
    newHead,
    op.previousHead,
    'cherry-pick completed after skipping a commit',
  );
  await clearState(repoPath);

  return {
    ok: true,
    commands,
    status: { inProgress: false, conflicts: [] },
    newHead,
    previousHead: op.previousHead,
    message: `Skipped. ${op.target} is at ${newHead.slice(0, 7)}.`,
  };
}

export function abortOperation(repoPath: string): Promise<OpResult> {
  return withRepoLock(repoPath, () => runAbort(repoPath));
}

async function runAbort(repoPath: string): Promise<OpResult> {
  const op = await readState(repoPath);
  const wt = await managedWorktreePath(repoPath);
  const kind = (await inFlightOperation(wt)) ?? op?.kind ?? null;
  const commands: string[][] = [];

  if (kind && existsSync(wt)) {
    commands.push([kind, '--abort']);
    await git([kind, '--abort'], { cwd: wt, write: true, allowFail: true });

    // `--abort` fails when CHERRY_PICK_HEAD is already gone, leaving the
    // sequencer behind and git still refusing new picks. `--quit` is what
    // actually clears that, so always finish the job.
    if (await hasSequencerState(wt)) {
      commands.push(['cherry-pick', '--quit']);
      await git(['cherry-pick', '--quit'], { cwd: wt, write: true, allowFail: true });
    }
  }
  if (existsSync(wt)) {
    // Belt and braces: put the scratch worktree back where we started, or at
    // least somewhere consistent when we have no record of where that was.
    const restoreTo = op?.previousHead ?? 'HEAD';
    await git(['reset', '--hard', restoreTo], { cwd: wt, write: true, scratch: true, allowFail: true });
    await git(['clean', '-fd'], { cwd: wt, write: true, scratch: true, allowFail: true });
  }
  await clearState(repoPath);

  const stillStuck = existsSync(wt) && (await inFlightOperation(wt)) !== null;

  return {
    ok: !stillStuck,
    commands,
    status: await statusFor(repoPath, null),
    message: stillStuck
      ? `Could not fully clear the operation. Inspect ${wt} by hand.`
      : op
        ? `Aborted. ${op.target} is unchanged at ${op.previousHead.slice(0, 7)}.`
        : kind
          ? 'Cleared a leftover operation. No branch was moved.'
          : 'Nothing to abort.',
  };
}

/** Renders a command list for the confirm dialog exactly as a user would type it. */
export function previewCommands(commands: string[][]): string[] {
  return commands.map(renderCommand);
}

export { GitError };
