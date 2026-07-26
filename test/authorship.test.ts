import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RepoBuilder } from './repo-builder.ts';
import { buildMatrix } from '../server/services/matrix.ts';
import { buildCleanupReport } from '../server/services/cleanup.ts';
import { contributorsOf, authorshipOf } from '../server/services/commits.ts';
import type { CommitInfo, ReleaseMatrix, TicketGroup } from '../shared/types.ts';

let repo: RepoBuilder;

beforeEach(() => {
  repo = new RepoBuilder('prod');
  repo.use(['develop', 'stable', 'prod']);
});
afterEach(() => repo.dispose());

const group = (m: ReleaseMatrix, ticket: string): TicketGroup =>
  m.groups.find((g) => g.ticket === ticket) ??
  (() => {
    throw new Error(`no group for ${ticket}`);
  })();

function base() {
  repo.as('Ana Sousa').write('README.md', '# app\n').commit('initial');
  repo.branch('stable').branch('develop');
}

function fakeCommit(author: string, email: string, isMerge = false): CommitInfo {
  return {
    sha: 'x'.repeat(40),
    short: 'xxxxxxx',
    author,
    authorEmail: email,
    date: '2026-01-01T00:00:00.000Z',
    subject: 's',
    body: '',
    parents: isMerge ? ['a', 'b'] : ['a'],
    isMerge,
  };
}

describe('contributor tallying', () => {
  it('counts per person, most prolific first', () => {
    const people = contributorsOf([
      fakeCommit('Ana', 'ana@x'),
      fakeCommit('Ben', 'ben@x'),
      fakeCommit('Ana', 'ana@x'),
    ]);
    expect(people.map((p) => [p.name, p.commits])).toEqual([
      ['Ana', 2],
      ['Ben', 1],
    ]);
  });

  it('treats one person spelled two ways as one, keyed on email', () => {
    const people = contributorsOf([
      fakeCommit('Ana Sousa', 'ana@x'),
      fakeCommit('ana sousa', 'ANA@X'),
    ]);
    expect(people).toHaveLength(1);
    expect(people[0].commits).toBe(2);
  });

  it('ignores merge commits, whose author did not write the work', () => {
    const people = contributorsOf([
      fakeCommit('Ana', 'ana@x'),
      fakeCommit('Release Bot', 'bot@x', true),
    ]);
    expect(people.map((p) => p.name)).toEqual(['Ana']);
  });

  it('takes the oldest commit as who started the branch', () => {
    // Newest-first, as git log returns it.
    const authorship = authorshipOf([
      fakeCommit('Ben', 'ben@x'),
      fakeCommit('Ana', 'ana@x'),
    ]);
    expect(authorship.startedBy?.name).toBe('Ana');
  });

  it('has no starter when there is nothing but merges', () => {
    expect(authorshipOf([fakeCommit('Bot', 'bot@x', true)]).startedBy).toBeUndefined();
  });
});

describe('per-ticket authorship', () => {
  it('attributes each ticket to the people who wrote its commits', async () => {
    base();
    repo.checkout('feature/PAY-1-work', 'develop');
    repo.as('Ana Sousa').write('a.js', 'a\n').commit('[PAY-1] first bit');
    repo.as('Ben Ito').write('a.js', 'a\nb\n').commit('[PAY-1] second bit');
    repo.as('Ana Sousa').write('a.js', 'a\nb\nc\n').commit('[PAY-1] third bit');
    repo.as('Chris Vale').write('b.js', 'b\n').commit('[PAY-2] separate work');
    repo.checkout('prod');

    const m = await buildMatrix('t', repo.path, 'feature/PAY-1-work');

    const one = group(m, 'PAY-1').authors;
    expect(one.map((a) => [a.name, a.commits])).toEqual([
      ['Ana Sousa', 2],
      ['Ben Ito', 1],
    ]);

    const two = group(m, 'PAY-2').authors;
    expect(two.map((a) => a.name)).toEqual(['Chris Vale']);
  });

  it('reports who started the branch and everyone who worked on it', async () => {
    base();
    repo.checkout('feature/PAY-9-shared', 'develop');
    repo.as('Dana Reyes').write('d.js', 'd\n').commit('[PAY-9] kick things off');
    repo.as('Eli Novak').write('e.js', 'e\n').commit('[PAY-9] carry on');
    repo.checkout('prod');

    const m = await buildMatrix('t', repo.path, 'feature/PAY-9-shared');

    expect(m.authorship.startedBy?.name).toBe('Dana Reyes');
    expect(m.authorship.startedBy?.email).toBe('dana.reyes@example.invalid');
    expect(m.authorship.contributors.map((c) => c.name).sort()).toEqual(['Dana Reyes', 'Eli Novak']);
  });
});

describe('branch authorship in cleanup', () => {
  it('names the first committer on each branch', async () => {
    base();
    repo.checkout('feature/one', 'develop');
    repo.as('Ana Sousa').write('one.js', '1\n').commit('start one');
    repo.as('Ben Ito').write('one.js', '1\n2\n').commit('continue one');

    repo.checkout('feature/two', 'develop');
    repo.as('Chris Vale').write('two.js', '2\n').commit('start two');
    repo.checkout('prod');

    const report = await buildCleanupReport(repo.path);
    const one = report.branches.find((b) => b.name === 'feature/one')!;
    const two = report.branches.find((b) => b.name === 'feature/two')!;

    expect(one.authorship.startedBy?.name).toBe('Ana Sousa');
    expect(one.authorship.contributors.map((c) => c.name).sort()).toEqual(['Ana Sousa', 'Ben Ito']);
    expect(two.authorship.startedBy?.name).toBe('Chris Vale');
  });

  it('still names the starter for a branch already merged into the chain', async () => {
    // The fast path skips classification, but authorship must survive it.
    base();
    repo.checkout('feature/merged', 'develop');
    repo.as('Dana Reyes').write('m.js', 'm\n').commit('work that shipped');
    repo.checkout('prod');
    repo.mergeInto('feature/merged');

    const branch = (await buildCleanupReport(repo.path)).branches.find(
      (b) => b.name === 'feature/merged',
    )!;
    expect(branch.safety).toBe('merged');
    expect(branch.authorship.startedBy?.name).toBe('Dana Reyes');
  });

  it('leaves the promotion branches without an owner', async () => {
    // They are shared infrastructure, not someone's branch.
    base();
    repo.checkout('prod');
    const report = await buildCleanupReport(repo.path);
    for (const name of ['prod', 'stable', 'develop']) {
      const branch = report.branches.find((b) => b.name === name)!;
      expect(branch.authorship.startedBy, name).toBeUndefined();
      expect(branch.authorship.contributors, name).toEqual([]);
    }
  });
});
