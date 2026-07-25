import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { newFixture, dropFixture, raw, type Fixture } from './helpers.ts';
import { buildPipeline } from '../server/services/pipeline.ts';
import type { PipelineReport } from '../shared/types.ts';

let fx: Fixture;
let report: PipelineReport;

beforeAll(async () => {
  fx = newFixture();
  report = await buildPipeline(fx.repo);
});
afterAll(() => dropFixture(fx));

describe('pipeline drift', () => {
  it('reports one leg per adjacent pair, upstream to downstream', () => {
    expect(report.chain).toEqual(['develop', 'stable', 'prod']);
    expect(report.legs.map((l) => [l.upstream, l.downstream])).toEqual([
      ['develop', 'stable'],
      ['stable', 'prod'],
    ]);
  });

  it('counts what is waiting to be promoted', () => {
    const leg = report.legs.find((l) => l.upstream === 'develop')!;
    const expected = Number(raw(fx.repo, ['rev-list', '--count', 'stable..develop']));
    expect(leg.ahead.length).toBe(expected);
    expect(leg.ahead.length).toBeGreaterThan(0);
  });

  it('surfaces the hotfix that prod has and stable does not', () => {
    // The back-merge signal: without this, a production fix quietly rots.
    const leg = report.legs.find((l) => l.downstream === 'prod')!;
    expect(leg.behind.map((c) => c.sha)).toContain(fx.hotfix);
    expect(leg.behind.length).toBe(
      Number(raw(fx.repo, ['rev-list', '--count', 'stable..prod'])),
    );
  });

  it('skips chain branches the repo does not have', async () => {
    const partial = await buildPipeline(fx.repo, ['develop', 'nonexistent', 'prod']);
    expect(partial.chain).toEqual(['develop', 'prod']);
    expect(partial.legs).toHaveLength(1);
  });
});
