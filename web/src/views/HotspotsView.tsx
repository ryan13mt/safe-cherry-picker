import type { HotspotReport } from '../../../shared/types.ts';

/**
 * Files that keep causing trouble across branches.
 *
 * A file two tickets both touch is normal; a file that repeatedly makes one
 * ticket depend on another is where your cherry-picks keep failing — and usually
 * a sign the file is doing too many jobs.
 */
export function HotspotsView({ report }: { report: HotspotReport }) {
  const worst = report.files[0]?.collisions ?? 0;

  return (
    <div className="hotspots">
      <div className="hotspots-head">
        <p>
          {report.files.length === 0
            ? 'No files are shared between tickets yet — nothing to trip over.'
            : `${report.files.length} file${report.files.length === 1 ? '' : 's'} are touched by more than one ticket.`}
        </p>
        <span className="muted small">
          scanned {report.branchesScanned.length} branch
          {report.branchesScanned.length === 1 ? '' : 'es'}
        </span>
      </div>

      {report.skipped.length > 0 && (
        <p className="warn-text small">
          {report.skipped.length} branches were skipped to keep the scan quick.
        </p>
      )}

      {report.files.length > 0 && (
        <table className="hotspot-table">
          <thead>
            <tr>
              <th>File</th>
              <th>Collisions</th>
              <th>Tickets</th>
              <th>Churn</th>
            </tr>
          </thead>
          <tbody>
            {report.files.map((file) => (
              <tr key={file.path}>
                <td className="hotspot-path">
                  <code>{file.path}</code>
                  {file.branches.length > 1 && (
                    <span className="muted small"> · {file.branches.length} branches</span>
                  )}
                </td>
                <td>
                  {file.collisions === 0 ? (
                    <span className="muted small">—</span>
                  ) : (
                    <span
                      className="chip tone-partial"
                      title={`Ticket pairs that collided here:\n${file.pairs.join('\n')}`}
                    >
                      {file.collisions}
                    </span>
                  )}
                  {worst > 0 && (
                    <div
                      className="heat-bar"
                      style={{ width: `${Math.round((file.collisions / worst) * 90)}%` }}
                    />
                  )}
                </td>
                <td className="hotspot-tickets">
                  {file.tickets.slice(0, 4).map((t) => (
                    <span key={t} className="ticket-chip">
                      {t}
                    </span>
                  ))}
                  {file.tickets.length > 4 && (
                    <span className="muted small" title={file.tickets.join(', ')}>
                      +{file.tickets.length - 4}
                    </span>
                  )}
                </td>
                <td className="muted small">{file.churn} lines</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="muted small">
        A collision means this file is why one ticket depends on another — either it was created
        by one and edited by the next, or one rewrote most of what the other touches. Those are
        the picks that fail when a ticket is taken on its own.
      </p>
    </div>
  );
}
