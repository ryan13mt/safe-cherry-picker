import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { git } from '../git.ts';
import type { BlameLine, ConflictDetail, ConflictHunk, ConflictKind } from '../../shared/types.ts';

/**
 * Everything needed to understand a conflict without leaving the app.
 *
 * When git stops on a conflict it records up to three versions of each file in
 * the index: stage 1 is the common ancestor, stage 2 is what the target branch
 * had ("ours"), stage 3 is what the incoming commit wants ("theirs"). Which
 * stages are present tells you what kind of conflict it is — a missing stage 1
 * means both sides added the file independently; a missing stage 2 or 3 means
 * one side deleted it.
 *
 * The working-tree copy holds git's merged attempt with conflict markers, and
 * that's what we parse into hunks for display.
 */

interface IndexStage {
  mode: string;
  sha: string;
  stage: number;
  path: string;
}

/** `git ls-files -u` lists the unmerged index entries with their stage numbers. */
async function unmergedStages(worktree: string): Promise<Map<string, IndexStage[]>> {
  const res = await git(['ls-files', '-u', '-z'], { cwd: worktree, allowFail: true });
  const byPath = new Map<string, IndexStage[]>();
  if (res.code !== 0) return byPath;

  for (const record of res.stdout.split('\0')) {
    if (!record.trim()) continue;
    // "<mode> <sha> <stage>\t<path>"
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    const [mode, sha, stage] = record.slice(0, tab).split(/\s+/);
    const file = record.slice(tab + 1);
    if (!byPath.has(file)) byPath.set(file, []);
    byPath.get(file)!.push({ mode, sha, stage: Number(stage), path: file });
  }
  return byPath;
}

const MAX_BLOB_BYTES = 512 * 1024;

async function blobText(
  worktree: string,
  sha: string,
): Promise<{ text?: string; binary: boolean; truncated: boolean }> {
  const size = await git(['cat-file', '-s', sha], { cwd: worktree, allowFail: true });
  const bytes = Number(size.stdout.trim());
  if (Number.isFinite(bytes) && bytes > MAX_BLOB_BYTES) {
    return { binary: false, truncated: true };
  }
  const res = await git(['cat-file', 'blob', sha], { cwd: worktree, allowFail: true });
  if (res.code !== 0) return { binary: false, truncated: false };
  // A NUL byte is git's own heuristic for "this is not text".
  if (res.stdout.includes('\0')) return { binary: true, truncated: false };
  return { text: res.stdout, binary: false, truncated: false };
}

function classify(stages: IndexStage[]): ConflictKind {
  const has = (n: number) => stages.some((s) => s.stage === n);
  if (!has(1) && has(2) && has(3)) return 'both-added';
  if (has(1) && has(2) && !has(3)) return 'deleted-by-them';
  if (has(1) && !has(2) && has(3)) return 'deleted-by-us';
  return 'both-modified';
}

const START = /^<{7}(?: |$)/;
const BASE = /^\|{7}(?: |$)/;
const SPLIT = /^={7}$/;
const END = /^>{7}(?: |$)/;

/**
 * Splits a conflicted file into its conflicting regions and the context between
 * them, so the UI can show just the parts that need a decision.
 *
 * Handles diff3/zdiff3 output (which includes a `|||||||` base section) as well
 * as the default two-way style, since the user's merge.conflictStyle is their
 * choice, not ours to override.
 */
export function parseConflictHunks(merged: string): ConflictHunk[] {
  const lines = merged.split('\n');
  const hunks: ConflictHunk[] = [];
  let i = 0;
  let contextStart = 0;

  while (i < lines.length) {
    if (!START.test(lines[i])) {
      i++;
      continue;
    }

    const startLine = i;
    const ours: string[] = [];
    const base: string[] = [];
    const theirs: string[] = [];
    let section: 'ours' | 'base' | 'theirs' = 'ours';
    i++;

    while (i < lines.length && !END.test(lines[i])) {
      if (BASE.test(lines[i])) section = 'base';
      else if (SPLIT.test(lines[i])) section = 'theirs';
      else if (section === 'ours') ours.push(lines[i]);
      else if (section === 'base') base.push(lines[i]);
      else theirs.push(lines[i]);
      i++;
    }

    const endLine = Math.min(i, lines.length - 1);
    hunks.push({
      startLine: startLine + 1,
      endLine: endLine + 1,
      contextBefore: lines.slice(Math.max(contextStart, startLine - 3), startLine),
      ours,
      base: base.length ? base : undefined,
      theirs,
      contextAfter: lines.slice(endLine + 1, endLine + 4),
    });

    i++;
    contextStart = i;
  }
  return hunks;
}

/**
 * Per-line origin for one side of a conflict.
 *
 * `--line-porcelain` repeats the full commit header for every line, which is
 * verbose but means we never have to carry state between abbreviated entries.
 */
async function blameFile(
  worktree: string,
  rev: string,
  file: string,
): Promise<BlameLine[] | undefined> {
  const res = await git(['blame', '--line-porcelain', rev, '--', file], {
    cwd: worktree,
    allowFail: true,
  });
  if (res.code !== 0) return undefined;

  const lines: BlameLine[] = [];
  let current: Partial<BlameLine> & { time?: number } = {};

  for (const line of res.stdout.split('\n')) {
    if (/^[0-9a-f]{40} \d+ \d+/.test(line)) {
      const sha = line.slice(0, 40);
      current = { sha, short: sha.slice(0, 7) };
    } else if (line.startsWith('author ')) {
      current.author = line.slice('author '.length);
    } else if (line.startsWith('author-time ')) {
      current.time = Number(line.slice('author-time '.length));
    } else if (line.startsWith('summary ')) {
      current.summary = line.slice('summary '.length);
    } else if (line.startsWith('\t')) {
      // The tab-prefixed line is the content, and closes this entry.
      lines.push({
        sha: current.sha ?? '',
        short: current.short ?? '',
        author: current.author ?? '',
        date: current.time ? new Date(current.time * 1000).toISOString() : '',
        summary: current.summary ?? '',
      });
      current = {};
    }
  }
  return lines;
}

/**
 * Finds where a run of lines sits in its own file.
 *
 * Conflict markers tell us the *content* of each side but not its line numbers,
 * and the merged file's line numbering matches neither side. Searching for the
 * block is the reliable way back. Hunks appear in file order, so searching from
 * the previous hunk's end resolves the case where identical blocks repeat.
 */
function locateBlock(fileLines: string[], block: string[], from: number): number | undefined {
  if (block.length === 0) return undefined;
  // A block of only blank lines would match the first blank line anywhere in the
  // file and attribute it to an unrelated commit. Better to show no origin than
  // a wrong one.
  if (!block.some((line) => line.trim() !== '')) return undefined;
  for (let i = Math.max(0, from); i <= fileLines.length - block.length; i++) {
    let match = true;
    for (let j = 0; j < block.length; j++) {
      if (fileLines[i + j] !== block[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return undefined;
}

/** Blame is a process per file per side, so keep it off pathological cases. */
const MAX_BLAME_LINES = 5000;
const MAX_BLAME_FILES = 25;

export interface ConflictReportInput {
  worktree: string;
  /** The commit being applied, so we can show what it was trying to do. */
  incomingSha?: string;
}

export async function describeConflicts(input: ConflictReportInput): Promise<ConflictDetail[]> {
  const { worktree, incomingSha } = input;
  if (!existsSync(worktree)) return [];

  const stages = await unmergedStages(worktree);
  const details: ConflictDetail[] = [];

  for (const [file, entries] of stages) {
    const kind = classify(entries);
    const stageSha = (n: number) => entries.find((e) => e.stage === n)?.sha;

    const [base, ours, theirs] = await Promise.all([
      stageSha(1) ? blobText(worktree, stageSha(1)!) : Promise.resolve(undefined),
      stageSha(2) ? blobText(worktree, stageSha(2)!) : Promise.resolve(undefined),
      stageSha(3) ? blobText(worktree, stageSha(3)!) : Promise.resolve(undefined),
    ]);

    const binary = Boolean(ours?.binary || theirs?.binary || base?.binary);
    const full = path.join(worktree, file);
    let merged: string | undefined;
    if (!binary && existsSync(full)) {
      try {
        const raw = readFileSync(full, 'utf8');
        if (raw.length <= MAX_BLOB_BYTES) merged = raw;
      } catch {
        // unreadable — leave merged undefined and fall back to the stage views
      }
    }

    // The diff the incoming commit wanted to make to this file: the single most
    // useful piece of context when deciding how to resolve.
    let incomingDiff: string | undefined;
    if (incomingSha && !binary) {
      const res = await git(
        ['show', '--format=', '--unified=3', incomingSha, '--', file],
        { cwd: worktree, allowFail: true },
      );
      if (res.code === 0 && res.stdout.trim()) incomingDiff = res.stdout;
    }

    const hunks = merged ? parseConflictHunks(merged) : [];
    await attachOrigins({
      worktree,
      file,
      hunks,
      oursText: ours?.text,
      theirsText: theirs?.text,
      incomingSha,
      enabled: !binary && details.length < MAX_BLAME_FILES,
    });

    details.push({
      path: file,
      kind,
      binary,
      truncated: Boolean(ours?.truncated || theirs?.truncated || base?.truncated),
      base: base?.text,
      ours: ours?.text,
      theirs: theirs?.text,
      merged,
      hunks,
      incomingDiff,
    });
  }

  details.sort((a, b) => a.path.localeCompare(b.path));
  return details;
}

/**
 * Works out where each hunk's lines live in their own file and who last touched
 * them. HEAD is the target branch (the worktree sits detached on it), and the
 * incoming commit is the other side.
 */
async function attachOrigins(input: {
  worktree: string;
  file: string;
  hunks: ConflictHunk[];
  oursText?: string;
  theirsText?: string;
  incomingSha?: string;
  enabled: boolean;
}): Promise<void> {
  const { worktree, file, hunks, oursText, theirsText, incomingSha, enabled } = input;
  if (!enabled || hunks.length === 0) return;

  const oursLines = oursText?.split('\n');
  const theirsLines = theirsText?.split('\n');

  const oursBlame =
    oursLines && oursLines.length <= MAX_BLAME_LINES
      ? await blameFile(worktree, 'HEAD', file)
      : undefined;
  const theirsBlame =
    theirsLines && theirsLines.length <= MAX_BLAME_LINES && incomingSha
      ? await blameFile(worktree, incomingSha, file)
      : undefined;

  // Hunks are in file order, so advance a cursor per side rather than searching
  // from the top each time — that also disambiguates repeated blocks.
  let oursCursor = 0;
  let theirsCursor = 0;

  for (const hunk of hunks) {
    if (oursLines) {
      const at = locateBlock(oursLines, hunk.ours, oursCursor);
      if (at !== undefined) {
        hunk.oursStart = at + 1;
        oursCursor = at + hunk.ours.length;
        if (oursBlame) hunk.oursBlame = oursBlame.slice(at, at + hunk.ours.length);
      }
    }
    if (theirsLines) {
      const at = locateBlock(theirsLines, hunk.theirs, theirsCursor);
      if (at !== undefined) {
        hunk.theirsStart = at + 1;
        theirsCursor = at + hunk.theirs.length;
        if (theirsBlame) hunk.theirsBlame = theirsBlame.slice(at, at + hunk.theirs.length);
      }
    }
  }
}

export type Resolution = 'ours' | 'theirs';

/**
 * Takes one side wholesale for a single file and stages the result.
 *
 * For a plain content conflict `git checkout --ours/--theirs` picks the right
 * stage. For a delete/modify conflict there is no blob on one side, so "take
 * the deletion" has to be expressed as a removal instead.
 */
export async function resolveFile(
  worktree: string,
  file: string,
  choice: Resolution,
): Promise<string[][]> {
  const stages = await unmergedStages(worktree);
  const entries = stages.get(file);
  if (!entries) throw new Error(`${file} is not conflicted.`);

  const kind = classify(entries);
  const commands: string[][] = [];

  const deletionWins =
    (kind === 'deleted-by-us' && choice === 'ours') ||
    (kind === 'deleted-by-them' && choice === 'theirs');

  if (deletionWins) {
    commands.push(['rm', '-f', '--', file]);
    await git(['rm', '-f', '--', file], { cwd: worktree, write: true });
    return commands;
  }

  const wantedStage = choice === 'ours' ? 2 : 3;
  if (!entries.some((e) => e.stage === wantedStage)) {
    throw new Error(
      `There is no "${choice}" version of ${file} to take — the other side deleted it.`,
    );
  }

  commands.push(['checkout', `--${choice}`, '--', file], ['add', '--', file]);
  await git(['checkout', `--${choice}`, '--', file], { cwd: worktree, write: true });
  await git(['add', '--', file], { cwd: worktree, write: true });
  return commands;
}
