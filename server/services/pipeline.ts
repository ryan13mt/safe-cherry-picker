import { loadConfig } from '../config.ts';
import { logCommits } from './commits.ts';
import { localBranches } from './discover.ts';
import type { PipelineLeg, PipelineReport } from '../../shared/types.ts';

/**
 * The chain is ordered upstream -> downstream (develop, stable, prod).
 * Promotion merges chain[i] into chain[i+1]; a back-merge goes the other way.
 *
 * `ahead` is the promotion payload: commits the upstream branch has that the
 * downstream one lacks. `behind` is the inverse — typically a hotfix that
 * landed straight on prod and never made it back down. That second number is
 * the one that silently rots, so the UI treats any non-zero value as a warning.
 */
export async function buildPipeline(repoPath: string, chainOverride?: string[]): Promise<PipelineReport> {
  const cfg = loadConfig();
  const wanted = chainOverride ?? cfg.chain;
  const existing = new Set(await localBranches(repoPath));
  const chain = wanted.filter((b) => existing.has(b));

  const legs: PipelineLeg[] = [];
  for (let i = 0; i < chain.length - 1; i++) {
    const upstream = chain[i];
    const downstream = chain[i + 1];

    // `A..B` means "reachable from B but not from A".
    const [ahead, behind] = await Promise.all([
      logCommits({ cwd: repoPath, revs: [`${downstream}..${upstream}`], maxCount: cfg.maxBranchCommits }),
      logCommits({ cwd: repoPath, revs: [`${upstream}..${downstream}`], maxCount: cfg.maxBranchCommits }),
    ]);

    legs.push({ upstream, downstream, ahead, behind });
  }

  return { chain, legs, generatedAt: new Date().toISOString() };
}
