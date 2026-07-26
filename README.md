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

## Choosing the folder to scan

**Change folder…** in the header opens a folder picker: navigate directories, jump to Home,
the current root, or any drive, or paste a path. Folders that are git repositories are
badged, and the footer says how many are directly inside, so you can tell whether you've
landed somewhere useful before committing to it.

The choice is saved to `.gcprc.local.json` (gitignored) and takes effect immediately — no
restart. The header always shows which folder is being scanned.

Two notes on how this works:

- A browser's own directory picker is no use here. For security it returns an opaque
  handle rather than a path, and the server needs a real path to run git in. So the server
  lists directories and the client navigates them. That means the app can enumerate folder
  names on this machine — acceptable for a loopback-only tool that already reads your
  repositories, but it is part of why that 127.0.0.1 binding matters.
- Scans stop after 6000 directories. Without a budget, choosing something like `C:\` would
  walk a large part of the filesystem and hang the request. When the cap is hit the header
  says so, rather than quietly showing too few repositories.

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
commit to anything. Promotions get the same treatment: the Promote and Back-merge
buttons predict their conflicts the same way.

### Ticket dependencies

Tickets on a branch are rarely independent, and the matrix says which ones are standing
on each other's work — before you try a pick and find out the hard way. Two signals, both
computed from real diff numbers:

| Shown | Meaning |
|---|---|
| **Requires X** (hard) | X *added* a file this ticket edits. Picking without X cannot work — the file wouldn't exist. |
| **Overlaps with X** (soft) | X wrote the majority of the changed lines in a file this ticket also touches (≥50%, at least 10 lines). Usually conflicts, and always means the two were developed together. |

Only an *earlier* change counts, so dependencies point one way. Expanding a ticket lists
the files and the exact split (`src/fraud.js — 80% of the changed lines are ACME-100's,
12 vs 2`).

The row-level warning only appears when the dependency **isn't already on the branch
you're picking into** — that's the difference between "these two were written together"
and "this pick will break". Selecting a ticket with an unmet dependency shows
*⚠ needs ACME-100 first* next to the simulation result.

Dependencies on the **Ungrouped** bucket are reported too. Unticketed commits still have
to be picked, so a ticket that builds on one has a genuine dependency even though there's
no ticket to name.

### Blocking on uncommitted changes

By default the app refuses to *start* operations while the selected repository has
uncommitted changes. A banner lists them, actions are disabled, and the server enforces it
too — the API refuses even if the UI is bypassed.

Worth being clear about what this is and isn't: it is a **policy**, not a safety fix.
Operations run in a disposable worktree and never touch your working copy — there's a test
asserting a WIP file survives a conflict and an abort untouched. This setting exists
because operating on a repo that isn't in a clean state is usually a mistake anyway.

What is deliberately **not** blocked: continue, skip, abort and resolve. Blocking those
would let a single stray file trap a paused cherry-pick with no way to finish or unwind it.
Dry runs and all read-only views also stay available.

`blockOnDirty` in the config controls it:

| Value | Behaviour |
|---|---|
| `any` (default) | Modifications *or* untracked files block operations |
| `tracked` | Only modifications block; stray untracked files are tolerated |
| `off` | No check |

### Find ticket — "where is PAY-1042?"

The release matrix goes branch → tickets. This goes the other way, which is the direction
the question is usually asked in: QA says *"is PAY-1042 in stable yet?"* and doesn't know
or care which branch it started on.

Type a ticket id and get every commit mentioning it, which branches contain each one, and
a per-chain-branch verdict. Cherry-picked copies are marked as copies and name their
source, so you can see the original on the feature branch *and* where it has been picked
to.

This searches commit messages rather than running the classifier, which is the point: a
cherry-picked copy keeps the original subject, so one search finds the original and every
copy. The trade-off is stated in the UI — a squash that rewrote the subject and dropped
the id will be missed, and the release matrix is what catches those.

### Remote awareness

The pipeline view shows how far each chain branch has drifted from its upstream:
*"Not pushed: stable +3"*, or which branches are behind. It closes the loop the app
otherwise leaves open — it moves local branches and then goes quiet, leaving you to
remember what still needs pushing.

**Fetching is never automatic.** Remote-tracking refs go stale the moment someone else
pushes, so reaching the network on page load would be both surprising and slow. There's a
Fetch button, and the bar says when it last ran so you know how much to trust the numbers.

`fetch` was previously refused outright along with `push` and `pull`. It's now permitted
because it only moves `refs/remotes` — but the policy layer is strict about it, since
`git fetch origin main:main` writes a *local* branch. Only a bare remote name and a short
list of vetted flags are accepted; any refspec is refused. `push` and `pull` remain
denied, and the network opt-in unlocks nothing else. A test asserts that fetching leaves
every local branch untouched.

### Who did what

Each ticket in the matrix names the people who wrote its commits, with a count —
`PAY-1042 · Ana Sousa 3 · Chris Vale 1`. Identities are keyed on email, so the same person
committing under two spellings of their name counts once.

Each feature branch also shows **who started it** and everyone who has worked on it, in
both the matrix header and the Cleanup tab (useful before deleting someone else's branch).

A caveat worth stating plainly: **git records nothing about who created a branch.** There
is no such metadata. "Started by" is the author of the branch's oldest own commit — the
first committer — which is a proxy, and the only one that survives a clone. Reflogs do
know who typed `git checkout -b`, but they are local to that machine and would be absent
or wrong for everyone else, so they aren't used.

Merge commits are excluded from attribution: whoever ran the merge didn't write the work
it carries. Promotion branches are shared infrastructure and get no owner.

### Command log

A collapsible drawer at the foot of the page lists every git command the app has run —
argv, exit code and duration, newest first, last 200. This app moves branches on your
behalf, so being able to see exactly what it executed is the difference between trusting
it and hoping. "Copy all" gives you the lot as plain text.

### Smaller things

- **Per-ticket churn** — `3 files +11 −0` beside each ticket, from the same diff numbers
  the dependency analysis computes. Hover for the per-file breakdown.
- **Filter box** on the matrix, matching ticket ids and commit subjects.
- **Tab badges** — pipeline drift, outstanding tickets on the current branch, and how many
  branches are deletable, so you can see what needs attention without clicking.
- **Add required tickets** — the dependency warning offers a button that ticks the
  outstanding commits of whatever the selection depends on.
- **Copy buttons** — the exact git commands, the worktree path when a conflict is paused,
  and markdown **release notes** for a promotion (tickets, subjects and SHAs, grouped and
  linked to Jira when a base url is set).
- **Last repo, branch and tab are remembered** between sessions, and restored only if they
  still exist.

### Cleanup — which branches have finished

`git branch --merged prod` only understands ancestry, so in a workflow built around
partial cherry-picks it misses most of the branches that have actually shipped. The
Cleanup tab runs the release classifier over every local branch instead:

| Verdict | Meaning | Deletable |
|---|---|---|
| **merged** | Every commit is an ancestor of a chain branch | Yes, with plain `git branch -d` |
| **released by pick** | Every commit has shipped, some by cherry-pick | Yes, but needs `-D` — git only checks ancestry |
| **probably shipped** | Full coverage relies on a squash or subject match | **No** — the app won't delete on a guess |
| **still outstanding** | Has commits that haven't reached any chain branch | No, with a count of what's left |

Each row shows the branch it's released to, its last commit, and its age, so stale
branches stand out. Note that "released to develop" still means deleting is safe — the
commits are reachable — but it is *not* the same as shipped to production; the row says
which.

Deleting re-runs the classification server-side rather than trusting the page, so a
cleanup tab left open while someone pushes new work can't delete it. The response returns
the deleted tip, and the app shows `git branch <name> <sha>` to put it back.

`branch -D` is gated behind a dedicated `forceDelete` opt-in in the git layer, set only
after the classifier has confirmed the work is released. It unlocks nothing else.

### Conflict viewer

When an operation does stop on a conflict, you don't have to leave the app to understand
it. For each conflicted file the viewer shows:

- **What kind of conflict it is** — both sides changed it, both added it independently,
  or one side deleted it. (Git can't tell "deleted here" from "never existed here", so
  the wording covers both — the second is what you get when a pick skips the commit that
  created the file.)
- **The incoming commit's diff**, so you can see what it was actually trying to do.
- **Each conflicting region, with both sides named by branch** rather than "ours" and
  "theirs" — `stable` versus `feature/PAY-1100-fraud-checks · 314adfd`. The base is shown
  too when your `merge.conflictStyle` is diff3.
- **Which commit introduced each line**, in a blame gutter beside it, hoverable for the
  author, date and subject. This is often the whole answer: if the incoming lines came
  from a commit you *didn't* select, that's why it conflicts.
- **Adjustable context** — ±3 / ±10 / ±25 / whole file. The merged file is already in the
  payload, so widening is instant and needs no round trip.
- **Line numbers from each side's own file**, not the merged one with markers in it.
- **Take ours / Take theirs** per file, which runs `git checkout --ours/--theirs` and
  stages the result. For delete conflicts it offers the deletion-aware choice instead.

Binary files say so plainly rather than pretending to be mergeable, and very large files
are skipped rather than pushed through the browser.

You can still resolve by hand in the worktree — the path is shown — and the app will not
let you continue while conflict markers remain in a file, because committing
`<<<<<<< HEAD` into a release branch is worse than an error message.

A cherry-pick can also stop because a commit is **empty** — its changes are already on
the target. That's reported as its own state, with a **Skip this commit** action, rather
than being mislabelled a conflict with zero conflicted files.

### How squashing works

Squash mode picks each commit **normally** and then collapses them with
`reset --soft` + a single commit.

The obvious implementation — `git cherry-pick -n A B C` followed by one commit — does not
work. Git requires a clean tree before each pick in a sequence, and `-n` guarantees the
tree is dirty from the second pick onwards, so it fails with *"your local changes would be
overwritten by cherry-pick"*. It only fails for some shapes (one commit adding a file that
a later one edits is enough; several edits to a pre-existing file can slip through), which
makes it a particularly bad thing to rely on.

Picking normally also means conflicts resume through the ordinary `--continue` path, and
the collapse happens once the whole sequence has landed. The squash commit's message lists
every source SHA, so traceability survives even though the individual `-x` trailers don't.

### Interrupted operations

Git's idea of "a cherry-pick is in progress" is broader than `CHERRY_PICK_HEAD`: a
multi-commit pick also keeps a `sequencer/` directory holding the remaining todo list, and
that can outlive `CHERRY_PICK_HEAD` — for example when a later commit in the sequence
turns out empty. While it exists, git refuses every new pick with *"cherry-pick is already
in progress"*.

The app detects that state, so an interrupted pick stays visible and abortable instead of
silently blocking everything. Abort clears the sequencer with `cherry-pick --quit` when
`--abort` can't (which is the case once `CHERRY_PICK_HEAD` has gone), and a stale
sequencer left by a crash is cleared before the next operation starts.

If git has an operation in progress that the app has no record of — a crash between
writes, or a pick you drove by hand in the worktree — it's reported as **orphaned**: you
get an Abort button but not Continue or Skip, because there's no way to know which branch
it was meant to advance.

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
- Anything that touches a working tree (`cherry-pick`, `merge`, `commit`, `add`, `rm`,
  `checkout`, `reset`, `clean`) is refused unless its cwd is inside the managed worktree —
  identified by position (`…/.git/gcp-worktree`), not just by folder name.
- Global options that redirect git elsewhere (`-C`, `--git-dir`, `--work-tree`) are
  refused, since they would otherwise sidestep that check entirely.
- `reset`/`clean` are double-gated behind a `scratch: true` flag on top of that.
- `--force` is refused except for `clean -f` and `rm -f`, which genuinely need it and are
  confined to the scratch worktree; `update-ref` is restricted to `refs/heads/*` and must
  supply the expected old value.
- Operations are serialised per repo, so a double-clicked button can't run two
  cherry-picks through the same worktree at once.
- Every branch advance writes a descriptive reflog entry (`git-cherry-picker: merge
  develop into stable`), so `git reflog stable` shows exactly what the app did and when.
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

114 tests across two styles:

**A shared fixture** (`scripts/make-fixture.mjs`) for anything that needs a realistic
history: a merged branch, plain cherry-picks, a `-x` pick, a squash merge, a hotfix
stranded on prod, interleaved tickets, a lowercase prefix, an id mentioned mid-subject,
and a branch with no id in its name. This drives the classifier, grouping, base
selection, pipeline and view tests.

Throwaway repos are swept before and after a run by `test/global-setup.ts`, which only
touches directories over an hour old. That age guard is deliberate: two suites running at
once — or a stray `rm` on the same prefixes — would otherwise delete the live fixtures of
a run in progress, and the victim fails in a way that looks exactly like a flaky test.

**A repo builder** (`test/repo-builder.ts`) for edge cases, where each test constructs
the smallest history that produces the situation. Covered:

| Area | Cases |
|---|---|
| Ordering | reversed selection; commits whose timestamps contradict their topology |
| Empty / unpickable | already-applied commit → pause + skip; merge commits skipped; all-merge selection; unknown sha; root commit |
| Mid-sequence | partial apply then pause with done/remaining; abort restores; refusing to continue with markers left in |
| Conflict kinds | both-modified, both-added, binary, modify/delete, delete/modify |
| Resolution | take ours, take theirs, accept a deletion, reject a non-conflicted path |
| Merges | already up to date, merge into itself, forced merge commit, fast-forward, unrelated histories, missing branch, checked-out target |
| Prediction | conflict and clean merges predicted before running; dry runs leave no trace |
| Unusual input | non-ascii paths, subjects and content; branch names with slashes and dots |
| Concurrency | two simultaneous operations serialised; compare-and-swap refuses when the branch moved underneath |
| Isolation | checkout, current branch and uncommitted work unchanged across conflict and abort |

## Layout

```
server/
  git.ts                  the policy layer — every git call goes through here
  services/
    discover.ts           repo discovery, scan-root containment
    pipeline.ts           ahead/behind per chain leg, both directions
    release.ts            the four-strategy classifier
    grouping.ts           Jira extraction + partial/likely/released rollup
    dryrun.ts             merge-tree conflict simulation, for picks and merges
    conflicts.ts          index stages, hunk parsing, per-file resolution
    worktree.ts           managed worktree lifecycle
    ops.ts                cherry-pick / merge / continue / skip / abort
web/src/                  React client
scripts/make-fixture.mjs  fixture for the classifier tests
scripts/make-sandbox.mjs  realistic demo repo (npm run sandbox)
test/repo-builder.ts      builder for edge-case repos
```

## Not included

- Pushing to remotes — deliberately; that stays a manual step in your terminal
- Jira API integration — ticket ids come from commit messages only, no credentials
- GitHub/GitLab PR/MR APIs
- Rebasing, history rewriting, force operations
