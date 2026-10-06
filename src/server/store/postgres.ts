import { Pool } from 'pg';
import { newId, nowIso, Store, SnapshotRow } from './index';

const COLS = [
  'id', 'owner', 'name', 'repo', 'date_iso', 'ref', 'commit_sha', 'commit_date', 'head_sha',
  'status', 'preview_mode', 'project_type', 'ecosystem', 'toolchain', 'error', 'metadata',
  'diff', 'advisories', 'story', 'timeline', 'readme_md', 'install_snippet', 'test_log',
  'build_log', 'stages', 'build_ms', 'created_at', 'updated_at',
] as const;

const globalForPg = globalThis as unknown as { __tmPool?: Pool; __tmPgStore?: Store };

function pool(): Pool {
  if (!globalForPg.__tmPool) {
    globalForPg.__tmPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
  }
  return globalForPg.__tmPool;
}

function rowFrom(r: any): SnapshotRow {
  return {
    id: r.id,
    owner: r.owner,
    name: r.name,
    repo: r.repo,
    dateIso: r.date_iso,
    ref: r.ref,
    commitSha: r.commit_sha,
    commitDate: r.commit_date,
    headSha: r.head_sha,
    status: r.status,
    previewMode: r.preview_mode,
    projectType: r.project_type,
    ecosystem: r.ecosystem,
    toolchain: r.toolchain,
    error: r.error,
    metadata: r.metadata,
    diff: r.diff,
    advisories: r.advisories,
    story: r.story,
    timeline: r.timeline,
    readmeMd: r.readme_md,
    installSnippet: r.install_snippet,
    testLog: r.test_log,
    buildLog: r.build_log,
    stages: r.stages,
    buildMs: r.build_ms,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function postgresStore(): Store {
  if (globalForPg.__tmPgStore) return globalForPg.__tmPgStore;
  let p: Pool | null = null;
  const get = () => p || (p = pool());

  const store: Store = {
    async init() {
      await get().query(`
        CREATE TABLE IF NOT EXISTS snapshots (
          id TEXT PRIMARY KEY,
          owner TEXT NOT NULL,
          name TEXT NOT NULL,
          repo TEXT NOT NULL,
          date_iso TIMESTAMPTZ NOT NULL,
          ref TEXT,
          commit_sha TEXT NOT NULL,
          commit_date TIMESTAMPTZ NOT NULL,
          head_sha TEXT,
          status TEXT NOT NULL,
          preview_mode TEXT NOT NULL DEFAULT 'none',
          project_type TEXT,
          ecosystem TEXT,
          toolchain JSONB,
          error TEXT,
          metadata JSONB,
          diff JSONB,
          advisories JSONB,
          story JSONB,
          timeline JSONB,
          readme_md TEXT,
          install_snippet TEXT,
          test_log TEXT,
          build_log TEXT,
          stages JSONB NOT NULL DEFAULT '[]'::jsonb,
          build_ms BIGINT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS snapshots_repo_commit_idx ON snapshots (repo, commit_sha);
        CREATE INDEX IF NOT EXISTS snapshots_status_idx ON snapshots (status);
      `);
    },
    async createSnapshot(row) {
      const v = [
        row.id, row.owner, row.name, row.repo, row.dateIso, row.ref, row.commitSha, row.commitDate,
        row.headSha, row.status, row.previewMode, row.projectType, row.ecosystem,
        row.toolchain ? JSON.stringify(row.toolchain) : null, row.error,
        row.metadata ? JSON.stringify(row.metadata) : null,
        row.diff ? JSON.stringify(row.diff) : null,
        row.advisories ? JSON.stringify(row.advisories) : null,
        row.story ? JSON.stringify(row.story) : null,
        row.timeline ? JSON.stringify(row.timeline) : null,
        row.readmeMd, row.installSnippet, row.testLog, row.buildLog,
        JSON.stringify(row.stages || []), row.buildMs, row.createdAt, row.updatedAt,
      ];
      await get().query(
        `INSERT INTO snapshots (${COLS.join(',')}) VALUES (${COLS.map((_, i) => `$${i + 1}`).join(',')})`,
        v
      );
    },
    async getSnapshot(id) {
      const res = await get().query(`SELECT * FROM snapshots WHERE id = $1`, [id]);
      return res.rows[0] ? rowFrom(res.rows[0]) : null;
    },
    async findSnapshot(repo, sha) {
      const res = await get().query(
        `SELECT * FROM snapshots WHERE repo = $1 AND commit_sha = $2
         AND status IN ('ready','degraded','building','analyzing','queued')
         ORDER BY created_at DESC LIMIT 1`,
        [repo, sha]
      );
      return res.rows[0] ? rowFrom(res.rows[0]) : null;
    },
    async updateSnapshot(id, patch) {
      const map: Record<string, string> = {
        dateIso: 'date_iso', commitSha: 'commit_sha', commitDate: 'commit_date', headSha: 'head_sha',
        previewMode: 'preview_mode', projectType: 'project_type', buildLog: 'build_log',
        readmeMd: 'readme_md', installSnippet: 'install_snippet', testLog: 'test_log', buildMs: 'build_ms',
      };
      const sets: string[] = [];
      const vals: unknown[] = [];
      let i = 1;
      for (const [k, v] of Object.entries(patch)) {
        const col = map[k] || k;
        sets.push(`${col} = $${i}`);
        vals.push(typeof v === 'object' && v !== null ? JSON.stringify(v) : v);
        i++;
      }
      sets.push(`updated_at = $${i}`);
      vals.push(nowIso());
      vals.push(id);
      await get().query(`UPDATE snapshots SET ${sets.join(', ')} WHERE id = $${i + 1}`, vals);
    },
    async listStranded(before) {
      const res = await get().query(
        `SELECT * FROM snapshots
         WHERE status NOT IN ('ready','degraded','failed') AND updated_at < $1
         ORDER BY updated_at ASC LIMIT 200`,
        [before]
      );
      return res.rows.map(rowFrom);
    },
    async close() {
      await pool().end();
    },
  };
  globalForPg.__tmPgStore = store;
  return store;
}

export { newId };
