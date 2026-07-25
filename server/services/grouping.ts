import { loadConfig } from '../config.ts';
import type {
  ClassifiedCommit,
  CommitInfo,
  GroupState,
  GroupTargetSummary,
  ReleaseStatus,
  TicketGroup,
} from '../../shared/types.ts';

/**
 * QA clears tickets, not commits, so the matrix groups by Jira id.
 *
 * Extraction is deliberately strict: only a bracketed prefix at the very start
 * of the subject counts. A ticket merely mentioned mid-sentence ("similar to
 * ABC-1") must not drag a commit into that group. Commits that don't follow the
 * convention fall back to the branch name, and anything still unmatched lands
 * visibly in an Ungrouped bucket rather than being silently mis-filed.
 */

export const UNGROUPED = null;

export interface TicketRef {
  ticket: string | null;
  source: 'subject' | 'branch' | null;
}

export function extractTicket(subject: string, branchName?: string | null): TicketRef {
  const cfg = loadConfig();

  const subjectRe = new RegExp(cfg.ticketPattern);
  const fromSubject = subjectRe.exec(subject ?? '');
  if (fromSubject?.[1]) {
    return { ticket: fromSubject[1].toUpperCase(), source: 'subject' };
  }

  if (branchName) {
    const branchRe = new RegExp(cfg.branchTicketPattern);
    const fromBranch = branchRe.exec(branchName);
    if (fromBranch?.[1]) {
      return { ticket: fromBranch[1].toUpperCase(), source: 'branch' };
    }
  }

  return { ticket: UNGROUPED, source: null };
}

/**
 * Rolls per-commit statuses up to a per-ticket verdict.
 *
 * `partial` is the state this whole app exists to surface: a ticket with some
 * commits on the target and some not is half-shipped, which is a latent bug and
 * invisible in plain git.
 */
export function summariseGroup(
  commits: ClassifiedCommit[],
  target: string,
): GroupTargetSummary {
  let releasedCount = 0;
  let likelyCount = 0;
  const missing: string[] = [];

  for (const c of commits) {
    const status: ReleaseStatus | undefined = c.status[target];
    if (status?.released) {
      releasedCount++;
    } else if (status && status.confidence === 'low') {
      likelyCount++;
      missing.push(c.commit.sha);
    } else {
      missing.push(c.commit.sha);
    }
  }

  const total = commits.length;
  const pendingCount = total - releasedCount - likelyCount;

  let state: GroupState;
  if (total === 0) {
    state = 'pending';
  } else if (releasedCount === total) {
    state = 'released';
  } else if (releasedCount === 0 && likelyCount === 0) {
    state = 'pending';
  } else if (releasedCount + likelyCount === total && releasedCount === 0) {
    // Only heuristic evidence backs this ticket — say so rather than claiming it shipped.
    state = 'likely';
  } else {
    state = 'partial';
  }

  return { state, releasedCount, likelyCount, pendingCount, total, missing };
}

const STATE_RANK: Record<GroupState, number> = {
  partial: 0, // loudest first — these are the ones that bite
  pending: 1,
  likely: 2,
  released: 3,
};

/** Worst (lowest-ranked) state a group has across all targets. */
function worstState(group: TicketGroup, targets: string[]): number {
  let worst = STATE_RANK.released;
  for (const t of targets) {
    const s = group.summary[t];
    if (s) worst = Math.min(worst, STATE_RANK[s.state]);
  }
  return worst;
}

export interface GroupInput {
  commits: CommitInfo[];
  statuses: Map<string, Record<string, ReleaseStatus>>;
  targets: string[];
  branchName: string;
}

export function groupCommits(input: GroupInput): TicketGroup[] {
  const cfg = loadConfig();
  const { commits, statuses, targets, branchName } = input;

  const order: (string | null)[] = [];
  const buckets = new Map<string | null, ClassifiedCommit[]>();

  for (const commit of commits) {
    const { ticket, source } = extractTicket(commit.subject, branchName);
    const classified: ClassifiedCommit = {
      commit,
      ticket,
      ticketSource: source,
      status: statuses.get(commit.sha) ?? {},
    };
    if (!buckets.has(ticket)) {
      buckets.set(ticket, []);
      order.push(ticket);
    }
    buckets.get(ticket)!.push(classified);
  }

  const groups: TicketGroup[] = order.map((ticket) => {
    const groupCommitsList = buckets.get(ticket)!;
    const summary: Record<string, GroupTargetSummary> = {};
    for (const target of targets) {
      summary[target] = summariseGroup(groupCommitsList, target);
    }
    return {
      ticket,
      label: ticket ?? 'Ungrouped',
      url: ticket && cfg.jiraBaseUrl ? joinUrl(cfg.jiraBaseUrl, ticket) : null,
      commits: groupCommitsList,
      summary,
    };
  });

  // Partial groups float to the top; Ungrouped always sinks to the bottom so it
  // never crowds out real tickets.
  return groups.sort((a, b) => {
    if (a.ticket === null && b.ticket !== null) return 1;
    if (b.ticket === null && a.ticket !== null) return -1;
    const diff = worstState(a, targets) - worstState(b, targets);
    if (diff !== 0) return diff;
    return order.indexOf(a.ticket) - order.indexOf(b.ticket);
  });
}

function joinUrl(base: string, ticket: string): string {
  return `${base.replace(/\/+$/, '')}/${ticket}`;
}

/** Per-target ticket progress for the UI's progress bars. */
export function ticketProgress(
  groups: TicketGroup[],
  targets: string[],
): Record<string, { releasedTickets: number; totalTickets: number }> {
  const out: Record<string, { releasedTickets: number; totalTickets: number }> = {};
  for (const target of targets) {
    let released = 0;
    for (const g of groups) {
      if (g.summary[target]?.state === 'released') released++;
    }
    out[target] = { releasedTickets: released, totalTickets: groups.length };
  }
  return out;
}
