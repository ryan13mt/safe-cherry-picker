import { useCallback, useEffect, useState } from 'react';
import { api, type AppConfigView, type BranchList, type OpResponse } from './api.ts';
import type {
  PipelineReport,
  ReleaseMatrix as Matrix,
  RepoSummary,
  SimulationResult,
  OpStatus,
  ConflictReport,
  CleanupReport,
} from '../../shared/types.ts';
import { PipelineView } from './views/PipelineView.tsx';
import { ReleaseMatrixView } from './views/ReleaseMatrix.tsx';
import { OpDialog, type OpPlan } from './components/OpDialog.tsx';
import { ConflictViewer } from './components/ConflictViewer.tsx';
import { FolderPicker } from './components/FolderPicker.tsx';
import { CleanupView } from './views/CleanupView.tsx';
import { CommandLog } from './components/CommandLog.tsx';
import { CopyButton } from './components/CopyButton.tsx';
import { buildReleaseNotes } from './releaseNotes.ts';

type Tab = 'pipeline' | 'matrix' | 'cleanup';

type PendingOp =
  | { kind: 'cherry-pick'; target: string; commits: string[] }
  | { kind: 'merge'; from: string; into: string };

/**
 * Remembers the last repo, branch and tab. Small, but it removes a bit of
 * friction every time the app is opened.
 */
const remember = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`gcp.${key}`);
    } catch {
      return null; // storage disabled; carry on without it
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(`gcp.${key}`, value);
    } catch {
      /* ignore */
    }
  },
};

export function App() {
  const [repos, setRepos] = useState<RepoSummary[]>([]);
  const [repoId, setRepoId] = useState<string>('');
  const [branchInfo, setBranchInfo] = useState<BranchList | null>(null);
  const [tab, setTab] = useState<Tab>(() => (remember.get('tab') as Tab | null) ?? 'pipeline');

  const [pipeline, setPipeline] = useState<PipelineReport | null>(null);
  const [matrix, setMatrix] = useState<Matrix | null>(null);
  const [branch, setBranch] = useState<string>('');

  const [opStatus, setOpStatus] = useState<OpStatus | null>(null);
  const [conflicts, setConflicts] = useState<ConflictReport | null>(null);
  const [cleanup, setCleanup] = useState<CleanupReport | null>(null);
  const [plan, setPlan] = useState<{ plan: OpPlan; op: PendingOp } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [config, setConfig] = useState<AppConfigView | null>(null);
  const [pickingFolder, setPickingFolder] = useState(false);

  const loadRepos = useCallback(async () => {
    const [list, cfg] = await Promise.all([api.repos(true), api.config()]);
    setRepos(list);
    setConfig(cfg);
    setRepoId(list.length ? list[0].id : '');
    return list;
  }, []);

  useEffect(() => {
    Promise.all([api.repos(), api.config()])
      .then(([list, cfg]) => {
        setRepos(list);
        setConfig(cfg);
        if (list.length && !repoId) {
          // Restore the last repo only if it's still there.
          const saved = remember.get('repoId');
          setRepoId(list.some((r) => r.id === saved) ? saved! : list[0].id);
        }
      })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (repoId) remember.set('repoId', repoId);
  }, [repoId]);

  useEffect(() => remember.set('tab', tab), [tab]);

  useEffect(() => {
    if (repoId && branch) remember.set(`branch.${repoId}`, branch);
  }, [repoId, branch]);

  const chooseFolder = async (folder: string) => {
    const info = await api.setScanRoot(folder);
    // Clear anything belonging to the old folder before the new list arrives.
    setBranchInfo(null);
    setPipeline(null);
    setMatrix(null);
    setBranch('');
    const list = await loadRepos();
    setPickingFolder(false);
    setToast(
      `${info.scanRoot} — ${list.length} ${list.length === 1 ? 'repo' : 'repos'} found` +
        (info.truncated ? `, stopped after ${info.visited} folders` : ''),
    );
  };

  const refreshRepo = useCallback(async () => {
    if (!repoId) return;
    setError(null);
    try {
      const [info, pipe, status] = await Promise.all([
        api.branches(repoId),
        api.pipeline(repoId),
        api.opStatus(repoId),
      ]);
      setBranchInfo(info);
      setPipeline(pipe);
      setOpStatus(status);
      setConflicts(status.inProgress ? await api.conflicts(repoId) : null);

      const saved = remember.get(`branch.${repoId}`);
      const preferred =
        branch && info.branches.includes(branch)
          ? branch
          : saved && info.branches.includes(saved)
            ? saved
            : (info.branches.find((b) => !info.chain.includes(b)) ?? info.branches[0] ?? '');
      setBranch(preferred);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [repoId]);

  useEffect(() => {
    void refreshRepo();
  }, [refreshRepo]);

  useEffect(() => {
    // Only ask once the branch is known to belong to the *current* repo.
    // Switching repos leaves the previous repo's branch in state for a render,
    // and asking the new repo about a branch it doesn't have fails confusingly.
    const branchBelongsToRepo =
      branchInfo?.id === repoId && Boolean(branch) && branchInfo.branches.includes(branch);

    if (!branchBelongsToRepo) {
      setMatrix(null);
      return;
    }
    let cancelled = false;
    api
      .releaseStatus(repoId, branch)
      .then((m) => !cancelled && setMatrix(m))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [repoId, branch, branchInfo, opStatus?.inProgress]);

  const simulate = useCallback(
    (target: string, commits: string[]): Promise<SimulationResult> =>
      api.simulate(repoId, target, commits),
    [repoId],
  );

  const openCherryPick = async (
    target: string,
    commits: string[],
    simulation: SimulationResult | null,
  ) => {
    setError(null);
    try {
      const preview = await api.cherryPick(repoId, {
        target,
        commits,
        style: 'individual',
        dryRun: true,
      });
      setPlan({
        op: { kind: 'cherry-pick', target, commits },
        plan: {
          title: `Cherry-pick ${commits.length} commit(s) into ${target}`,
          summary: 'Applied oldest-first. Nothing is pushed.',
          preview: preview.preview,
          simulation: simulation ?? preview.simulation,
          styleChoice: true,
        },
      });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const openMerge = async (from: string, into: string, backMerge: boolean) => {
    setError(null);
    try {
      const preview = await api.merge(repoId, { from, into, dryRun: true });

      // The pipeline already holds the commits this merge would bring, so notes
      // are a formatting job rather than another round trip.
      const leg = pipeline?.legs.find(
        (l) =>
          (l.upstream === from && l.downstream === into) ||
          (l.downstream === from && l.upstream === into),
      );
      const commits = leg ? (leg.upstream === from ? leg.ahead : leg.behind) : [];

      setPlan({
        op: { kind: 'merge', from, into },
        plan: {
          title: backMerge ? `Back-merge ${from} into ${into}` : `Promote ${from} into ${into}`,
          summary: backMerge
            ? `Brings ${into} back in line with ${from}, so the next promotion cannot revert it.`
            : `Merges every commit waiting in ${from}.`,
          preview: preview.preview,
          simulation: preview.simulation,
          releaseNotes:
            commits.length > 0 && config
              ? buildReleaseNotes({
                  commits,
                  ticketPattern: config.ticketPattern,
                  jiraBaseUrl: config.jiraBaseUrl,
                  from,
                  into,
                })
              : undefined,
        },
      });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const runPlan = async (style: 'individual' | 'squash') => {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      const result: OpResponse =
        plan.op.kind === 'cherry-pick'
          ? await api.cherryPick(repoId, {
              target: plan.op.target,
              commits: plan.op.commits,
              style,
              sourceBranch: branch,
            })
          : await api.merge(repoId, { from: plan.op.from, into: plan.op.into });

      setPlan(null);
      setToast(result.message ?? (result.ok ? 'Done.' : 'Stopped on a conflict.'));
      await refreshRepo();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const resolveOp = async (action: 'continue' | 'abort' | 'skip') => {
    setBusy(true);
    setError(null);
    try {
      const call =
        action === 'continue' ? api.opContinue : action === 'abort' ? api.opAbort : api.opSkip;
      const result = await call(repoId);
      setToast(result.message ?? 'Done.');
      // A failed continue is not an error state — it usually means something is
      // still unresolved, and the message says what.
      if (!result.ok && result.message) setError(result.message);
      await refreshRepo();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Fetched once per repo in the background so the tab can carry a count, then
  // refreshed whenever the tab is opened or an operation finishes. Failures are
  // swallowed: a missing badge is not worth an error banner.
  useEffect(() => {
    if (!repoId) return;
    let cancelled = false;
    setCleanup(null);
    api
      .cleanup(repoId)
      .then((r) => !cancelled && setCleanup(r))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [repoId, tab === 'cleanup', opStatus?.inProgress]);

  const removeBranch = async (name: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.deleteBranch(repoId, name);
      setToast(`Deleted ${name}. Restore it with: git branch ${name} ${result.deleted.slice(0, 10)}`);
      setCleanup(await api.cleanup(repoId));
      setRepos(await api.repos(true));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const takeSide = async (file: string, choice: 'ours' | 'theirs') => {
    setBusy(true);
    setError(null);
    try {
      await api.resolve(repoId, file, choice);
      setConflicts(await api.conflicts(repoId));
      setOpStatus(await api.opStatus(repoId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  const repo = repos.find((r) => r.id === repoId);

  // Tab badges: what needs attention, without having to click through.
  const driftCount = pipeline?.legs.reduce((n, l) => n + l.ahead.length + l.behind.length, 0) ?? 0;
  const deletableCount =
    cleanup?.branches.filter((b) => b.safety === 'merged' || b.safety === 'picked').length ?? 0;
  const outstandingTickets =
    matrix?.groups.filter((g) =>
      matrix.targets.some((t) => {
        const state = g.summary[t]?.state;
        return state === 'partial' || state === 'pending';
      }),
    ).length ?? 0;

  return (
    <div className="app">
      <header>
        <h1>Git Promotion Manager</h1>
        <div className="header-controls">
          <label>
            Repo
            <select value={repoId} onChange={(e) => setRepoId(e.target.value)}>
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="ghost small"
            onClick={() => api.repos(true).then(setRepos).catch((e) => setError(e.message))}
          >
            Rescan
          </button>
          <button className="ghost small" onClick={() => setPickingFolder(true)} title={config?.scanRoot}>
            Change folder…
          </button>
          {repo && (
            <span className="muted repo-path" title={repo.path}>
              on <strong>{repo.currentBranch ?? 'detached HEAD'}</strong>
              {repo.dirty && <span className="dirty-flag" title="Uncommitted changes present"> · uncommitted work</span>}
            </span>
          )}
        </div>
        <nav>
          <button className={tab === 'pipeline' ? 'tab active' : 'tab'} onClick={() => setTab('pipeline')}>
            Pipeline
            {driftCount > 0 && <span className="tab-badge">{driftCount}</span>}
          </button>
          <button className={tab === 'matrix' ? 'tab active' : 'tab'} onClick={() => setTab('matrix')}>
            Release matrix
            {outstandingTickets > 0 && <span className="tab-badge">{outstandingTickets}</span>}
          </button>
          <button className={tab === 'cleanup' ? 'tab active' : 'tab'} onClick={() => setTab('cleanup')}>
            Cleanup
            {deletableCount > 0 && <span className="tab-badge">{deletableCount}</span>}
          </button>
        </nav>
      </header>

      {opStatus?.inProgress && (
        <div className="banner banner-warn">
          <div>
            <strong>
              {opStatus.kind} into {opStatus.target} is paused
              {opStatus.empty ? ' on an empty commit' : ' on a conflict'}
            </strong>
            <p>
              {opStatus.empty
                ? 'This commit changes nothing here — its work is already on the target. Skip it to carry on.'
                : 'Resolve below, or edit the files directly in the worktree.'}{' '}
              Your own checkout is untouched and {opStatus.target} has not moved.
            </p>
            <p className="muted worktree-path">
              worktree: <code>{opStatus.worktreePath}</code>
              {opStatus.worktreePath && (
                <CopyButton
                  text={opStatus.worktreePath}
                  label="Copy path"
                  title="Copy the worktree path, to open it in your editor"
                />
              )}
            </p>
            {opStatus.remaining && opStatus.remaining.length > 0 && (
              <p className="muted">
                {opStatus.done?.length ?? 0} applied, {opStatus.remaining.length} still to go.
              </p>
            )}
          </div>
          <div className="banner-actions">
            {!opStatus.empty && !opStatus.orphaned && (
              <button className="primary" disabled={busy} onClick={() => resolveOp('continue')}>
                Continue
              </button>
            )}
            {opStatus.kind === 'cherry-pick' && !opStatus.orphaned && (
              <button
                className={opStatus.empty ? 'primary' : 'ghost'}
                disabled={busy}
                onClick={() => resolveOp('skip')}
              >
                Skip this commit
              </button>
            )}
            <button
              className={opStatus.orphaned ? 'primary' : 'ghost'}
              disabled={busy}
              onClick={() => resolveOp('abort')}
            >
              Abort
            </button>
          </div>
        </div>
      )}

      {conflicts?.inProgress && (
        <ConflictViewer report={conflicts} busy={busy} onResolve={takeSide} />
      )}

      {error && (
        <div className="banner banner-error">
          <span>{error}</span>
          <button className="ghost small" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {repo?.blocked && (
        <div className="banner banner-block">
          <div>
            <strong>Actions are blocked — {repo.name} has uncommitted changes</strong>
            <p>
              Commit or stash them, then recheck. Viewing is unaffected, and an operation
              already in progress can still be continued or aborted.
            </p>
            <ul className="file-list">
              {repo.uncommitted.tracked.map((f) => (
                <li key={`t-${f}`}>
                  <code>{f}</code> <span className="muted small">modified</span>
                </li>
              ))}
              {repo.uncommitted.untracked.map((f) => (
                <li key={`u-${f}`}>
                  <code>{f}</code> <span className="muted small">untracked</span>
                </li>
              ))}
            </ul>
            {repo.uncommitted.truncated && (
              <p className="muted small">…and more ({repo.uncommitted.count} in total).</p>
            )}
          </div>
          <div className="banner-actions">
            <button className="primary" disabled={busy} onClick={() => void refreshRepo()}>
              Recheck
            </button>
          </div>
        </div>
      )}

      {config && (
        <p className="scan-root muted small">
          scanning <code>{config.scanRoot}</code>
          {config.scanTruncated && (
            <span className="warn-text">
              {' '}
              — stopped after {config.scanVisited} folders, so some repos may be missing. Pick a
              narrower folder.
            </span>
          )}
        </p>
      )}

      <main>
        {repos.length === 0 && (
          <div className="empty">
            <p>No git repositories found under this folder.</p>
            <button className="primary" onClick={() => setPickingFolder(true)}>
              Choose a different folder
            </button>
          </div>
        )}

        {tab === 'pipeline' && pipeline && (
          <PipelineView
            report={pipeline}
            blocked={repo?.blocked ?? false}
            onPromote={(from, into) => openMerge(from, into, false)}
            onBackMerge={(from, into) => openMerge(from, into, true)}
          />
        )}

        {tab === 'cleanup' &&
          (cleanup ? (
            <CleanupView report={cleanup} busy={busy} onDelete={removeBranch} />
          ) : (
            <div className="empty">Working out which branches have shipped…</div>
          ))}

        {tab === 'matrix' && matrix && branchInfo && (
          <ReleaseMatrixView
            matrix={matrix}
            branches={branchInfo.branches}
            blocked={repo?.blocked ?? false}
            onBranchChange={setBranch}
            onCherryPick={openCherryPick}
            simulate={simulate}
          />
        )}
      </main>

      <CommandLog />

      {plan && (
        <OpDialog
          plan={plan.plan}
          busy={busy}
          error={error}
          onConfirm={runPlan}
          onCancel={() => setPlan(null)}
        />
      )}

      {pickingFolder && (
        <FolderPicker onCancel={() => setPickingFolder(false)} onChoose={chooseFolder} />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
