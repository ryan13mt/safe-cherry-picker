import { execFileSync } from 'node:child_process';
import { makeFixture, cleanupFixture, type Fixture } from '../scripts/make-fixture.mjs';
import { setConfig } from '../server/config.ts';

export type { Fixture };

/** Builds a fixture and points the app's config at it. */
export function newFixture(): Fixture {
  const fx = makeFixture();
  setConfig({
    scanRoot: fx.repo,
    chain: ['develop', 'stable', 'prod'],
    jiraBaseUrl: '',
  });
  return fx;
}

export function dropFixture(fx: Fixture): void {
  try {
    cleanupFixture(fx.repo);
  } catch {
    // Windows occasionally holds a handle on a worktree directory; a leftover
    // temp dir is not worth failing a test run over.
  }
}

/** Raw git, bypassing the app's wrapper, so assertions are independent of it. */
export function raw(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

/** A snapshot of everything an operation must not disturb. */
export function checkoutSnapshot(repo: string) {
  return {
    head: raw(repo, ['rev-parse', 'HEAD']),
    branch: raw(repo, ['rev-parse', '--abbrev-ref', 'HEAD']),
    status: raw(repo, ['status', '--porcelain']),
  };
}
