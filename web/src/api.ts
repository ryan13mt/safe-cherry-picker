import type {
  RepoSummary,
  PipelineReport,
  ReleaseMatrix,
  SimulationResult,
  OpResult,
  OpStatus,
  ConflictReport,
  BrowseResult,
  ScanInfo,
  CleanupReport,
  TicketLookup,
  RemoteReport,
  HotspotReport,
  GitCommandRecord,
} from '../../shared/types.ts';

export interface ApiError extends Error {
  status: number;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(body?.error ?? `Request failed (${res.status})`) as ApiError;
    err.status = res.status;
    throw err;
  }
  return body as T;
}

const post = <T,>(path: string, body: unknown): Promise<T> =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body) });

export interface AppConfigView {
  scanRoot: string;
  chain: string[];
  jiraBaseUrl: string;
  ticketPattern: string;
  scanTruncated: boolean;
  scanVisited: number;
}

export interface BranchList extends RepoSummary {
  branches: string[];
}

export type OpResponse = OpResult & { preview: string[]; simulation?: SimulationResult };

export const api = {
  config: () => request<AppConfigView>('/config'),
  browse: (path?: string) =>
    request<BrowseResult>(`/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  setScanRoot: (path: string) => post<ScanInfo>('/config/scan-root', { path }),
  commands: () => request<GitCommandRecord[]>('/commands'),
  repos: (refresh = false) => request<RepoSummary[]>(`/repos${refresh ? '?refresh=1' : ''}`),
  branches: (id: string) => request<BranchList>(`/repos/${id}/branches`),
  pipeline: (id: string) => request<PipelineReport>(`/repos/${id}/pipeline`),
  releaseStatus: (id: string, branch: string) =>
    request<ReleaseMatrix>(`/repos/${id}/release-status?branch=${encodeURIComponent(branch)}`),
  simulate: (id: string, target: string, commits: string[]) =>
    post<SimulationResult>(`/repos/${id}/simulate`, { target, commits }),
  cherryPick: (
    id: string,
    body: {
      target: string;
      commits: string[];
      style: 'individual' | 'squash';
      sourceBranch?: string;
      dryRun?: boolean;
    },
  ) => post<OpResponse>(`/repos/${id}/cherry-pick`, body),
  merge: (id: string, body: { from: string; into: string; noFf?: boolean; dryRun?: boolean }) =>
    post<OpResponse>(`/repos/${id}/merge`, body),
  find: (id: string, ticket: string) =>
    request<TicketLookup>(`/repos/${id}/find?ticket=${encodeURIComponent(ticket)}`),
  remote: (id: string) => request<RemoteReport>(`/repos/${id}/remote`),
  fetch: (id: string) => post<RemoteReport>(`/repos/${id}/fetch`, {}),
  hotspots: (id: string) => request<HotspotReport>(`/repos/${id}/hotspots`),
  cleanup: (id: string) => request<CleanupReport>(`/repos/${id}/cleanup`),
  deleteBranch: (id: string, name: string) =>
    post<{ name: string; deleted: string; preview: string[] }>(`/repos/${id}/delete-branch`, { name }),
  opStatus: (id: string) => request<OpStatus>(`/repos/${id}/op/status`),
  opContinue: (id: string) => post<OpResponse>(`/repos/${id}/op/continue`, {}),
  opAbort: (id: string) => post<OpResponse>(`/repos/${id}/op/abort`, {}),
  opSkip: (id: string) => post<OpResponse>(`/repos/${id}/op/skip`, {}),
  conflicts: (id: string) => request<ConflictReport>(`/repos/${id}/op/conflicts`),
  resolve: (id: string, path: string, choice: 'ours' | 'theirs') =>
    post<OpResponse>(`/repos/${id}/op/resolve`, { path, choice }),
};
