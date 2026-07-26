import { useState } from 'react';
import type { PipelineReport, CommitInfo, RemoteReport } from '../../../shared/types.ts';

/**
 * The promotion board. Each leg shows both directions, because the number that
 * quietly rots is the reverse one: commits sitting on a downstream branch (a
 * hotfix straight onto prod) that never made it back upstream.
 */

function CommitList({ commits }: { commits: CommitInfo[] }) {
  if (commits.length === 0) return <p className="muted">Nothing.</p>;
  return (
    <ul className="commit-list">
      {commits.map((c) => (
        <li key={c.sha}>
          <code className="sha">{c.short}</code>
          <span>{c.subject}</span>
          <span className="muted">{new Date(c.date).toLocaleDateString()}</span>
        </li>
      ))}
    </ul>
  );
}

export function PipelineView({
  report,
  blocked,
  remote,
  fetching,
  onFetch,
  onPromote,
  onBackMerge,
}: {
  report: PipelineReport;
  /** Uncommitted changes present: drift is still shown, actions are not offered. */
  blocked: boolean;
  remote: RemoteReport | null;
  fetching: boolean;
  onFetch: () => void;
  onPromote: (from: string, into: string) => void;
  onBackMerge: (from: string, into: string) => void;
}) {
  const blockedTitle = blocked ? 'Blocked: the repository has uncommitted changes' : undefined;
  const unpushed = remote?.branches.filter((b) => b.ahead > 0) ?? [];
  const [open, setOpen] = useState<string | null>(null);

  if (report.chain.length < 2) {
    return (
      <div className="empty">
        <p>
          This repo has fewer than two of the configured chain branches
          {report.chain.length ? ` (found: ${report.chain.join(', ')})` : ''}.
        </p>
        <p className="muted">Adjust "chain" in .gcprc.json to match this repo's branch names.</p>
      </div>
    );
  }

  return (
    <div className="pipeline">
      {remote?.hasRemote && (
        <div className="remote-bar">
          <span className="muted small">
            {unpushed.length === 0 ? (
              'Everything is pushed.'
            ) : (
              <>
                <strong className="warn-text">Not pushed:</strong>{' '}
                {unpushed.map((b) => `${b.branch} +${b.ahead}`).join(', ')}
              </>
            )}
            {remote.branches.some((b) => b.behind > 0) && (
              <>
                {' · '}
                <span className="warn-text">
                  behind: {remote.branches.filter((b) => b.behind > 0).map((b) => `${b.branch} −${b.behind}`).join(', ')}
                </span>
              </>
            )}
          </span>
          <span className="spacer" />
          <span className="muted small">
            {remote.lastFetchedAt
              ? `fetched ${new Date(remote.lastFetchedAt).toLocaleString()}`
              : 'never fetched — counts may be stale'}
          </span>
          <button className="ghost small" onClick={onFetch} disabled={fetching}>
            {fetching ? 'Fetching…' : 'Fetch'}
          </button>
        </div>
      )}

      {report.legs.map((leg) => {
        const aheadKey = `${leg.upstream}->${leg.downstream}`;
        const behindKey = `${leg.downstream}->${leg.upstream}`;
        return (
          <div className="leg" key={aheadKey}>
            <div className="stage">
              <h3>{leg.upstream}</h3>
            </div>

            <div className="arrows">
              <div className="arrow-row">
                <button
                  className={`badge ${leg.ahead.length ? 'badge-active' : ''}`}
                  onClick={() => setOpen(open === aheadKey ? null : aheadKey)}
                  disabled={leg.ahead.length === 0}
                >
                  ↑ {leg.ahead.length} to promote
                </button>
                <button
                  className="primary small"
                  disabled={leg.ahead.length === 0 || blocked}
                  title={blockedTitle}
                  onClick={() => onPromote(leg.upstream, leg.downstream)}
                >
                  Promote →
                </button>
              </div>

              <div className="arrow-row">
                <button
                  className={`badge ${leg.behind.length ? 'badge-warn' : ''}`}
                  onClick={() => setOpen(open === behindKey ? null : behindKey)}
                  disabled={leg.behind.length === 0}
                >
                  {leg.behind.length
                    ? `↓ ${leg.behind.length} behind — needs back-merge`
                    : '↓ 0 behind'}
                </button>
                <button
                  className="ghost small"
                  disabled={leg.behind.length === 0 || blocked}
                  title={blockedTitle}
                  onClick={() => onBackMerge(leg.downstream, leg.upstream)}
                >
                  ← Back-merge
                </button>
              </div>

              {open === aheadKey && (
                <div className="drawer">
                  <h4>
                    In {leg.upstream}, not in {leg.downstream}
                  </h4>
                  <CommitList commits={leg.ahead} />
                </div>
              )}
              {open === behindKey && (
                <div className="drawer drawer-warn">
                  <h4>
                    In {leg.downstream}, not in {leg.upstream}
                  </h4>
                  <p className="muted">
                    Usually a hotfix applied downstream. Until it is merged back, the next promotion
                    can silently revert it.
                  </p>
                  <CommitList commits={leg.behind} />
                </div>
              )}
            </div>

            <div className="stage">
              <h3>{leg.downstream}</h3>
            </div>
          </div>
        );
      })}
    </div>
  );
}
