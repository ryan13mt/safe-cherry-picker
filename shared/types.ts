/** Types shared between the Express API and the React client. */

export interface DirEntry {
  name: string;
  path: string;
  /** Contains a .git, so choosing the parent would pick this up. */
  isRepo: boolean;
}

export interface BrowseResult {
  path: string;
  /** Null at a filesystem root. */
  parent: string | null;
  entries: DirEntry[];
  /** Drive roots, on Windows. Empty elsewhere. */
  drives: string[];
  /** The directory exists but could not be read (permissions). */
  unreadable: boolean;
  /** Useful starting points: home, and the current scan root. */
  suggestions: { label: string; path: string }[];
}

export interface ScanInfo {
  scanRoot: string;
  repoCount: number;
  /** The scan hit its directory budget, so some repos may be missing. */
  truncated: boolean;
  visited: number;
}

export interface WorkingTreeStatus {
  dirty: boolean;
  /** Tracked files with staged or unstaged modifications. */
  tracked: string[];
  untracked: string[];
  /** The lists were capped; `count` is the real total. */
  truncated: boolean;
  count: number;
}

export interface RepoSummary {
  id: string;
  name: string;
  path: string;
  /** Chain branches from the config that actually exist in this repo, in chain order. */
  chain: string[];
  /** Chain branches from the config that are missing here. */
  missingChain: string[];
  currentBranch: string | null;
  dirty: boolean;
  uncommitted: WorkingTreeStatus;
  /**
   * Set when the working tree is dirty enough to block new operations, per the
   * `blockOnDirty` setting. Read-only views stay available.
   */
  blocked: boolean;
  blockedReason?: string;
}

export interface Person {
  name: string;
  email: string;
}

export interface Contributor extends Person {
  commits: number;
}

export interface CommitInfo {
  sha: string;
  short: string;
  author: string;
  /** Kept alongside the name so identities dedupe even when names vary. */
  authorEmail: string;
  date: string;
  subject: string;
  body: string;
  parents: string[];
  /** True when the commit has more than one parent; these cannot be cherry-picked plainly. */
  isMerge: boolean;
}

export interface PipelineLeg {
  /** Work flows from `upstream` into `downstream` on promotion. */
  upstream: string;
  downstream: string;
  /** Commits in upstream that downstream does not have — the promotion payload. */
  ahead: CommitInfo[];
  /** Commits in downstream that upstream lacks — needs a back-merge. */
  behind: CommitInfo[];
}

export interface PipelineReport {
  chain: string[];
  legs: PipelineLeg[];
  generatedAt: string;
}

export type ReleaseMethod =
  | 'merged'
  | 'traced'
  | 'patch-id'
  | 'squashed'
  | 'subject'
  | 'none';

export type Confidence = 'exact' | 'high' | 'low' | 'none';

export interface ReleaseStatus {
  method: ReleaseMethod;
  confidence: Confidence;
  released: boolean;
  /** The commit on the target branch that evidences the release, when known. */
  evidenceSha?: string;
  evidenceShort?: string;
  note?: string;
}

export interface ClassifiedCommit {
  commit: CommitInfo;
  ticket: string | null;
  ticketSource: 'subject' | 'branch' | null;
  /** Keyed by target branch name. */
  status: Record<string, ReleaseStatus>;
}

export type GroupState = 'released' | 'partial' | 'likely' | 'pending';

export interface GroupTargetSummary {
  state: GroupState;
  releasedCount: number;
  likelyCount: number;
  pendingCount: number;
  total: number;
  /** SHAs still missing from this target — the actionable set. */
  missing: string[];
}

export interface TicketFileStat {
  path: string;
  added: number;
  removed: number;
  /** This ticket added the file. */
  created: boolean;
  deleted: boolean;
}

export interface TicketDependency {
  /** The ticket being depended upon. */
  ticket: string | null;
  label: string;
  reasons: {
    path: string;
    /**
     * `creates-file`   — the other ticket added this file; picking without it
     *                    cannot work.
     * `dominant-churn` — the other ticket wrote most of the changed lines here.
     */
    kind: 'creates-file' | 'dominant-churn';
    /** The other ticket's share of changed lines in this file, 0–1. */
    share: number;
    otherLines: number;
    ourLines: number;
  }[];
  /** `hard` when a file would be missing entirely; `soft` when it is heavy overlap. */
  strength: 'hard' | 'soft';
}

export interface TicketGroup {
  /** Upper-cased ticket id, or null for the Ungrouped bucket. */
  ticket: string | null;
  label: string;
  url: string | null;
  commits: ClassifiedCommit[];
  /** Keyed by target branch name. */
  summary: Record<string, GroupTargetSummary>;
  /** Files this ticket touches, biggest churn first. */
  files: TicketFileStat[];
  /** Tickets this one builds on, hard dependencies first. */
  dependsOn: TicketDependency[];
  /** Who wrote this ticket's commits, most prolific first. */
  authors: Contributor[];
}

/**
 * Who worked on a branch.
 *
 * Note `startedBy`: git records nothing about branch *creation*, so this is the
 * author of the branch's oldest own commit — a proxy, and the only one that
 * survives a clone. (Reflogs know who typed `git checkout -b`, but they are
 * local-only and would be wrong for everyone else.)
 */
export interface BranchAuthorship {
  startedBy?: Person & { date: string; sha: string; short: string };
  contributors: Contributor[];
}

export interface ReleaseMatrix {
  repoId: string;
  branch: string;
  targets: string[];
  base: string;
  /** Who started and worked on this branch. */
  authorship: BranchAuthorship;
  groups: TicketGroup[];
  /** Per-target ticket counts for the progress bars. */
  progress: Record<string, { releasedTickets: number; totalTickets: number }>;
  truncated: boolean;
  generatedAt: string;
}

/**
 * How completely a branch's work has reached the promotion chain.
 *  merged     — every commit is an ancestor of a chain branch. Exact.
 *  picked     — every commit is released, some only by cherry-pick. High confidence.
 *  likely     — full coverage needs a squash/subject guess. Verify by hand.
 *  unreleased — has work that hasn't shipped.
 *  skipped    — can't be evaluated or deleted (checked out, or a chain branch).
 */
export type BranchSafety = 'merged' | 'picked' | 'likely' | 'unreleased' | 'skipped';

export interface BranchReport {
  name: string;
  tip: string;
  short: string;
  lastCommitDate: string;
  lastCommitAuthor: string;
  lastCommitSubject: string;
  /** Days since the last commit, for spotting stale branches. */
  ageDays: number;
  safety: BranchSafety;
  /** The most downstream chain branch it is fully released to. */
  releasedTo?: string;
  /** How the weakest commit was matched, so "picked" vs "merged" is explainable. */
  weakestMethod?: ReleaseMethod;
  totalCommits: number;
  unreleasedCount: number;
  /** Who started the branch and who worked on it. */
  authorship: BranchAuthorship;
  /** git's own `branch -d` would accept it; no force needed. */
  fastDelete: boolean;
  /** Present when the branch can't be acted on. */
  note?: string;
}

export interface CleanupReport {
  chain: string[];
  branches: BranchReport[];
  /** Classification stopped early because there were too many branches. */
  truncated: boolean;
  generatedAt: string;
}

export interface SimulationResult {
  target: string;
  clean: boolean;
  /** Commits that were simulated, in the order they would be applied. */
  applied: string[];
  /** First commit that failed to apply cleanly, if any. */
  failedAt?: { sha: string; short: string; subject: string };
  conflicts: string[];
  skippedMerges: string[];
  error?: string;
}

export interface GitCommandRecord {
  args: string[];
  cwd: string;
  code: number;
  ms: number;
  at: string;
}

export type OpKind = 'cherry-pick' | 'merge';

export interface OpStatus {
  /** An operation is in progress and waiting on conflict resolution. */
  inProgress: boolean;
  kind?: OpKind;
  target?: string;
  worktreePath?: string;
  conflicts: string[];
  /**
   * The paused commit turned out to be a no-op — its changes are already on the
   * target. It has to be skipped rather than resolved.
   */
  empty?: boolean;
  /**
   * Git has an operation in progress that the app has no record of. It can be
   * cleared, but not meaningfully continued — we don't know which branch it was
   * meant to advance.
   */
  orphaned?: boolean;
  /** Commits already applied in this operation. */
  done?: string[];
  remaining?: string[];
  message?: string;
}

export type ConflictKind = 'both-modified' | 'both-added' | 'deleted-by-us' | 'deleted-by-them';

export interface BlameLine {
  sha: string;
  short: string;
  author: string;
  /** ISO date of the authoring commit. */
  date: string;
  summary: string;
}

export interface ConflictHunk {
  startLine: number;
  endLine: number;
  contextBefore: string[];
  /** What the target branch already had. */
  ours: string[];
  /** Present only when the user's merge.conflictStyle includes the base (diff3). */
  base?: string[];
  /** What the incoming commit wants. */
  theirs: string[];
  contextAfter: string[];
  /** 1-based position of this block within each side's own file, when locatable. */
  oursStart?: number;
  theirsStart?: number;
  /** Per-line origin, aligned index-for-index with `ours` / `theirs`. */
  oursBlame?: BlameLine[];
  theirsBlame?: BlameLine[];
}

/** Where one side of a conflict comes from, for labelling the columns. */
export interface ConflictSide {
  /** Branch name, when one is known. */
  branch?: string;
  commit?: { sha: string; short: string; subject: string };
  /** Ready-to-display label, e.g. "stable" or "feature/PAY-1100 · a1b2c3d". */
  label: string;
}

export interface ConflictDetail {
  path: string;
  kind: ConflictKind;
  binary: boolean;
  truncated: boolean;
  base?: string;
  ours?: string;
  theirs?: string;
  /** Working-tree content, including git's conflict markers. */
  merged?: string;
  hunks: ConflictHunk[];
  /** The diff the incoming commit wanted to make to this file. */
  incomingDiff?: string;
}

export interface ConflictReport {
  inProgress: boolean;
  kind?: OpKind;
  target?: string;
  worktreePath?: string;
  /** The commit currently being applied, when one is identifiable. */
  incoming?: { sha: string; short: string; subject: string };
  /** Provenance of each column, so the UI can name them rather than say "ours". */
  ours?: ConflictSide;
  theirs?: ConflictSide;
  files: ConflictDetail[];
}

export interface OpResult {
  ok: boolean;
  /** Populated when dryRun is true, or alongside a real run, for the preview panel. */
  commands: string[][];
  status: OpStatus;
  /** New tip of the target branch after a successful run. */
  newHead?: string;
  previousHead?: string;
  message?: string;
}
