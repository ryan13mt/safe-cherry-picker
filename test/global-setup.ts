import { readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Sweeps up throwaway repos at the end of a run.
 *
 * Every test disposes of its own fixture, but on Windows `rmSync` intermittently
 * loses a race with a handle that hasn't been released yet — git worktrees are
 * the usual culprit. Each test swallowing that failure is right (a stray temp
 * directory shouldn't fail a run) but it means they accumulate, and a leftover
 * directory is a plausible source of cross-run interference.
 *
 * By teardown every git process has long exited, so this pass generally
 * succeeds where the in-test one didn't.
 */

const PREFIXES = ['gcp-fixture-', 'gcp-edge-', 'gcp-scan-', 'gcp-browse-', 'gcp-origin-'];

/**
 * Only touch directories older than this.
 *
 * This matters more than it looks: a second test run — or a stray cleanup
 * command — sweeping the same prefixes would otherwise delete the live fixtures
 * of a run already in progress, and the victim fails in a way that looks like a
 * flaky test rather than external interference. Anything this old cannot belong
 * to a running suite.
 */
const MIN_AGE_MS = 60 * 60 * 1000;

export function setup(): void {
  sweep();
}

export function teardown(): void {
  sweep();
}

function sweep(): void {
  const dir = tmpdir();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  const cutoff = Date.now() - MIN_AGE_MS;
  for (const name of entries) {
    if (!PREFIXES.some((p) => name.startsWith(p))) continue;
    const full = path.join(dir, name);
    try {
      const info = statSync(full);
      if (!info.isDirectory() || info.mtimeMs > cutoff) continue;
      rmSync(full, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    } catch {
      // Locked or already gone. It is a temp directory; leave it.
    }
  }
}
