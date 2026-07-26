import { git } from '../git.ts';
import type { BranchAuthorship, CommitInfo, Contributor } from '../../shared/types.ts';

/**
 * Field and record separators that cannot appear in commit metadata, so a body
 * containing newlines or quotes can't corrupt the parse.
 */
const FS = '\x1f';
const RS = '\x1e';
export const LOG_FORMAT = `--format=%H${FS}%h${FS}%an${FS}%ae${FS}%aI${FS}%s${FS}%P${FS}%b${RS}`;

export function parseLog(stdout: string): CommitInfo[] {
  const out: CommitInfo[] = [];
  for (const record of stdout.split(RS)) {
    const trimmed = record.replace(/^\r?\n/, '');
    if (!trimmed.trim()) continue;
    const [sha, short, author, authorEmail, date, subject, parents, body = ''] = trimmed.split(FS);
    if (!sha) continue;
    const parentList = (parents ?? '').trim().split(/\s+/).filter(Boolean);
    out.push({
      sha,
      short,
      author,
      authorEmail: authorEmail ?? '',
      date,
      subject: subject ?? '',
      body: body ?? '',
      parents: parentList,
      isMerge: parentList.length > 1,
    });
  }
  return out;
}

export interface LogOptions {
  cwd: string;
  /** Revision arguments, e.g. ['base..branch'] or ['main', '--not', 'other']. */
  revs: string[];
  maxCount?: number;
}

export async function logCommits(opts: LogOptions): Promise<CommitInfo[]> {
  const args = ['log', LOG_FORMAT];
  if (opts.maxCount) args.push(`--max-count=${opts.maxCount}`);
  args.push(...opts.revs);
  const { stdout } = await git(args, { cwd: opts.cwd });
  return parseLog(stdout);
}

export async function countCommits(cwd: string, revs: string[]): Promise<number> {
  const { stdout } = await git(['rev-list', '--count', ...revs], { cwd });
  return Number(stdout.trim()) || 0;
}

/**
 * Who worked on a set of commits, most prolific first.
 *
 * Keyed on email so the same person spelled two ways counts once; the display
 * name is whichever they used most recently.
 */
export function contributorsOf(commits: CommitInfo[]): Contributor[] {
  const byEmail = new Map<string, Contributor>();
  for (const commit of commits) {
    // A merge commit's author didn't write the work it carries.
    if (commit.isMerge) continue;
    const key = (commit.authorEmail || commit.author).toLowerCase();
    const existing = byEmail.get(key);
    if (existing) existing.commits++;
    else byEmail.set(key, { name: commit.author, email: commit.authorEmail, commits: 1 });
  }
  return [...byEmail.values()].sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name));
}

/**
 * Who started a branch and who worked on it.
 *
 * Git stores nothing about branch creation, so "started by" is the author of the
 * oldest commit unique to the branch. That is a proxy — someone can branch and
 * let a colleague make the first commit — but it is the only signal that
 * survives a clone. Reflogs record who ran `git checkout -b`, but they are local
 * to whoever did it and would be wrong or absent for everyone else.
 *
 * `commits` is expected newest-first, as git log returns it.
 */
export function authorshipOf(commits: CommitInfo[]): BranchAuthorship {
  const own = commits.filter((c) => !c.isMerge);
  const oldest = own[own.length - 1];
  return {
    startedBy: oldest
      ? {
          name: oldest.author,
          email: oldest.authorEmail,
          date: oldest.date,
          sha: oldest.sha,
          short: oldest.short,
        }
      : undefined,
    contributors: contributorsOf(commits),
  };
}

/**
 * Normalises a subject for heuristic matching: lowercased, PR-number suffixes
 * removed (GitHub appends " (#123)" on squash), whitespace collapsed.
 */
export function normaliseSubject(subject: string): string {
  return subject
    .replace(/\s*\(#\d+\)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Pulls every `(cherry picked from commit <sha>)` trailer out of a commit body. */
export function extractCherryTrailers(body: string): string[] {
  const out: string[] = [];
  const re = /\(cherry picked from commit ([0-9a-f]{7,40})\)/gi;
    let m: RegExpExecArray | null;
  while ((m = re.exec(body))) out.push(m[1].toLowerCase());
  return out;
}

/**
 * Candidate subject lines from a squash commit body. GitHub writes "* subject"
 * per squashed commit; GitLab and manual squashes often use "- subject" or a
 * bare line. Very short lines are ignored — they generate false positives.
 */
export function squashBodyLines(body: string): string[] {
  return body
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[*\-+]\s+/, '').trim())
    .filter((line) => line.length >= 10 && !/^(cherry picked from|co-authored-by|signed-off-by)/i.test(line))
    .map(normaliseSubject);
}
