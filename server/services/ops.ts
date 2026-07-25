import path from 'node:path';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { git, renderCommand, GitError } from '../git.ts';
import { logCommits } from './commits.ts';
import {
  prepareWorktree,
  managedWorktreePath,
  gitCommonDir,
  branchCheckedOutElsewhere,
  inFlightOperation,
  conflictedFiles,
} from './worktree.ts';
import { simulateCherryPick } from './dryrun.ts';
import type { CommitInfo, OpResult, OpStatus, SimulationResult } from '../../shared/types.ts';

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

/** Blocks operations that would be unsafe before we touch anything. */
async function preflight(repoPath: string, target: string): Promise<void> {
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
}

/** Moves the branch to `newHead`, refusing if it moved under us. */
async function advanceBranch(
  repoPath: string,
  target: string,
  newHead: string,
  previousHead: string,
): Promise<void> {
  await git(['update-ref', `refs/heads/${target}`, newHead, previousHead], {
    cwd: repoPath,
    write: true,
  });
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
 */
async function orderOldestFirst(repoPath: string, shas: string[]): Promise<CommitInfo[]> {
  const commits = await commitsForShas(repoPath, shas);
  const { stdout } = await git(['rev-list', '--topo-order', '--reverse', '--no-walk', ...shas], {
    cwd: repoPath,
    allowFail: true,
  });
  const order = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (order.length !== commits.length) {
    return commits.slice().sort((a, b) => a.date.localeCompare(b.date));
  }
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  return order.map((s) => bySha.get(s)).filter((c): c is CommitInfo => Boolean(c));
}

export interface CherryPickInput {
  repoPath: string;
  target: string;
  shas: string[];
  style: 'individual' | 'squash';
  /** Required for squash mode; ignored otherwise. */
  message?: string;
  dryRun?: boolean;
}

export async function cherryPick(input: CherryPickInput): Promise<OpResult & { simulation?: SimulationResult }> {
  const { repoPath, target, style, dryRun } = input;
  const ordered = await orderOldestFirst(repoPath, input.shas);
  const pickable = ordered.filter((c) => !c.isMerge);
  const shas = pickable.map((c) => c.sha);

  if (shas.length === 0) {
    throw new Error('Nothing to cherry-pick (merge commits cannot be picked without a mainline).');
  }

  const message =
    input.message ??
    defaultSquashMessage(pickable);

  const commands: string[][] =
    style === 'squash'
      ? [['cherry-pick', '-n', '-x', ...shas], ['commit', '-m', message]]
      : [['cherry-pick', '-x', ...shas]];

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
  const previousHead = await revParse(repoPath, target);
  const wt = await prepareWorktree(repoPath, target);

  const op: PersistedOp = {
    kind: 'cherry-pick',
    target,
    previousHead,
    shas,
    style,
    message,
    startedAt: new Date().toISOString(),
  };
  await writeState(repoPath, op);

  for (const args of commands) {
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
  }

  const newHead = await revParse(wt, 'HEAD');
  await advanceBranch(repoPath, target, newHead, previousHead);
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

export async function merge(input: MergeInput): Promise<OpResult> {
  const { repoPath, from, into, noFf = true, dryRun } = input;
  const message = input.message ?? `Merge branch '${from}' into ${into}`;
  const args = ['merge', ...(noFf ? ['--no-ff'] : []), '--no-edit', '-m', message, from];
  const commands = [args];

  if (dryRun) {
    return {
      ok: true,
      commands,
      status: { inProgress: false, conflicts: [] },
      message: `Would merge ${from} into ${into}.`,
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
  await advanceBranch(repoPath, into, newHead, previousHead);
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
  if (!kind || !op) {
    return { inProgress: false, conflicts: [] };
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

  return {
    inProgress: true,
    kind,
    target: op.target,
    worktreePath: wt,
    conflicts,
    done: op.shas.slice(0, doneCount),
    remaining: op.shas.slice(doneCount),
    message:
      `Resolve the conflicted files in ${wt}, then continue. ` +
      `Your own checkout is untouched.`,
  };
}

export async function operationStatus(repoPath: string): Promise<OpStatus> {
  return statusFor(repoPath, await readState(repoPath));
}

export async function continueOperation(repoPath: string): Promise<OpResult> {
  const op = await readState(repoPath);
  if (!op) throw new Error('No operation is in progress.');
  const wt = await managedWorktreePath(repoPath);
  const kind = await inFlightOperation(wt);

  const commands: string[][] = [];
  if (kind) {
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

  // A squash-mode pick still needs its single commit once the picks land.
  if (op.kind === 'cherry-pick' && op.style === 'squash') {
    const pending = await git(['diff', '--cached', '--quiet'], { cwd: wt, allowFail: true });
    if (pending.code !== 0) {
      commands.push(['commit', '-m', op.message ?? 'squashed cherry-pick']);
      await git(['commit', '-m', op.message ?? 'squashed cherry-pick'], { cwd: wt, write: true });
    }
  }

  const newHead = await revParse(wt, 'HEAD');
  await advanceBranch(repoPath, op.target, newHead, op.previousHead);
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

export async function abortOperation(repoPath: string): Promise<OpResult> {
  const op = await readState(repoPath);
  const wt = await managedWorktreePath(repoPath);
  const kind = (await inFlightOperation(wt)) ?? op?.kind ?? null;
  const commands: string[][] = [];

  if (kind && existsSync(wt)) {
    commands.push([kind, '--abort']);
    await git([kind, '--abort'], { cwd: wt, write: true, allowFail: true });
  }
  if (existsSync(wt) && op) {
    // Belt and braces: put the scratch worktree back exactly where we started.
    await git(['reset', '--hard', op.previousHead], { cwd: wt, write: true, scratch: true, allowFail: true });
    await git(['clean', '-fd'], { cwd: wt, write: true, scratch: true, allowFail: true });
  }
  await clearState(repoPath);

  return {
    ok: true,
    commands,
    status: { inProgress: false, conflicts: [] },
    message: op
      ? `Aborted. ${op.target} is unchanged at ${op.previousHead.slice(0, 7)}.`
      : 'Nothing to abort.',
  };
}

/** Renders a command list for the confirm dialog exactly as a user would type it. */
export function previewCommands(commands: string[][]): string[] {
  return commands.map(renderCommand);
}

export { GitError };
