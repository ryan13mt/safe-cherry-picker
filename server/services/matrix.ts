import { loadConfig } from '../config.ts';
import { logCommits } from './commits.ts';
import { localBranches } from './discover.ts';
import { classify, findBase } from './release.ts';
import { groupCommits, ticketProgress } from './grouping.ts';
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

  const groups = groupCommits({ commits: limited, statuses, targets, branchName: branch });

  return {
    repoId,
    branch,
    targets,
    base,
    groups,
    progress: ticketProgress(groups, targets),
    truncated,
    generatedAt: new Date().toISOString(),
  };
}
