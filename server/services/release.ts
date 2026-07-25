import { loadConfig } from '../config.ts';
import { git } from '../git.ts';
import {
  logCommits,
  normaliseSubject,
  extractCherryTrailers,
  squashBodyLines,
} from './commits.ts';
import type { CommitInfo, ReleaseStatus } from '../../shared/types.ts';

/**
 * Answering "has this commit been released?" is harder than it sounds, because
 * a commit can reach a target branch three different ways and only one of them
 * preserves the SHA:
 *
 *   merge commit   -> SHA preserved, exact ancestry test works
 *   cherry-pick    -> new SHA, but the patch is identical (usually)
 *   squash merge   -> new SHA and a different patch entirely
 *
 * So we run four strategies in descending order of trust and report which one
 * fired, rather than collapsing everything to a boolean. A "probably released"
 * answer the user can see and second-guess is far more useful than a confident
 * wrong one.
 */

const NOT_RELEASED: ReleaseStatus = {
  method: 'none',
  confidence: 'none',
  released: false,
};

interface TargetIndex {
  /** source sha (lowercased, possibly abbreviated) -> target commit that picked it */
  trailers: Map<string, CommitInfo>;
  /** normalised subject -> target commit */
  subjects: Map<string, CommitInfo>;
  /** normalised body line of a squash commit -> target commit */
  squashLines: Map<string, CommitInfo>;
}

/**
 * One pass over the target branch builds all three lookup maps. Doing this per
 * target (rather than per commit, per target) is what keeps a full matrix at a
 * handful of git invocations instead of hundreds.
 */
async function buildTargetIndex(
  repoPath: string,
  target: string,
  base: string,
): Promise<TargetIndex> {
  const cfg = loadConfig();
  // Bounded by the merge-base and a commit cap, deliberately NOT by date: a
  // cherry-pick made a year ago is still a cherry-pick, and filtering the index
  // by age would silently downgrade it to "pending".
  const commits = await logCommits({
    cwd: repoPath,
    revs: [`${base}..${target}`],
    maxCount: cfg.maxTargetIndexCommits,
  });

  const trailers = new Map<string, CommitInfo>();
  const subjects = new Map<string, CommitInfo>();
  const squashLines = new Map<string, CommitInfo>();

  for (const c of commits) {
    for (const src of extractCherryTrailers(c.body)) {
      if (!trailers.has(src)) trailers.set(src, c);
    }
    const subj = normaliseSubject(c.subject);
    if (subj && !subjects.has(subj)) subjects.set(subj, c);
    // A squash commit lists the original subjects in its body.
    if (c.body.trim()) {
      for (const line of squashBodyLines(c.body)) {
        if (line && !squashLines.has(line)) squashLines.set(line, c);
      }
    }
  }
  return { trailers, subjects, squashLines };
}

/** Trailers may abbreviate the source SHA, so match on prefixes too. */
function lookupTrailer(index: TargetIndex, sha: string): CommitInfo | undefined {
  const exact = index.trailers.get(sha.toLowerCase());
  if (exact) return exact;
  for (const [key, commit] of index.trailers) {
    if (sha.toLowerCase().startsWith(key) || key.startsWith(sha.toLowerCase())) return commit;
  }
  return undefined;
}

/** Commits on `branch` that are NOT reachable from `target`. */
async function unmergedShas(repoPath: string, branch: string, target: string): Promise<Set<string>> {
  const { stdout } = await git(['rev-list', branch, `^${target}`], { cwd: repoPath });
  return new Set(stdout.split('\n').map((l) => l.trim()).filter(Boolean));
}

/**
 * `git cherry` compares patch-ids: a `-` prefix means an equivalent patch already
 * exists upstream. This catches clean cherry-picks whose SHA changed.
 */
async function patchEquivalentShas(
  repoPath: string,
  target: string,
  branch: string,
): Promise<Set<string>> {
  const res = await git(['cherry', '-v', target, branch], { cwd: repoPath, allowFail: true });
  const equivalent = new Set<string>();
  if (res.code !== 0) return equivalent;
  for (const line of res.stdout.split('\n')) {
    const m = /^([+-])\s+([0-9a-f]{7,40})/.exec(line.trim());
    if (m && m[1] === '-') equivalent.add(m[2]);
  }
  return equivalent;
}

export interface ClassifyInput {
  repoPath: string;
  branch: string;
  targets: string[];
  base: string;
  commits: CommitInfo[];
}

/**
 * Returns a map: sha -> target -> status.
 */
export async function classify(
  input: ClassifyInput,
): Promise<Map<string, Record<string, ReleaseStatus>>> {
  const { repoPath, branch, targets, base, commits } = input;
  const result = new Map<string, Record<string, ReleaseStatus>>();
  for (const c of commits) result.set(c.sha, {});

  for (const target of targets) {
    const [unmerged, patchEquivalent, index] = await Promise.all([
      unmergedShas(repoPath, branch, target),
      patchEquivalentShas(repoPath, target, branch),
      buildTargetIndex(repoPath, target, base),
    ]);

    for (const commit of commits) {
      result.get(commit.sha)![target] = classifyOne(commit, unmerged, patchEquivalent, index);
    }
  }
  return result;
}

function classifyOne(
  commit: CommitInfo,
  unmerged: Set<string>,
  patchEquivalent: Set<string>,
  index: TargetIndex,
): ReleaseStatus {
  // 1. Exact ancestry. If it isn't in the "not reachable from target" set, the
  //    commit object itself is on the target branch. Nothing beats this.
  if (!unmerged.has(commit.sha)) {
    return { method: 'merged', confidence: 'exact', released: true };
  }

  // 2. An explicit `-x` trailer naming this commit. Also exact, and it survives
  //    conflict resolution during the pick, which patch-id matching does not.
  const traced = lookupTrailer(index, commit.sha);
  if (traced) {
    return {
      method: 'traced',
      confidence: 'exact',
      released: true,
      evidenceSha: traced.sha,
      evidenceShort: traced.short,
      note: 'Recorded by a cherry-pick -x trailer.',
    };
  }

  // 3. Patch-id equivalence.
  if (patchEquivalent.has(commit.sha)) {
    return {
      method: 'patch-id',
      confidence: 'high',
      released: true,
      note: 'An identical patch exists on the target (git cherry).',
    };
  }

  const subject = normaliseSubject(commit.subject);

  // 4. Heuristics. These are guesses: a squash rewrote the patch, so all we have
  //    left to match on is text. Reported as low confidence and never counted as
  //    definitely released.
  if (subject) {
    const squashed = index.squashLines.get(subject);
    if (squashed) {
      return {
        method: 'squashed',
        confidence: 'low',
        released: false,
        evidenceSha: squashed.sha,
        evidenceShort: squashed.short,
        note: `Subject appears in the body of squash commit ${squashed.short} — probably released, verify before relying on it.`,
      };
    }
    const sameSubject = index.subjects.get(subject);
    if (sameSubject) {
      return {
        method: 'subject',
        confidence: 'low',
        released: false,
        evidenceSha: sameSubject.sha,
        evidenceShort: sameSubject.short,
        note: `A commit with an identical subject (${sameSubject.short}) is on the target, but the patch differs.`,
      };
    }
  }

  return { ...NOT_RELEASED };
}

/**
 * Recovers where a branch forked, for a branch that has since been merged into
 * `target`.
 *
 * Once `feature/x` is merged into develop, `merge-base develop feature/x` is
 * feature/x's own tip — useless. But the merge commit that brought it in still
 * records both sides: its first parent is the target's mainline immediately
 * before the merge, so the merge-base of the branch with that parent is the
 * fork point. Without this, a branch cut from a busy develop and then merged
 * back lists every unrelated ticket develop had accumulated.
 */
async function divergenceViaMergeCommit(
  repoPath: string,
  branch: string,
  target: string,
): Promise<string | null> {
  // Merges on the ancestry path between the branch and the target, oldest first;
  // the first one that took this branch as a side parent is the one we want.
  const res = await git(
    ['rev-list', '--merges', '--ancestry-path', '--reverse', `${branch}..${target}`],
    { cwd: repoPath, allowFail: true },
  );
  if (res.code !== 0) return null;

  for (const merge of res.stdout.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const second = await git(['rev-parse', `${merge}^2`], { cwd: repoPath, allowFail: true });
    if (second.code !== 0) continue;

    const broughtUsIn = await git(
      ['merge-base', '--is-ancestor', branch, second.stdout.trim()],
      { cwd: repoPath, allowFail: true },
    );
    if (broughtUsIn.code !== 0) continue;

    const first = await git(['rev-parse', `${merge}^1`], { cwd: repoPath, allowFail: true });
    if (first.code !== 0) continue;

    const forkPoint = await git(['merge-base', branch, first.stdout.trim()], {
      cwd: repoPath,
      allowFail: true,
    });
    if (forkPoint.code === 0 && forkPoint.stdout.trim()) return forkPoint.stdout.trim();
  }
  return null;
}

/**
 * Where the branch diverged from the promotion chain — i.e. which commits count
 * as "this branch's own work".
 *
 * The rule is: the **most recent** merge-base that isn't the branch tip.
 *
 * Both halves matter. Taking the earliest merge-base (e.g. against prod) drags
 * the base back so far that every commit `develop` has accumulated since gets
 * attributed to this branch — a spike branched off a busy develop would list
 * other people's tickets. Taking the most recent one blindly is just as wrong:
 * once a branch is merged into develop, its merge-base with develop *is* the
 * tip, and the matrix would come up empty exactly when you most want to look at
 * it. Skipping tip-valued merge-bases handles that case.
 */
export async function findBase(
  repoPath: string,
  branch: string,
  targets: string[],
): Promise<string> {
  const tip = (await git(['rev-parse', `${branch}^{commit}`], { cwd: repoPath })).stdout.trim();

  const bases: string[] = [];
  for (const target of targets) {
    const res = await git(['merge-base', target, branch], { cwd: repoPath, allowFail: true });
    const sha = res.stdout.trim();
    if (res.code !== 0 || !sha) continue;

    // Merge-base equal to the tip means the branch is fully contained in this
    // target, so it tells us nothing about where the branch forked. The merge
    // commit that brought it in still does.
    if (sha === tip) {
      const viaMerge = await divergenceViaMergeCommit(repoPath, branch, target);
      if (viaMerge) bases.push(viaMerge);
      continue;
    }
    bases.push(sha);
  }

  if (bases.length === 0) {
    // No shared history with the chain — fall back to the root commit.
    const { stdout } = await git(['rev-list', '--max-parents=0', branch], { cwd: repoPath });
    return stdout.trim().split('\n')[0] ?? branch;
  }

  const candidates = [...new Set(bases)].filter((b) => b !== tip);

  // Merged into every chain branch: there is genuinely nothing outstanding, and
  // an empty range says so honestly.
  if (candidates.length === 0) return tip;
  if (candidates.length === 1) return candidates[0];

  // The most recent candidate is the one all the others are ancestors of.
  for (const candidate of candidates) {
    let isDescendantOfAll = true;
    for (const other of candidates) {
      if (other === candidate) continue;
      const res = await git(['merge-base', '--is-ancestor', other, candidate], {
        cwd: repoPath,
        allowFail: true,
      });
      if (res.code !== 0) {
        isDescendantOfAll = false;
        break;
      }
    }
    if (isDescendantOfAll) return candidate;
  }

  // Candidates sit on unrelated lines; their common ancestor is the safe answer.
  const res = await git(['merge-base', '--octopus', ...candidates], { cwd: repoPath, allowFail: true });
  const octopus = res.stdout.trim();
  return res.code === 0 && octopus ? octopus : candidates[candidates.length - 1];
}
