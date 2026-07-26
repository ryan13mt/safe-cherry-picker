import { useState } from 'react';
import { Authorship } from '../components/People.tsx';
import type { BranchReport, BranchSafety, CleanupReport } from '../../../shared/types.ts';

/**
 * Branches whose work has finished, so they can be cleared away.
 *
 * `git branch --merged` only understands ancestry, so it misses everything that
 * shipped by cherry-pick. This uses the release classifier instead, and is
 * explicit about how strong each verdict is — deleting on the strength of a
 * squash guess is exactly the mistake worth avoiding.
 */

const SAFETY: Record<BranchSafety, { label: string; tone: string; blurb: string }> = {
  merged: {
    label: 'merged',
    tone: 'released',
    blurb: 'Every commit is an ancestor of the target branch. Nothing can be lost.',
  },
  picked: {
    label: 'released by pick',
    tone: 'traced',
    blurb:
      'Every commit has shipped, some by cherry-pick rather than merge. Git will not delete these without a force flag, because it only checks ancestry.',
  },
  likely: {
    label: 'probably shipped',
    tone: 'likely',
    blurb:
      'Full coverage relies on a squash or subject match, which is a guess. Check by hand — the app will not delete these.',
  },
  unreleased: {
    label: 'still outstanding',
    tone: 'partial',
    blurb: 'Has commits that have not reached any promotion branch.',
  },
  skipped: {
    label: 'not applicable',
    tone: 'pending',
    blurb: 'Chain branches and anything currently checked out.',
  },
};

const ORDER: BranchSafety[] = ['merged', 'picked', 'likely', 'unreleased', 'skipped'];

function age(days: number): string {
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 60) return `${days} days ago`;
  return `${Math.round(days / 30)} months ago`;
}

function Row({
  branch,
  busy,
  onDelete,
}: {
  branch: BranchReport;
  busy: boolean;
  onDelete: (name: string) => void;
}) {
  const deletable = branch.safety === 'merged' || branch.safety === 'picked';
  return (
    <tr>
      <td className="cleanup-name">
        <code>{branch.name}</code>
        {branch.releasedTo && <span className="muted small">on {branch.releasedTo}</span>}
      </td>
      <td className="muted small">
        <code className="sha">{branch.short}</code> {branch.lastCommitSubject}
      </td>
      <td className="cleanup-people">
        {branch.authorship.startedBy ? (
          <Authorship authorship={branch.authorship} />
        ) : (
          <span className="muted small">—</span>
        )}
      </td>
      <td className="muted small">{age(branch.ageDays)}</td>
      <td className="muted small">
        {branch.safety === 'unreleased'
          ? `${branch.unreleasedCount} of ${branch.totalCommits} outstanding`
          : (branch.note ?? (branch.weakestMethod === 'merged' ? 'ancestry' : branch.weakestMethod))}
      </td>
      <td>
        {deletable && (
          <button
            className="ghost small"
            disabled={busy}
            onClick={() => onDelete(branch.name)}
            title={
              branch.fastDelete
                ? 'git branch -d — git verifies it is merged'
                : 'git branch -D — needed because it shipped by cherry-pick, not by merge'
            }
          >
            Delete
          </button>
        )}
      </td>
    </tr>
  );
}

export function CleanupView({
  report,
  busy,
  onDelete,
}: {
  report: CleanupReport;
  busy: boolean;
  onDelete: (name: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);

  const groups = ORDER.map((safety) => ({
    safety,
    branches: report.branches.filter((b) => b.safety === safety),
  })).filter((g) => g.branches.length > 0);

  const visible = showAll
    ? groups
    : groups.filter((g) => g.safety !== 'unreleased' && g.safety !== 'skipped');

  const deletableCount = report.branches.filter(
    (b) => b.safety === 'merged' || b.safety === 'picked',
  ).length;

  return (
    <div className="cleanup">
      <div className="cleanup-head">
        <p>
          {deletableCount === 0
            ? 'No branches are finished yet.'
            : `${deletableCount} branch${deletableCount === 1 ? '' : 'es'} have shipped and can be removed.`}
        </p>
        <button className="ghost small" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Hide' : 'Show'} everything else
        </button>
      </div>

      {report.truncated && (
        <p className="warn-text small">
          Too many branches to classify them all; some are listed without a verdict.
        </p>
      )}

      {visible.map(({ safety, branches }) => (
        <section key={safety} className="cleanup-group">
          <h3>
            <span className={`chip tone-${SAFETY[safety].tone}`}>{SAFETY[safety].label}</span>
            <span className="muted small">{branches.length}</span>
          </h3>
          <p className="muted small">{SAFETY[safety].blurb}</p>
          <table className="cleanup-table">
            <tbody>
              {branches.map((b) => (
                <Row key={b.name} branch={b} busy={busy} onDelete={onDelete} />
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
