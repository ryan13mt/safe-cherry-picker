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
  /** Commits already applied in this operation. */
  done?: string[];
  remaining?: string[];
  message?: string;
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
