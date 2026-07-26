import { useState } from 'react';
import { api } from '../api.ts';
import { Person } from '../components/People.tsx';
import type { TicketLookup } from '../../../shared/types.ts';

/**
 * "Where is PAY-1042?"
 *
 * The matrix goes branch → tickets. This goes the other way, which is the
 * direction the question is usually asked in — QA doesn't know or care which
 * branch the work started on.
 */
export function FindTicket({ repoId, chain }: { repoId: string; chain: string[] }) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<TicketLookup | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await api.find(repoId, query.trim()));
    } catch (err) {
      setResult(null);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="find">
      <form className="find-bar" onSubmit={search}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Ticket id, e.g. PAY-1042"
          aria-label="Ticket id"
          spellCheck={false}
        />
        <button className="primary" type="submit" disabled={busy || !query.trim()}>
          {busy ? 'Searching…' : 'Find it'}
        </button>
      </form>

      {error && <p className="error-text">{error}</p>}

      {result && result.sightings.length === 0 && (
        <div className="empty">
          <p>
            Nothing mentions <strong>{result.ticket}</strong> on any local branch.
          </p>
          <p className="muted">
            It may not have been written yet, or a squash may have rewritten the subject and
            dropped the id.
          </p>
        </div>
      )}

      {result && result.sightings.length > 0 && (
        <>
          <section className="find-summary">
            <h3>{result.ticket}</h3>
            <div className="find-chain">
              {(chain.length ? chain : Object.keys(result.chainStatus)).map((branch) => (
                <span
                  key={branch}
                  className={`chip ${result.chainStatus[branch] ? 'tone-released' : 'tone-pending'}`}
                >
                  {result.chainStatus[branch] ? '✔' : '○'} {branch}
                </span>
              ))}
            </div>
            {result.sourceBranches.length > 0 && (
              <p className="muted small">
                Work lives on {result.sourceBranches.map((b) => <code key={b}>{b}</code>).map((el, i) => (
                  <span key={i}>{i > 0 && ', '}{el}</span>
                ))}
              </p>
            )}
          </section>

          <table className="find-table">
            <thead>
              <tr>
                <th>Commit</th>
                <th>Author</th>
                <th>Where</th>
              </tr>
            </thead>
            <tbody>
              {result.sightings.map((s) => (
                <tr key={s.commit.sha}>
                  <td>
                    <code className="sha">{s.commit.short}</code> {s.commit.subject}
                    {s.isCopy && (
                      <span
                        className="chip tone-traced"
                        title={`Cherry-picked copy of ${s.copiedFrom ?? 'another commit'}`}
                      >
                        copy
                      </span>
                    )}
                  </td>
                  <td>
                    <Person name={s.commit.author} email={s.commit.authorEmail} />
                  </td>
                  <td className="muted small">
                    {s.onChain.map((b) => (
                      <span key={b} className="chip tone-released">
                        {b}
                      </span>
                    ))}
                    {s.ownedBy.map((b) => (
                      <span key={b} className="chip tone-pending" title="Where this commit was written">
                        {b}
                      </span>
                    ))}
                    {s.onChain.length === 0 && s.ownedBy.length === 0 && (
                      <span title={s.branches.join(', ')}>
                        {s.branches.length === 0 ? '—' : `${s.branches.length} branches`}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {result.truncated && (
            <p className="warn-text small">Showing the most recent matches only.</p>
          )}
          <p className="muted small">
            Found by searching commit messages, so every cherry-picked copy shows up too. A squash
            that rewrote the subject and dropped the id would be missed — the release matrix
            catches those.
          </p>
        </>
      )}
    </div>
  );
}
