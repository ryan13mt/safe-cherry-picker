import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    // Clears throwaway repos before and after the run; see the file for why the
    // per-test cleanup isn't always enough on Windows.
    globalSetup: ['test/global-setup.ts'],
    // Each test drives real git processes against a real fixture repo.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Fixture repos are created and mutated per file; running files in parallel
    // is fine, but tests within a file share a repo and must stay ordered.
    fileParallelism: true,
    sequence: { concurrent: false },
  },
});
