import { SnapshotStatus, Stage } from '@/core/types';

export interface SnapshotRow {
  id: string;
  owner: string;
  name: string;
  repo: string; // owner/name
  dateIso: string;
  ref: string | null;
  commitSha: string;
  commitDate: string;
  headSha: string | null;
  status: SnapshotStatus;
  previewMode: 'iframe' | 'readme' | 'none';
  projectType: string | null;
  ecosystem: string | null;
  toolchain: Record<string, string> | null;
  error: string | null;
  metadata: Record<string, unknown> | null;
  diff: import('@/core/types').LockDiff | null;
  advisories: import('@/core/types').SecurityLens | null;
  story: import('@/core/types').Story | null;
  timeline: import('@/core/types').TimelinePoint[] | null;
  readmeMd: string | null;
  installSnippet: string | null;
  testLog: string | null;
  buildLog: string | null;
  stages: Stage[];
  buildMs: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface Store {
  init(): Promise<void>;
  createSnapshot(row: SnapshotRow): Promise<void>;
  getSnapshot(id: string): Promise<SnapshotRow | null>;
  findSnapshot(repo: string, commitSha: string): Promise<SnapshotRow | null>;
  updateSnapshot(id: string, patch: Partial<SnapshotRow>): Promise<void>;
  close(): Promise<void>;
}

export function newId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

type Rowish = Partial<SnapshotRow>;

export function memoryStore(): Store {
  const rows = new Map<string, SnapshotRow>();
  return {
    async init() {},
    async createSnapshot(row) {
      rows.set(row.id, { ...row });
    },
    async getSnapshot(id) {
      return rows.get(id) ? { ...rows.get(id)! } : null;
    },
    async findSnapshot(repo, sha) {
      for (const r of rows.values()) {
        if (r.repo === repo && r.commitSha === sha && ['ready', 'degraded', 'building', 'analyzing', 'queued'].includes(r.status)) {
          return { ...r };
        }
      }
      return null;
    },
    async updateSnapshot(id, patch: Rowish) {
      const r = rows.get(id);
      if (!r) return;
      Object.assign(r, patch, { updatedAt: nowIso() });
    },
    async close() {
      rows.clear();
    },
  };
}

const globalForStore = globalThis as unknown as { __tmStore?: Store };

export function getStore(): Store {
  if (globalForStore.__tmStore) return globalForStore.__tmStore;
  let s: Store;
  if (process.env.DATABASE_URL) {
    // lazy require so dev without pg config never loads the driver
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { postgresStore } = require('./postgres') as typeof import('./postgres');
    s = postgresStore();
  } else {
    s = memoryStore();
  }
  globalForStore.__tmStore = s;
  return s;
}
