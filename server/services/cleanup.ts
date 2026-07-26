import { loadConfig } from '../config.ts';
import { git } from '../git.ts';
import { logCommits, authorshipOf } from './commits.ts';
import { localBranches, currentBranch } from './discover.ts';
import { classify, findBase } from './release.ts';
import { listWorktrees } from './worktree.ts';
import type {
  BranchReport,
  BranchSafety,
  CleanupReport,
  CommitInfo,
  ReleaseMethod,
} from '../../shared/types.ts';

/**
 * Which local branches have finished, so they can be deleted.
 *
 * `git branch --merged prod` only knows about ancestry, so it misses every
 * branch that reached production by cherry-pick — which, in a workflow built
 * around partial picks, is most of them. The classifier already knows better, so
 * this puts it to work.
 *
 * The cheap ancestry check runs first for all branches in one call, and only the
 * branches it doesn't cover pay for full classification.
 */

/** Full classification is a handful of git calls per branch, so bound it. */
const MAX_CLASSIFIED = 60;

const METHOD_RANK: Record<ReleaseMethod, number> = {
  merged: 0,
  traced: 1,
  'patch-id': 2,
  squashed: 3,
  subject: 4,
  none: 5,
};

export async function buildCleanupReport(repoPath: string): Promise<CleanupReport> {
  const cfg = loadConfig();
  const all = await localBranches(repoPath);
  const chain = cfg.chain.filter((b) => all.includes(b));
  const chainSet = new Set(chain);

  const current = await currentBranch(repoPath);
  const checkedOut = new Map<string, string>();
  for (const wt of await listWorktrees(repoPath)) {
    if (wt.branch) checkedOut.set(wt.branch, wt.path);
  }

  // Ancestry-merged branches, one call per chain branch. Most downstream first,
  // so the strongest claim wins.
  const mergedInto = new Map<string, string>();
  for (const target of [...chain].reverse()) {
    const res = await git(['branch', '--merged', target, '--format=%(refname:short)'], {
      cwd: repoPath,
      allowFail: true,
    });
    if (res.code !== 0) continue;
    for (const name of res.stdout.split('\n').map((l) => l.trim()).filter(Boolean)) {
      if (!mergedInto.has(name)) mergedInto.set(name, target);
    }
  }

  const reports: BranchReport[] = [];
  let classified = 0;
  let truncated = false;

  for (const name of all) {
    const [tipCommit] = await logCommits({ cwd: repoPath, revs: ['--no-walk', name] });
    if (!tipCommit) continue;

    const base: BranchReport = {
      name,
      tip: tipCommit.sha,
      short: tipCommit.short,
      lastCommitDate: tipCommit.date,
      lastCommitAuthor: tipCommit.author,
      lastCommitSubject: tipCommit.subject,
      ageDays: Math.max(0, Math.floor((Date.now() - Date.parse(tipCommit.date)) / 86_400_000)),
      safety: 'skipped',
      totalCommits: 0,
      unreleasedCount: 0,
      authorship: { contributors: [] },
      fastDelete: false,
    };

    if (chainSet.has(name)) {
      reports.push({ ...base, note: 'Part of the promotion chain.' });
      continue;
    }
    if (name === current) {
      reports.push({ ...base, note: 'Checked out in your working copy.' });
      continue;
    }
    const elsewhere = checkedOut.get(name);
    if (elsewhere) {
      reports.push({ ...base, note: `Checked out at ${elsewhere}.` });
      continue;
    }

    if (classified >= MAX_CLASSIFIED) {
      truncated = true;
      reports.push({ ...base, note: 'Too many branches to classify; narrow the repo or raise the cap.' });
      continue;
    }
    classified++;

    // The branch's own commits, needed for authorship whether or not the
    // expensive classification runs.
    const own = await branchCommits(repoPath, name, chain);
    const authorship = authorshipOf(own.commits);

    // Fast path: ancestry says it's fully merged, so skip the classifier.
    const merged = mergedInto.get(name);
    if (merged) {
      reports.push({
        ...base,
        safety: 'merged',
        releasedTo: merged,
        weakestMethod: 'merged',
        totalCommits: own.commits.length,
        authorship,
        fastDelete: true,
      });
      continue;
    }

    reports.push({
      ...base,
      authorship,
      ...(await classifyBranch(repoPath, name, chain, own)),
    });
  }

  // Most deletable first, then oldest, so the obvious candidates are on top.
  const order: Record<BranchSafety, number> = {
    merged: 0,
    picked: 1,
    likely: 2,
    unreleased: 3,
    skipped: 4,
  };
  reports.sort((a, b) => order[a.safety] - order[b.safety] || b.ageDays - a.ageDays);

  return { chain, branches: reports, truncated, generatedAt: new Date().toISOString() };
}

interface BranchCommits {
  base: string;
  targets: string[];
  commits: CommitInfo[];
}

/** The commits unique to a branch, relative to where it left the chain. */
async function branchCommits(
  repoPath: string,
  branch: string,
  chain: string[],
): Promise<BranchCommits> {
  const targets = chain.filter((t) => t !== branch);
  if (targets.length === 0) return { base: branch, targets, commits: [] };
  const base = await findBase(repoPath, branch, targets);
  return {
    base,
    targets,
    commits: await logCommits({ cwd: repoPath, revs: [`${base}..${branch}`], maxCount: 1000 }),
  };
}

async function classifyBranch(
  repoPath: string,
  branch: string,
  chain: string[],
  own: BranchCommits,
): Promise<Partial<BranchReport>> {
  const { base, targets, commits } = own;
  if (targets.length === 0) return { note: 'No promotion branches to compare against.' };

  if (commits.length === 0) {
    // Nothing unique to this branch at all.
    return { safety: 'merged', releasedTo: targets[targets.length - 1], weakestMethod: 'merged', fastDelete: true };
  }

  const statuses = await classify({ repoPath, branch, targets, base, commits });

  // Prefer the most downstream branch it is fully covered by.
  let best: Partial<BranchReport> = {
    safety: 'unreleased',
    totalCommits: commits.length,
    unreleasedCount: commits.length,
  };

  for (const target of [...targets].reverse()) {
    let weakest: ReleaseMethod = 'merged';
    let unreleased = 0;

    for (const commit of commits) {
      const status = statuses.get(commit.sha)?.[target];
      const method = status?.method ?? 'none';
      if (METHOD_RANK[method] > METHOD_RANK[weakest]) weakest = method;
      if (!status?.released && status?.confidence !== 'low') unreleased++;
    }

    const safety: BranchSafety =
      weakest === 'none'
        ? 'unreleased'
        : METHOD_RANK[weakest] >= METHOD_RANK.squashed
          ? 'likely'
          : weakest === 'merged'
            ? 'merged'
            : 'picked';

    const candidate: Partial<BranchReport> = {
      safety,
      releasedTo: safety === 'unreleased' ? undefined : target,
      weakestMethod: weakest,
      totalCommits: commits.length,
      unreleasedCount: unreleased,
      // Only ancestry lets git delete without a force flag.
      fastDelete: safety === 'merged',
    };

    if (safety !== 'unreleased') return candidate;
    // Keep the smallest outstanding count across targets for the summary.
    if ((best.unreleasedCount ?? Infinity) > unreleased) best = candidate;
  }

  return best;
}

export type DeleteOutcome = { name: string; deleted: string; commands: string[][] };

/**
 * Deletes a branch, but only one this report considers finished.
 *
 * The classifier is re-run rather than trusting whatever the client sends: a
 * stale page is exactly how you'd delete a branch that has since gained work.
 * `-D` is needed for anything released by cherry-pick, since git's own `-d` only
 * understands ancestry — so the deleted tip is returned for `git branch <name>
 * <sha>` if the call was wrong after all.
 */
export async function deleteBranch(repoPath: string, name: string): Promise<DeleteOutcome> {
  const report = await buildCleanupReport(repoPath);
  const entry = report.branches.find((b) => b.name === name);

  if (!entry) throw new Error(`No such branch: ${name}`);
  if (entry.safety === 'skipped') throw new Error(entry.note ?? `${name} cannot be deleted.`);
  if (entry.safety === 'unreleased') {
    throw new Error(
      `${name} still has ${entry.unreleasedCount} unreleased commit(s). Refusing to delete it.`,
    );
  }
  if (entry.safety === 'likely') {
    throw new Error(
      `${name} only matches by squash or subject, which is a guess. Verify it by hand, then ` +
        `delete it with git if you're sure.`,
    );
  }

  const flag = entry.fastDelete ? '-d' : '-D';
  const commands = [['branch', flag, name]];
  await git(['branch', flag, name], {
    cwd: repoPath,
    write: true,
    // Only reachable once the classifier has confirmed the work is released.
    forceDelete: !entry.fastDelete,
  });

  return { name, deleted: entry.tip, commands };
}
