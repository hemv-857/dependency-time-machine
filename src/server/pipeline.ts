import { buildStory } from '@/core/changelog/story';
import { resolveCommit, NotFoundError, RateLimitError } from '@/core/git/resolve';
import { detectProject } from '@/core/detect';
import { diffLockfiles } from '@/core/lockfile/diff';
import { parseLockfileFrom, parseManifestFrom } from '@/core/lockfile/parse';
import { buildSecurityLens } from '@/core/security/osv';
import { buildTimeline } from '@/core/timeline';
import { LockDiff, PkgChange, ReleaseInfo, SecurityLens, SnapshotStatus, Stage } from '@/core/types';
import { GhClient } from './github';
import { childLogger } from './log';
import { npmDoc } from './npm-registry';
import { planBuild, BuildPlan } from './builder/plan';
import { runLocal, toolchainVersions } from './builder/local';
import { runDocker, dockerAvailable } from './builder/docker';
import { untrustedExecAllowed } from './builder/local';
import { findOutDir } from './builder/local';
import { stopForSnapshot } from './sandbox';
import { newId, nowIso, Store, SnapshotRow } from './store/index';
import { TtlCache } from './ttl-cache';
import path from 'node:path';

const log = childLogger({ mod: 'pipeline' });

// ---------------------------------------------------------------- helpers

interface CommitResolution {
  sha: string;
  committedDate: string;
  repo: { fullName: string; htmlUrl: string; description?: string; createdAt: string };
}

const resolveCache = new TtlCache<CommitResolution>(15 * 60 * 1000);
const analysisCache = new TtlCache<Analysis>(60 * 60 * 1000);

export interface Analysis {
  files: string[];
  projectType: string;
  ecosystem: string;
  lockfile: import('@/core/types').Lockfile | null;
  manifest: import('@/core/types').Manifest | null;
  readmeMd: string | null;
  hasLockfile: boolean;
}

export function dataDir(): string {
  return process.env.TM_DATA_DIR || '.data';
}

export function buildDir(repo: string, sha: string): string {
  return `${dataDir()}/builds/${repo.replace('/', '~')}/${sha.slice(0, 12)}`;
}

// ---------------------------------------------------------------- analysis

export async function analyzeCommit(gh: GhClient, fullName: string, sha: string): Promise<Analysis> {
  const cacheKey = `${fullName}@${sha}`;
  const hit = analysisCache.get(cacheKey);
  if (hit) return hit;

  const { fetchTree, listFiles, readTreeFile } = await import('./trees');
  const tree = await fetchTree(gh, fullName, sha);
  const files = await listFiles(tree);
  const info = detectProject(files);
  const lockfile = parseLockfileFrom(files, (p) => readTreeFile(tree, p));
  const manifest = parseManifestFrom(files, (p) => readTreeFile(tree, p));
  const readmeMd = info.readmePath ? readTreeFile(tree, info.readmePath) : null;
  const value: Analysis = {
    files,
    projectType: info.type,
    ecosystem: info.ecosystem,
    lockfile,
    manifest,
    readmeMd,
    hasLockfile: !!lockfile,
  };
  analysisCache.set(cacheKey, value);
  return value;
}

async function enrichDiff(
  diff: LockDiff,
  ecosystem: string,
  lens: SecurityLens
): Promise<Record<string, import('@/core/changelog/story').NpmDocLite | null>> {
  const docs: Record<string, import('@/core/changelog/story').NpmDocLite | null> = {};
  if (ecosystem !== 'npm') return docs;
  const interesting = diff.changes.filter((c) => ['major', 'minor', 'patch'].includes(c.kind));
  const names = [
    ...interesting.filter((c) => c.kind === 'major').map((c) => c.name),
    ...interesting.filter((c) => c.kind !== 'major').map((c) => c.name),
  ].slice(0, 12);
  for (const n of new Set(names)) docs[n] = await npmDoc(n);

  // real release notes for the biggest bumps, from each package's own repo.
  // best effort and capped — a missing notes page must never fail the snapshot.
  const gh = (await import('./github')).ghClient();
  const { packageReleaseNotes } = await import('./pkg-notes');
  const { githubRepoFromNpmDoc } = await import('@/core/changelog/story');
  const notable = diff.changes.filter((c) => c.kind === 'major' && c.to).slice(0, 8);
  await Promise.all(
    notable.map(async (c) => {
      const doc = docs[c.name];
      if (!doc) return;
      const slug = githubRepoFromNpmDoc(doc);
      if (!slug) return;
      try {
        const notes = await packageReleaseNotes(gh, slug, c.from, c.to!);
        if (notes) doc.notes = notes;
      } catch {
        /* keep the generic body */
      }
    })
  );
  for (const c of diff.changes) {
    if (c.kind === 'added' || c.kind === 'removed') continue;
    const doc = docs[c.name] || null;
    const links: PkgChange['links'] = [
      { label: 'npm versions', href: `https://www.npmjs.com/package/${c.name}?activeTab=versions` },
    ];
    if (doc) {
      const { githubRepoFromNpmDoc } = await import('@/core/changelog/story');
      const repo = githubRepoFromNpmDoc(doc);
      if (repo) links.splice(1, 0, { label: 'releases', href: `https://github.com/${repo}/releases` });
      links.push({ label: 'diff', href: `https://npmdiff.dev/${c.name}/${c.from || '—'}/${c.name}/${c.to}` });
    }
    c.links = links;
    c.advisories = lens.then
      .filter((a) => a.packages.includes(c.name))
      .map((a) => ({ id: a.id, severity: a.severity, url: a.url }));
  }
  return docs;
}

// ---------------------------------------------------------------- snapshot lifecycle

export interface EnsureInput {
  owner: string;
  name: string;
  dateIso?: string;
  ref?: string | null;
  force?: boolean;
}

export async function resolveTarget(gh: GhClient, fullName: string, opts: { dateIso?: string; ref?: string | null }): Promise<CommitResolution> {
  const key = `${fullName}|${opts.ref || opts.dateIso || ''}`;
  const hit = resolveCache.get(key);
  if (hit) return hit;
  const r = await resolveCommit(gh, fullName, { dateIso: opts.dateIso, ref: opts.ref || undefined });
  const value: CommitResolution = {
    sha: r.sha,
    committedDate: r.committedDate,
    repo: { fullName, htmlUrl: r.repo.html_url, description: r.repo.description, createdAt: r.repo.created_at },
  };
  resolveCache.set(key, value);
  return value;
}

export async function ensureSnapshot(input: EnsureInput): Promise<SnapshotRow> {
  const gh = (await import('./github')).ghClient();
  const store = (await import('./store/index')).getStore();
  const queue = (await import('./queue')).getQueue();
  const fullName = `${input.owner}/${input.name}`;

  const target = await resolveTarget(gh, fullName, { dateIso: input.dateIso, ref: input.ref });

  if (!input.force) {
    const existing = await store.findSnapshot(fullName, target.sha);
    if (existing) return existing;
  }

  const row: SnapshotRow = {
    id: newId(),
    owner: input.owner,
    name: input.name,
    repo: fullName,
    dateIso: input.dateIso || target.committedDate,
    ref: input.ref || null,
    commitSha: target.sha,
    commitDate: target.committedDate,
    headSha: null,
    status: 'queued',
    previewMode: 'none',
    projectType: null,
    ecosystem: null,
    toolchain: null,
    error: null,
    metadata: {
      repoHtmlUrl: target.repo.htmlUrl,
      description: target.repo.description || null,
      repoCreatedAt: target.repo.createdAt,
      requestedRef: input.ref || null,
    },
    diff: null,
    advisories: null,
    story: null,
    timeline: null,
    readmeMd: null,
    installSnippet: null,
    testLog: null,
    buildLog: null,
    stages: [stage('resolve', 'ok', null, `${target.sha.slice(0, 10)} @ ${target.committedDate.slice(0, 10)}`)],
    buildMs: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await store.createSnapshot(row);
  await queue.enqueue(row.id);
  return row;
}

function stage(name: string, status: Stage['status'], startedAt: string | null, detail?: string): Stage {
  return { name, status, startedAt: startedAt || nowIso(), endedAt: status === 'running' ? undefined : nowIso(), detail };
}

async function setStatus(store: Store, row: SnapshotRow, status: SnapshotStatus, stages: Stage[]): Promise<void> {
  row.status = status;
  row.stages = stages;
  await store.updateSnapshot(row.id, { status, stages });
  const { publishStage, setLastPayload } = await import('./events');
  setLastPayload(row.id, row);
  publishStage(row.id, stages, status);
}

// ---------------------------------------------------------------- the job

export async function runSnapshotJob(id: string): Promise<void> {
  const store = (await import('./store/index')).getStore();
  const gh = (await import('./github')).ghClient();
  const row = await store.getSnapshot(id);
  if (!row) return;
  const jobLog = childLogger({ mod: 'pipeline', snapshotId: id, repo: row.repo });
  const stages: Stage[] = [...(row.stages || [])];

  try {
    // ---- trees + analysis
    stages.push(stage('fetch', 'running', nowIso()));
    await setStatus(store, row, 'analyzing', stages);
    const head = await gh.latestCommit(row.repo);
    const [thenAnalysis, nowAnalysis] = await Promise.all([
      analyzeCommit(gh, row.repo, row.commitSha),
      analyzeCommit(gh, row.repo, head.sha),
    ]);
    stages[stages.length - 1] = {
      ...stages[stages.length - 1],
      status: 'ok',
      endedAt: nowIso(),
      detail: `${thenAnalysis.files.length} files (then) · ${nowAnalysis.files.length} (now)`,
    };
    await setStatus(store, row, 'analyzing', stages);

    // ---- diff
    stages.push(stage('diff', 'running', nowIso()));
    await setStatus(store, row, 'analyzing', stages);
    const diff = diffLockfiles(thenAnalysis.lockfile, nowAnalysis.lockfile);
    stages[stages.length - 1] = { ...stages[stages.length - 1], status: 'ok', endedAt: nowIso(), detail: `${diff.counts.total} changes` };
    await setStatus(store, row, 'analyzing', stages);

    // ---- security lens (OSV) — best effort
    stages.push(stage('security', 'running', nowIso()));
    let lens = await buildSecurityLens(thenAnalysis.lockfile, nowAnalysis.lockfile);
    stages[stages.length - 1] = {
      ...stages[stages.length - 1],
      status: lens.available ? 'ok' : 'skipped',
      endedAt: nowIso(),
      detail: lens.available ? `${lens.then.length} advisories then · ${lens.fixed.length} fixed now` : 'OSV unavailable',
    };
    await setStatus(store, row, 'analyzing', stages);

    // ---- story + timeline (registry lookups capped)
    stages.push(stage('story', 'running', nowIso()));
    let releases: ReleaseInfo[] = [];
    try {
      releases = await gh.releases(row.repo);
    } catch (e) {
      jobLog.warn({ err: (e as Error).message }, 'releases unavailable');
    }
    const docs = await enrichDiff(diff, thenAnalysis.ecosystem, lens);
    const story = buildStory({
      repoFullName: row.repo,
      repoUrl: (row.metadata?.repoHtmlUrl as string) || `https://github.com/${row.repo}`,
      thenIso: row.commitDate,
      diff,
      lens,
      releases,
      npmDocs: docs,
    });
    const repoMeta = await gh.repo(row.repo).catch(() => null);
    const timeline = buildTimeline(releases, repoMeta?.created_at);
    stages[stages.length - 1] = { ...stages[stages.length - 1], status: 'ok', endedAt: nowIso(), detail: `${story.cards.length} cards` };

    const toolchain = toolchainVersions();
    row.headSha = head.sha;
    row.projectType = thenAnalysis.projectType;
    row.ecosystem = thenAnalysis.ecosystem;
    row.readmeMd = thenAnalysis.readmeMd;
    row.installSnippet = installSnippetFor(thenAnalysis);
    row.diff = diff;
    row.advisories = lens;
    row.story = story;
    row.timeline = timeline;
    row.toolchain = toolchain;
    await store.updateSnapshot(row.id, {
      headSha: head.sha,
      projectType: thenAnalysis.projectType,
      ecosystem: thenAnalysis.ecosystem,
      readmeMd: thenAnalysis.readmeMd,
      installSnippet: row.installSnippet,
      diff,
      advisories: lens,
      story,
      timeline,
      toolchain,
    });

    // ---- build / runnability
    const plan = planBuild({ type: thenAnalysis.projectType, manifest: thenAnalysis.manifest, hasLockfile: thenAnalysis.hasLockfile });
    if (!plan) {
      row.previewMode = 'readme';
      stages.push(stage('build', 'skipped', nowIso(), 'not a runnable app — showing README + install snippet'));
      await store.updateSnapshot(row.id, { previewMode: 'readme' });
      await setStatus(store, row, 'ready', stages);
      await finish(store, row, stages);
      return;
    }

    stages.push(stage('build', 'running', nowIso()));
    await setStatus(store, row, 'building', stages);
    const result = await executeBuild(row, thenAnalysis, plan);
    row.buildLog = result.log;
    row.buildMs = result.ms;
    const persistBuild = {
      buildLog: result.log,
      buildMs: result.ms,
      testLog: result.mode === 'test' ? result.log : null,
    };
    if (result.ok && (result.mode === 'static' || result.mode === 'server')) {
      row.previewMode = 'iframe';
      stages[stages.length - 1] = {
        ...stages[stages.length - 1],
        status: 'ok',
        endedAt: nowIso(),
        detail: `${result.mode === 'static' ? `static output in ${result.outDir}` : 'server app'} (${Math.round(result.ms / 1000)}s)`,
      };
      await store.updateSnapshot(row.id, { previewMode: 'iframe', ...persistBuild });
      await setStatus(store, row, 'ready', stages);
    } else if (result.ok && result.mode === 'test') {
      row.previewMode = 'readme';
      row.testLog = result.log;
      stages[stages.length - 1] = { ...stages[stages.length - 1], status: 'ok', endedAt: nowIso(), detail: `tests ran (${Math.round(result.ms / 1000)}s)` };
      await store.updateSnapshot(row.id, { previewMode: 'readme', ...persistBuild });
      await setStatus(store, row, 'ready', stages);
    } else {
      row.previewMode = 'none';
      const why = result.timedOut
        ? `build exceeded the ${Math.round(Number(process.env.TM_BUILD_TIMEOUT_MS || 180000) / 1000)}s hard timeout — changelog only, no live preview`
        : 'build failed — changelog only, no live preview';
      stages[stages.length - 1] = { ...stages[stages.length - 1], status: 'failed', endedAt: nowIso(), detail: why };
      await store.updateSnapshot(row.id, { previewMode: 'none', ...persistBuild });
      await setStatus(store, row, 'degraded', stages);
    }
    await finish(store, row, stages);
  } catch (e) {
    const err = e as Error;
    const message =
      e instanceof NotFoundError
        ? `Repository not found (or private): ${row.repo}`
        : e instanceof RateLimitError
          ? err.message
          : err.message;
    jobLog.error({ err: message }, 'snapshot job failed');
    stages.push(stage('error', 'failed', nowIso(), message));
    await store.updateSnapshot(row.id, { status: 'failed', error: message, stages });
    const { publishStage, setLastPayload, publish } = await import('./events');
    const fresh = await store.getSnapshot(row.id);
    if (fresh) {
      setLastPayload(row.id, fresh);
      publish(row.id, 'done', fresh);
    }
    publishStage(row.id, stages, 'failed');
  }
}

async function finish(store: Store, row: SnapshotRow, stages: Stage[]): Promise<void> {
  const { setLastPayload, publish } = await import('./events');
  const fresh = await store.getSnapshot(row.id);
  if (fresh) {
    setLastPayload(row.id, fresh);
    publish(row.id, 'done', fresh);
  }
  log.info({ snapshotId: row.id, repo: row.repo, status: row.status, previewMode: row.previewMode }, 'snapshot ready');
}

function installSnippetFor(analysis: Analysis): string | null {
  if (analysis.manifest?.ownName) {
    if (analysis.ecosystem === 'go') {
      return `go get ${analysis.manifest.ownName}@${analysis.manifest.ownVersion || 'latest'}`;
    }
    if (analysis.ecosystem === 'cargo') {
      return `cargo add ${analysis.manifest.ownName}${
        analysis.manifest.ownVersion ? `@${analysis.manifest.ownVersion}` : ''
      }`;
    }
    return `npm i ${analysis.manifest.ownName}@${analysis.manifest.ownVersion || 'latest'}`;
  }
  if (analysis.ecosystem === 'pypi') return 'pip install -r requirements.txt';
  return null;
}

// ---------------------------------------------------------------- build execution

interface ExecResult {
  ok: boolean;
  mode: 'static' | 'server' | 'test' | 'none';
  outDir?: string;
  projDir?: string;
  ms: number;
  log: string;
  timedOut: boolean;
}

async function executeBuild(row: SnapshotRow, analysis: Analysis, plan: BuildPlan): Promise<ExecResult> {
  const bdir = buildDir(row.repo, row.commitSha);
  const projDir = `${bdir}/proj`;
  const resultFile = `${bdir}/result.json`;
  const fs = await import('node:fs/promises');

  // build cache: (repo, commit, plan shape)
  try {
    const cached = JSON.parse(await fs.readFile(resultFile, 'utf8'));
    if (cached && cached.ok && cached.planKey === planKey(plan)) return cached as ExecResult;
  } catch {
    /* no cache */
  }

  await fs.rm(bdir, { recursive: true, force: true });
  await fs.mkdir(bdir, { recursive: true });
  const { fetchTree } = await import('./trees');
  const gh = (await import('./github')).ghClient();
  const tree = await fetchTree(gh, row.repo, row.commitSha);
  await fs.cp(tree, projDir, { recursive: true });

  const logParts: string[] = [];
  const runner = await pickRunner();
  const res =
    runner === 'docker'
      ? await runDocker(plan, projDir, (c) => logParts.push(c))
      : await runLocal(plan, projDir, (c) => logParts.push(c));

  let mode: ExecResult['mode'] = 'none';
  let outDir: string | undefined;
  if (plan.mode === 'test') {
    mode = 'test';
  } else if (res.ok) {
    // A remote-daemon run already downloaded its output; only a local run
    // needs the output probed on disk.
    const found = (res as { outHint?: string }).outHint || (await findOutDir(projDir, plan.outDirs));
    if (found) {
      mode = 'static';
      outDir = path.relative(projDir, found);
    } else if (plan.startScript) {
      mode = 'server';
    } else {
      mode = 'none';
    }
  }
  const exec: ExecResult & { planKey: string } = {
    ok: res.ok && mode !== 'none',
    mode,
    outDir,
    projDir,
    ms: res.ms,
    log: logParts.join('') || res.log,
    timedOut: res.timedOut,
    planKey: planKey(plan),
  };
  if (exec.ok) await fs.writeFile(resultFile, JSON.stringify(exec));
  return exec;
}

function planKey(plan: BuildPlan): string {
  return `${plan.mode}:${plan.steps.map((s) => s.name).join('+')}`;
}

async function pickRunner(): Promise<'local' | 'docker'> {
  const pref = process.env.TM_RUNNER || 'auto';
  if (pref === 'docker') return 'docker';
  if (pref === 'local') return 'local';
  return (await dockerAvailable()) ? 'docker' : 'local';
}

// ---------------------------------------------------------------- preview

export async function ensurePreview(id: string): Promise<{ sandboxId: string; url: string; expiresAt: number }> {
  const store = (await import('./store/index')).getStore();
  const row = await store.getSnapshot(id);
  if (!row) throw new NotFoundError(`snapshot ${id} not found`);
  if (row.status !== 'ready') throw new Error(`snapshot is ${row.status}, not ready`);
  if (row.previewMode !== 'iframe') throw new Error('this snapshot has no live preview');

  const { start, info, stopForSnapshot } = await import('./sandbox');
  stopForSnapshot(id); // one live sandbox per snapshot

  const bdir = buildDir(row.repo, row.commitSha);
  const projDir = `${bdir}/proj`;
  const fs = await import('node:fs/promises');
  let result: (ExecResult & { planKey?: string }) | null = null;
  try {
    result = JSON.parse(await fs.readFile(`${bdir}/result.json`, 'utf8'));
  } catch {
    result = null;
  }
  let analysis: Analysis | null = null;
  let plan: BuildPlan | null = null;
  if (!result || !result.ok) {
    // cache miss → run the build now
    analysis = await analyzeCommit((await import('./github')).ghClient(), row.repo, row.commitSha);
    plan = planBuild({ type: analysis.projectType, manifest: analysis.manifest, hasLockfile: analysis.hasLockfile });
    if (!plan) throw new Error('not runnable');
    result = await executeBuild(row, analysis, plan);
    if (!result.ok) throw new Error('build failed — no preview available');
  }
  // a cached result.json still needs the plan to know how to install+start
  if (!analysis) analysis = await analyzeCommit((await import('./github')).ghClient(), row.repo, row.commitSha);
  if (!plan) {
    plan = planBuild({ type: analysis.projectType, manifest: analysis.manifest, hasLockfile: analysis.hasLockfile });
  }
  if (!plan) throw new Error('not runnable');

  const sb =
    result.mode === 'static' && result.outDir
      ? await start({ snapshotId: id, staticDir: `${projDir}/${result.outDir}` })
      : await startServerPreview({ snapshotId: id, projDir, analysis, plan });

  return { sandboxId: sb.id, url: `/api/preview/${sb.id}`, expiresAt: sb.expiresAt };
}

/**
 * Start a repo's own server for the preview.
 *
 * Preferred path is a container, so this works with a remote daemon: the tree is
 * uploaded and `npm start` runs inside an ephemeral container with the same
 * hardening as a build. The local runner stays as the dev fallback, and is still
 * refused in production unless explicitly allowed — which it now does *after*
 * Docker has been ruled out, rather than before it is even considered.
 */
async function startServerPreview(args: {
  snapshotId: string;
  projDir: string;
  analysis: Analysis;
  plan: BuildPlan;
}): Promise<{ id: string; expiresAt: number }> {
  const { startContainer, start } = await import('./sandbox');
  const install = args.plan.steps.find((s) => s.name === 'install')?.cmd;
  try {
    return await startContainer({
      snapshotId: args.snapshotId,
      projDir: args.projDir,
      startCmd: 'npm start',
      installCmd: install,
      image: args.plan.toolchain === 'python' ? process.env.TM_PYTHON_IMAGE : process.env.TM_NODE_IMAGE,
    });
  } catch (e) {
    if (!untrustedExecAllowed()) throw e;
    log.warn({ err: (e as Error).message }, 'container preview unavailable — falling back to the local runner');
    return start({
      snapshotId: args.snapshotId,
      startCmd: 'npm start',
      projDir: args.projDir,
    });
  }
}

export type { SnapshotRow, Store };
export { NotFoundError, RateLimitError };
