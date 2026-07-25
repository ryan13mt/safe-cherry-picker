# Git Promotion & Cherry-Pick Manager

A local web app for driving a `develop → stable → prod` promotion pipeline, and for
answering the question plain git can't: **which commits on this branch have actually
been released, and which are still outstanding?**

It runs on your machine, operates on other repos discovered on disk, and never pushes.

## Running it

```sh
npm install
npm run dev      # API on 127.0.0.1:5179, UI on 127.0.0.1:5178
```

Or as a single process serving the built client:

```sh
npm run build
npm start        # http://127.0.0.1:5179
```

> On this machine node lives at `C:\Program Files\nodejs` but isn't on every shell's
> PATH. If `npm` isn't found, add that directory to PATH first.

## Sandbox repo

To try the app without touching real work:

```sh
npm run sandbox
```

This builds `../gcp-sandbox` — a sibling of this project, so it lands inside the default
`scanRoot` and the app finds it with no config change. Re-running rebuilds it from
scratch, so it doubles as a **reset button** once you've cherry-picked it into a mess.

It's deliberately messy in realistic ways: a completed release cycle promoted by merge, a
hotfix stranded on prod, a partially released feature branch (one commit picked plainly,
one with `-x`, one ticket squash-merged, others left behind), two tickets interleaved
through the same file, a lowercase `[pay-1099]` prefix, a commit that merely *mentions*
a ticket mid-subject, and a spike branch with no ticket in its name.

The script prints a walkthrough of what to look at on each branch. Highlights:

| Branch | What it demonstrates |
|---|---|
| `feature/PAY-1042-refunds` | All four detection methods at once; PAY-1042 and PAY-1043 both ⚠ partial on stable |
| `feature/PAY-1100-fraud-checks` | Select PAY-1101 alone → simulated conflict in `src/fraud.js`; select it with PAY-1100 → clean |
| `feature/PAY-1200-invoices` | Nothing released yet — the straightforward case |
| `spike/perf-tuning` | Branch name has no ticket, so unprefixed commits land in Ungrouped |

Delete it with `rm -rf ../gcp-sandbox` when you're done.

## Configuration

`.gcprc.json` at the project root (`.gcprc.local.json` overrides it and is gitignored):

| Key | Meaning |
|---|---|
| `scanRoot` | Folder scanned for git repos |
| `scanDepth` | How deep to look (default 3) |
| `chain` | Promotion order, **upstream first**: `["develop","stable","prod"]` |
| `ticketPattern` | Strict bracketed prefix, anchored at the subject start |
| `branchTicketPattern` | Fallback applied to the branch name |
| `jiraBaseUrl` | Optional; turns ticket ids into links |
| `maxBranchCommits` / `maxTargetIndexCommits` | Safety caps on very large branches |

Repos that lack some chain branches are handled — missing ones are simply skipped.

## What it shows

### Pipeline view

Per adjacent pair in the chain, both directions:

- **↑ N to promote** — commits waiting to move upstream→downstream
- **↓ N behind — needs back-merge** — commits the *downstream* branch has that upstream
  lacks, i.e. a hotfix applied straight to prod. Until it is merged back, the next
  promotion can silently revert it. This is the number that rots quietly, so it is
  styled as a warning.

### Release matrix

The branch's commits grouped by Jira ticket, one column per promotion branch.

Detecting "already released" is genuinely hard, because a commit reaches a branch three
different ways and only one preserves the SHA. Four strategies run in descending order
of trust, and the UI reports **which one fired**:

| Shown | Method | Confidence |
|---|---|---|
| `✔ merged` | The commit is an ancestor of the target | Exact |
| `✔ˣ picked` | A target commit carries `(cherry picked from commit <sha>)` | Exact |
| `🍒 picked` | `git cherry` patch-id equivalence | High |
| `~? likely` | Subject found in a squash commit body, or an identical subject | **Low — not counted as released** |
| `○ pending` | Nothing matched | — |

Honest limitations, surfaced in the UI rather than hidden:

- Patch-id matching **misses** cherry-picks that resolved conflicts (the patch changed),
  and can **false-positive** on trivially identical diffs like version bumps.
- Squash detection is a text heuristic. It is styled distinctly and never counted as
  definitely released.
- Picks made *by this app* always pass `-x`, so they become exactly traceable afterwards.

Group states roll the commits up per target. **`⚠ partial`** — some commits shipped and
some didn't — sorts to the top, because a half-shipped ticket is a latent bug that is
invisible in plain git.

Commits with no bracketed prefix fall back to the branch name (`feature/JIRA-900-x`);
anything still unmatched lands visibly in **Ungrouped** rather than being mis-filed. An
id merely *mentioned* mid-subject never groups a commit.

### Conflict dry-run

Picking one ticket means skipping the other tickets' commits interleaved with it — which
is exactly when picks blow up. Instead of guessing from file overlap, the app replays the
pick for real using `git merge-tree --write-tree`, entirely in the object database:

- No checkout, no worktree, no ref changes, no index or working-tree writes.
- It does write a few unreferenced trees/commits, which git prunes during routine gc.
- A test asserts the fixture repo is byte-identical before and after.

You get **✓ simulated clean** or **⚠ conflicts in N files** with the paths, before you
commit to anything.

## Safety model

The riskiest thing here is that promotions need branch checkouts.

**All writes happen in a disposable worktree** at `<repo>/.git/gcp-worktree`, on a
detached HEAD. The branch ref is only moved at the end with a compare-and-swap
`update-ref`, so if anything else moved the branch meanwhile, git refuses rather than
clobbering it. Your checkout, current branch and uncommitted work are never touched.

Enforced in `server/git.ts`, not merely in the UI:

- `execFile` with an argv array — **never a shell string**, so branch names can't inject.
- `push`, `pull`, `fetch`, `rebase`, `filter-branch`, `reflog`, `gc` and friends are
  rejected outright. **Nothing is ever pushed.**
- Mutating subcommands require an explicit `write: true` from the caller.
- Anything that touches a working tree (`cherry-pick`, `merge`, `commit`, `add`,
  `checkout`, `reset`, `clean`) is refused unless its cwd is inside the managed worktree.
- `reset`/`clean` are double-gated behind a `scratch: true` flag on top of that.
- `--force` in any form is refused; `update-ref` is restricted to `refs/heads/*` and must
  supply the expected old value.
- The server binds `127.0.0.1` only, and repo paths must resolve inside `scanRoot`.
- Every write endpoint previews the literal git commands before running.

If a branch is checked out in another worktree, the app **refuses** to advance it rather
than leaving that working copy inconsistent.

On conflict the operation pauses; the UI shows the conflicted files and the worktree path
so you can resolve them in your editor, then Continue or Abort.

## Tests

```sh
npm test
```

`scripts/make-fixture.mjs` builds a throwaway repo containing every case: a merged
branch, plain cherry-picks, a `-x` pick, a squash merge, a hotfix stranded on prod, two
tickets interleaved through the same file, a lowercase ticket prefix, an id mentioned
mid-subject, and a branch with no id in its name. The suite covers the classifier,
grouping, the dry-run engine, the write ops (including a real conflict, resolve and
abort), the git policy layer, and server-rendered views.

## Layout

```
server/
  git.ts                  the policy layer — every git call goes through here
  services/
    discover.ts           repo discovery, scan-root containment
    pipeline.ts           ahead/behind per chain leg, both directions
    release.ts            the four-strategy classifier
    grouping.ts           Jira extraction + partial/likely/released rollup
    dryrun.ts             merge-tree conflict simulation
    worktree.ts           managed worktree lifecycle
    ops.ts                cherry-pick / merge / continue / abort
web/src/                  React client
scripts/make-fixture.mjs  the test repo generator
```

## Not included

- Pushing to remotes — deliberately; that stays a manual step in your terminal
- Jira API integration — ticket ids come from commit messages only, no credentials
- GitHub/GitLab PR/MR APIs
- Rebasing, history rewriting, force operations
