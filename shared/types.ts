/** Types shared between the Express API and the React client. */

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
}

export interface CommitInfo {
  sha: string;
  short: string;
  author: string;
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

export interface TicketGroup {
  /** Upper-cased ticket id, or null for the Ungrouped bucket. */
  ticket: string | null;
  label: string;
  url: string | null;
  commits: ClassifiedCommit[];
  /** Keyed by target branch name. */
  summary: Record<string, GroupTargetSummary>;
}

export interface ReleaseMatrix {
  repoId: string;
  branch: string;
  targets: string[];
  base: string;
  groups: TicketGroup[];
  /** Per-target ticket counts for the progress bars. */
  progress: Record<string, { releasedTickets: number; totalTickets: number }>;
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
