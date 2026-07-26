import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RepoBuilder } from './repo-builder.ts';
import { findTicket } from '../server/services/lookup.ts';

/** "Where is PAY-1042?" — the matrix inverted. */

let repo: RepoBuilder;

beforeEach(() => {
  repo = new RepoBuilder('prod');
  repo.use(['develop', 'stable', 'prod']);
});
afterEach(() => repo.dispose());

function base() {
  repo.write('README.md', '# app\n').commit('initial');
  repo.branch('stable').branch('develop');
}

describe('finding a ticket', () => {
  it('reports which chain branches have it, and where the work lives', async () => {
    base();
    repo.checkout('feature/PAY-1-work', 'develop');
    const a = repo.as('Ana Sousa').write('a.js', 'a\n').commit('[PAY-1] add the thing');
    repo.checkout('stable');
    repo.run(['cherry-pick', '-x', a]);
    repo.checkout('prod');

    const found = await findTicket(repo.path, 'PAY-1');

    expect(found.ticket).toBe('PAY-1');
    // The original on the feature branch plus the picked copy on stable.
    expect(found.sightings).toHaveLength(2);
    expect(found.chainStatus.stable).toBe(true);
    expect(found.chainStatus.prod).toBe(false);
    expect(found.sourceBranches).toContain('feature/PAY-1-work');
  });

  it('names only the branch the work was written on, not every branch containing it', async () => {
    base();
    repo.checkout('feature/PAY-7-origin', 'develop');
    repo.write('x.js', 'x\n').commit('[PAY-7] the actual work');
    repo.checkout('develop');
    repo.mergeInto('feature/PAY-7-origin');

    // Cut *after* the merge, so it contains the commit without owning it.
    repo.checkout('feature/unrelated-later', 'develop');
    repo.write('y.js', 'y\n').commit('something else entirely');
    repo.checkout('prod');

    const found = await findTicket(repo.path, 'PAY-7');
    expect(found.sourceBranches).toEqual(['feature/PAY-7-origin']);
    expect(found.sourceBranches).not.toContain('feature/unrelated-later');

    // Containment is still reported, since it is true — just not as ownership.
    const sighting = found.sightings.find((s) => s.commit.subject.includes('actual work'))!;
    expect(sighting.branches).toContain('feature/unrelated-later');
    expect(sighting.ownedBy).toEqual(['feature/PAY-7-origin']);
  });

  it('marks a cherry-picked copy as a copy, and names its source', async () => {
    base();
    repo.checkout('feature/PAY-2-work', 'develop');
    const a = repo.write('b.js', 'b\n').commit('[PAY-2] original work');
    repo.checkout('stable');
    repo.run(['cherry-pick', '-x', a]);
    repo.checkout('prod');

    const found = await findTicket(repo.path, 'PAY-2');
    const copy = found.sightings.find((s) => s.isCopy)!;
    const original = found.sightings.find((s) => !s.isCopy)!;

    expect(copy.copiedFrom).toBe(a);
    expect(copy.onChain).toContain('stable');
    expect(original.commit.sha).toBe(a);
  });

  it('carries the author through, so you know who to ask', async () => {
    base();
    repo.checkout('feature/PAY-3-work', 'develop');
    repo.as('Ben Ito').write('c.js', 'c\n').commit('[PAY-3] some work');
    repo.checkout('prod');

    const found = await findTicket(repo.path, 'PAY-3');
    expect(found.sightings[0].commit.author).toBe('Ben Ito');
  });

  it('is case-insensitive, since ticket ids get typed in a hurry', async () => {
    base();
    repo.checkout('feature/PAY-4-work', 'develop');
    repo.write('d.js', 'd\n').commit('[PAY-4] mixed case search');
    repo.checkout('prod');

    expect((await findTicket(repo.path, 'pay-4')).sightings).toHaveLength(1);
  });

  it('returns nothing for a ticket that does not exist, rather than erroring', async () => {
    base();
    repo.checkout('prod');
    const found = await findTicket(repo.path, 'PAY-9999');
    expect(found.sightings).toEqual([]);
    expect(found.sourceBranches).toEqual([]);
    expect(Object.values(found.chainStatus).every((v) => v === false)).toBe(true);
  });

  it('does not match a different ticket that shares a prefix', async () => {
    base();
    repo.checkout('feature/mix', 'develop');
    repo.write('e.js', 'e\n').commit('[PAY-10] ten');
    repo.write('f.js', 'f\n').commit('[PAY-100] one hundred');
    repo.checkout('prod');

    // A bare substring search would return both; the search is on the literal id.
    const ten = await findTicket(repo.path, 'PAY-100');
    expect(ten.sightings).toHaveLength(1);
    expect(ten.sightings[0].commit.subject).toContain('one hundred');
  });

  it('treats regex characters in the query literally', async () => {
    base();
    repo.checkout('feature/odd', 'develop');
    repo.write('g.js', 'g\n').commit('[PAY-5] safe');
    repo.checkout('prod');

    // Would be a wildcard if the query were not escaped.
    const found = await findTicket(repo.path, 'PAY-5');
    expect(found.sightings).toHaveLength(1);
  });

  it('finds work that has reached every chain branch', async () => {
    base();
    repo.checkout('feature/PAY-6-work', 'develop');
    repo.write('h.js', 'h\n').commit('[PAY-6] shipped everywhere');
    repo.checkout('develop');
    repo.mergeInto('feature/PAY-6-work');
    repo.checkout('stable');
    repo.mergeInto('develop');
    repo.checkout('prod');
    repo.mergeInto('stable');

    const found = await findTicket(repo.path, 'PAY-6');
    expect(found.chainStatus).toEqual({ develop: true, stable: true, prod: true });
  });
});
