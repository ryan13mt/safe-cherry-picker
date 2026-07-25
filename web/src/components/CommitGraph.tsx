import { useMemo } from 'react';
import type { ClassifiedCommit } from '../../../shared/types.ts';
import { ticketColour, statusLook } from '../status.tsx';

/**
 * A lane-assigned commit graph, hand-rolled in SVG.
 *
 * The point of this panel is not decoration: dots are tinted per ticket, so a
 * glance shows how badly the tickets are interleaved. Tightly interleaved
 * colours mean picking one ticket in isolation is likely to conflict.
 */

const ROW_H = 26;
const LANE_W = 16;
const LEFT_PAD = 12;

interface Node {
  commit: ClassifiedCommit;
  lane: number;
  row: number;
}

interface Edge {
  from: Node;
  toRow: number;
  toLane: number;
  /** The parent is outside the rendered set — draw the edge running off the bottom. */
  dangling: boolean;
}

function layout(commits: ClassifiedCommit[]): { nodes: Node[]; edges: Edge[]; laneCount: number } {
  // `lanes[i]` holds the sha that lane i is currently waiting to draw.
  const lanes: (string | null)[] = [];
  const nodes: Node[] = [];
  const nodeBySha = new Map<string, Node>();
  const inSet = new Set(commits.map((c) => c.commit.sha));

  commits.forEach((commit, row) => {
    const sha = commit.commit.sha;
    let lane = lanes.indexOf(sha);
    if (lane === -1) {
      lane = lanes.indexOf(null);
      if (lane === -1) lane = lanes.length;
    }
    lanes[lane] = null;

    const node: Node = { commit, lane, row };
    nodes.push(node);
    nodeBySha.set(sha, node);

    const [first, ...rest] = commit.commit.parents;
    if (first) lanes[lane] = first;
    for (const extra of rest) {
      // A merge inside the branch forks a new lane for its second parent.
      let free = lanes.indexOf(null);
      if (free === -1) free = lanes.length;
      lanes[free] = extra;
    }
  });

  const edges: Edge[] = [];
  for (const node of nodes) {
    for (const parent of node.commit.commit.parents) {
      const target = nodeBySha.get(parent);
      if (target) {
        edges.push({ from: node, toRow: target.row, toLane: target.lane, dangling: false });
      } else if (!inSet.has(parent)) {
        edges.push({ from: node, toRow: nodes.length, toLane: node.lane, dangling: true });
      }
    }
  }

  const laneCount = Math.max(1, ...nodes.map((n) => n.lane + 1));
  return { nodes, edges, laneCount };
}

function x(lane: number): number {
  return LEFT_PAD + lane * LANE_W;
}
function y(row: number): number {
  return row * ROW_H + ROW_H / 2;
}

export function CommitGraph({
  commits,
  targets,
}: {
  commits: ClassifiedCommit[];
  targets: string[];
}) {
  const { nodes, edges, laneCount } = useMemo(() => layout(commits), [commits]);

  if (commits.length === 0) {
    return <p className="muted">No commits to graph.</p>;
  }

  const width = LEFT_PAD * 2 + laneCount * LANE_W;
  const height = commits.length * ROW_H + 8;

  return (
    <div className="graph">
      <svg width={width} height={height} role="img" aria-label="Commit graph tinted by ticket">
        {edges.map((edge, i) => {
          const x1 = x(edge.from.lane);
          const y1 = y(edge.from.row);
          const x2 = x(edge.toLane);
          const y2 = edge.dangling ? height : y(edge.toRow);
          const mid = (y1 + y2) / 2;
          const d =
            x1 === x2
              ? `M ${x1} ${y1} L ${x2} ${y2}`
              : `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`;
          return <path key={i} d={d} className="graph-edge" />;
        })}
        {nodes.map((node) => (
          <circle
            key={node.commit.commit.sha}
            cx={x(node.lane)}
            cy={y(node.row)}
            r={node.commit.commit.isMerge ? 3.5 : 5}
            fill={ticketColour(node.commit.ticket)}
            className={node.commit.commit.isMerge ? 'graph-node merge' : 'graph-node'}
          >
            <title>{`${node.commit.commit.short} ${node.commit.commit.subject}`}</title>
          </circle>
        ))}
      </svg>

      <ol className="graph-rows" style={{ ['--row-h' as string]: `${ROW_H}px` }}>
        {commits.map((c) => (
          <li key={c.commit.sha} className="graph-row">
            <span className="ticket-chip" style={{ borderColor: ticketColour(c.ticket) }}>
              {c.ticket ?? 'Ungrouped'}
            </span>
            <code className="sha">{c.commit.short}</code>
            <span className="graph-subject">{c.commit.subject}</span>
            <span className="graph-targets">
              {targets.map((t) => {
                const look = statusLook(c.status[t]);
                return (
                  <span key={t} className={`dot tone-${look.tone}`} title={`${t}: ${look.label}`}>
                    {look.glyph}
                  </span>
                );
              })}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
