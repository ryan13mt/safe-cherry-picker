import { readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { loadConfig } from '../config.ts';
import { git, gitLine } from '../git.ts';
import type { RepoSummary, WorkingTreeStatus } from '../../shared/types.ts';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'vendor',
  'target',
  '.next',
  '.venv',
  '__pycache__',
]);

export interface DiscoveredRepo {
  id: string;
  name: string;
  path: string;
}

/** Stable across restarts, and safe in a URL. */
export function repoId(absPath: string): string {
  return createHash('sha1').update(path.resolve(absPath).toLowerCase()).digest('hex').slice(0, 12);
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function isRepo(dir: string): Promise<boolean> {
  const dotGit = path.join(dir, '.git');
  try {
    const info = await stat(dotGit);
    // A linked worktree records .git as a file pointing at the real git dir.
    if (info.isFile()) return true;
    // A directory called .git isn't automatically a repo; require HEAD, so a
    // stray or half-deleted folder doesn't show up as a phantom entry.
    await stat(path.join(dotGit, 'HEAD'));
    return true;
  } catch {
    return false;
  }
}

/**
 * `isRoot` matters: the scan root may itself be a repo while also containing the
 * repos you actually care about. Stopping at the first `.git` would hide every
 * one of them, so the root is recorded and still descended into.
 */
/**
 * A directory budget for one scan. Without it, choosing something like `C:\` in
 * the folder picker would walk a large part of the filesystem and hang the
 * request. The cap is reported back so the UI can say the list is incomplete
 * rather than quietly showing too few repos.
 */
const MAX_DIRS_VISITED = 6000;

export interface ScanStats {
  visited: number;
  truncated: boolean;
}

let lastScan: ScanStats = { visited: 0, truncated: false };
export function lastScanStats(): ScanStats {
  return { ...lastScan };
}

async function walk(
  dir: string,
  depth: number,
  found: DiscoveredRepo[],
  isRoot = false,
): Promise<void> {
  if (depth < 0) return;
  if (lastScan.visited >= MAX_DIRS_VISITED) {
    lastScan.truncated = true;
    return;
  }
  lastScan.visited++;

  if (await isRepo(dir)) {
    found.push({ id: repoId(dir), name: path.basename(dir), path: dir });
    // Below the root, don't descend into a repo: submodules and nested clones
    // are out of scope.
    if (!isRoot) return;
  }
  if (depth === 0) return;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // permission denied, transient junction, etc.
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    await walk(path.join(dir, entry.name), depth - 1, found);
  }
}

let cache: { at: number; repos: DiscoveredRepo[] } | null = null;
const CACHE_MS = 10_000;

export async function discoverRepos(force = false): Promise<DiscoveredRepo[]> {
  const cfg = loadConfig();
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.repos;

  const found: DiscoveredRepo[] = [];
  lastScan = { visited: 0, truncated: false };
  if (await isDir(cfg.scanRoot)) {
    await walk(cfg.scanRoot, cfg.scanDepth, found, true);
  }
  found.sort((a, b) => a.name.localeCompare(b.name));
  cache = { at: Date.now(), repos: found };
  return found;
}

export function clearRepoCache(): void {
  cache = null;
}

/**
 * Resolves an id to a repo, refusing anything that escapes the configured scan
 * root. This is the guard that stops a crafted API call reaching an arbitrary
 * path on disk.
 */
export async function resolveRepo(id: string): Promise<DiscoveredRepo> {
  const repos = await discoverRepos();
  const hit = repos.find((r) => r.id === id);
  if (!hit) throw new Error(`Unknown repo id: ${id}`);

  const cfg = loadConfig();
  const rel = path.relative(cfg.scanRoot, hit.path);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Repo ${hit.name} resolves outside the configured scan root.`);
  }
  return hit;
}

export async function localBranches(repoPath: string): Promise<string[]> {
  const { stdout } = await git(
    ['for-each-ref', '--format=%(refname:short)', 'refs/heads'],
    { cwd: repoPath },
  );
  return stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

export async function currentBranch(repoPath: string): Promise<string | null> {
  const res = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    cwd: repoPath,
    allowFail: true,
  });
  const name = res.stdout.trim();
  return name || null; // empty when HEAD is detached
}

export async function isDirty(repoPath: string): Promise<boolean> {
  const { stdout } = await git(['status', '--porcelain'], { cwd: repoPath });
  return stdout.trim().length > 0;
}

const MAX_LISTED_FILES = 50;

/**
 * What is uncommitted in the user's checkout, split by kind.
 *
 * Parsed from `--porcelain -z`: entries are NUL-terminated, and a rename or copy
 * carries two paths, so those records consume an extra field.
 */
export async function workingTreeStatus(repoPath: string): Promise<WorkingTreeStatus> {
  const { stdout } = await git(['status', '--porcelain', '-z'], { cwd: repoPath });
  const fields = stdout.split('\0');

  const tracked: string[] = [];
  const untracked: string[] = [];

  for (let i = 0; i < fields.length; i++) {
    const record = fields[i];
    if (!record) continue;
    const code = record.slice(0, 2);
    const file = record.slice(3);
    if (code === '??') untracked.push(file);
    else tracked.push(file);
    // Renames and copies report "<new>\0<old>"; skip the second path.
    if (code[0] === 'R' || code[0] === 'C') i++;
  }

  const count = tracked.length + untracked.length;
  return {
    dirty: count > 0,
    tracked: tracked.slice(0, MAX_LISTED_FILES),
    untracked: untracked.slice(0, MAX_LISTED_FILES),
    truncated: count > MAX_LISTED_FILES,
    count,
  };
}

/**
 * Whether the working tree should stop new operations from starting, per the
 * `blockOnDirty` setting. Deliberately about *starting* work: finishing or
 * unwinding an operation already in flight is never blocked, or a stray file
 * could trap a paused cherry-pick with no way out.
 */
export function dirtyBlockReason(status: WorkingTreeStatus): string | undefined {
  const mode = loadConfig().blockOnDirty;
  if (mode === 'off') return undefined;

  const relevant = mode === 'tracked' ? status.tracked : [...status.tracked, ...status.untracked];
  if (relevant.length === 0) return undefined;

  const shown = relevant.slice(0, 5).join(', ');
  const more = status.count > 5 ? `, and ${status.count - 5} more` : '';
  return (
    `This repository has ${status.count} uncommitted change${status.count === 1 ? '' : 's'} ` +
    `(${shown}${more}). Commit or stash them before running operations.`
  );
}

const CLEAN: WorkingTreeStatus = {
  dirty: false,
  tracked: [],
  untracked: [],
  truncated: false,
  count: 0,
};

export async function summarise(repo: DiscoveredRepo): Promise<RepoSummary> {
  const cfg = loadConfig();
  let branches: string[] = [];
  let current: string | null = null;
  let uncommitted: WorkingTreeStatus = CLEAN;
  try {
    branches = await localBranches(repo.path);
    current = await currentBranch(repo.path);
    uncommitted = await workingTreeStatus(repo.path);
  } catch {
    // An empty repo (no commits yet) can't answer these; report it as-is
    // rather than dropping it from the list.
  }
  const present = cfg.chain.filter((b) => branches.includes(b));
  const missing = cfg.chain.filter((b) => !branches.includes(b));
  const blockedReason = dirtyBlockReason(uncommitted);
  return {
    id: repo.id,
    name: repo.name,
    path: repo.path,
    chain: present,
    missingChain: missing,
    currentBranch: current,
    dirty: uncommitted.dirty,
    uncommitted,
    blocked: Boolean(blockedReason),
    blockedReason,
  };
}

/** True when the ref exists in this repo. */
export async function refExists(repoPath: string, ref: string): Promise<boolean> {
  const res = await gitLine(['rev-parse', '--quiet', '--verify', `${ref}^{commit}`], {
    cwd: repoPath,
    allowFail: true,
  }).catch(() => '');
  return res.length > 0;
}
