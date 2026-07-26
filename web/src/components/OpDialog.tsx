import { useEffect, useState } from 'react';
import { CopyButton } from './CopyButton.tsx';
import type { SimulationResult } from '../../../shared/types.ts';

/**
 * Nothing runs until the user has seen the literal git commands. The preview is
 * the same argv the server will execute, rendered the way you'd type it.
 */

export interface OpPlan {
  title: string;
  summary: string;
  preview: string[];
  simulation?: SimulationResult;
  /** Shown when the operation offers an individual/squash choice. */
  styleChoice?: boolean;
  /** Markdown notes for a promotion, offered as a copy button. */
  releaseNotes?: string;
}

export function OpDialog({
  plan,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  plan: OpPlan;
  busy: boolean;
  error: string | null;
  onConfirm: (style: 'individual' | 'squash') => void;
  onCancel: () => void;
}) {
  const [style, setStyle] = useState<'individual' | 'squash'>('individual');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  const sim = plan.simulation;
  const conflicted = sim && !sim.clean;

  return (
    <div className="modal-backdrop" onClick={() => !busy && onCancel()}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h2>{plan.title}</h2>
        <p className="muted">{plan.summary}</p>

        {sim && (
          <div className={conflicted ? 'sim sim-bad' : 'sim sim-good'}>
            <strong>
              {conflicted
                ? `⚠ Conflicts in ${sim.conflicts.length} file${sim.conflicts.length === 1 ? '' : 's'}`
                : '✓ Simulated clean'}
            </strong>
            {conflicted ? (
              <>
                <p>
                  First failure at <code>{sim.failedAt?.short}</code> — {sim.failedAt?.subject}
                  {sim.applied.length > 0 && ` (${sim.applied.length} commit(s) applied before it)`}
                </p>
                <ul className="file-list">
                  {sim.conflicts.map((f) => (
                    <li key={f}>
                      <code>{f}</code>
                    </li>
                  ))}
                </ul>
                <p className="muted">
                  You can still run it — git will stop at the conflict and this app will walk you
                  through resolving it.
                </p>
              </>
            ) : (
              <p className="muted">
                Replayed against the real trees; every commit applies without conflict.
              </p>
            )}
            {sim.skippedMerges.length > 0 && (
              <p className="muted">
                Skipping {sim.skippedMerges.length} merge commit(s) — those can't be cherry-picked
                without choosing a mainline.
              </p>
            )}
            {sim.error && <p className="error-text">{sim.error}</p>}
          </div>
        )}

        {plan.styleChoice && (
          <fieldset className="style-choice">
            <legend>How should this land?</legend>
            <label>
              <input
                type="radio"
                name="style"
                checked={style === 'individual'}
                onChange={() => setStyle('individual')}
              />
              <span>
                <strong>Individual commits</strong>
                <em>Each pick recorded with -x, so it stays exactly traceable later.</em>
              </span>
            </label>
            <label>
              <input
                type="radio"
                name="style"
                checked={style === 'squash'}
                onChange={() => setStyle('squash')}
              />
              <span>
                <strong>Squash into one</strong>
                <em>
                  Cleaner history, but per-commit tracing is lost — future runs fall back to the
                  low-confidence squash heuristic.
                </em>
              </span>
            </label>
          </fieldset>
        )}

        <div className="preview">
          <h3>
            Commands to run
            <span className="preview-actions">
              <CopyButton text={plan.preview.join('\n')} label="Copy commands" />
              {plan.releaseNotes && (
                <CopyButton
                  text={plan.releaseNotes}
                  label="Copy release notes"
                  title="Markdown summary of every ticket in this promotion"
                />
              )}
            </span>
          </h3>
          <pre>
            {plan.preview.map((line) => (
              <div key={line}>{line}</div>
            ))}
          </pre>
          <p className="muted">
            Runs in a disposable worktree; your checkout and uncommitted work are untouched. Nothing
            is pushed.
          </p>
        </div>

        {error && <p className="error-text">{error}</p>}

        <div className="modal-actions">
          <button className="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="primary" onClick={() => onConfirm(style)} disabled={busy}>
            {busy ? 'Running…' : conflicted ? 'Run anyway' : 'Run it'}
          </button>
        </div>
      </div>
    </div>
  );
}
