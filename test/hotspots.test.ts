import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RepoBuilder } from './repo-builder.ts';
import { buildHotspotReport } from '../server/services/hotspots.ts';
import { buildMatrix } from '../server/services/matrix.ts';
import { setConfig } from '../server/config.ts';
import type { HotspotReport } from '../shared/types.ts';

let repo: RepoBuilder;

beforeEach(() => {
  repo = new RepoBuilder('prod');
  repo.use(['develop', 'stable', 'prod']);
  setConfig({ staleAfterDays: 14 });
});
afterEach(() => repo.dispose());

function base() {
  repo.write('README.md', '# app\n').commit('initial');
  repo.branch('stable').branch('develop');
}

const file = (r: HotspotReport, path: string) =>
  r.files.find((f) => f.path === path) ??
  (() => {
    throw new Error(`no hotspot for ${path}; got ${r.files.map((f) => f.path).join(', ')}`);
  })();

describe('conflict hotspots', () => {
  it('ranks a file that repeatedly makes one ticket depend on another', async () => {
    base();
    // Two branches where the same file is created by one ticket and edited by
    // another — the shape that breaks a lone cherry-pick.
    repo.checkout('feature/one', 'develop');
    repo.write('src/shared.js', 'export const a = 1;\n').commit('[ACME-1] create shared');
    repo.write('src/shared.js', 'export const a = 2;\n').commit('[ACME-2] edit shared');

    repo.checkout('feature/two', 'develop');
    repo.write('src/shared.js', 'export const b = 1;\n').commit('[ACME-3] create shared again');
    repo.write('src/shared.js', 'export const b = 2;\n').commit('[ACME-4] edit it again');
    repo.checkout('prod');

    const report = await buildHotspotReport(repo.path);
    const shared = file(report, 'src/shared.js');

    expect(shared.collisions).toBeGreaterThanOrEqual(2);
    expect(shared.branches.sort()).toEqual(['feature/one', 'feature/two']);
    expect(shared.tickets).toEqual(expect.arrayContaining(['ACME-1', 'ACME-2', 'ACME-3', 'ACME-4']));
    // The worst offender sorts first.
    expect(report.files[0].path).toBe('src/shared.js');
  });

  it('names the ticket pairs that collided, order-independently', async () => {
    base();
    repo.checkout('feature/pair', 'develop');
    repo.write('src/x.js', 'x\n').commit('[ACME-10] create x');
    repo.write('src/x.js', 'x2\n').commit('[ACME-20] edit x');
    repo.checkout('prod');

    const x = file(await buildHotspotReport(repo.path), 'src/x.js');
    expect(x.pairs).toEqual(['ACME-10 ↔ ACME-20']);
  });

  it('ignores files only one ticket ever touches', async () => {
    base();
    repo.checkout('feature/solo', 'develop');
    repo.write('src/lonely.js', 'a\n').commit('[ACME-5] add lonely');
    repo.write('src/lonely.js', 'b\n').commit('[ACME-5] tweak lonely');
    repo.checkout('prod');

    const report = await buildHotspotReport(repo.path);
    expect(report.files.map((f) => f.path)).not.toContain('src/lonely.js');
  });

  it('does not scan the promotion branches, which carry everyone\'s work', async () => {
    base();
    repo.checkout('feature/real', 'develop');
    repo.write('a.js', 'a\n').commit('[ACME-6] work');
    repo.checkout('prod');

    const report = await buildHotspotReport(repo.path);
    expect(report.branchesScanned).not.toContain('develop');
    expect(report.branchesScanned).not.toContain('stable');
    expect(report.branchesScanned).not.toContain('prod');
    expect(report.branchesScanned).toContain('feature/real');
  });

  it('accumulates churn across branches', async () => {
    base();
    repo.checkout('feature/a', 'develop');
    repo.write('src/hot.js', 'one\n').commit('[ACME-7] create hot');
    repo.write('src/hot.js', 'one\ntwo\n').commit('[ACME-8] extend hot');
    repo.checkout('prod');

    const hot = file(await buildHotspotReport(repo.path), 'src/hot.js');
    expect(hot.churn).toBeGreaterThan(0);
  });

  it('returns an empty report for a repo with no feature branches', async () => {
    base();
    repo.checkout('prod');
    const report = await buildHotspotReport(repo.path);
    expect(report.files).toEqual([]);
    expect(report.branchesScanned).toEqual([]);
  });
});

describe('age of unreleased work', () => {
  it('reports how long a ticket has been waiting for each branch', async () => {
    base();
    repo.checkout('feature/waiting', 'develop');
    // Written 40 days ago and never shipped.
    repo.write('w.js', 'w\n');
    repo.commitAt('[ACME-30] old unreleased work', Math.floor(Date.now() / 1000) - 40 * 86400);
    repo.checkout('prod');

    const m = await buildMatrix('t', repo.path, 'feature/waiting');
    const summary = m.groups.find((g) => g.ticket === 'ACME-30')!.summary.stable;

    expect(summary.state).toBe('pending');
    expect(summary.waitingDays).toBeGreaterThanOrEqual(39);
    expect(summary.stale).toBe(true);
    expect(summary.waitingSince).toBeTruthy();
  });

  it('does not flag work that is only days old', async () => {
    base();
    repo.checkout('feature/fresh', 'develop');
    repo.write('f.js', 'f\n');
    repo.commitAt('[ACME-31] fresh work', Math.floor(Date.now() / 1000) - 2 * 86400);
    repo.checkout('prod');

    const m = await buildMatrix('t', repo.path, 'feature/fresh');
    const summary = m.groups.find((g) => g.ticket === 'ACME-31')!.summary.stable;
    expect(summary.waitingDays).toBeLessThan(5);
    expect(summary.stale).toBe(false);
  });

  it('measures from the oldest unreleased commit, not the newest', async () => {
    base();
    repo.checkout('feature/spread', 'develop');
    const old = Math.floor(Date.now() / 1000) - 30 * 86400;
    repo.write('s1.js', '1\n').commitAt('[ACME-32] started long ago', old);
    repo.write('s2.js', '2\n').commitAt('[ACME-32] finished recently', Math.floor(Date.now() / 1000) - 86400);
    repo.checkout('prod');

    const m = await buildMatrix('t', repo.path, 'feature/spread');
    const summary = m.groups.find((g) => g.ticket === 'ACME-32')!.summary.stable;
    // The work has been waiting since it was *started*, which is the honest read.
    expect(summary.waitingDays).toBeGreaterThanOrEqual(29);
  });

  it('stops counting once the work has shipped', async () => {
    base();
    repo.checkout('feature/shipped', 'develop');
    const sha = repo.write('d.js', 'd\n').commit('[ACME-33] done');
    repo.checkout('stable');
    repo.run(['cherry-pick', sha]);
    repo.checkout('prod');

    const m = await buildMatrix('t', repo.path, 'feature/shipped');
    const summary = m.groups.find((g) => g.ticket === 'ACME-33')!.summary.stable;
    expect(summary.state).toBe('released');
    expect(summary.waitingDays).toBeUndefined();
    expect(summary.stale).toBe(false);
  });

  it('respects the configured threshold', async () => {
    base();
    repo.checkout('feature/threshold', 'develop');
    repo.write('t.js', 't\n');
    repo.commitAt('[ACME-34] work', Math.floor(Date.now() / 1000) - 10 * 86400);
    repo.checkout('prod');

    setConfig({ staleAfterDays: 30 });
    let m = await buildMatrix('t', repo.path, 'feature/threshold');
    expect(m.groups.find((g) => g.ticket === 'ACME-34')!.summary.stable.stale).toBe(false);

    setConfig({ staleAfterDays: 7 });
    m = await buildMatrix('t', repo.path, 'feature/threshold');
    expect(m.groups.find((g) => g.ticket === 'ACME-34')!.summary.stable.stale).toBe(true);
  });
});
