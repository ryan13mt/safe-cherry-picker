import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { newFixture, dropFixture, type Fixture } from './helpers.ts';
import { buildMatrix } from '../server/services/matrix.ts';
import { buildPipeline } from '../server/services/pipeline.ts';
import { ReleaseMatrixView } from '../web/src/views/ReleaseMatrix.tsx';
import { PipelineView } from '../web/src/views/PipelineView.tsx';
import { OpDialog } from '../web/src/components/OpDialog.tsx';
import type { ReleaseMatrix, PipelineReport } from '../shared/types.ts';

/**
 * Renders the real views against real fixture data. This is a smoke test, not a
 * substitute for clicking around: server rendering skips effects, so it proves
 * the components build correct markup from live data, not that interactions work.
 */

let fx: Fixture;
let matrix: ReleaseMatrix;
let pipeline: PipelineReport;

beforeAll(async () => {
  fx = newFixture();
  matrix = await buildMatrix('test', fx.repo, fx.branch);
  pipeline = await buildPipeline(fx.repo);
});
afterAll(() => dropFixture(fx));

describe('release matrix view', () => {
  it('renders every ticket with a state per target branch', () => {
    const html = renderToStaticMarkup(
      <ReleaseMatrixView
        matrix={matrix}
        blocked={false}
        branches={[fx.branch, 'develop', 'stable', 'prod']}
        onBranchChange={() => {}}
        onCherryPick={() => {}}
        simulate={async () => {
          throw new Error('not called during render');
        }}
      />,
    );

    for (const ticket of ['JIRA-412', 'JIRA-388', 'JIRA-401', 'JIRA-777']) {
      expect(html, `${ticket} should appear`).toContain(ticket);
    }
    // The half-shipped ticket must be visibly flagged, not just present.
    expect(html).toContain('partial');
    expect(html).toContain('Cherry-pick into');
    expect(html).toContain('7 tickets');
  });

  it('defaults the destination to a branch that still has work outstanding', () => {
    // develop has the whole branch merged, so defaulting there would disable
    // every checkbox and make the screen look broken.
    const html = renderToStaticMarkup(
      <ReleaseMatrixView
        matrix={matrix}
        blocked={false}
        branches={[fx.branch]}
        onBranchChange={() => {}}
        onCherryPick={() => {}}
        simulate={async () => {
          throw new Error('not called during render');
        }}
      />,
    );
    expect(html).toContain('Cherry-pick into stable');
    expect(html).not.toContain('Cherry-pick into develop');
  });

  it('links tickets when a Jira base url is configured', async () => {
    const { setConfig } = await import('../server/config.ts');
    setConfig({ jiraBaseUrl: 'https://example.atlassian.net/browse' });
    const linked = await buildMatrix('test', fx.repo, fx.branch);
    const html = renderToStaticMarkup(
      <ReleaseMatrixView
        matrix={linked}
        blocked={false}
        branches={[fx.branch]}
        onBranchChange={() => {}}
        onCherryPick={() => {}}
        simulate={async () => {
          throw new Error('not called');
        }}
      />,
    );
    expect(html).toContain('https://example.atlassian.net/browse/JIRA-412');
    setConfig({ jiraBaseUrl: '' });
  });
});

describe('unmet dependencies in the matrix', () => {
  /** Two tickets, where B needs a file A created, and A isn't on the target. */
  function matrixWithDependency(dependencyState: 'pending' | 'released'): ReleaseMatrix {
    const commit = (sha: string, subject: string) => ({
      commit: {
        sha,
        short: sha.slice(0, 7),
        author: 'A',
        authorEmail: 'a@example.invalid',
        date: '2026-01-01T00:00:00.000Z',
        subject,
        body: '',
        parents: ['p'],
        isMerge: false,
      },
      ticket: subject.slice(1, 9),
      ticketSource: 'subject' as const,
      status: {
        stable: { method: 'none' as const, confidence: 'none' as const, released: false },
      },
    });
    const summary = (state: 'pending' | 'released') => ({
      stable: {
        state,
        releasedCount: state === 'released' ? 1 : 0,
        likelyCount: 0,
        pendingCount: state === 'released' ? 0 : 1,
        total: 1,
        missing: state === 'released' ? [] : ['aaaaaaa1'],
      },
    });

    return {
      repoId: 'r',
      branch: 'feature/x',
      targets: ['stable'],
      base: 'base',
      truncated: false,
      generatedAt: '',
      authorship: {
        startedBy: {
          name: 'Ben Ito',
          email: 'ben@example.invalid',
          date: '2026-01-01T00:00:00.000Z',
          sha: 'aaaaaaa1',
          short: 'aaaaaaa',
        },
        contributors: [
          { name: 'Ben Ito', email: 'ben@example.invalid', commits: 1 },
          { name: 'Ana Sousa', email: 'ana@example.invalid', commits: 1 },
        ],
      },
      progress: { stable: { releasedTickets: 0, totalTickets: 2 } },
      groups: [
        {
          ticket: 'ACME-200',
          label: 'ACME-200',
          url: null,
          commits: [commit('bbbbbbb1', '[ACME-200] edit the file')],
          summary: summary('pending'),
          authors: [{ name: 'Ana Sousa', email: 'ana@example.invalid', commits: 1 }],
          files: [{ path: 'src/fraud.js', added: 1, removed: 1, created: false, deleted: false }],
          dependsOn: [
            {
              ticket: 'ACME-100',
              label: 'ACME-100',
              strength: 'hard',
              reasons: [
                { path: 'src/fraud.js', kind: 'creates-file', share: 0.8, otherLines: 12, ourLines: 2 },
              ],
            },
          ],
        },
        {
          ticket: 'ACME-100',
          label: 'ACME-100',
          url: null,
          commits: [commit('aaaaaaa1', '[ACME-100] add the file')],
          summary: summary(dependencyState),
          authors: [{ name: 'Ben Ito', email: 'ben@example.invalid', commits: 1 }],
          files: [{ path: 'src/fraud.js', added: 12, removed: 0, created: true, deleted: false }],
          dependsOn: [],
        },
      ],
    };
  }

  const render = (m: ReleaseMatrix) =>
    renderToStaticMarkup(
      <ReleaseMatrixView
        matrix={m}
        blocked={false}
        branches={['feature/x']}
        onBranchChange={() => {}}
        onCherryPick={() => {}}
        simulate={async () => {
          throw new Error('not called');
        }}
      />,
    );

  it('warns that the dependency is not on the target branch', () => {
    const html = render(matrixWithDependency('pending'));
    expect(html).toContain('needs ACME-100');
    expect(html).toContain('not on stable');
    // The per-file detail ("Requires ACME-100 / src/fraud.js created by…") lives
    // in the expanded row, which a server render can't open.
  });

  it('stays quiet once the dependency is already released there', () => {
    // The two were written together, but nothing is outstanding, so there is
    // nothing to warn about.
    const html = render(matrixWithDependency('released'));
    expect(html).not.toContain('needs ACME-100');
    expect(html).not.toContain('not on stable');
  });
});

describe('matrix affordances', () => {
  const render = (m: ReleaseMatrix) =>
    renderToStaticMarkup(
      <ReleaseMatrixView
        matrix={m}
        blocked={false}
        branches={[fx.branch]}
        onBranchChange={() => {}}
        onCherryPick={() => {}}
        simulate={async () => {
          throw new Error('not called');
        }}
      />,
    );

  it('shows per-ticket churn from data the dependency pass already computed', () => {
    const html = render(matrix);
    // "N files +X −Y" next to each ticket.
    expect(html).toMatch(/\d+ files?/);
    expect(html).toContain('stat-add');
    expect(html).toContain('stat-del');
  });

  it('names who wrote each ticket, and who started the branch', () => {
    const html = render(matrix);
    // The fixture is authored by one bot, so it should appear as the starter
    // and against the tickets.
    expect(html).toContain('started by');
    expect(html).toContain('Fixture Bot');
    expect(html).toContain('person-initials');
  });

  it('offers a filter box', () => {
    const html = render(matrix);
    expect(html).toContain('Filter by ticket or subject');
  });
});

describe('copy affordances', () => {
  it('offers to copy the commands, and the release notes when there are any', async () => {
    const { OpDialog: Dialog } = await import('../web/src/components/OpDialog.tsx');
    const html = renderToStaticMarkup(
      <Dialog
        plan={{
          title: 'Promote develop into stable',
          summary: 'Merges everything waiting.',
          preview: ['git merge --no-ff --no-edit -m "Merge" develop'],
          releaseNotes: '## develop → stable\n\n- **JIRA-1**',
        }}
        busy={false}
        error={null}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain('Copy commands');
    expect(html).toContain('Copy release notes');
  });

  it('omits the release-notes button when there is nothing to summarise', async () => {
    const { OpDialog: Dialog } = await import('../web/src/components/OpDialog.tsx');
    const html = renderToStaticMarkup(
      <Dialog
        plan={{ title: 'x', summary: 'y', preview: ['git status'] }}
        busy={false}
        error={null}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain('Copy commands');
    expect(html).not.toContain('Copy release notes');
  });
});

describe('pipeline view', () => {
  it('renders a promote and a back-merge control per leg', () => {
    const html = renderToStaticMarkup(
      <PipelineView
        report={pipeline}
        blocked={false}
        remote={null}
        fetching={false}
        onFetch={() => {}}
        onPromote={() => {}}
        onBackMerge={() => {}}
      />,
    );
    expect(html).toContain('develop');
    expect(html).toContain('stable');
    expect(html).toContain('prod');
    expect(html).toContain('to promote');
    // The hotfix on prod must surface as a back-merge warning.
    expect(html).toContain('needs back-merge');
  });
});

describe('conflict viewer', () => {
  it('shows the three versions, the incoming diff and a way to take each side', async () => {
    const { ConflictViewer } = await import('../web/src/components/ConflictViewer.tsx');
    const html = renderToStaticMarkup(
      <ConflictViewer
        busy={false}
        onResolve={() => {}}
        report={{
          inProgress: true,
          kind: 'cherry-pick',
          target: 'stable',
          worktreePath: 'C:/repo/.git/gcp-worktree',
          incoming: { sha: 'abc', short: 'abc1234', subject: '[JIRA-812] tighten parser' },
          ours: { branch: 'stable', label: 'stable' },
          theirs: {
            branch: 'feature/PAY-1100-fraud-checks',
            commit: { sha: 'abc', short: 'abc1234', subject: '[JIRA-812] tighten parser' },
            label: 'feature/PAY-1100-fraud-checks · abc1234',
          },
          files: [
            {
              path: 'src/parser.ts',
              kind: 'both-modified',
              binary: false,
              truncated: false,
              base: 'original\n',
              ours: 'stable side\n',
              theirs: 'incoming side\n',
              merged: '<<<<<<< HEAD\nstable side\n=======\nincoming side\n>>>>>>> abc\n',
              hunks: [
                {
                  startLine: 1,
                  endLine: 5,
                  contextBefore: [],
                  ours: ['stable side'],
                  theirs: ['incoming side'],
                  contextAfter: [],
                  oursStart: 12,
                  theirsStart: 34,
                  oursBlame: [
                    {
                      sha: 'dddddddd',
                      short: 'ddddddd',
                      author: 'Dana',
                      date: '2026-01-02T00:00:00.000Z',
                      summary: 'stable hotfix',
                    },
                  ],
                  theirsBlame: [
                    {
                      sha: 'eeeeeeee',
                      short: 'eeeeeee',
                      author: 'Eli',
                      date: '2026-02-03T00:00:00.000Z',
                      summary: 'tighten parser',
                    },
                  ],
                },
              ],
              incomingDiff: '@@ -1 +1 @@\n-original\n+incoming side\n',
            },
          ],
        }}
      />,
    );

    expect(html).toContain('src/parser.ts');
    expect(html).toContain('[JIRA-812] tighten parser');
    expect(html).toContain('stable side');
    expect(html).toContain('incoming side');
    expect(html).toContain('Take ours');
    expect(html).toContain('Take theirs');
    expect(html).toContain('both sides changed this file');

    // Both columns are named by branch rather than just "ours"/"theirs".
    expect(html).toContain('feature/PAY-1100-fraud-checks');
    expect(html).toContain('>stable<');

    // Per-line origin, with the full commit detail available on hover.
    expect(html).toContain('ddddddd');
    expect(html).toContain('eeeeeee');
    expect(html).toContain('stable hotfix');
    expect(html).toContain('Dana');

    // Line numbers come from each side's own file.
    expect(html).toContain('>12<');
    expect(html).toContain('>34<');

    // And a control for widening context.
    expect(html).toContain('±10');
  });

  it('offers deletion-aware wording for a modify/delete conflict', async () => {
    const { ConflictViewer } = await import('../web/src/components/ConflictViewer.tsx');
    const html = renderToStaticMarkup(
      <ConflictViewer
        busy={false}
        onResolve={() => {}}
        report={{
          inProgress: true,
          kind: 'cherry-pick',
          target: 'stable',
          files: [
            {
              path: 'gone.ts',
              kind: 'deleted-by-them',
              binary: false,
              truncated: false,
              ours: 'kept\n',
              hunks: [],
            },
          ],
        }}
      />,
    );
    // "Take theirs" would be meaningless here â€” the point is accepting a delete.
    expect(html).toContain('Accept deletion');
    expect(html).not.toContain('Take theirs');
  });

  it('says plainly that a binary file cannot be merged line by line', async () => {
    const { ConflictViewer } = await import('../web/src/components/ConflictViewer.tsx');
    const html = renderToStaticMarkup(
      <ConflictViewer
        busy={false}
        onResolve={() => {}}
        report={{
          inProgress: true,
          kind: 'merge',
          target: 'prod',
          files: [{ path: 'logo.png', kind: 'both-modified', binary: true, truncated: false, hunks: [] }],
        }}
      />,
    );
    expect(html).toContain('binary');
    expect(html).toContain('nothing to merge line by line');
  });
});

describe('operation dialog', () => {
  it('shows the literal commands and the conflict detail before anything runs', () => {
    const html = renderToStaticMarkup(
      <OpDialog
        plan={{
          title: 'Cherry-pick 1 commit into stable',
          summary: 'Applied oldest-first.',
          preview: ['git cherry-pick -x abc1234'],
          styleChoice: true,
          simulation: {
            target: 'stable',
            clean: false,
            applied: [],
            conflicts: ['parser.txt'],
            skippedMerges: [],
            failedAt: { sha: 'abc1234', short: 'abc1234', subject: '[JIRA-812] tighten parser' },
          },
        }}
        busy={false}
        error={null}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(html).toContain('git cherry-pick -x abc1234');
    expect(html).toContain('parser.txt');
    expect(html).toContain('Conflicts in 1 file');
    expect(html).toContain('Run anyway');
    // The safety promise is stated where the user is deciding.
    expect(html).toContain('Nothing is pushed');
  });

  it('offers the individual vs squash choice with the trade-off spelled out', () => {
    const html = renderToStaticMarkup(
      <OpDialog
        plan={{ title: 'x', summary: 'y', preview: ['git cherry-pick -x a'], styleChoice: true }}
        busy={false}
        error={null}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain('Individual commits');
    expect(html).toContain('Squash into one');
    expect(html).toContain('traceable');
  });
});
