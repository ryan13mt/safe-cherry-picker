import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Builds a realistic sandbox repo for exercising the app by hand.
 *
 * It is deliberately messy in the ways real repos are messy: promotions done by
 * merge, partial releases done by cherry-pick (some with -x, some without), one
 * ticket squash-merged, a hotfix stranded on prod, tickets interleaved through
 * the same file, commits that ignore the ticket convention, and a branch with no
 * ticket in its name.
 *
 * Re-running rebuilds it from scratch, so it doubles as a reset button:
 *
 *   npm run sandbox
 *
 * The default location is a sibling of this project, which puts it inside the
 * configured scanRoot so the app discovers it with no config change.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = path.resolve(here, '..', '..', 'gcp-sandbox');

// Spread the history over the last ~10 weeks so dates look plausible.
let clock = Math.floor(Date.now() / 1000) - 70 * 86400;
const HOUR = 3600;

let repo;

function git(args, env = {}) {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function write(file, contents) {
  const full = path.join(repo, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents, 'utf8');
}

// A handful of people, so per-ticket attribution and "who started this branch"
// have something to show.
const PEOPLE = {
  ana: { name: 'Ana Sousa', email: 'ana.sousa@example.invalid' },
  ben: { name: 'Ben Ito', email: 'ben.ito@example.invalid' },
  chris: { name: 'Chris Vale', email: 'chris.vale@example.invalid' },
  dana: { name: 'Dana Reyes', email: 'dana.reyes@example.invalid' },
};
let author = PEOPLE.ana;

/** Sets who authors the commits that follow. */
function as(person) {
  author = person;
}

function commit(message, hours = 5) {
  clock += hours * HOUR;
  const stamp = `${clock} +0000`;
  git(['add', '-A']);
  git(['commit', '-m', message], {
    GIT_AUTHOR_DATE: stamp,
    GIT_COMMITTER_DATE: stamp,
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
  });
  return git(['rev-parse', 'HEAD']);
}

function merge(branch, into) {
  clock += 2 * HOUR;
  const stamp = `${clock} +0000`;
  git(['merge', '--no-ff', '--no-edit', '-m', `Merge branch '${branch}' into ${into}`, branch], {
    GIT_AUTHOR_DATE: stamp,
    GIT_COMMITTER_DATE: stamp,
  });
}

function checkout(branch, from) {
  git(from ? ['checkout', '--quiet', '-b', branch, from] : ['checkout', '--quiet', branch]);
}

function mod(file, lines) {
  write(file, lines.join('\n') + '\n');
}

export function makeSandbox(dir = DEFAULT_DIR) {
  repo = dir;
  if (existsSync(repo)) rmSync(repo, { recursive: true, force: true, maxRetries: 5 });
  mkdirSync(repo, { recursive: true });

  git(['init', '--initial-branch=prod', '--quiet']);
  git(['config', 'user.name', 'Sandbox Bot']);
  git(['config', 'user.email', 'sandbox@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['config', 'core.autocrlf', 'false']);

  // ---------------------------------------------------------------- baseline
  write('README.md', '# Acme Payments\n\nInternal payments service.\n');
  write('src/server.js', "export function start() {\n  console.log('listening');\n}\n");
  write('src/payments.js', 'export function charge(amount) {\n  return { ok: true, amount };\n}\n');
  write('src/auth.js', 'export function verify(token) {\n  return Boolean(token);\n}\n');
  commit('chore: initial service scaffold');

  git(['branch', 'stable']);
  git(['branch', 'develop']);

  // ------------------------------------------------- release cycle 1 (shipped)
  // A complete promotion: develop -> stable -> prod, entirely by merge. Every
  // commit here shows as "merged / exact" on all three branches.
  checkout('feature/PAY-1001-receipts', 'develop');
  write('src/receipts.js', 'export function render(order) {\n  return `Receipt #${order.id}`;\n}\n');
  commit('[PAY-1001] add receipt renderer');
  mod('src/receipts.js', [
    'export function render(order) {',
    '  return `Receipt #${order.id} — ${order.total}`;',
    '}',
  ]);
  commit('[PAY-1001] include total on receipts');

  checkout('develop');
  merge('feature/PAY-1001-receipts', 'develop');
  checkout('stable');
  merge('develop', 'stable');
  checkout('prod');
  merge('stable', 'prod');

  // ------------------------------------------------------ hotfix, straight to prod
  // The classic drift: fixed in production, never merged back. This is what the
  // pipeline view's "behind" warning exists to catch.
  checkout('prod');
  mod('src/auth.js', [
    'export function verify(token) {',
    '  if (typeof token !== "string") return false;',
    '  return token.length > 0;',
    '}',
  ]);
  commit('[PAY-1010] hotfix: reject non-string auth tokens');

  // ------------------------------------------- refunds: a partially released branch
  // The centrepiece. Three tickets, one of which ends up half-shipped, and each
  // detection method exercised at least once.
  const refunds = 'feature/PAY-1042-refunds';
  checkout(refunds, 'develop');

  write('src/refunds.js', 'export function refund(id) {\n  return { id, status: "pending" };\n}\n');
  const r1 = commit('[PAY-1042] add refund endpoint');
  as(PEOPLE.ben);

  write('src/ledger.js', 'export function record(entry) {\n  return [entry];\n}\n');
  const r2 = commit('[PAY-1043] add ledger write path');
  as(PEOPLE.ana);

  mod('src/refunds.js', [
    'export function refund(id) {',
    '  if (!id) throw new Error("id required");',
    '  return { id, status: "pending" };',
    '}',
  ]);
  const r3 = commit('[PAY-1042] validate refund id');

  // No ticket prefix — falls back to the branch name (PAY-1042).
  write('docs/refunds.md', '# Refunds\n\nHow refunds work.\n');
  commit('docs: describe the refund flow');

  mod('src/ledger.js', [
    'export function record(entry) {',
    '  if (!entry.amount) throw new Error("amount required");',
    '  return [entry];',
    '}',
  ]);
  as(PEOPLE.ben);
  const r5 = commit('[PAY-1043] validate ledger entries');
  as(PEOPLE.chris);

  // Squash-merged downstream later: patch differs, only the subject survives.
  write('src/notifications.js', 'export function notify(user) {\n  return `sent to ${user}`;\n}\n');
  commit('[PAY-1050] notify customer on refund');

  // Mentions a ticket mid-subject: must NOT be grouped as PAY-999.
  mod('src/server.js', [
    'export function start() {',
    "  console.log('listening');",
    '}',
    '',
    'export function stop() {',
    "  console.log('stopped');",
    '}',
  ]);
  commit('refactor: tidy server lifecycle, similar to PAY-999');

  // Lowercase prefix must normalise to PAY-1099.
  write('src/metrics.js', 'export function count(name) {\n  return { name, n: 1 };\n}\n');
  commit('[pay-1099] add metrics counter');

  checkout('develop');
  merge(refunds, 'develop');

  // Partial release to stable, using three different mechanisms.
  checkout('stable');

  // Plain pick: SHA changes, patch-id still matches -> "picked", high confidence.
  git(['cherry-pick', r1]);

  // Recorded pick: leaves a trailer -> "picked (traced)", exact.
  git(['cherry-pick', '-x', r2]);

  // PAY-1042's second commit (r3) is deliberately NOT picked, so PAY-1042 shows
  // as PARTIAL on stable. PAY-1043's r5 is also left behind.
  void r3;
  void r5;

  // Squash merge for PAY-1050: same intent, different patch, subject preserved
  // in the body -> "likely", low confidence.
  write('src/notifications.js', 'export function notify(user) {\n  // squashed variant\n  return `sent to ${user}`;\n}\n');
  commit('[PAY-1050] customer refund notifications (#218)\n\n* [PAY-1050] notify customer on refund\n* review tweaks');

  // ------------------------------------------- fraud checks: interleaved tickets
  // PAY-1100 and PAY-1101 take turns editing the same file. Picking PAY-1101
  // alone skips a commit it builds on, so it genuinely conflicts — while
  // PAY-1103 touches only its own file and picks cleanly.
  // Dana owns PAY-1100 and Chris owns PAY-1101, interleaved in one file — so the
  // dependency between them also has two different people behind it.
  const fraud = 'feature/PAY-1100-fraud-checks';
  checkout(fraud, 'develop');
  as(PEOPLE.dana);

  write('src/fraud.js', ['export function score(txn) {', '  return 0;', '}'].join('\n') + '\n');
  commit('[PAY-1100] add fraud scoring stub');
  as(PEOPLE.chris);

  mod('src/fraud.js', [
    'export function score(txn) {',
    '  let risk = 0;',
    '  if (txn.amount > 1000) risk += 10;',
    '  return risk;',
    '}',
  ]);
  commit('[PAY-1101] weight large transactions');
  as(PEOPLE.dana);

  mod('src/fraud.js', [
    'export function score(txn) {',
    '  let risk = 0;',
    '  if (txn.amount > 1000) risk += 10;',
    '  if (txn.country !== "GB") risk += 5;',
    '  return risk;',
    '}',
  ]);
  commit('[PAY-1100] weight foreign transactions');

  mod('src/fraud.js', [
    'export function score(txn) {',
    '  let risk = 0;',
    '  if (txn.amount > 1000) risk += 10;',
    '  if (txn.country !== "GB") risk += 5;',
    '  if (txn.velocity > 3) risk += 20;',
    '  return risk;',
    '}',
  ]);
  commit('[PAY-1101] weight transaction velocity');

  // Self-contained: picks cleanly on its own.
  write('src/blocklist.js', 'export const blocked = new Set();\n');
  commit('[PAY-1103] add card blocklist');

  checkout('develop');
  merge(fraud, 'develop');

  // ------------------------------------- an unreleased branch, nothing shipped yet
  const invoices = 'feature/PAY-1200-invoices';
  checkout(invoices, 'develop');
  write('src/invoices.js', 'export function issue(order) {\n  return { order, issued: true };\n}\n');
  commit('[PAY-1200] issue invoices');
  write('src/invoice-pdf.js', 'export function toPdf(invoice) {\n  return Buffer.from(String(invoice));\n}\n');
  commit('[PAY-1200] render invoice pdf');
  write('src/invoice-mail.js', 'export function mail(invoice) {\n  return `mailed ${invoice.order}`;\n}\n');
  commit('[PAY-1201] email invoices to customers');

  // ------------------------------------------ a branch with no ticket in its name
  // Its unprefixed commits have nowhere to fall back to, so they land in the
  // Ungrouped bucket.
  const spike = 'spike/perf-tuning';
  checkout(spike, 'develop');
  write('bench/load.js', 'export const iterations = 1000;\n');
  commit('add a crude load benchmark');
  mod('bench/load.js', ['export const iterations = 5000;', 'export const warmup = 100;']);
  commit('raise benchmark iteration count');
  write('src/cache.js', 'export const cache = new Map();\n');
  commit('[PAY-1300] add an in-process cache');

  // Park HEAD on a feature branch so prod, stable and develop are all free for
  // the app to operate on. (It refuses to advance a branch checked out here.)
  checkout(refunds);

  const count = (revs) => git(['rev-list', '--count', ...revs]);

  return {
    path: repo,
    branches: git(['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n'),
    head: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    drift: {
      'develop -> stable': { ahead: count(['stable..develop']), behind: count(['develop..stable']) },
      'stable -> prod': { ahead: count(['prod..stable']), behind: count(['stable..prod']) },
    },
  };
}

if (process.argv[1] && process.argv[1].endsWith('make-sandbox.mjs')) {
  const target = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_DIR;
  const info = makeSandbox(target);

  console.log(`\nSandbox rebuilt at ${info.path}`);
  console.log(`HEAD is on ${info.head} (prod, stable and develop are all free)\n`);
  console.log('Branches:');
  for (const b of info.branches) console.log(`  ${b}`);
  console.log('\nPipeline drift:');
  for (const [leg, d] of Object.entries(info.drift)) {
    console.log(`  ${leg}: ${d.ahead} to promote, ${d.behind} behind`);
  }
  console.log(`
Things to try:
  Pipeline tab
    - stable -> prod shows commits "behind": the PAY-1010 hotfix that never came
      back, plus prod's own merge commit. Back-merge to reconcile them.
    - Promote develop into stable to move a release along.

  Release matrix, branch feature/PAY-1042-refunds
    - PAY-1042 and PAY-1043 are both PARTIAL on stable: one commit of each was
      picked, the other left behind. Half-shipped tickets sort to the top.
    - PAY-1043's picked commit shows "picked" with an exact trailer (-x); the
      PAY-1042 one shows "picked" via patch-id, since it was picked plainly.
    - PAY-1050 shows "likely" — squash-merged, so only the subject matched.
    - "[pay-1099] add metrics counter" normalises to PAY-1099.
    - "refactor: tidy server lifecycle, similar to PAY-999" is NOT grouped as
      PAY-999; it falls back to the branch ticket.

  Release matrix, branch feature/PAY-1100-fraud-checks
    - Select PAY-1101 alone -> simulated conflict in src/fraud.js (it skips the
      PAY-1100 commits it builds on).
    - Select PAY-1100 and PAY-1101 together -> simulated clean.
    - Select PAY-1103 alone -> clean; it only touches its own file.

  Release matrix, branch spike/perf-tuning
    - The branch name has no ticket, so its unprefixed commits land in Ungrouped.

Reset it any time with:  npm run sandbox
`);
}
