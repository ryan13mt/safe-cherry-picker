import { Fragment, useEffect, useMemo, useState } from 'react';
import type {
  GroupTargetSummary,
  ReleaseMatrix as Matrix,
  SimulationResult,
  TicketDependency,
  TicketGroup,
} from '../../../shared/types.ts';
import { statusLook, groupStateLook, ticketColour } from '../status.tsx';
import { CommitGraph } from '../components/CommitGraph.tsx';
import { People, Authorship } from '../components/People.tsx';

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
/**
 * A dependency only matters if the ticket it points at isn't already on the
 * branch you're picking into — that's the difference between "these two were
 * written together" and "this pick will break".
 */
function unmetDependencies(matrix: Matrix, group: TicketGroup, target: string) {
  const stateOf = (ticket: string | null) =>
    matrix.groups.find((g) => g.ticket === ticket)?.summary[target]?.state;
  return group.dependsOn.filter((dep) => {
    const state = stateOf(dep.ticket);
    // Unknown means the dependency isn't on this branch at all, so it counts.
    return state !== 'released';
  });
}

function DependencyNote({ deps, target }: { deps: TicketDependency[]; target: string }) {
  if (deps.length === 0) return null;
  const hard = deps.filter((d) => d.strength === 'hard');
  return (
    <span
      className={hard.length ? 'chip tone-partial' : 'chip tone-likely'}
      title={deps
        .map((d) =>
          [
            `${d.label} — ${d.strength === 'hard' ? 'required' : 'heavy overlap'}`,
            ...d.reasons.map((r) =>
              r.kind === 'creates-file'
                ? `  ${r.path}: created by ${d.label}`
                : `  ${r.path}: ${Math.round(r.share * 100)}% of changes are ${d.label}'s (${r.otherLines} lines)`,
            ),
          ].join('\n'),
        )
        .join('\n\n')}
    >
      {hard.length ? '⚠ needs' : '~ overlaps'} {deps.map((d) => d.label).join(', ')}
      {` (not on ${target})`}
    </span>
  );
}

function waitLabel(days: number): string {
  if (days === 0) return 'today';
  if (days === 1) return '1 day';
  if (days < 60) return `${days} days`;
  return `${Math.round(days / 30)} months`;
}

/** How long this ticket has been waiting to reach the chosen branch. */
function Waiting({ summary, target }: { summary?: GroupTargetSummary; target: string }) {
  if (!summary?.waitingDays || summary.state === 'released') return null;
  return (
    <span
      className={summary.stale ? 'chip tone-partial' : 'muted small'}
      title={
        `Oldest unreleased commit was written ${new Date(summary.waitingSince!).toLocaleDateString()}.` +
        (summary.stale ? `\nPast the staleAfterDays threshold — it has missed a release cycle.` : '')
      }
    >
      {summary.stale ? '⏳ ' : ''}
      waiting {waitLabel(summary.waitingDays)} for {target}
    </span>
  );
}

/** "5 files · +120 −30", from churn the dependency analysis already computed. */
function DiffStat({ group }: { group: TicketGroup }) {
  if (group.files.length === 0) return null;
  const added = group.files.reduce((n, f) => n + f.added, 0);
  const removed = group.files.reduce((n, f) => n + f.removed, 0);
  return (
    <span
      className="muted small diffstat"
      title={group.files
        .map((f) => `${f.path}  +${f.added} −${f.removed}${f.created ? '  (new)' : f.deleted ? '  (deleted)' : ''}`)
        .join('\n')}
    >
      {group.files.length} file{group.files.length === 1 ? '' : 's'}
      <span className="stat-add"> +{added}</span>
      <span className="stat-del"> −{removed}</span>
    </span>
  );
}

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
  blocked,
  onBranchChange,
  onCherryPick,
  simulate,
}: {
  matrix: Matrix;
  branches: string[];
  /** Uncommitted changes present: the matrix still renders, actions are not offered. */
  blocked: boolean;
  onBranchChange: (branch: string) => void;
  onCherryPick: (target: string, commits: string[], simulation: SimulationResult | null) => void;
  simulate: (target: string, commits: string[]) => Promise<SimulationResult>;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState<string>(() => defaultTarget(matrix));
  const [filter, setFilter] = useState('');
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

  const stale = matrix.groups.filter((g) => g.summary[target]?.stale);
  const staleCount = stale.length;
  const oldestWait = stale.reduce<number | undefined>(
    (max, g) => Math.max(max ?? 0, g.summary[target]?.waitingDays ?? 0),
    undefined,
  );

  const needle = filter.trim().toLowerCase();
  const visibleGroups = needle
    ? matrix.groups.filter(
        (g) =>
          g.label.toLowerCase().includes(needle) ||
          g.commits.some((c) => c.commit.subject.toLowerCase().includes(needle)),
      )
    : matrix.groups;

  // Dependencies of the tickets actually selected — the ones about to bite.
  const selectedGroups = matrix.groups.filter((g) =>
    g.commits.some((c) => selected.has(c.commit.sha)),
  );
  const selectedTickets = new Set(selectedGroups.map((g) => g.ticket));
  const blockingDeps = selectedGroups
    .flatMap((g) => unmetDependencies(matrix, g, target))
    // A dependency you're picking at the same time isn't a problem.
    .filter((d) => !selectedTickets.has(d.ticket));

  /** Ticks the outstanding commits of everything the selection depends on. */
  const addRequiredTickets = () => {
    const next = new Set(selected);
    for (const dep of blockingDeps) {
      const group = matrix.groups.find((g) => g.ticket === dep.ticket);
      for (const sha of group?.summary[target]?.missing ?? []) next.add(sha);
    }
    setSelected(next);
  };

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
        <input
          className="matrix-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by ticket or subject"
          aria-label="Filter tickets"
        />
        <span className="muted">
          {needle
            ? `${visibleGroups.length} of ${matrix.groups.length} tickets`
            : `${allCommits.length} commits in ${matrix.groups.length} tickets`}{' '}
          since <code>{matrix.base.slice(0, 7)}</code>
        </span>
        <Authorship authorship={matrix.authorship} />
        {matrix.truncated && (
          <span className="warn-text">Truncated — branch exceeds the configured commit cap.</span>
        )}
      </div>

      {staleCount > 0 && (
        <p className="stale-summary">
          <span className="chip tone-partial">⏳ {staleCount} stale</span>
          <span className="muted small">
            {staleCount === 1 ? 'ticket has' : 'tickets have'} been waiting more than a release
            cycle to reach <strong>{target}</strong>
            {oldestWait !== undefined && ` — the longest for ${waitLabel(oldestWait)}`}.
          </span>
        </p>
      )}

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
              {visibleGroups.map((group) => {
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
                        <DiffStat group={group} />
                        <People people={group.authors} max={2} />
                        <Waiting summary={group.summary[target]} target={target} />
                        <DependencyNote deps={unmetDependencies(matrix, group, target)} target={target} />
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

                    {isOpen && group.dependsOn.length > 0 && (
                      <tr className="commit-row dep-row">
                        <td></td>
                        <td colSpan={matrix.targets.length + 1}>
                          <div className="dep-detail">
                            {group.dependsOn.map((dep) => (
                              <div key={dep.label}>
                                <strong>
                                  {dep.strength === 'hard' ? 'Requires' : 'Overlaps with'} {dep.label}
                                </strong>
                                <ul>
                                  {dep.reasons.map((r) => (
                                    <li key={r.path}>
                                      <code>{r.path}</code>{' '}
                                      {r.kind === 'creates-file' ? (
                                        <>created by {dep.label}</>
                                      ) : (
                                        <>
                                          {Math.round(r.share * 100)}% of the changed lines are{' '}
                                          {dep.label}'s ({r.otherLines} vs {r.ourLines})
                                        </>
                                      )}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}

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

            {blockingDeps.length > 0 && (
              <span
                className={
                  blockingDeps.some((d) => d.strength === 'hard') ? 'sim-inline bad' : 'sim-inline warn-text'
                }
                title={blockingDeps
                  .flatMap((d) => d.reasons.map((r) => `${r.path} — ${d.label}`))
                  .join('\n')}
              >
                {blockingDeps.some((d) => d.strength === 'hard') ? '⚠ needs' : '~ overlaps'}{' '}
                {[...new Set(blockingDeps.map((d) => d.label))].join(', ')} first
              </span>
            )}

            {blockingDeps.length > 0 && (
              <button className="ghost small" onClick={addRequiredTickets}>
                Add {[...new Set(blockingDeps.map((d) => d.label))].join(', ')}
              </button>
            )}

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
              disabled={selectedList.length === 0 || !target || blocked}
              title={blocked ? 'Blocked: the repository has uncommitted changes' : undefined}
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
