import { SnapshotRow } from './store/index';
import { forSnapshot } from './sandbox';

export interface PublicSnapshot {
  id: string;
  repo: { owner: string; name: string; fullName: string; htmlUrl: string | null };
  dateIso: string;
  commitDate: string;
  ref: string | null;
  commit: { sha: string; url: string };
  headSha: string | null;
  status: string;
  previewMode: 'iframe' | 'readme' | 'none';
  projectType: string | null;
  ecosystem: string | null;
  toolchain: Record<string, string> | null;
  error: string | null;
  stages: unknown[];
  diff: unknown;
  advisories: unknown;
  story: unknown;
  timeline: unknown;
  readmeMd: string | null;
  installSnippet: string | null;
  testLog: string | null;
  buildLog: string | null;
  buildMs: number | null;
  preview: { mode: string; active: boolean; url?: string; expiresAt?: number };
  sharePath: string;
  createdAt: string;
  updatedAt: string;
}

export function toPublic(row: SnapshotRow): PublicSnapshot {
  const sb = row.previewMode === 'iframe' ? forSnapshot(row.id) : null;
  return {
    id: row.id,
    repo: { owner: row.owner, name: row.name, fullName: row.repo, htmlUrl: (row.metadata?.repoHtmlUrl as string) || `https://github.com/${row.repo}` },
    dateIso: row.dateIso,
    commitDate: row.commitDate,
    ref: row.ref,
    commit: { sha: row.commitSha, url: `https://github.com/${row.repo}/commit/${row.commitSha}` },
    headSha: row.headSha,
    status: row.status,
    previewMode: row.previewMode,
    projectType: row.projectType,
    ecosystem: row.ecosystem,
    toolchain: row.toolchain,
    error: row.error,
    stages: row.stages || [],
    diff: row.diff,
    advisories: row.advisories,
    story: row.story,
    timeline: row.timeline,
    readmeMd: row.readmeMd,
    installSnippet: row.installSnippet,
    testLog: row.testLog,
    buildLog: row.buildLog,
    buildMs: row.buildMs,
    preview: {
      mode: row.previewMode,
      active: !!sb,
      url: sb ? `/api/preview/${sb.id}/` : undefined,
      expiresAt: sb ? sb.expiresAt : undefined,
    },
    sharePath: `/github.com/${row.owner}/${row.name}@${row.commitDate.slice(0, 10)}`,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
