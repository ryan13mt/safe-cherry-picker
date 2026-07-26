import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.ts';
import { CopyButton } from './CopyButton.tsx';
import type { GitCommandRecord } from '../../../shared/types.ts';

/**
 * Every git command the app has run, newest first.
 *
 * This app moves branches on your behalf, so being able to see exactly what it
 * executed — with exit codes and timings — is the difference between trusting it
 * and hoping. The server has recorded this all along; this just shows it.
 */
export function CommandLog() {
  const [records, setRecords] = useState<GitCommandRecord[] | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .commands()
      .then((r) => {
        setRecords(r);
        setError(null);
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  // Only fetch while the drawer is open; refresh whenever it is reopened.
  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const asText = (records ?? [])
    .map((r) => `git ${r.args.join(' ')}`)
    .join('\n');

  return (
    <details className="command-log" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Command log — every git command this app has run</summary>

      <div className="command-log-bar">
        <button className="ghost small" onClick={load}>
          Refresh
        </button>
        {records && records.length > 0 && <CopyButton text={asText} label="Copy all" />}
        <span className="muted small">
          {records ? `${records.length} most recent` : 'loading…'}
        </span>
      </div>

      {error && <p className="error-text">{error}</p>}

      {records && records.length === 0 && (
        <p className="muted">Nothing yet — it fills up as the app reads and writes.</p>
      )}

      {records && records.length > 0 && (
        <div className="command-scroll">
          <table className="command-table">
            <tbody>
              {records.map((r, i) => (
                <tr key={`${r.at}-${i}`} className={r.code === 0 ? '' : 'command-failed'}>
                  <td className="command-time muted">{new Date(r.at).toLocaleTimeString()}</td>
                  <td className="command-args">
                    <code>git {r.args.join(' ')}</code>
                  </td>
                  <td className="command-meta muted">
                    {r.ms}ms
                    {r.code !== 0 && <span className="error-text"> · exit {r.code}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}
