import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { newFixture, dropFixture, type Fixture } from './helpers.ts';
import { buildMatrix } from '../server/services/matrix.ts';
import type { ReleaseMatrix, ClassifiedCommit } from '../shared/types.ts';

let fx: Fixture;
let matrix: ReleaseMatrix;

const find = (m: ReleaseMatrix, sha: string): ClassifiedCommit => {
  for (const g of m.groups) {
    const hit = g.commits.find((c) => c.commit.sha === sha);
    if (hit) return hit;
  }
  throw new Error(`commit ${sha} missing from the matrix`);
};

beforeAll(async () => {
  fx = newFixture();
  matrix = await buildMatrix('test', fx.repo, fx.branch);
});

afterAll(() => dropFixture(fx));

describe('release classifier', () => {
  it('includes every feature commit', () => {
    const shas = matrix.groups.flatMap((g) => g.commits.map((c) => c.commit.sha));
    expect(shas.sort()).toEqual(Object.values(fx.sha).sort());
  });

  it('treats a merged branch as exactly released', () => {
    for (const sha of Object.values(fx.sha)) {
      const status = find(matrix, sha).status.develop;
      expect(status.method, `commit ${sha} on develop`).toBe('merged');
      expect(status.confidence).toBe('exact');
      expect(status.released).toBe(true);
    }
  });

  it('detects a plain cherry-pick by patch-id', () => {
    for (const sha of [fx.sha.A, fx.sha.C]) {
      const status = find(matrix, sha).status.stable;
      expect(status.method).toBe('patch-id');
      expect(status.confidence).toBe('high');
      expect(status.released).toBe(true);
    }
  });

  it('prefers the -x trailer, and reports it as exact', () => {
    const status = find(matrix, fx.sha.B).status.stable;
    expect(status.method).toBe('traced');
    expect(status.confidence).toBe('exact');
    expect(status.released).toBe(true);
    expect(status.evidenceSha).toBeTruthy();
  });

  it('flags a squash match as low confidence and NOT released', () => {
    const status = find(matrix, fx.sha.F).status.stable;
    expect(status.method).toBe('squashed');
    expect(status.confidence).toBe('low');
    // The whole point: a heuristic must never be reported as a certainty.
    expect(status.released).toBe(false);
    expect(status.note).toMatch(/verify/i);
  });

  it('reports genuinely unreleased commits as pending', () => {
    expect(find(matrix, fx.sha.D).status.stable.method).toBe('none');
    for (const sha of Object.values(fx.sha)) {
      expect(find(matrix, sha).status.prod.method, `commit ${sha} on prod`).toBe('none');
      expect(find(matrix, sha).status.prod.released).toBe(false);
    }
  });
});

describe('ticket grouping', () => {
  const group = (ticket: string | null) =>
    matrix.groups.find((g) => g.ticket === ticket) ??
    (() => {
      throw new Error(`no group for ${ticket}`);
    })();

  it('groups by the bracketed prefix', () => {
    expect(group('JIRA-412').commits.map((c) => c.commit.sha).sort()).toEqual(
      [fx.sha.A, fx.sha.C].sort(),
    );
  });

  it('normalises a lowercase prefix', () => {
    expect(group('JIRA-777').commits[0].commit.sha).toBe(fx.sha.H);
  });

  it('falls back to the branch name when the subject has no id', () => {
    const g = group('JIRA-900');
    expect(g.commits.map((c) => c.commit.sha).sort()).toEqual([fx.sha.E, fx.sha.G].sort());
    expect(g.commits.every((c) => c.ticketSource === 'branch')).toBe(true);
  });

  it('does NOT group on an id mentioned mid-subject', () => {
    // "refactor similar to JIRA-555 handling" must never become a JIRA-555
    // commit; strict prefix matching sends it to the branch fallback instead.
    expect(matrix.groups.some((g) => g.ticket === 'JIRA-555')).toBe(false);
    const g = group('JIRA-900');
    expect(g.commits.find((c) => c.commit.sha === fx.sha.G)).toBeTruthy();
  });

  it('marks a half-shipped ticket as partial', () => {
    const summary = group('JIRA-388').summary.stable;
    expect(summary.state).toBe('partial');
    expect(summary.releasedCount).toBe(1);
    expect(summary.missing).toEqual([fx.sha.D]);
  });

  it('marks a fully picked ticket as released', () => {
    expect(group('JIRA-412').summary.stable.state).toBe('released');
    expect(group('JIRA-412').summary.stable.missing).toEqual([]);
  });

  it('marks a squash-only match as likely, not released', () => {
    expect(group('JIRA-401').summary.stable.state).toBe('likely');
  });

  it('sorts partial groups to the top', () => {
    expect(matrix.groups[0].ticket).toBe('JIRA-388');
  });

  it('counts released tickets per target for the progress bars', () => {
    expect(matrix.progress.prod.releasedTickets).toBe(0);
    expect(matrix.progress.develop.releasedTickets).toBe(matrix.groups.length);
    expect(matrix.progress.stable.releasedTickets).toBe(1); // JIRA-412 only
  });
});

describe('unknown branches', () => {
  it('explains that the branch is missing instead of leaking a git error', async () => {
    // Reachable by switching repos in the UI: the previously selected branch
    // may not exist in the repo you just switched to.
    await expect(buildMatrix('test', fx.repo, 'main')).rejects.toThrow(
      /Branch 'main' does not exist/,
    );
    // And it says what is available, so the message is actionable.
    await expect(buildMatrix('test', fx.repo, 'main')).rejects.toThrow(/Available: .*develop/);
  });

  it('rejects a branch name that could be read as an option', async () => {
    await expect(buildMatrix('test', fx.repo, '--upload-pack=evil')).rejects.toThrow(
      /does not exist/,
    );
  });
});

describe('branch base selection', () => {
  it('scopes a branch to its own commits when develop has moved on and the branch was merged back', async () => {
    // spike/tidy-up was cut from develop *after* the feature branch was merged
    // in, then merged back itself — so its merge-base with develop is its own
    // tip, and the fork point survives only in the merge commit. Get this wrong
    // and a two-commit spike lists all ten feature commits as its own.
    const plain = await buildMatrix('test', fx.repo, fx.plain.branch);
    const shas = plain.groups.flatMap((g) => g.commits.map((c) => c.commit.sha));

    expect(shas.sort()).toEqual([fx.plain.ticketed, fx.plain.ungrouped].sort());
    for (const featureSha of Object.values(fx.sha)) {
      expect(shas, 'feature commits must not leak in').not.toContain(featureSha);
    }
  });

  it('still lists a branch already merged into develop', async () => {
    // The inverse trap: merge-base with develop *is* the tip here, so taking the
    // most recent merge-base blindly would render an empty matrix.
    const merged = await buildMatrix('test', fx.repo, fx.branch);
    const shas = merged.groups.flatMap((g) => g.commits.map((c) => c.commit.sha));
    expect(shas.sort()).toEqual(Object.values(fx.sha).sort());
  });
});

describe('Ungrouped bucket', () => {
  it('collects unprefixed commits when the branch name has no id either, and sinks them to the bottom', async () => {
    const plain = await buildMatrix('test', fx.repo, fx.plain.branch);
    const ungrouped = plain.groups.find((g) => g.ticket === null);

    expect(ungrouped, 'expected an Ungrouped bucket').toBeTruthy();
    expect(ungrouped!.commits.map((c) => c.commit.sha)).toEqual([fx.plain.ungrouped]);
    expect(ungrouped!.label).toBe('Ungrouped');
    expect(plain.groups[plain.groups.length - 1].ticket).toBeNull();

    const ticketed = plain.groups.find((g) => g.ticket === 'JIRA-333');
    expect(ticketed!.commits[0].ticketSource).toBe('subject');
  });
});
