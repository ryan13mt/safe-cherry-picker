import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RepoBuilder } from './repo-builder.ts';
import { remoteReport, fetchRemotes } from '../server/services/remote.ts';

/**
 * Remote awareness, tested against a local bare repo acting as the remote — so
 * these exercise the real code paths without touching the network.
 */

let repo: RepoBuilder;
let origin: string;

beforeEach(() => {
  repo = new RepoBuilder('prod');
  repo.use(['develop', 'stable', 'prod']);
  origin = mkdtempSync(path.join(tmpdir(), 'gcp-origin-'));
});
afterEach(() => {
  repo.dispose();
  try {
    rmSync(origin, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* ignore */
  }
});

function base() {
  repo.write('app.txt', 'one\n').commit('initial');
  repo.branch('stable').branch('develop');
}

/** Wires up a bare repo as `origin` and pushes the chain to it. */
function withOrigin() {
  repo.run(['init', '--bare', '--quiet', origin]);
  repo.run(['remote', 'add', 'origin', origin]);
  repo.run(['push', '--quiet', '-u', 'origin', 'prod', 'stable', 'develop']);
}

describe('without a remote', () => {
  it('reports no upstream rather than failing', async () => {
    base();
    const report = await remoteReport(repo.path);

    expect(report.hasRemote).toBe(false);
    expect(report.remotes).toEqual([]);
    expect(report.branches.map((b) => b.branch).sort()).toEqual(['develop', 'prod', 'stable']);
    expect(report.branches.every((b) => b.upstream === null)).toBe(true);
  });

  it('refuses to fetch when nothing tracks a remote', async () => {
    base();
    await expect(fetchRemotes(repo.path)).rejects.toThrow(/nothing to fetch/i);
  });
});

describe('with a remote', () => {
  it('reports each chain branch as in sync just after pushing', async () => {
    base();
    withOrigin();

    const report = await remoteReport(repo.path);
    expect(report.hasRemote).toBe(true);
    expect(report.remotes).toEqual(['origin']);
    for (const branch of report.branches) {
      expect(branch.upstream, branch.branch).toBe(`origin/${branch.branch}`);
      expect(branch.ahead, branch.branch).toBe(0);
      expect(branch.behind, branch.branch).toBe(0);
    }
  });

  it('counts unpushed commits as ahead — the reminder to push', async () => {
    base();
    withOrigin();

    repo.checkout('stable');
    repo.write('app.txt', 'one\ntwo\n').commit('local work on stable');
    repo.checkout('prod');

    const stable = (await remoteReport(repo.path)).branches.find((b) => b.branch === 'stable')!;
    expect(stable.ahead).toBe(1);
    expect(stable.behind).toBe(0);
  });

  it('counts commits only the remote has as behind', async () => {
    base();
    withOrigin();

    // Someone else pushes: simulated by committing in a clone and pushing.
    const other = new RepoBuilder('prod');
    try {
      other.run(['remote', 'add', 'origin', origin]);
      other.run(['fetch', '--quiet', 'origin']);
      other.run(['checkout', '--quiet', '-b', 'develop', 'origin/develop']);
      other.write('app.txt', 'one\nfrom elsewhere\n').commit('work by someone else');
      other.run(['push', '--quiet', 'origin', 'develop']);
    } finally {
      // Keep the repo until after the fetch below.
    }

    // Before fetching, our view is stale — which is exactly why fetch is manual.
    const stale = (await remoteReport(repo.path)).branches.find((b) => b.branch === 'develop')!;
    expect(stale.behind).toBe(0);

    const fresh = (await fetchRemotes(repo.path)).branches.find((b) => b.branch === 'develop')!;
    expect(fresh.behind).toBe(1);
    expect(fresh.ahead).toBe(0);

    other.dispose();
  });

  it('records when it last fetched', async () => {
    base();
    withOrigin();

    const after = await fetchRemotes(repo.path);
    expect(after.lastFetchedAt).toBeTruthy();
    expect(Date.parse(after.lastFetchedAt!)).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('fetching moves no local branch and merges nothing', async () => {
    base();
    withOrigin();
    const before = repo.run(['show-ref', '--heads']);

    await fetchRemotes(repo.path);

    expect(repo.run(['show-ref', '--heads'])).toBe(before);
  });
});
