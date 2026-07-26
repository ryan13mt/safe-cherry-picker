import type { CommitInfo } from '../../shared/types.ts';

/**
 * Markdown release notes for a promotion.
 *
 * The commits are already on hand from the pipeline view, so this is assembling
 * data rather than fetching it. Grouping uses the same ticket pattern the server
 * classifies with, so the notes match what the matrix shows.
 */
export function buildReleaseNotes(input: {
  commits: CommitInfo[];
  ticketPattern: string;
  from: string;
  into: string;
  jiraBaseUrl?: string;
}): string {
  const { commits, ticketPattern, from, into, jiraBaseUrl } = input;

  let re: RegExp;
  try {
    re = new RegExp(ticketPattern);
  } catch {
    re = /^\s*\[([A-Za-z][A-Za-z0-9]*-\d+)\]/;
  }

  const groups = new Map<string | null, CommitInfo[]>();
  const order: (string | null)[] = [];

  // Merge commits are noise in release notes — the work they carry is listed
  // by the commits themselves.
  for (const commit of commits.filter((c) => !c.isMerge)) {
    const ticket = re.exec(commit.subject)?.[1]?.toUpperCase() ?? null;
    if (!groups.has(ticket)) {
      groups.set(ticket, []);
      order.push(ticket);
    }
    groups.get(ticket)!.push(commit);
  }

  const ticketed = order.filter((t): t is string => t !== null).sort();
  const untitled = groups.get(null) ?? [];

  const lines = [`## ${from} → ${into}`, ''];

  if (groups.size === 0) {
    lines.push('_Nothing to promote._');
    return lines.join('\n');
  }

  for (const ticket of ticketed) {
    const heading = jiraBaseUrl
      ? `[${ticket}](${jiraBaseUrl.replace(/\/+$/, '')}/${ticket})`
      : ticket;
    lines.push(`- **${heading}**`);
    for (const commit of groups.get(ticket)!) {
      lines.push(`  - ${stripTicket(commit.subject, re)} (\`${commit.short}\`)`);
    }
  }

  if (untitled.length > 0) {
    lines.push('- **Other**');
    for (const commit of untitled) {
      lines.push(`  - ${commit.subject} (\`${commit.short}\`)`);
    }
  }

  const count = commits.filter((c) => !c.isMerge).length;
  lines.push('', `_${count} commit${count === 1 ? '' : 's'} across ${groups.size} group${groups.size === 1 ? '' : 's'}._`);
  return lines.join('\n');
}

/** The ticket is already the bullet's heading; don't repeat it on every line. */
function stripTicket(subject: string, re: RegExp): string {
  const match = re.exec(subject);
  if (!match) return subject;
  return subject.slice(match[0].length).replace(/^[\s:—-]+/, '').trim() || subject;
}
