import { describe, it, expect } from 'vitest';
import { parseConflictHunks } from '../server/services/conflicts.ts';

/**
 * The hunk parser is pure text handling, so it gets direct tests rather than
 * being exercised only through a real repo.
 */
describe('parseConflictHunks', () => {
  it('returns nothing for a file with no markers', () => {
    expect(parseConflictHunks('just\nsome\nlines\n')).toEqual([]);
  });

  it('splits a two-way conflict into ours and theirs', () => {
    const merged = [
      'context above',
      '<<<<<<< HEAD',
      'ours line',
      '=======',
      'theirs line',
      '>>>>>>> abc1234 (incoming)',
      'context below',
    ].join('\n');

    const [hunk] = parseConflictHunks(merged);
    expect(hunk.ours).toEqual(['ours line']);
    expect(hunk.theirs).toEqual(['theirs line']);
    expect(hunk.base).toBeUndefined();
    expect(hunk.contextBefore).toEqual(['context above']);
    expect(hunk.contextAfter).toEqual(['context below']);
    expect(hunk.startLine).toBe(2);
    expect(hunk.endLine).toBe(6);
  });

  it('captures the ancestor section when diff3 style is configured', () => {
    const merged = [
      '<<<<<<< HEAD',
      'ours',
      '||||||| base',
      'original',
      '=======',
      'theirs',
      '>>>>>>> incoming',
    ].join('\n');

    const [hunk] = parseConflictHunks(merged);
    expect(hunk.ours).toEqual(['ours']);
    expect(hunk.base).toEqual(['original']);
    expect(hunk.theirs).toEqual(['theirs']);
  });

  it('finds every conflicting region in a file', () => {
    const merged = [
      'a',
      '<<<<<<< HEAD',
      'one-ours',
      '=======',
      'one-theirs',
      '>>>>>>> x',
      'b',
      '<<<<<<< HEAD',
      'two-ours',
      '=======',
      'two-theirs',
      '>>>>>>> x',
      'c',
    ].join('\n');

    const hunks = parseConflictHunks(merged);
    expect(hunks).toHaveLength(2);
    expect(hunks[0].theirs).toEqual(['one-theirs']);
    expect(hunks[1].ours).toEqual(['two-ours']);
    // The second hunk's leading context must not swallow the first hunk.
    expect(hunks[1].contextBefore.join('')).not.toContain('<<<');
  });

  it('handles an empty side, which is how a pure addition or deletion appears', () => {
    const merged = ['<<<<<<< HEAD', '=======', 'added by them', '>>>>>>> x'].join('\n');
    const [hunk] = parseConflictHunks(merged);
    expect(hunk.ours).toEqual([]);
    expect(hunk.theirs).toEqual(['added by them']);
  });

  it('does not treat similar-looking lines as markers', () => {
    // Fewer than seven characters, or a marker mid-line, must not count.
    const merged = ['<<<< not a marker', 'a ======= b', '>>>>>> six only'].join('\n');
    expect(parseConflictHunks(merged)).toEqual([]);
  });

  it('reports a side that contributes no lines as empty rather than omitting it', () => {
    // "ours added a line, theirs never had it" — the theirs side is genuinely
    // empty and the UI must say so instead of showing nothing at all.
    const merged = ['<<<<<<< HEAD', 'extra line', '=======', '>>>>>>> x'].join('\n');
    const [hunk] = parseConflictHunks(merged);
    expect(hunk.ours).toEqual(['extra line']);
    expect(hunk.theirs).toEqual([]);
  });

  it('tolerates an unterminated conflict region', () => {
    // Truncated files happen; the parser must not hang or throw.
    const merged = ['<<<<<<< HEAD', 'ours', '=======', 'theirs'].join('\n');
    const hunks = parseConflictHunks(merged);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].theirs).toEqual(['theirs']);
  });
});
