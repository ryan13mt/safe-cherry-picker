import { Fragment, useEffect, useMemo, useState } from 'react';
import type { ReleaseMatrix as Matrix, SimulationResult, TicketGroup } from '../../../shared/types.ts';
import { statusLook, groupStateLook, ticketColour } from '../status.tsx';
import { CommitGraph } from '../components/CommitGraph.tsx';

/**
 * The core screen: what of this branch has shipped, ticket by ticket, and what
 * is still outstanding on each promotion branch.
 */

function ProgressBar({ done, total }: { done: number; total: number }) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div className="progress" title={`${done} of ${total} tickets`}>
      <div className="progress-fill" style={{ width: `${pct}%` }} />
      <span className="progress-label">
        {done}/{total} tickets
      </span>
    </div>
  );
}

/**
 * Default to the first branch that still has outstanding tickets. Defaulting to
 * targets[0] means landing on the branch the work was merged into, where every
 * checkbox is disabled and the screen looks broken.
 */
function defaultTarget(matrix: Matrix): string {
  const withWork = matrix.targets.find((t) => {
    const p = matrix.progress[t];
    return p && p.releasedTickets < p.totalTickets;
  });
  return withWork ?? matrix.targets[0] ?? '';
}

export function ReleaseMatrixView({
  matrix,
  branches,
  onBranchChange,
  onCherryPick,
  simulate,
}: {
  matrix: Matrix;
  branches: string[];
  onBranchChange: (branch: string) => void;
  onCherryPick: (target: string, commits: string[], simulation: SimulationResult | null) => void;
  simulate: (target: string, commits: string[]) => Promise<SimulationResult>;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState<string>(() => defaultTarget(matrix));
  const [sim, setSim] = useState<SimulationResult | null>(null);
  const [simBusy, setSimBusy] = useState(false);

  // Only fires when the branch or target set changes, so a deliberate choice of
  // destination survives the refresh that follows an operation.
  useEffect(() => {
    setSelected(new Set());
    setSim(null);
    setTarget(defaultTarget(matrix));
  }, [matrix.branch, matrix.targets.join(',')]);

  const selectedList = useMemo(() => [...selected], [selected]);

  // Re-simulate whenever the selection or the destination changes: the answer to
  // "will this conflict?" depends on both.
  useEffect(() => {
    if (selectedList.length === 0 || !target) {
      setSim(null);
      return;
    }
    let cancelled = false;
    setSimBusy(true);
    const timer = setTimeout(() => {
      simulate(target, selectedList)
        .then((r) => !cancelled && setSim(r))
        .catch(() => !cancelled && setSim(null))
        .finally(() => !cancelled && setSimBusy(false));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [selectedList.join(','), target]);

  const toggleGroup = (group: TicketGroup) => {
    const actionable = group.summary[target]?.missing ?? [];
    const next = new Set(selected);
    const allOn = actionable.length > 0 && actionable.every((s) => next.has(s));
    for (const sha of actionable) {
      if (allOn) next.delete(sha);
      else next.add(sha);
    }
    setSelected(next);
  };

  const toggleCommit = (sha: string) => {
    const next = new Set(selected);
    next.has(sha) ? next.delete(sha) : next.add(sha);
    setSelected(next);
  };

  const toggleExpand = (key: string) => {
    const next = new Set(expanded);
    next.has(key) ? next.delete(key) : next.add(key);
    setExpanded(next);
  };

  const allCommits = matrix.groups.flatMap((g) => g.commits);

  return (
    <div className="matrix-view">
      <div className="matrix-toolbar">
        <label>
          Branch
          <select value={matrix.branch} onChange={(e) => onBranchChange(e.target.value)}>
            {branches.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
        <span className="muted">
          {allCommits.length} commits in {matrix.groups.length} tickets since{' '}
          <code>{matrix.base.slice(0, 7)}</code>
        </span>
        {matrix.truncated && (
          <span className="warn-text">Truncated — branch exceeds the configured commit cap.</span>
        )}
      </div>

      {matrix.targets.length === 0 ? (
        <div className="empty">
          <p>No promotion branches to compare against.</p>
        </div>
      ) : (
        <>
          <table className="matrix">
            <thead>
              <tr>
                <th className="col-select"></th>
                <th className="col-ticket">Ticket</th>
                {matrix.targets.map((t) => (
                  <th key={t} className="col-target">
                    <div className="target-head">
                      <span>{t}</span>
                      <ProgressBar
                        done={matrix.progress[t]?.releasedTickets ?? 0}
                        total={matrix.progress[t]?.totalTickets ?? 0}
                      />
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.groups.map((group) => {
                const key = group.ticket ?? '__ungrouped__';
                const isOpen = expanded.has(key);
                const actionable = group.summary[target]?.missing ?? [];
                const allOn = actionable.length > 0 && actionable.every((s) => selected.has(s));
                const someOn = actionable.some((s) => selected.has(s));

                return (
                  <Fragment key={key}>
                    <tr className="group-row">
                      <td className="col-select">
                        <input
                          type="checkbox"
                          checked={allOn}
                          ref={(el) => {
                            if (el) el.indeterminate = !allOn && someOn;
                          }}
                          disabled={actionable.length === 0}
                          onChange={() => toggleGroup(group)}
                          aria-label={`Select unreleased commits in ${group.label}`}
                        />
                      </td>
                      <td className="col-ticket">
                        <button className="expander" onClick={() => toggleExpand(key)}>
                          {isOpen ? '▾' : '▸'}
                        </button>
                        <span
                          className="ticket-chip"
                          style={{ borderColor: ticketColour(group.ticket) }}
                        >
                          {group.url ? (
                            <a href={group.url} target="_blank" rel="noreferrer">
                              {group.label}
                            </a>
                          ) : (
                            group.label
                          )}
                        </span>
                        <span className="muted">
                          {group.commits.length} commit{group.commits.length === 1 ? '' : 's'}
                        </span>
                      </td>
                      {matrix.targets.map((t) => {
                        const summary = group.summary[t];
                        const look = groupStateLook(summary?.state ?? 'pending');
                        return (
                          <td key={t} className="col-target">
                            <span className={`chip tone-${look.tone}`} title={look.title}>
                              {look.glyph} {look.label}
                            </span>
                            {summary?.state === 'partial' && (
                              <span className="muted small">
                                {summary.releasedCount}/{summary.total}
                              </span>
                            )}
                          </td>
                        );
                      })}
                    </tr>

                    {isOpen &&
                      group.commits.map((c) => (
                        <tr key={c.commit.sha} className="commit-row">
                          <td className="col-select">
                            <input
                              type="checkbox"
                              checked={selected.has(c.commit.sha)}
                              disabled={Boolean(c.status[target]?.released)}
                              onChange={() => toggleCommit(c.commit.sha)}
                              aria-label={`Select ${c.commit.short}`}
                            />
                          </td>
                          <td className="col-ticket commit-cell">
                            <code className="sha">{c.commit.short}</code>
                            <span>{c.commit.subject}</span>
                            {c.ticketSource === 'branch' && (
                              <span className="muted small" title="Ticket inferred from the branch name">
                                via branch
                              </span>
                            )}
                            {c.commit.isMerge && (
                              <span className="muted small" title="Merge commits cannot be cherry-picked">
                                merge
                              </span>
                            )}
                          </td>
                          {matrix.targets.map((t) => {
                            const look = statusLook(c.status[t]);
                            return (
                              <td key={t} className="col-target">
                                <span className={`chip tone-${look.tone}`} title={look.title}>
                                  {look.glyph} {look.label}
                                </span>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>

          <div className="action-bar">
            <label>
              Cherry-pick into
              <select value={target} onChange={(e) => setTarget(e.target.value)}>
                {matrix.targets.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>

            <span className="selection-count">
              {selectedList.length} commit{selectedList.length === 1 ? '' : 's'} selected
            </span>

            {simBusy && <span className="muted">simulating…</span>}
            {!simBusy && sim && (
              <span className={sim.clean ? 'sim-inline good' : 'sim-inline bad'}>
                {sim.clean
                  ? '✓ simulated clean'
                  : `⚠ conflicts in ${sim.conflicts.length} file${sim.conflicts.length === 1 ? '' : 's'} (${sim.conflicts.slice(0, 3).join(', ')})`}
              </span>
            )}

            <button
              className="primary"
              disabled={selectedList.length === 0 || !target}
              onClick={() => onCherryPick(target, selectedList, sim)}
            >
              Cherry-pick into {target}
            </button>
          </div>

          <details className="graph-panel">
            <summary>Commit graph — tinted by ticket to show interleaving</summary>
            <CommitGraph commits={allCommits} targets={matrix.targets} />
          </details>
        </>
      )}
    </div>
  );
}
