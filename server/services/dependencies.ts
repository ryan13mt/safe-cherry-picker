import { git } from '../git.ts';
import type { CommitInfo, TicketDependency, TicketFileStat } from '../../shared/types.ts';

/**
 * Works out when one ticket is standing on another's work.
 *
 * The conflict simulation tells you a pick *will* fail; this tells you *why*
 * before you try — because the ticket you selected builds on a file another
 * ticket created, or one it rewrote most of. That is the difference between
 * "this conflicts" and "PAY-1101 needs PAY-1100 first".
 *
 * Two signals, both derived from real diff numbers rather than guessed:
 *
 *   creates-file    another ticket added the file, and this one edits it. Hard:
 *                   picking this ticket alone cannot work.
 *   dominant-churn  another ticket accounts for most of the changed lines in a
 *                   file this one also touches. Soft: it usually conflicts, and
 *                   it always means the two were developed together.
 */

/** A ticket must own at least this many lines in a file before it counts. */
const CHURN_FLOOR = 10;
/** ...and at least this share of the changed lines. */
const CHURN_SHARE = 0.5;

interface FileChange {
  path: string;
  added: number;
  removed: number;
  status: string;
  /** Position in the branch, oldest first, for ordering. */
  index: number;
  ticket: string | null;
  sha: string;
}

const RS = '\x1e';

/**
 * Per-commit file changes for the whole range in two passes: `--numstat` for the
 * line counts and `--name-status` for whether a file was added, modified or
 * deleted. Two git invocations for the branch, not two per commit.
 */
async function collectChanges(
  repoPath: string,
  base: string,
  branch: string,
  ticketOf: Map<string, string | null>,
  order: Map<string, number>,
): Promise<FileChange[]> {
  const range = `${base}..${branch}`;

  const [numstat, nameStatus] = await Promise.all([
    git(['log', `--format=${RS}%H`, '--numstat', '--no-renames', range], { cwd: repoPath }),
    git(['log', `--format=${RS}%H`, '--name-status', '--no-renames', range], { cwd: repoPath }),
  ]);

  // path -> status, per commit
  const statuses = new Map<string, Map<string, string>>();
  for (const block of nameStatus.stdout.split(RS)) {
    const lines = block.split('\n').filter(Boolean);
    if (lines.length === 0) continue;
    const sha = lines[0].trim();
    const perFile = new Map<string, string>();
    for (const line of lines.slice(1)) {
      const [status, ...rest] = line.split('\t');
      const file = rest[rest.length - 1];
      if (status && file) perFile.set(file, status.trim());
    }
    statuses.set(sha, perFile);
  }

  const changes: FileChange[] = [];
  for (const block of numstat.stdout.split(RS)) {
    const lines = block.split('\n').filter(Boolean);
    if (lines.length === 0) continue;
    const sha = lines[0].trim();
    const index = order.get(sha);
    if (index === undefined) continue;

    for (const line of lines.slice(1)) {
      const [added, removed, ...rest] = line.split('\t');
      const file = rest[rest.length - 1];
      if (!file) continue;
      changes.push({
        path: file,
        // Binary files report "-" rather than a count.
        added: Number(added) || 0,
        removed: Number(removed) || 0,
        status: statuses.get(sha)?.get(file) ?? 'M',
        index,
        ticket: ticketOf.get(sha) ?? null,
        sha,
      });
    }
  }
  return changes;
}

export interface DependencyInput {
  repoPath: string;
  base: string;
  branch: string;
  commits: CommitInfo[];
  /** sha -> ticket, as resolved by the grouper. */
  ticketOf: Map<string, string | null>;
}

export interface DependencyResult {
  /** ticket key -> the files it touches, with churn. */
  files: Map<string | null, TicketFileStat[]>;
  /** ticket key -> what it depends on. */
  dependencies: Map<string | null, TicketDependency[]>;
}

export async function analyseDependencies(input: DependencyInput): Promise<DependencyResult> {
  const { repoPath, base, branch, commits, ticketOf } = input;

  // Oldest first, so a lower index means "came earlier on the branch".
  const order = new Map<string, number>();
  [...commits].reverse().forEach((c, i) => order.set(c.sha, i));

  const changes = await collectChanges(repoPath, base, branch, ticketOf, order);

  // Aggregate per ticket per file.
  const perTicket = new Map<string | null, Map<string, TicketFileStat & { firstIndex: number }>>();
  const perFile = new Map<string, FileChange[]>();

  for (const change of changes) {
    if (!perFile.has(change.path)) perFile.set(change.path, []);
    perFile.get(change.path)!.push(change);

    if (!perTicket.has(change.ticket)) perTicket.set(change.ticket, new Map());
    const files = perTicket.get(change.ticket)!;
    const existing = files.get(change.path);
    if (existing) {
      existing.added += change.added;
      existing.removed += change.removed;
      existing.created ||= change.status === 'A';
      existing.deleted ||= change.status === 'D';
      existing.firstIndex = Math.min(existing.firstIndex, change.index);
    } else {
      files.set(change.path, {
        path: change.path,
        added: change.added,
        removed: change.removed,
        created: change.status === 'A',
        deleted: change.status === 'D',
        firstIndex: change.index,
      });
    }
  }

  const dependencies = new Map<string | null, TicketDependency[]>();

  for (const [ticket, files] of perTicket) {
    // other ticket -> reasons
    const byOther = new Map<string | null, TicketDependency['reasons']>();

    for (const [file, mine] of files) {
      const all = perFile.get(file) ?? [];
      const totalLines = all.reduce((n, c) => n + c.added + c.removed, 0);
      const myLines = mine.added + mine.removed;

      // Everyone else's contribution to this file.
      const others = new Map<string | null, { lines: number; created: boolean; firstIndex: number }>();
      for (const change of all) {
        if (change.ticket === ticket) continue;
        const agg = others.get(change.ticket) ?? {
          lines: 0,
          created: false,
          firstIndex: Number.MAX_SAFE_INTEGER,
        };
        agg.lines += change.added + change.removed;
        agg.created ||= change.status === 'A';
        agg.firstIndex = Math.min(agg.firstIndex, change.index);
        others.set(change.ticket, agg);
      }

      for (const [other, agg] of others) {
        // Only an *earlier* change can be depended upon.
        if (agg.firstIndex >= mine.firstIndex) continue;

        const share = totalLines > 0 ? agg.lines / totalLines : 0;
        let kind: TicketDependency['reasons'][number]['kind'] | null = null;

        if (agg.created && !mine.created) kind = 'creates-file';
        else if (agg.lines >= CHURN_FLOOR && share >= CHURN_SHARE) kind = 'dominant-churn';
        if (!kind) continue;

        if (!byOther.has(other)) byOther.set(other, []);
        byOther.get(other)!.push({
          path: file,
          kind,
          share: Math.round(share * 100) / 100,
          otherLines: agg.lines,
          ourLines: myLines,
        });
      }
    }

    const deps: TicketDependency[] = [...byOther]
      .map(([other, reasons]) => ({
        ticket: other,
        label: other ?? 'Ungrouped',
        reasons: reasons.sort((a, b) => b.otherLines - a.otherLines),
        strength: reasons.some((r) => r.kind === 'creates-file')
          ? ('hard' as const)
          : ('soft' as const),
      }))
      .sort((a, b) => {
        if (a.strength !== b.strength) return a.strength === 'hard' ? -1 : 1;
        return b.reasons.length - a.reasons.length;
      });

    if (deps.length > 0) dependencies.set(ticket, deps);
  }

  const files = new Map<string | null, TicketFileStat[]>();
  for (const [ticket, map] of perTicket) {
    files.set(
      ticket,
      [...map.values()]
        .map(({ firstIndex, ...stat }) => {
          void firstIndex;
          return stat;
        })
        .sort((a, b) => b.added + b.removed - (a.added + a.removed)),
    );
  }

  return { files, dependencies };
}
