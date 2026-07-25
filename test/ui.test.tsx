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

describe('pipeline view', () => {
  it('renders a promote and a back-merge control per leg', () => {
    const html = renderToStaticMarkup(
      <PipelineView report={pipeline} onPromote={() => {}} onBackMerge={() => {}} />,
    );
    expect(html).toContain('develop');
    expect(html).toContain('stable');
    expect(html).toContain('prod');
    expect(html).toContain('to promote');
    // The hotfix on prod must surface as a back-merge warning.
    expect(html).toContain('needs back-merge');
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
