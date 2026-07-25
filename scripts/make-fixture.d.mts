/** Types for the plain-JS fixture builder, so tests stay type-checked. */

export interface FixtureShas {
  /** [JIRA-412] add export module */
  A: string;
  /** [JIRA-388] fix null in parser */
  B: string;
  /** [JIRA-412] add csv writer */
  C: string;
  /** [JIRA-388] add regression test */
  D: string;
  /** chore: bump deps — no id, groups via the branch name */
  E: string;
  /** [JIRA-401] audit log — squash-matched on stable */
  F: string;
  /** refactor similar to JIRA-555 handling — must not group as JIRA-555 */
  G: string;
  /** [jira-777] lowercase ticket */
  H: string;
  /** [JIRA-999] parser tweak — the interleaved commit */
  J: string;
  /** [JIRA-812] tighten parser — conflicts if J is skipped */
  I: string;
}

export interface Fixture {
  repo: string;
  branch: string;
  base: string;
  sha: FixtureShas;
  plain: { branch: string; ticketed: string; ungrouped: string };
  hotfix: string;
  docs: { branch: string; sha: string };
  tickets: Record<string, string[]>;
}

export function makeFixture(dir?: string): Fixture;
export function cleanupFixture(repo: string): void;
