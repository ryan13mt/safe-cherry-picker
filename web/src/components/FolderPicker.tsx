import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import type { BrowseResult } from '../../../shared/types.ts';

/**
 * Picks the folder the app scans for repositories.
 *
 * The browser's own directory picker is no help: it returns an opaque handle
 * rather than a path, and the server needs a real path to run git in. So this
 * navigates directories the server lists, and also accepts a pasted path for
 * when you already know where you're going.
 */
export function FolderPicker({
  onCancel,
  onChoose,
}: {
  onCancel: () => void;
  onChoose: (path: string) => Promise<void>;
}) {
  const [view, setView] = useState<BrowseResult | null>(null);
  const [manual, setManual] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async (path?: string) => {
    setLoading(true);
    setError(null);
    try {
      const next = await api.browse(path);
      setView(next);
      setManual(next.path);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void go();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [saving, onCancel]);

  const choose = async (path: string) => {
    setSaving(true);
    setError(null);
    try {
      await onChoose(path);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const repoCount = view?.entries.filter((e) => e.isRepo).length ?? 0;

  return (
    <div className="modal-backdrop" onClick={() => !saving && onCancel()}>
      <div className="modal picker" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h2>Choose the folder to scan</h2>
        <p className="muted">
          Repositories inside this folder — up to three levels deep — appear in the repo list.
        </p>

        <div className="picker-bar">
          <button className="ghost small" disabled={!view?.parent || loading} onClick={() => go(view?.parent ?? undefined)}>
            ↑ Up
          </button>
          {view?.suggestions.map((s) => (
            <button key={s.path} className="chip-btn" onClick={() => go(s.path)} title={s.path}>
              {s.label}
            </button>
          ))}
          {view?.drives.map((d) => (
            <button key={d} className="chip-btn" onClick={() => go(d)}>
              {d}
            </button>
          ))}
        </div>

        <form
          className="picker-path"
          onSubmit={(e) => {
            e.preventDefault();
            void go(manual);
          }}
        >
          <input
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            spellCheck={false}
            aria-label="Folder path"
            placeholder="Paste or type a path"
          />
          <button className="ghost small" type="submit" disabled={loading}>
            Go
          </button>
        </form>

        <div className="picker-list">
          {loading ? (
            <p className="muted">Loading…</p>
          ) : view?.unreadable ? (
            <p className="error-text">This folder can't be read — check its permissions.</p>
          ) : view?.entries.length === 0 ? (
            <p className="muted">No subfolders here. You can still choose this folder.</p>
          ) : (
            <ul>
              {view?.entries.map((entry) => (
                <li key={entry.path}>
                  <button className="picker-entry" onClick={() => go(entry.path)}>
                    <span className="picker-icon">{entry.isRepo ? '◉' : '▸'}</span>
                    <span className="picker-name">{entry.name}</span>
                    {entry.isRepo && <span className="chip tone-traced">git repo</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {view && !loading && (
          <p className="muted small">
            {repoCount > 0
              ? `${repoCount} git ${repoCount === 1 ? 'repository' : 'repositories'} directly inside this folder.`
              : 'No git repositories directly inside this folder — there may still be some deeper down.'}
          </p>
        )}

        {error && <p className="error-text">{error}</p>}

        <div className="modal-actions">
          <button className="ghost" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
          <button
            className="primary"
            disabled={saving || loading || !view}
            onClick={() => view && choose(view.path)}
          >
            {saving ? 'Scanning…' : 'Use this folder'}
          </button>
        </div>
      </div>
    </div>
  );
}
