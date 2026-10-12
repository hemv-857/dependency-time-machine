# Dependency Time Machine

<a href="https://github.com/hemv-857/dependency-time-machine/actions/workflows/ci.yml"><img src="https://github.com/hemv-857/dependency-time-machine/actions/workflows/ci.yml/badge.svg" alt="dependency-time-machine CI"></a> <a href="https://github.com/hemv-857/dependency-time-machine/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a> <img src="https://img.shields.io/badge/TypeScript-3178C6.svg" alt="TypeScript">

Enter any repository URL and a past date. It resolves the commit closest to that
day, rebuilds the project from that exact lockfile, and tells you what shipped
since — the majors, the minors, and the CVEs that no longer exist.

```
http://localhost:3000/github.com/axios/axios@2023-06-01
```

Live preview, permalink per snapshot, and a then-vs-now dependency diff backed by
OSV advisory data.

---

## What it does

| Stage | Behaviour |
|---|---|
| **Resolve** | `git rev-list -n 1 --before=DATE` equivalent via the GitHub API, or jump to a tag |
| **Export** | Download the whole snapshot as a standalone Markdown report |
| **Share** | OpenGraph/Twitter card generated from the permalink, no snapshot needed |
| **Analyse** | Fetch the commit tarball, detect ecosystem, parse manifest and lockfile |
| **Diff** | Lockfile then-vs-now: majors, minors, patches, additions, removals |
| **Security lens** | OSV batch query — which advisories were open back then, which are fixed now, which are still open |
| **Story** | Per-bump changelog narrative, release notes, and deep links to npm versions and version diffs |
| **Build** | Ephemeral container builds that exact dependency tree, then serves the output |

Repositories with no lockfile (libraries) skip the build and show the README plus
an install snippet instead. Lockfile diffing covers npm, pnpm, Yarn,
`requirements.txt`, `go.sum` and `Cargo.lock`; OSV advisories cover npm, PyPI,
Go and crates.io.

Private repositories work through a [GitHub App](#private-repositories).

## Architecture

```
app/                    Next.js App Router — UI + JSON API
src/core/               Pure logic, no I/O: lockfile parsing, diffing, OSV, changelog
src/server/pipeline.ts  Stage orchestration
src/server/builder/     local | docker-api | docker build runners
src/server/store/       Postgres, with an in-memory default
worker/index.ts         BullMQ consumer (out-of-process builds)
```

`src/core/` holds the interesting logic and is fully unit-tested in isolation —
lockfile parsing for npm/pnpm/yarn, semver classification, and changelog
generation. The server layer is thin orchestration over it.

State is in-memory unless you set `DATABASE_URL`; builds run in-process unless you
set `REDIS_URL`. That makes a single-container trial run with no dependencies,
while Postgres and Redis are what you want for real deployments.

## Security model

**This service executes code from repositories chosen by whoever hits the URL.**
`npm ci` runs dependency lifecycle scripts, `npm run build` runs the repo's own
scripts, and `npm start` runs its server. That is arbitrary code execution, so it
is fenced off deliberately:

- The local build runner and the server-mode preview are **refused when
  `NODE_ENV=production`** unless you set `TM_ALLOW_UNSAFE_LOCAL_EXEC=1`. A
  reduced environment variable is not a security boundary; only the runner choice is.
- With `TM_RUNNER=docker`, builds run over the **Docker Engine API** — no docker
  CLI and no local daemon required. Point `TM_DOCKER_HOST` at any reachable
  daemon.
- Containers get **no bind mounts at all**, so they have no host filesystem
  access. Source is uploaded per container and the output is downloaded.
  Capabilities are dropped, privilege escalation is disabled, and
  memory/CPU/PIDs are capped.
- If no isolated runner is reachable the snapshot degrades to changelog-only and
  still returns everything except the live build. It fails closed.
- Input is validated at the boundary: `github.com` only, with a strict owner/name
  charset that also rejects `.` and `..`.
- Snapshot creation, repo resolution and comparison are rate limited per IP.

Deploy with `TM_RUNNER=docker` and a remote daemon. `TM_ALLOW_UNSAFE_LOCAL_EXEC`
is only defensible on a disposable VM with no secrets and no egress.

## Setup

Requires Node 18.17+ (`engines`); CI and the build images run Node 20.

```bash
npm install
cp .env.example .env        # optional; everything has a working default
npm run dev                 # http://localhost:3000
```

For a production-shaped local run:

```bash
npm run build
npm run start:standalone
```

`npm run build` also copies `.next/static` into the standalone tree. Next.js omits
it by design, and without it the server answers stylesheet requests with the HTML
page at status 200 — the app renders unstyled with nothing in the logs.

### With Docker Compose

```bash
docker compose up --build
```

Brings up web, worker, Postgres and Redis.

### Configuration

Everything is optional; defaults run in-process with in-memory state.

| Variable | Default | Notes |
|---|---|---|
| `GITHUB_TOKEN` | — | Anonymous GitHub API is 60 req/hr per IP. Set this. |
| `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` | — | Enables private repos. See below. |
| `TM_STALE_SNAPSHOT_MS` | `900000` | Fail snapshots stranded by a dead process. |
| `TM_PUBLIC_URL` | — | Public origin for permalinks in exported Markdown. |
| `TM_SNAPSHOT_RETENTION_DAYS` | `90` | Age out terminal snapshots. `0` disables. |
| `TM_GITHUB_BUDGET` / `TM_GITHUB_BUDGET_REFILL` | `4000` / `70` | Global token bucket over outbound GitHub calls. |
| `TM_DOCKER_PREVIEW_BIND` | `127.0.0.1` | Address the preview container's port binds to on the daemon host. |
| `TM_PREVIEW_READY_TIMEOUT_MS` | `120000` | How long to wait for a preview container. |
| `DATABASE_URL` | — | Postgres. Without it, snapshots are lost on restart. |
| `REDIS_URL` | — | Redis + BullMQ. Without it, builds run in the web process. |
| `TM_RUNNER` | `auto` | `docker`, `local`, or `auto`. `auto` fails closed. |
| `TM_DOCKER_HOST` | `unix:///var/run/docker.sock` | `tcp://`, `https://`, or `unix://`. |
| `TM_DOCKER_TOKEN` / `TM_DOCKER_CA` | — | For a TLS remote daemon. |
| `TM_ALLOW_UNSAFE_LOCAL_EXEC` | — | Re-enables host execution. Refused in production. |
| `TM_BUILD_TIMEOUT_MS` | `180000` | Hard per-build timeout. |
| `TM_SANDBOX_TTL_MS` | `600000` | Ephemeral preview lifetime. |
| `TM_NODE_IMAGE` / `TM_PYTHON_IMAGE` | `node:20-bookworm-slim` / `python:3.12-slim` | Build images. |
| `TM_DOCKER_NETWORK` | `bridge` | Use a network with registry-only egress. |

Full list in [`.env.example`](.env.example).

## API

```
GET  /api/resolve?repo=github.com/o/r&date=2023-06-01
GET  /api/snapshots?limit=&offset=&repo=&status=&q=   browse/search
GET  /api/snapshot/:id/markdown                        download the report
GET  /og/:owner/:repo/:date                            OpenGraph image
POST /api/snapshot                  { repo, date?, ref?, force? }
GET  /api/snapshot/:id
GET  /api/snapshot/:id/events       SSE progress stream
GET  /api/snapshot/:id/log
POST /api/snapshot/:id/preview      start an ephemeral instance
POST /api/compare                   { repo, a, b }
GET  /api/healthz  /api/readyz
```

`/api/readyz` reports store, queue, GitHub rate limit, and whether the build
runner is reachable. It does not fail readiness when the daemon is down, because
snapshots degrade rather than break.

## Testing

```bash
npm run typecheck
npm test              # 130 unit tests
npm run test:e2e      # build + 11 Playwright tests
```

Unit tests cover the core logic plus the production hardening paths: the stale
reaper, retry classification, Markdown escaping, the new lockfile parsers, the
Docker Engine API, and GitHub App token minting (with a generated RSA key, so the
JWT signature is verified without real credentials). The Docker runner is tested
against a fake Engine API, so the upload/run/download path is verified without a
daemon installed.

`e2e/audit.spec.ts` is a sweep over every route that fails on console errors, page
exceptions, 5xx responses, missing stylesheet regressions, and horizontal
overflow at mobile, tablet and desktop widths. It also asserts the share button
does not claim a copy succeeded when the clipboard write was denied.

## Private repositories

A personal `GITHUB_TOKEN` inherits access to every private repo that user can
read. For a service that builds code that is the wrong trust boundary, so private
repos go through a [GitHub App](https://docs.github.com/en/apps) instead, which is
scoped to the repositories it is installed on and enforced by GitHub — access is
simply "is there an installation for this repo".

1. Create a GitHub App with read-only **Contents** and **Metadata** permission.
2. Install it on the repositories you want reachable.
3. Download the private key and set:

```
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY=/path/to/app.pem   # or the PEM contents, \n for newlines
```

Internally: private key → short-lived JWT (9 min) → installation access token
(1 h, cached in memory for 50 min). Tokens are per-repo scoped and dropped on a
401. Never commit the key.

Without a key configured everything falls back to `GITHUB_TOKEN`, so public
snapshots are unaffected.

## Deployment

- **Docker** — `Dockerfile` has `runner` (web, no build tooling) and `worker`
  (full build stage) targets, plus `docker-compose.yml` for the full stack.
- **Fly.io** — see `fly.toml`. The web machine runs no daemon and no docker CLI;
  point `TM_DOCKER_HOST` at a separate builder host.

## Operating notes

- **Retention.** Terminal snapshots are deleted after `TM_SNAPSHOT_RETENTION_DAYS`
  (90 by default). In-flight rows are never pruned, and neither are stranded ones —
  those are failed by the reaper first.
- **API budget.** A token bucket (`TM_GITHUB_BUDGET`) caps outbound GitHub calls
  per process. The per-IP limiter protects against one client; this protects the
  deployment's own token quota from all of them. `/api/snapshots` reports the
  remaining budget.
- **Caching.** Terminal snapshots are immutable, so `/api/snapshot/:id` sends an
  ETag and `stale-while-revalidate`; repeat permalink views cost a 304. In-flight
  snapshots stay `no-store` so pollers never see stale progress.
- **Browse.** `/snapshots` lists and filters what has been snapshotted.

## Limitations

- Private repositories need a GitHub App; there is no per-user OAuth flow.
- Server-mode previews publish a container port on the daemon host. That is
  loopback-only by default, so a preview is only reachable when this app can dial
  the daemon's loopback. Setting `TM_DOCKER_PREVIEW_BIND=0.0.0.0` publishes a
  stranger's `npm start` to the network — the app logs a warning, but that setting
  is a real exposure.
- The remote-daemon build and preview paths are verified against a fake Engine
  API rather than a live daemon.
- Advisory coverage follows OSV: npm, PyPI, Go and crates.io.
- Release notes are quoted when a package's own repo published one covering the
  jump; otherwise the generic description is kept, so cards can still be vague.
- The API budget is per-process and in-memory, so it resets on restart and is not
  shared between instances.
- Node's `--permission` model is not used as isolation; it is not a security
  boundary.
- In-memory state means one process. Scale out with Postgres + Redis.

## License

MIT — see [LICENSE](LICENSE).