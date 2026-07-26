import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(here, '..');

export interface AppConfig {
  scanRoot: string;
  scanDepth: number;
  /** Ordered upstream -> downstream. Promotion merges chain[i] into chain[i+1]. */
  chain: string[];
  /**
   * Refuse to start operations while the repo has uncommitted changes.
   *  'any'     — modifications or untracked files (default)
   *  'tracked' — modifications only; stray untracked files are tolerated
   *  'off'     — no check
   */
  blockOnDirty: 'any' | 'tracked' | 'off';
  maxBranchCommits: number;
  maxTargetIndexCommits: number;
  ticketPattern: string;
  branchTicketPattern: string;
  jiraBaseUrl: string;
  port: number;
}

const defaults: AppConfig = {
  scanRoot: path.resolve(projectRoot, '..'),
  scanDepth: 3,
  chain: ['develop', 'stable', 'prod'],
  blockOnDirty: 'any',
  maxBranchCommits: 1000,
  maxTargetIndexCommits: 5000,
  ticketPattern: '^\\s*\\[([A-Za-z][A-Za-z0-9]*-\\d+)\\]',
  branchTicketPattern: '([A-Za-z][A-Za-z0-9]*-\\d+)',
  jiraBaseUrl: '',
  port: 5179,
};

function readIfPresent(file: string): Partial<AppConfig> {
  if (!existsSync(file)) return {};
  try {
    // Strip a UTF-8 BOM: Notepad and PowerShell's Set-Content both add one, and
    // JSON.parse rejects it outright.
    const raw = readFileSync(file, 'utf8').replace(/^﻿/, '');
    return JSON.parse(raw) as Partial<AppConfig>;
  } catch (err) {
    throw new Error(`Could not parse ${file}: ${(err as Error).message}`);
  }
}

let cached: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cached) return cached;
  const base = readIfPresent(path.join(projectRoot, '.gcprc.json'));
  const local = readIfPresent(path.join(projectRoot, '.gcprc.local.json'));
  const merged = { ...defaults, ...base, ...local };
  merged.scanRoot = path.resolve(merged.scanRoot);
  cached = merged;
  return merged;
}

export const LOCAL_CONFIG_FILE = '.gcprc.local.json';

/**
 * Persists an override to `.gcprc.local.json` and reloads.
 *
 * The local file exists precisely so machine-specific choices — which folder to
 * scan, above all — don't have to be committed. Writing here rather than to
 * `.gcprc.json` keeps the checked-in defaults intact.
 */
export function persistLocalConfig(patch: Partial<AppConfig>): AppConfig {
  const file = path.join(projectRoot, LOCAL_CONFIG_FILE);
  const merged = { ...readIfPresent(file), ...patch };
  writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  cached = null; // force a reload so the change takes effect without a restart
  return loadConfig();
}

/** Test hook: override config without touching disk. */
export function setConfig(patch: Partial<AppConfig>): AppConfig {
  cached = { ...loadConfig(), ...patch };
  if (patch.scanRoot) cached.scanRoot = path.resolve(patch.scanRoot);
  return cached;
}

export function resetConfig(): void {
  cached = null;
}
