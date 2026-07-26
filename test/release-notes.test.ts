import { describe, it, expect } from 'vitest';
import { buildReleaseNotes } from '../web/src/releaseNotes.ts';
import type { CommitInfo } from '../shared/types.ts';

const PATTERN = '^\\s*\\[([A-Za-z][A-Za-z0-9]*-\\d+)\\]';

function commit(subject: string, short = 'abc1234', isMerge = false): CommitInfo {
  return {
    sha: `${short}00000000000000000000000000000000`.slice(0, 40),
    short,
    author: 'A',
    authorEmail: 'a@example.invalid',
    date: '2026-01-01T00:00:00.000Z',
    subject,
    body: '',
    parents: isMerge ? ['p1', 'p2'] : ['p1'],
    isMerge,
  };
}

const notes = (commits: CommitInfo[], extra: Partial<Parameters<typeof buildReleaseNotes>[0]> = {}) =>
  buildReleaseNotes({ commits, ticketPattern: PATTERN, from: 'stable', into: 'prod', ...extra });

describe('release notes', () => {
  it('groups commits under their ticket', () => {
    const md = notes([
      commit('[PAY-100] add refunds', 'aaa1111'),
      commit('[PAY-100] validate refunds', 'bbb2222'),
      commit('[PAY-200] add invoices', 'ccc3333'),
    ]);

    expect(md).toContain('## stable → prod');
    expect(md).toContain('- **PAY-100**');
    expect(md).toContain('- **PAY-200**');
    // The ticket is the heading, so it isn't repeated on each line.
    expect(md).toContain('  - add refunds (`aaa1111`)');
    expect(md).not.toContain('  - [PAY-100] add refunds');
  });

  it('sorts tickets and puts unticketed work under Other', () => {
    const md = notes([
      commit('[PAY-300] c', 'ccc'),
      commit('tidy up the build', 'ddd'),
      commit('[PAY-100] a', 'aaa'),
    ]);
    expect(md.indexOf('PAY-100')).toBeLessThan(md.indexOf('PAY-300'));
    expect(md).toContain('- **Other**');
    expect(md).toContain('  - tidy up the build (`ddd`)');
  });

  it('leaves merge commits out, since their content is already listed', () => {
    const md = notes([
      commit('[PAY-100] real work', 'aaa'),
      commit("Merge branch 'feature/x' into develop", 'mmm', true),
    ]);
    expect(md).not.toContain('Merge branch');
    expect(md).toContain('1 commit across 1 group');
  });

  it('links tickets when a Jira base url is configured', () => {
    const md = notes([commit('[PAY-100] a')], {
      jiraBaseUrl: 'https://example.atlassian.net/browse/',
    });
    expect(md).toContain('[PAY-100](https://example.atlassian.net/browse/PAY-100)');
  });

  it('says so plainly when there is nothing to promote', () => {
    expect(notes([])).toContain('Nothing to promote');
  });

  it('falls back to the default pattern if the configured one is invalid', () => {
    const md = buildReleaseNotes({
      commits: [commit('[PAY-100] a')],
      ticketPattern: '([unclosed',
      from: 'stable',
      into: 'prod',
    });
    expect(md).toContain('PAY-100');
  });

  it('keeps the subject when stripping the ticket would empty it', () => {
    const md = notes([commit('[PAY-100]', 'aaa')]);
    expect(md).toContain('[PAY-100]');
  });
});
