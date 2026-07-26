import { useCallback, useEffect, useState } from 'react';
import { api, type BranchList, type OpResponse } from './api.ts';
import type {
  PipelineReport,
  ReleaseMatrix as Matrix,
  RepoSummary,
  SimulationResult,
  OpStatus,
  ConflictReport,
} from '../../shared/types.ts';
import { PipelineView } from './views/PipelineView.tsx';
import { ReleaseMatrixView } from './views/ReleaseMatrix.tsx';
import { OpDialog, type OpPlan } from './components/OpDialog.tsx';
import { ConflictViewer } from './components/ConflictViewer.tsx';

type Tab = 'pipeline' | 'matrix';

type PendingOp =
  | { kind: 'cherry-pick'; target: string; commits: string[] }
  | { kind: 'merge'; from: string; into: string };

export function App() {
  const [repos, setRepos] = useState<RepoSummary[]>([]);
  const [repoId, setRepoId] = useState<string>('');
  const [branchInfo, setBranchInfo] = useState<BranchList | null>(null);
  const [tab, setTab] = useState<Tab>('pipeline');

  const [pipeline, setPipeline] = useState<PipelineReport | null>(null);
  const [matrix, setMatrix] = useState<Matrix | null>(null);
  const [branch, setBranch] = useState<string>('');

  const [opStatus, setOpStatus] = useState<OpStatus | null>(null);
  const [conflicts, setConflicts] = useState<ConflictReport | null>(null);
  const [plan, setPlan] = useState<{ plan: OpPlan; op: PendingOp } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    api
      .repos()
      .then((list) => {
        setRepos(list);
        if (list.length && !repoId) setRepoId(list[0].id);
      })
      .catch((e) => setError(e.message));
  }, []);

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

      const preferred =
        branch && info.branches.includes(branch)
          ? branch
          : info.branches.find((b) => !info.chain.includes(b)) ?? info.branches[0] ?? '';
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
      setPlan({
        op: { kind: 'merge', from, into },
        plan: {
          title: backMerge ? `Back-merge ${from} into ${into}` : `Promote ${from} into ${into}`,
          summary: backMerge
            ? `Brings ${into} back in line with ${from}, so the next promotion cannot revert it.`
            : `Merges every commit waiting in ${from}.`,
          preview: preview.preview,
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
          </button>
          <button className={tab === 'matrix' ? 'tab active' : 'tab'} onClick={() => setTab('matrix')}>
            Release matrix
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
            <p className="muted">
              worktree: <code>{opStatus.worktreePath}</code>
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

      <main>
        {repos.length === 0 && <div className="empty">No git repos found under the configured scan root.</div>}

        {tab === 'pipeline' && pipeline && (
          <PipelineView
            report={pipeline}
            onPromote={(from, into) => openMerge(from, into, false)}
            onBackMerge={(from, into) => openMerge(from, into, true)}
          />
        )}

        {tab === 'matrix' && matrix && branchInfo && (
          <ReleaseMatrixView
            matrix={matrix}
            branches={branchInfo.branches}
            onBranchChange={setBranch}
            onCherryPick={openCherryPick}
            simulate={simulate}
          />
        )}
      </main>

      {plan && (
        <OpDialog
          plan={plan.plan}
          busy={busy}
          error={error}
          onConfirm={runPlan}
          onCancel={() => setPlan(null)}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
