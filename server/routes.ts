import { Router } from 'express';
import { z } from 'zod';
import { loadConfig, persistLocalConfig } from './config.ts';
import { commandHistory, GitPolicyError } from './git.ts';
import {
  discoverRepos,
  resolveRepo,
  summarise,
  localBranches,
  clearRepoCache,
  lastScanStats,
} from './services/discover.ts';
import { browse, validateScanRoot } from './services/browse.ts';
import { buildCleanupReport, deleteBranch } from './services/cleanup.ts';
import { findTicket } from './services/lookup.ts';
import { remoteReport, fetchRemotes } from './services/remote.ts';
import { buildPipeline } from './services/pipeline.ts';
import { buildMatrix } from './services/matrix.ts';
import { simulateCherryPick } from './services/dryrun.ts';
import { logCommits } from './services/commits.ts';
import {
  cherryPick,
  merge,
  operationStatus,
  continueOperation,
  abortOperation,
  skipOperation,
  conflictReport,
  resolveConflict,
  previewCommands,
} from './services/ops.ts';

const shaSchema = z.string().regex(/^[0-9a-f]{7,40}$/i, 'Not a git object id');
const branchSchema = z
  .string()
  .min(1)
  .max(255)
  // Reject anything that could be read as an option or a path escape.
  .refine((s) => !s.startsWith('-') && !s.includes('..') && !/[\0\n\r]/.test(s), {
    message: 'Invalid branch name',
  });

export const router = Router();

function fail(res: import('express').Response, err: unknown): void {
  const status = err instanceof GitPolicyError ? 403 : 400;
  res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
}

router.get('/config', (_req, res) => {
  const cfg = loadConfig();
  const scan = lastScanStats();
  res.json({
    scanRoot: cfg.scanRoot,
    chain: cfg.chain,
    jiraBaseUrl: cfg.jiraBaseUrl,
    ticketPattern: cfg.ticketPattern,
    scanTruncated: scan.truncated,
    scanVisited: scan.visited,
  });
});

/**
 * A filesystem path, not a git revision — so the rules differ from branchSchema.
 * Absolute Windows and POSIX paths are both fine; control characters are not.
 */
const fsPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => !/[\0\r\n]/.test(p), { message: 'Invalid path' });

router.get('/browse', async (req, res) => {
  try {
    const target = req.query.path === undefined ? undefined : fsPathSchema.parse(req.query.path);
    res.json(await browse(target));
  } catch (err) {
    fail(res, err);
  }
});

router.post('/config/scan-root', async (req, res) => {
  try {
    const { path: requested } = z.object({ path: fsPathSchema }).parse(req.body);
    const resolved = await validateScanRoot(requested);

    persistLocalConfig({ scanRoot: resolved });
    clearRepoCache();

    // Scan immediately so the response can say what was actually found, rather
    // than leaving the user to guess whether the folder was a good choice.
    const repos = await discoverRepos(true);
    const scan = lastScanStats();
    res.json({
      scanRoot: resolved,
      repoCount: repos.length,
      truncated: scan.truncated,
      visited: scan.visited,
    });
  } catch (err) {
    fail(res, err);
  }
});

router.get('/commands', (_req, res) => {
  res.json(commandHistory());
});

router.get('/repos', async (req, res) => {
  try {
    if (req.query.refresh === '1') clearRepoCache();
    const repos = await discoverRepos(req.query.refresh === '1');
    res.json(await Promise.all(repos.map(summarise)));
  } catch (err) {
    fail(res, err);
  }
});

router.get('/repos/:id/branches', async (req, res) => {
  try {
    const repo = await resolveRepo(req.params.id);
    const [branches, summary] = await Promise.all([
      localBranches(repo.path),
      summarise(repo),
    ]);
    res.json({ branches, ...summary });
  } catch (err) {
    fail(res, err);
  }
});

router.get('/repos/:id/pipeline', async (req, res) => {
  try {
    const repo = await resolveRepo(req.params.id);
    res.json(await buildPipeline(repo.path));
  } catch (err) {
    fail(res, err);
  }
});

router.get('/repos/:id/release-status', async (req, res) => {
  try {
    const branch = branchSchema.parse(req.query.branch);
    const repo = await resolveRepo(req.params.id);
    res.json(await buildMatrix(repo.id, repo.path, branch));
  } catch (err) {
    fail(res, err);
  }
});

const simulateSchema = z.object({
  target: branchSchema,
  commits: z.array(shaSchema).min(1).max(500),
});

router.post('/repos/:id/simulate', async (req, res) => {
  try {
    const body = simulateSchema.parse(req.body);
    const repo = await resolveRepo(req.params.id);
    const commits = await logCommits({
      cwd: repo.path,
      revs: ['--no-walk', ...body.commits],
    });
    // Oldest first: the order the picks would actually be applied in.
    commits.sort((a, b) => a.date.localeCompare(b.date));
    res.json(await simulateCherryPick({ repoPath: repo.path, target: body.target, commits }));
  } catch (err) {
    fail(res, err);
  }
});

const cherryPickSchema = z.object({
  target: branchSchema,
  commits: z.array(shaSchema).min(1).max(500),
  style: z.enum(['individual', 'squash']).default('individual'),
  message: z.string().max(5000).optional(),
  /** Purely for labelling a paused conflict; never passed to git as a revision. */
  sourceBranch: branchSchema.optional(),
  dryRun: z.boolean().default(false),
});

router.post('/repos/:id/cherry-pick', async (req, res) => {
  try {
    const body = cherryPickSchema.parse(req.body);
    const repo = await resolveRepo(req.params.id);
    const result = await cherryPick({
      repoPath: repo.path,
      target: body.target,
      shas: body.commits,
      style: body.style,
      message: body.message,
      sourceBranch: body.sourceBranch,
      dryRun: body.dryRun,
    });
    res.json({ ...result, preview: previewCommands(result.commands) });
  } catch (err) {
    fail(res, err);
  }
});

const mergeSchema = z.object({
  from: branchSchema,
  into: branchSchema,
  noFf: z.boolean().default(true),
  message: z.string().max(5000).optional(),
  dryRun: z.boolean().default(false),
});

router.post('/repos/:id/merge', async (req, res) => {
  try {
    const body = mergeSchema.parse(req.body);
    const repo = await resolveRepo(req.params.id);
    const result = await merge({
      repoPath: repo.path,
      from: body.from,
      into: body.into,
      noFf: body.noFf,
      message: body.message,
      dryRun: body.dryRun,
    });
    res.json({ ...result, preview: previewCommands(result.commands) });
  } catch (err) {
    fail(res, err);
  }
});

const ticketSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'Not a ticket id');

router.get('/repos/:id/find', async (req, res) => {
  try {
    const ticket = ticketSchema.parse(req.query.ticket);
    const repo = await resolveRepo(req.params.id);
    res.json(await findTicket(repo.path, ticket));
  } catch (err) {
    fail(res, err);
  }
});

router.get('/repos/:id/remote', async (req, res) => {
  try {
    const repo = await resolveRepo(req.params.id);
    res.json(await remoteReport(repo.path));
  } catch (err) {
    fail(res, err);
  }
});

/** Reaches the network, so it only ever happens when explicitly requested. */
router.post('/repos/:id/fetch', async (req, res) => {
  try {
    const repo = await resolveRepo(req.params.id);
    res.json(await fetchRemotes(repo.path));
  } catch (err) {
    fail(res, err);
  }
});

router.get('/repos/:id/cleanup', async (req, res) => {
  try {
    const repo = await resolveRepo(req.params.id);
    res.json(await buildCleanupReport(repo.path));
  } catch (err) {
    fail(res, err);
  }
});

router.post('/repos/:id/delete-branch', async (req, res) => {
  try {
    const { name } = z.object({ name: branchSchema }).parse(req.body);
    const repo = await resolveRepo(req.params.id);
    const result = await deleteBranch(repo.path, name);
    res.json({ ...result, preview: previewCommands(result.commands) });
  } catch (err) {
    fail(res, err);
  }
});

router.get('/repos/:id/op/status', async (req, res) => {
  try {
    const repo = await resolveRepo(req.params.id);
    res.json(await operationStatus(repo.path));
  } catch (err) {
    fail(res, err);
  }
});

router.post('/repos/:id/op/continue', async (req, res) => {
  try {
    const repo = await resolveRepo(req.params.id);
    const result = await continueOperation(repo.path);
    res.json({ ...result, preview: previewCommands(result.commands) });
  } catch (err) {
    fail(res, err);
  }
});

router.post('/repos/:id/op/abort', async (req, res) => {
  try {
    const repo = await resolveRepo(req.params.id);
    const result = await abortOperation(repo.path);
    res.json({ ...result, preview: previewCommands(result.commands) });
  } catch (err) {
    fail(res, err);
  }
});

router.post('/repos/:id/op/skip', async (req, res) => {
  try {
    const repo = await resolveRepo(req.params.id);
    const result = await skipOperation(repo.path);
    res.json({ ...result, preview: previewCommands(result.commands) });
  } catch (err) {
    fail(res, err);
  }
});

router.get('/repos/:id/op/conflicts', async (req, res) => {
  try {
    const repo = await resolveRepo(req.params.id);
    res.json(await conflictReport(repo.path));
  } catch (err) {
    fail(res, err);
  }
});

const resolveSchema = z.object({
  // Reject absolute paths and traversal: this becomes a pathspec inside the
  // worktree, and nothing outside it is ever a legitimate target.
  path: z
    .string()
    .min(1)
    .max(4096)
    .refine(
      (p) => !p.startsWith('-') && !p.startsWith('/') && !/^[A-Za-z]:/.test(p) && !p.split(/[\\/]/).includes('..'),
      { message: 'Invalid file path' },
    ),
  choice: z.enum(['ours', 'theirs']),
});

router.post('/repos/:id/op/resolve', async (req, res) => {
  try {
    const body = resolveSchema.parse(req.body);
    const repo = await resolveRepo(req.params.id);
    const result = await resolveConflict(repo.path, body.path, body.choice);
    res.json({ ...result, preview: previewCommands(result.commands) });
  } catch (err) {
    fail(res, err);
  }
});
