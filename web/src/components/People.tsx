import type { BranchAuthorship, Contributor } from '../../../shared/types.ts';

/** "Ana Sousa" -> "AS", for a compact avatar-ish marker. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Stable colour per person, so the same face keeps the same tint across the
 * screen. The name is always shown too — colour is never the only cue.
 */
const TINTS = ['#7aa2f7', '#bb9af7', '#7dcfff', '#9ece6a', '#e0af68', '#f7768e', '#73daca', '#ff9e64'];
function tint(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return TINTS[hash % TINTS.length];
}

export function Person({ name, email, count }: { name: string; email?: string; count?: number }) {
  return (
    <span className="person" title={[name, email].filter(Boolean).join(' · ')}>
      <span className="person-initials" style={{ background: `${tint(email || name)}22`, color: tint(email || name) }}>
        {initials(name)}
      </span>
      <span className="person-name">{name}</span>
      {count !== undefined && <span className="muted person-count">{count}</span>}
    </span>
  );
}

/** A row of contributors, collapsing the tail once the list gets long. */
export function People({ people, max = 3 }: { people: Contributor[]; max?: number }) {
  if (people.length === 0) return null;
  const shown = people.slice(0, max);
  const rest = people.slice(max);

  return (
    <span className="people">
      {shown.map((p) => (
        <Person key={p.email || p.name} name={p.name} email={p.email} count={p.commits} />
      ))}
      {rest.length > 0 && (
        <span
          className="muted small"
          title={rest.map((p) => `${p.name} (${p.commits})`).join('\n')}
        >
          +{rest.length} more
        </span>
      )}
    </span>
  );
}

/**
 * Branch authorship. "Started by" is the author of the branch's oldest own
 * commit — git records nothing about who actually created a branch, and the
 * tooltip says so rather than implying more certainty than exists.
 */
export function Authorship({ authorship, label = 'started by' }: { authorship: BranchAuthorship; label?: string }) {
  const { startedBy, contributors } = authorship;
  if (!startedBy && contributors.length === 0) return null;

  return (
    <span className="authorship">
      {startedBy && (
        <span
          className="muted small"
          title={`First commit on this branch: ${startedBy.short} on ${new Date(startedBy.date).toLocaleDateString()}.\nGit does not record who created a branch, so this is its first committer.`}
        >
          {label} <Person name={startedBy.name} email={startedBy.email} />
        </span>
      )}
      {contributors.length > 1 && (
        <span className="muted small">
          · {contributors.length} contributors <People people={contributors} max={3} />
        </span>
      )}
    </span>
  );
}
