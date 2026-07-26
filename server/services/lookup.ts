import { loadConfig } from '../config.ts';
import { git } from '../git.ts';
import { LOG_FORMAT, parseLog, extractCherryTrailers } from './commits.ts';
import { localBranches } from './discover.ts';
import { findBase } from './release.ts';
import type { TicketLookup, TicketSighting } from '../../shared/types.ts';

/**
 * Answers "where is PAY-1042?".
 *
 * The matrix goes branch → tickets; this goes the other way, which is the
 * direction people actually ask in. QA says "is PAY-1042 in stable yet?" and the
 * answer should not require knowing which branch to look at first.
 *
 * Searching commit messages rather than classifying is deliberate here: a
 * cherry-picked copy keeps the original subject, so a message search finds the
 * original *and* every copy of it, which is exactly the map you want. Commits
 * whose message lost the ticket (a squash that rewrote the subject) will be
 * missed, and the UI says so.
 */

/** Escapes a ticket for use in git's basic regular expressions. */
function escapeForGrep(ticket: string): string {
  return ticket.replace(/[.[\]*^$\\]/g, '\\$&');
}

const MAX_SIGHTINGS = 60;

export async function findTicket(repoPath: string, rawTicket: string): Promise<TicketLookup> {
  const cfg = loadConfig();
  const ticket = rawTicket.trim().toUpperCase();
  const all = await localBranches(repoPath);
  const chain = cfg.chain.filter((b) => all.includes(b));

  // `--branches` keeps this to local refs, consistent with the rest of the app.
  const res = await git(
    [
      'log',
      LOG_FORMAT,
      '--branches',
      '--regexp-ignore-case',
      `--grep=${escapeForGrep(ticket)}`,
      `--max-count=${MAX_SIGHTINGS + 1}`,
    ],
    { cwd: repoPath, allowFail: true },
  );

  const commits = res.code === 0 ? parseLog(res.stdout) : [];
  const truncated = commits.length > MAX_SIGHTINGS;
  const limited = truncated ? commits.slice(0, MAX_SIGHTINGS) : commits;

  const sightings: TicketSighting[] = [];
  const containment: string[][] = [];

  for (const commit of limited) {
    const containing = await git(
      ['branch', '--contains', commit.sha, '--format=%(refname:short)'],
      { cwd: repoPath, allowFail: true },
    );
    containment.push(
      containing.code === 0
        ? containing.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
        : [],
    );
  }

  // "Contains" is too broad to answer "where does this work live": a branch cut
  // from develop after the work merged contains it, but had nothing to do with
  // it. Ownership — the commit being part of a branch's own range — is the
  // question actually being asked, so compute it for the few candidate branches.
  const chainSet = new Set(chain);
  const candidates = [...new Set(containment.flat())].filter((b) => !chainSet.has(b));
  const ownedShas = new Map<string, Set<string>>();

  for (const branch of candidates) {
    ownedShas.set(branch, await ownCommits(repoPath, branch, chain));
  }

  for (const [i, commit] of limited.entries()) {
    const branches = containment[i];
    const trailers = extractCherryTrailers(commit.body);
    sightings.push({
      commit,
      branches,
      ownedBy: candidates.filter((b) => ownedShas.get(b)?.has(commit.sha)),
      onChain: chain.filter((c) => branches.includes(c)),
      isCopy: trailers.length > 0,
      copiedFrom: trailers[0],
    });
  }

  const chainStatus: Record<string, boolean> = {};
  for (const branch of chain) {
    chainStatus[branch] = sightings.some((s) => s.onChain.includes(branch));
  }

  const sourceBranches = [...new Set(sightings.flatMap((s) => s.ownedBy))].sort();

  return { ticket, sightings, chainStatus, sourceBranches, truncated };
}

/** The SHAs a branch introduced, relative to where it left the promotion chain. */
async function ownCommits(
  repoPath: string,
  branch: string,
  chain: string[],
): Promise<Set<string>> {
  const targets = chain.filter((t) => t !== branch);
  if (targets.length === 0) return new Set();

  const base = await findBase(repoPath, branch, targets);
  const res = await git(['rev-list', `${base}..${branch}`], { cwd: repoPath, allowFail: true });
  if (res.code !== 0) return new Set();
  return new Set(res.stdout.split('\n').map((l) => l.trim()).filter(Boolean));
}
