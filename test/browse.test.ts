import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { setConfig } from '../server/config.ts';
import { browse, validateScanRoot } from '../server/services/browse.ts';

let root: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'gcp-browse-'));
  mkdirSync(path.join(root, 'plain-folder'), { recursive: true });
  mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  mkdirSync(path.join(root, 'a-repo'), { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: path.join(root, 'a-repo') });
  writeFileSync(path.join(root, 'a-file.txt'), 'not a directory\n');
  setConfig({ scanRoot: root });
});

afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));

describe('directory browsing', () => {
  it('lists subfolders and flags the ones that are repos', async () => {
    const view = await browse(root);
    const names = view.entries.map((e) => e.name);

    expect(names).toContain('plain-folder');
    expect(names).toContain('a-repo');
    expect(view.entries.find((e) => e.name === 'a-repo')!.isRepo).toBe(true);
    expect(view.entries.find((e) => e.name === 'plain-folder')!.isRepo).toBe(false);
  });

  it('omits files and noise directories', async () => {
    const names = (await browse(root)).entries.map((e) => e.name);
    expect(names).not.toContain('a-file.txt'); // a file, not a folder
    expect(names).not.toContain('node_modules');
    expect(names).not.toContain('.git');
  });

  it('offers a parent to navigate up to, and none at a filesystem root', async () => {
    expect((await browse(root)).parent).toBe(path.dirname(root));
    expect((await browse(path.parse(root).root)).parent).toBeNull();
  });

  it('falls back to somewhere real when the path does not exist', async () => {
    // A saved path can go stale; the picker must still open somewhere usable.
    const view = await browse(path.join(root, 'no', 'such', 'place'));
    expect(view.path).toBe(root);
  });

  it('defaults to the configured scan root', async () => {
    expect((await browse()).path).toBe(root);
  });

  it('always suggests home as a starting point', async () => {
    const view = await browse(root);
    expect(view.suggestions.map((s) => s.path)).toContain(homedir());
  });

  it('reports an unreadable directory rather than throwing', async () => {
    // A path that exists as a file behaves like an unreadable directory here.
    const view = await browse(path.join(root, 'a-file.txt'));
    expect(view.unreadable).toBe(true);
    expect(view.entries).toEqual([]);
  });

  it('lists drive roots on Windows only', async () => {
    const view = await browse(root);
    if (process.platform === 'win32') {
      expect(view.drives.length).toBeGreaterThan(0);
      expect(view.drives).toContain('C:\\');
    } else {
      expect(view.drives).toEqual([]);
    }
  });
});

describe('scan root validation', () => {
  it('accepts an existing directory and returns it resolved', async () => {
    expect(await validateScanRoot(root)).toBe(path.resolve(root));
    expect(await validateScanRoot(`${root}${path.sep}.${path.sep}`)).toBe(path.resolve(root));
  });

  it('explains a missing folder', async () => {
    await expect(validateScanRoot(path.join(root, 'nope'))).rejects.toThrow(/does not exist/);
  });

  it('explains that a file is not a folder', async () => {
    await expect(validateScanRoot(path.join(root, 'a-file.txt'))).rejects.toThrow(/not a folder/);
  });
});
