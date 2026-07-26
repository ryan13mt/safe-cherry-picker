import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config.ts';
import type { BrowseResult, DirEntry } from '../../shared/types.ts';

/**
 * A server-side directory browser, so the scan folder can be chosen in the UI.
 *
 * A browser's own folder picker is no use here: for security it hands back an
 * opaque handle, never a filesystem path, and the server needs a real path to
 * run git in. So the server lists directories and the client navigates them.
 *
 * This is read-only and returns nothing but directory names and a "looks like a
 * repo" flag. It is still, deliberately, the ability to enumerate directories on
 * this machine — acceptable because the server binds 127.0.0.1 and already reads
 * the user's repositories, but it is why that binding matters.
 */

/** Noise that is never a useful choice of scan root. */
const HIDE = new Set([
  '.git',
  'node_modules',
  '$RECYCLE.BIN',
  'System Volume Information',
  '$WinREAgent',
  'DumpStack.log.tmp',
]);

export async function isRepoDir(dir: string): Promise<boolean> {
  try {
    await stat(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

/** Windows drive roots, probed cheaply. Empty on other platforms. */
function driveRoots(): string[] {
  if (process.platform !== 'win32') return [];
  const drives: string[] = [];
  for (let code = 'A'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code++) {
    const root = `${String.fromCharCode(code)}:\\`;
    if (existsSync(root)) drives.push(root);
  }
  return drives;
}

/** Null when `dir` is already a filesystem root. */
function parentOf(dir: string): string | null {
  const parent = path.dirname(dir);
  return parent === dir ? null : parent;
}

export async function browse(target?: string): Promise<BrowseResult> {
  const cfg = loadConfig();
  const home = homedir();
  const requested = target?.trim() ? path.resolve(target) : cfg.scanRoot;

  // Fall back to somewhere real rather than erroring, so a stale saved path
  // can't leave the picker with nowhere to start.
  let dir = requested;
  if (!existsSync(dir)) dir = existsSync(cfg.scanRoot) ? cfg.scanRoot : home;

  const suggestions = [
    { label: 'Home', path: home },
    { label: 'Current scan root', path: cfg.scanRoot },
  ].filter((s, i, all) => existsSync(s.path) && all.findIndex((o) => o.path === s.path) === i);

  let entries: DirEntry[] = [];
  let unreadable = false;
  try {
    const raw = await readdir(dir, { withFileTypes: true });
    const dirs = raw.filter((e) => e.isDirectory() && !HIDE.has(e.name));
    entries = await Promise.all(
      dirs.map(async (e) => {
        const full = path.join(dir, e.name);
        return { name: e.name, path: full, isRepo: await isRepoDir(full) };
      }),
    );
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  } catch {
    unreadable = true;
  }

  return { path: dir, parent: parentOf(dir), entries, drives: driveRoots(), unreadable, suggestions };
}

/** Checks a candidate scan root, with messages aimed at the person choosing it. */
export async function validateScanRoot(target: string): Promise<string> {
  const resolved = path.resolve(target.trim());

  let info;
  try {
    info = await stat(resolved);
  } catch {
    throw new Error(`${resolved} does not exist.`);
  }
  if (!info.isDirectory()) {
    throw new Error(`${resolved} is a file, not a folder.`);
  }
  try {
    await readdir(resolved);
  } catch {
    throw new Error(`${resolved} cannot be read — check the folder's permissions.`);
  }
  return resolved;
}
