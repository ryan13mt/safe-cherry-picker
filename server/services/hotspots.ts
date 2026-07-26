import { loadConfig } from '../config.ts';
import { logCommits } from './commits.ts';
import { localBranches } from './discover.ts';
import { extractTicket } from './grouping.ts';
import { findBase } from './release.ts';
import { analyseDependencies } from './dependencies.ts';
import type { FileHotspot, HotspotReport } from '../../shared/types.ts';

/**
 * Which files keep causing trouble.
 *
 * The dependency analysis already works out, for one branch, which files make
 * one ticket depend on another. Running it across every feature branch and
 * aggregating turns that into a standing answer: these are the files two people
 * always end up editing at once, and the reason your picks keep conflicting.
 *
 * That is an architectural signal as much as a git one — a file that collides
 * across half a dozen branches is usually one that wants splitting up.
 */

/** Each branch costs a findBase plus two log passes, so bound the scan. */
const MAX_BRANCHES = 40;

export async function buildHotspotReport(repoPath: string): Promise<HotspotReport> {
  const cfg = loadConfig();
  const all = await localBranches(repoPath);
  const chain = cfg.chain.filter((b) => all.includes(b));
  const chainSet = new Set(chain);

  // Feature branches only: the chain branches carry everyone's work, so they
  // would drown the signal.
  const candidates = all.filter((b) => !chainSet.has(b));
  const scanned = candidates.slice(0, MAX_BRANCHES);
  const skipped = candidates.slice(MAX_BRANCHES);

  interface Accum {
    tickets: Set<string>;
    branches: Set<string>;
    churn: number;
    collisions: number;
    pairs: Set<string>;
  }
  const byFile = new Map<string, Accum>();
  const get = (path: string): Accum => {
    let entry = byFile.get(path);
    if (!entry) {
      entry = { tickets: new Set(), branches: new Set(), churn: 0, collisions: 0, pairs: new Set() };
      byFile.set(path, entry);
    }
    return entry;
  };

  const branchesScanned: string[] = [];

  for (const branch of scanned) {
    const targets = chain.filter((t) => t !== branch);
    if (targets.length === 0) continue;

    const base = await findBase(repoPath, branch, targets);
    const commits = await logCommits({
      cwd: repoPath,
      revs: [`${base}..${branch}`],
      maxCount: cfg.maxBranchCommits,
    });
    if (commits.length === 0) continue;

    const ticketOf = new Map<string, string | null>(
      commits.map((c) => [c.sha, extractTicket(c.subject, branch).ticket]),
    );
    const { files, dependencies } = await analyseDependencies({
      repoPath,
      base,
      branch,
      commits,
      ticketOf,
    });
    branchesScanned.push(branch);

    for (const [ticket, stats] of files) {
      const label = ticket ?? 'Ungrouped';
      for (const stat of stats) {
        const entry = get(stat.path);
        entry.tickets.add(label);
        entry.branches.add(branch);
        entry.churn += stat.added + stat.removed;
      }
    }

    // The collision signal: a file named as the reason for a dependency.
    for (const [ticket, deps] of dependencies) {
      const from = ticket ?? 'Ungrouped';
      for (const dep of deps) {
        for (const reason of dep.reasons) {
          const entry = get(reason.path);
          entry.collisions++;
          // Order-independent, so A→B and B→A count as the same pair.
          entry.pairs.add([from, dep.label].sort().join(' ↔ '));
        }
      }
    }
  }

  const files: FileHotspot[] = [...byFile]
    .map(([path, a]) => ({
      path,
      tickets: [...a.tickets].sort(),
      branches: [...a.branches].sort(),
      churn: a.churn,
      collisions: a.collisions,
      pairs: [...a.pairs].sort(),
    }))
    // Only files that more than one ticket touched can be a hotspot.
    .filter((f) => f.collisions > 0 || f.tickets.length > 1)
    .sort(
      (a, b) =>
        b.collisions - a.collisions ||
        b.tickets.length - a.tickets.length ||
        b.churn - a.churn ||
        a.path.localeCompare(b.path),
    );

  return { files, branchesScanned, skipped, generatedAt: new Date().toISOString() };
}
