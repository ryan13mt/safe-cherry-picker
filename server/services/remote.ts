import { loadConfig } from '../config.ts';
import { git } from '../git.ts';
import { localBranches } from './discover.ts';
import type { RemoteStatus, RemoteReport } from '../../shared/types.ts';

/**
 * How far each promotion branch has drifted from its remote.
 *
 * The app moves local branches and then goes quiet, so you have to remember what
 * still needs pushing. This closes that loop without breaking the rule that
 * nothing is ever pushed from here: it reports, you push.
 *
 * Fetching is never automatic. Remote-tracking refs go stale the moment someone
 * else pushes, and quietly reaching the network on page load would be both
 * surprising and slow — so there is a button, and the report says when it last
 * happened.
 */

/** `<branch>...<upstream>` with --left-right gives "ahead<TAB>behind". */
async function aheadBehind(
  repoPath: string,
  branch: string,
  upstream: string,
): Promise<{ ahead: number; behind: number } | null> {
  const res = await git(['rev-list', '--left-right', '--count', `${branch}...${upstream}`], {
    cwd: repoPath,
    allowFail: true,
  });
  if (res.code !== 0) return null;
  const [ahead, behind] = res.stdout.trim().split(/\s+/).map(Number);
  return Number.isFinite(ahead) && Number.isFinite(behind) ? { ahead, behind } : null;
}

/** The configured upstream of a branch, e.g. "origin/stable". */
async function upstreamOf(repoPath: string, branch: string): Promise<string | null> {
  const res = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`], {
    cwd: repoPath,
    allowFail: true,
  });
  const name = res.stdout.trim();
  return res.code === 0 && name ? name : null;
}

/** When this repo last fetched, from the fetch-head mtime git maintains. */
async function lastFetchedAt(repoPath: string): Promise<string | null> {
  const res = await git(['rev-parse', '--git-path', 'FETCH_HEAD'], { cwd: repoPath, allowFail: true });
  if (res.code !== 0) return null;
  try {
    const { statSync } = await import('node:fs');
    const path = await import('node:path');
    return statSync(path.resolve(repoPath, res.stdout.trim())).mtime.toISOString();
  } catch {
    return null; // never fetched
  }
}

export async function remoteReport(repoPath: string): Promise<RemoteReport> {
  const cfg = loadConfig();
  const existing = await localBranches(repoPath);
  const chain = cfg.chain.filter((b) => existing.includes(b));

  const branches: RemoteStatus[] = [];
  const remotes = new Set<string>();

  for (const branch of chain) {
    const upstream = await upstreamOf(repoPath, branch);
    if (!upstream) {
      branches.push({ branch, upstream: null, ahead: 0, behind: 0 });
      continue;
    }
    remotes.add(upstream.split('/')[0]);
    const counts = await aheadBehind(repoPath, branch, upstream);
    branches.push({ branch, upstream, ahead: counts?.ahead ?? 0, behind: counts?.behind ?? 0 });
  }

  return {
    branches,
    remotes: [...remotes].sort(),
    lastFetchedAt: await lastFetchedAt(repoPath),
    hasRemote: branches.some((b) => b.upstream !== null),
  };
}

/**
 * Updates remote-tracking refs. Explicitly requested by the user, never on a
 * timer or a page load.
 *
 * `--no-write-fetch-head` keeps FETCH_HEAD out of it... except we rely on
 * FETCH_HEAD's mtime to report when this last ran, so it is deliberately left
 * alone. Nothing is merged: this only moves refs/remotes.
 */
export async function fetchRemotes(repoPath: string): Promise<RemoteReport> {
  const report = await remoteReport(repoPath);
  if (!report.hasRemote) {
    throw new Error('No promotion branch is tracking a remote, so there is nothing to fetch.');
  }
  for (const remote of report.remotes) {
    await git(['fetch', '--quiet', remote], { cwd: repoPath, network: true, timeoutMs: 120_000 });
  }
  return remoteReport(repoPath);
}
