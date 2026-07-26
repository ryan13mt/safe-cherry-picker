import { useMemo, useState } from 'react';
import type {
  BlameLine,
  ConflictDetail,
  ConflictHunk,
  ConflictReport,
} from '../../../shared/types.ts';

/**
 * Shows what is actually fighting, so a conflict can be understood without
 * dropping to a terminal: the incoming commit's intent, the conflicting regions
 * side by side, and a one-click way to take either side per file.
 */

const KIND_LABEL: Record<ConflictDetail['kind'], string> = {
  'both-modified': 'both sides changed this file',
  'both-added': 'both sides added this file independently',
  // Careful wording: git models "never existed here" and "was deleted here"
  // identically, and the first is the common case when a pick skips the commit
  // that created the file.
  'deleted-by-us': 'not on the target branch, but changed by the incoming commit',
  'deleted-by-them': 'on the target branch, but deleted by the incoming commit',
};

function DiffBlock({ diff }: { diff: string }) {
  return (
    <pre className="diff">
      {diff.split('\n').map((line, i) => {
        const cls = line.startsWith('+')
          ? 'diff-add'
          : line.startsWith('-')
            ? 'diff-del'
            : line.startsWith('@@')
              ? 'diff-hunk'
              : '';
        return (
          <div key={i} className={cls}>
            {line || ' '}
          </div>
        );
      })}
    </pre>
  );
}

function Side({
  label,
  sublabel,
  lines,
  blame,
  startLine,
  tone,
}: {
  label: string;
  sublabel?: string;
  lines: string[];
  blame?: BlameLine[];
  startLine?: number;
  tone: string;
}) {
  return (
    <div className={`side side-${tone}`}>
      <h5>
        <span className="side-role">{tone === 'base' ? 'base' : tone}</span>
        <span className="side-name">{label}</span>
        {sublabel && <span className="side-sub">{sublabel}</span>}
      </h5>
      <div className="side-body">
        {lines.length === 0 ? (
          <div className="muted empty-side">(nothing on this side)</div>
        ) : (
          lines.map((line, i) => {
            const origin = blame?.[i];
            return (
              <div className="code-line" key={i}>
                <span
                  className="line-no"
                  title={startLine ? `line ${startLine + i}` : undefined}
                >
                  {startLine ? startLine + i : ''}
                </span>
                <span
                  className={origin ? 'line-blame' : 'line-blame line-blame-unknown'}
                  title={
                    origin
                      ? `${origin.short} — ${origin.summary}\n${origin.author}, ${new Date(origin.date).toLocaleDateString()}`
                      : 'origin unknown'
                  }
                >
                  {origin ? origin.short : '·······'}
                </span>
                <span className="line-text">{line || ' '}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/** Plain context lines, sliced from the merged file. */
function Context({ lines, firstLine }: { lines: string[]; firstLine: number }) {
  if (lines.length === 0) return null;
  return (
    <div className="context">
      {lines.map((line, i) => (
        <div className="code-line" key={i}>
          <span className="line-no">{firstLine + i}</span>
          <span className="line-text">{line || ' '}</span>
        </div>
      ))}
    </div>
  );
}

function Hunk({
  hunk,
  merged,
  context,
  oursLabel,
  theirsLabel,
  theirsSub,
}: {
  hunk: ConflictHunk;
  merged?: string;
  context: number;
  oursLabel: string;
  theirsLabel: string;
  theirsSub?: string;
}) {
  // Context is re-sliced from the merged file rather than fetched again, so
  // widening it is instant and costs no round trip.
  const mergedLines = useMemo(() => merged?.split('\n'), [merged]);

  const before = useMemo(() => {
    if (!mergedLines) return { lines: hunk.contextBefore, first: hunk.startLine - hunk.contextBefore.length };
    const start = Math.max(0, hunk.startLine - 1 - context);
    return { lines: mergedLines.slice(start, hunk.startLine - 1), first: start + 1 };
  }, [mergedLines, hunk, context]);

  const after = useMemo(() => {
    if (!mergedLines) return { lines: hunk.contextAfter, first: hunk.endLine + 1 };
    const end = Math.min(mergedLines.length, hunk.endLine + context);
    return { lines: mergedLines.slice(hunk.endLine, end), first: hunk.endLine + 1 };
  }, [mergedLines, hunk, context]);

  return (
    <div className="hunk">
      <div className="hunk-head">
        conflict at lines {hunk.startLine}–{hunk.endLine}
      </div>
      <Context lines={before.lines} firstLine={before.first} />
      <div className="sides">
        <Side
          label={oursLabel}
          lines={hunk.ours}
          blame={hunk.oursBlame}
          startLine={hunk.oursStart}
          tone="ours"
        />
        {hunk.base && <Side label="common ancestor" lines={hunk.base} tone="base" />}
        <Side
          label={theirsLabel}
          sublabel={theirsSub}
          lines={hunk.theirs}
          blame={hunk.theirsBlame}
          startLine={hunk.theirsStart}
          tone="theirs"
        />
      </div>
      <Context lines={after.lines} firstLine={after.first} />
    </div>
  );
}

const CONTEXT_STEPS = [3, 10, 25];

function FileCard({
  file,
  oursLabel,
  theirsLabel,
  theirsSub,
  busy,
  onResolve,
}: {
  file: ConflictDetail;
  oursLabel: string;
  theirsLabel: string;
  theirsSub?: string;
  busy: boolean;
  onResolve: (path: string, choice: 'ours' | 'theirs') => void;
}) {
  const [showDiff, setShowDiff] = useState(false);
  const [context, setContext] = useState(3);
  const deletion = file.kind === 'deleted-by-us' || file.kind === 'deleted-by-them';
  const totalLines = file.merged ? file.merged.split('\n').length : 0;

  return (
    <div className="conflict-file">
      <div className="conflict-file-head">
        <code className="conflict-path">{file.path}</code>
        <span className="chip tone-partial">{KIND_LABEL[file.kind]}</span>
        {file.binary && <span className="chip tone-pending">binary</span>}
        {file.truncated && <span className="chip tone-pending">too large to display</span>}
        <span className="spacer" />
        {file.hunks.length > 0 && file.merged && (
          <span className="context-control" role="group" aria-label="Context lines">
            <span className="muted small">context</span>
            {CONTEXT_STEPS.map((n) => (
              <button
                key={n}
                className={context === n ? 'chip-btn active' : 'chip-btn'}
                onClick={() => setContext(n)}
              >
                ±{n}
              </button>
            ))}
            <button
              className={context >= totalLines ? 'chip-btn active' : 'chip-btn'}
              onClick={() => setContext(totalLines)}
              title="Show the whole file around each conflict"
            >
              all
            </button>
          </span>
        )}
        {file.incomingDiff && (
          <button className="ghost small" onClick={() => setShowDiff((v) => !v)}>
            {showDiff ? 'Hide' : 'Show'} incoming diff
          </button>
        )}
        <button className="ghost small" disabled={busy} onClick={() => onResolve(file.path, 'ours')}>
          {file.kind === 'deleted-by-us' ? 'Leave it out' : 'Take ours'}
        </button>
        <button className="ghost small" disabled={busy} onClick={() => onResolve(file.path, 'theirs')}>
          {file.kind === 'deleted-by-them' ? 'Accept deletion' : 'Take theirs'}
        </button>
      </div>

      {showDiff && file.incomingDiff && <DiffBlock diff={file.incomingDiff} />}

      {file.binary ? (
        <p className="muted">
          Binary file — there is nothing to merge line by line. Take one side, or replace it by hand
          in the worktree.
        </p>
      ) : deletion ? (
        <p className="muted">
          {file.kind === 'deleted-by-us'
            ? 'The target branch has no such file — often because the commit that created it was not picked. Take the incoming version, or leave the file out.'
            : 'The incoming commit deletes this file, but the target branch has changes to it. Decide whether the deletion or those changes win.'}
        </p>
      ) : file.hunks.length === 0 ? (
        <p className="muted">
          No conflict markers found — this file may already have been resolved in the worktree.
        </p>
      ) : (
        file.hunks.map((h, i) => (
          <Hunk
            key={i}
            hunk={h}
            merged={file.merged}
            context={context}
            oursLabel={oursLabel}
            theirsLabel={theirsLabel}
            theirsSub={theirsSub}
          />
        ))
      )}
    </div>
  );
}

export function ConflictViewer({
  report,
  busy,
  onResolve,
}: {
  report: ConflictReport;
  busy: boolean;
  onResolve: (path: string, choice: 'ours' | 'theirs') => void;
}) {
  if (!report.inProgress) return null;

  const oursLabel = report.ours?.branch ?? report.target ?? 'target branch';
  const theirsLabel = report.theirs?.branch ?? report.theirs?.label ?? 'incoming';
  // On a cherry-pick the branch alone is ambiguous — say which commit too.
  const theirsSub =
    report.kind === 'cherry-pick' && report.incoming ? report.incoming.short : undefined;

  return (
    <section className="conflicts">
      <header className="conflicts-head">
        <h3>
          {report.files.length} conflicted file{report.files.length === 1 ? '' : 's'}
        </h3>
        {report.incoming && (
          <p className="muted">
            Applying <code className="sha">{report.incoming.short}</code> {report.incoming.subject}
            {report.theirs?.branch && (
              <>
                {' '}
                from <strong>{report.theirs.branch}</strong>
              </>
            )}
            {report.target && (
              <>
                {' '}
                onto <strong>{report.target}</strong>
              </>
            )}
          </p>
        )}
        <p className="muted small">
          The <span className="tone-traced">ours</span> column is what{' '}
          <strong>{oursLabel}</strong> already has; <span className="tone-likely">theirs</span> is
          what <strong>{theirsLabel}</strong> is bringing in. Each line shows the commit that last
          touched it.
        </p>
      </header>

      {report.files.length === 0 ? (
        <p className="muted">
          Nothing is conflicted. If the operation is still paused, the commit is probably empty —
          skip it to carry on.
        </p>
      ) : (
        report.files.map((f) => (
          <FileCard
            key={f.path}
            file={f}
            oursLabel={oursLabel}
            theirsLabel={theirsLabel}
            theirsSub={theirsSub}
            busy={busy}
            onResolve={onResolve}
          />
        ))
      )}
    </section>
  );
}
