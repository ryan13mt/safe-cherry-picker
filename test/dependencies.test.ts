import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RepoBuilder } from './repo-builder.ts';
import { buildMatrix } from '../server/services/matrix.ts';
import type { ReleaseMatrix, TicketGroup } from '../shared/types.ts';

/**
 * Cross-ticket dependency detection: which tickets are standing on files another
 * ticket created, or rewrote most of.
 */

let repo: RepoBuilder;

beforeEach(() => {
  repo = new RepoBuilder('prod');
  repo.use(['develop', 'stable', 'prod']);
});
afterEach(() => repo.dispose());

const group = (m: ReleaseMatrix, ticket: string): TicketGroup =>
  m.groups.find((g) => g.ticket === ticket) ??
  (() => {
    throw new Error(`no group for ${ticket}. got: ${m.groups.map((g) => g.ticket).join(', ')}`);
  })();

function base() {
  repo.write('README.md', '# app\n').commit('initial');
  repo.branch('stable').branch('develop');
  repo.checkout('work', 'develop');
}

/**
 * Like `base`, but the given file already exists *before* the branch is cut, so
 * it is outside the matrix range and no ticket on the branch created it. That
 * isolates the churn signal from the creates-file one.
 */
function baseWithExistingFile(file: string, contents: string) {
  repo.write('README.md', '# app\n').commit('initial');
  repo.write(file, contents).commit('scaffold');
  repo.branch('stable').branch('develop');
  repo.checkout('work', 'develop');
}

const lines = (n: number, prefix: string) =>
  `${Array.from({ length: n }, (_, i) => `${prefix} ${i}`).join('\n')}\n`;

describe('creates-file dependency', () => {
  it('flags a ticket that edits a file another ticket added', async () => {
    base();
    repo.write('src/fraud.js', 'export function score() { return 0; }\n');
    repo.commit('[ACME-100] add fraud scoring');

    repo.write('src/fraud.js', 'export function score() { return 1; }\n');
    repo.commit('[ACME-200] tune fraud scoring');
    repo.checkout('prod');

    const m = await buildMatrix('t', repo.path, 'work');
    const dep = group(m, 'ACME-200').dependsOn;

    expect(dep).toHaveLength(1);
    expect(dep[0].ticket).toBe('ACME-100');
    expect(dep[0].strength).toBe('hard');
    expect(dep[0].reasons[0]).toMatchObject({ path: 'src/fraud.js', kind: 'creates-file' });

    // The dependency is one-way: the creator does not depend on the editor.
    expect(group(m, 'ACME-100').dependsOn).toEqual([]);
  });

  it('does not invent a dependency when each ticket owns its own files', async () => {
    base();
    repo.write('a.js', 'a\n').commit('[ACME-100] add a');
    repo.write('b.js', 'b\n').commit('[ACME-200] add b');
    repo.checkout('prod');

    const m = await buildMatrix('t', repo.path, 'work');
    expect(group(m, 'ACME-100').dependsOn).toEqual([]);
    expect(group(m, 'ACME-200').dependsOn).toEqual([]);
  });
});

describe('dominant-churn dependency', () => {
  it('flags heavy overlap when another ticket wrote most of a shared file', async () => {
    baseWithExistingFile('src/engine.js', lines(4, 'base'));

    // ACME-100 rewrites it substantially.
    repo.write('src/engine.js', lines(40, 'heavy')).commit('[ACME-100] rewrite the engine');

    // ACME-200 makes a small edit to the same file afterwards.
    repo.write('src/engine.js', `${lines(40, 'heavy')}// small tweak\n`);
    repo.commit('[ACME-200] tweak the engine');
    repo.checkout('prod');

    const m = await buildMatrix('t', repo.path, 'work');
    const dep = group(m, 'ACME-200').dependsOn;

    expect(dep).toHaveLength(1);
    expect(dep[0].ticket).toBe('ACME-100');
    expect(dep[0].strength).toBe('soft');
    const reason = dep[0].reasons[0];
    expect(reason.kind).toBe('dominant-churn');
    expect(reason.path).toBe('src/engine.js');
    expect(reason.share).toBeGreaterThan(0.5);
    expect(reason.otherLines).toBeGreaterThan(reason.ourLines);
  });

  it('ignores trivial overlap below the churn floor', async () => {
    baseWithExistingFile('shared.js', lines(6, 'x'));
    // Two lines is well under the floor, so this is noise, not a dependency.
    repo.write('shared.js', `${lines(6, 'x')}one\n`).commit('[ACME-100] add a line');
    repo.write('shared.js', `${lines(6, 'x')}one\ntwo\n`).commit('[ACME-200] add another line');
    repo.checkout('prod');

    const m = await buildMatrix('t', repo.path, 'work');
    expect(group(m, 'ACME-200').dependsOn).toEqual([]);
  });
});

describe('unticketed work', () => {
  it('reports a dependency on Ungrouped commits, which still have to be picked', async () => {
    base();
    // No ticket prefix, and the branch name has none either, so this lands in
    // Ungrouped — but it created the file, so the dependency is real.
    repo.write('src/util.js', 'export const x = 1;\n').commit('add a util, no ticket');
    repo.write('src/util.js', 'export const x = 2;\n').commit('[ACME-100] use the util');
    repo.checkout('prod');

    const m = await buildMatrix('t', repo.path, 'work');
    const dep = group(m, 'ACME-100').dependsOn;

    expect(dep).toHaveLength(1);
    expect(dep[0].ticket).toBeNull();
    expect(dep[0].label).toBe('Ungrouped');
    expect(dep[0].strength).toBe('hard');
  });
});

describe('ordering', () => {
  it('only an earlier ticket can be depended upon', async () => {
    base();
    // ACME-200 comes first here, so ACME-100 is the one with the dependency.
    repo.write('src/thing.js', 'export const a = 1;\n').commit('[ACME-200] add thing');
    repo.write('src/thing.js', 'export const a = 2;\n').commit('[ACME-100] change thing');
    repo.checkout('prod');

    const m = await buildMatrix('t', repo.path, 'work');
    expect(group(m, 'ACME-100').dependsOn.map((d) => d.ticket)).toEqual(['ACME-200']);
    expect(group(m, 'ACME-200').dependsOn).toEqual([]);
  });
});

describe('file churn reporting', () => {
  it('lists each ticket\'s files with line counts, biggest first', async () => {
    base();
    repo.write('small.js', lines(2, 's'));
    repo.write('big.js', lines(30, 'b'));
    repo.commit('[ACME-100] add two files');
    repo.checkout('prod');

    const m = await buildMatrix('t', repo.path, 'work');
    const files = group(m, 'ACME-100').files;

    expect(files.map((f) => f.path)).toEqual(['big.js', 'small.js']);
    expect(files[0].added).toBe(30);
    expect(files[0].created).toBe(true);
  });

  it('records a deletion', async () => {
    base();
    repo.write('doomed.js', lines(5, 'd')).commit('scaffold doomed');
    repo.remove('doomed.js').commit('[ACME-100] delete doomed');
    repo.checkout('prod');

    const m = await buildMatrix('t', repo.path, 'work');
    const file = group(m, 'ACME-100').files.find((f) => f.path === 'doomed.js')!;
    expect(file.deleted).toBe(true);
    expect(file.removed).toBe(5);
  });

  it('survives a binary file, where git reports no line counts', async () => {
    base();
    repo.binary('logo.png', 7).commit('[ACME-100] add a binary');
    repo.checkout('prod');

    const m = await buildMatrix('t', repo.path, 'work');
    const file = group(m, 'ACME-100').files.find((f) => f.path === 'logo.png')!;
    // "-" for added/removed must not become NaN.
    expect(file.added).toBe(0);
    expect(file.removed).toBe(0);
    expect(file.created).toBe(true);
  });
});
