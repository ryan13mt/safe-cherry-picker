import { loadConfig } from '../config.ts';
import { logCommits, authorshipOf } from './commits.ts';
import { localBranches } from './discover.ts';
import { classify, findBase } from './release.ts';
import { groupCommits, ticketProgress, extractTicket } from './grouping.ts';
import { analyseDependencies } from './dependencies.ts';
import type { ReleaseMatrix } from '../../shared/types.ts';

/** Ties the classifier and the grouper together into the screen the UI renders. */
export async function buildMatrix(
  repoId: string,
  repoPath: string,
  branch: string,
  targetsOverride?: string[],
): Promise<ReleaseMatrix> {
  const cfg = loadConfig();
  const existing = new Set(await localBranches(repoPath));

  // Check before touching rev-parse: otherwise an unknown branch surfaces as
  // git's "ambiguous argument" wall of text, which reads like a bug in the app
  // rather than a branch that simply isn't here.
  if (!existing.has(branch)) {
    throw new Error(
      `Branch '${branch}' does not exist in this repository. ` +
        `Available: ${[...existing].sort().join(', ') || '(none)'}.`,
    );
  }

  const targets = (targetsOverride ?? cfg.chain).filter(
    (t) => existing.has(t) && t !== branch,
  );

  const base = await findBase(repoPath, branch, targets);

  const commits = await logCommits({
    cwd: repoPath,
    revs: [`${base}..${branch}`],
    maxCount: cfg.maxBranchCommits + 1,
  });
  const truncated = commits.length > cfg.maxBranchCommits;
  const limited = truncated ? commits.slice(0, cfg.maxBranchCommits) : commits;

  const statuses = await classify({
    repoPath,
    branch,
    targets,
    base,
    commits: limited,
  });

  // Ticket assignment has to exist before dependencies can be attributed, so
  // resolve it once here and reuse it for both.
  const ticketOf = new Map<string, string | null>(
    limited.map((c) => [c.sha, extractTicket(c.subject, branch).ticket]),
  );
  const { files, dependencies } = await analyseDependencies({
    repoPath,
    base,
    branch,
    commits: limited,
    ticketOf,
  });

  const groups = groupCommits({
    commits: limited,
    statuses,
    targets,
    branchName: branch,
    files,
    dependencies,
  });

  return {
    repoId,
    branch,
    targets,
    base,
    authorship: authorshipOf(limited),
    groups,
    progress: ticketProgress(groups, targets),
    truncated,
    generatedAt: new Date().toISOString(),
  };
}
