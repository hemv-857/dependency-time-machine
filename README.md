# Dependency Time Machine

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
| **Analyse** | Fetch the commit tarball, detect ecosystem, parse manifest and lockfile |
| **Diff** | Lockfile then-vs-now: majors, minors, patches, additions, removals |
| **Security lens** | OSV batch query — which advisories were open back then, which are fixed now, which are still open |
| **Story** | Per-bump changelog narrative, release notes, and deep links to npm versions and version diffs |
| **Build** | Ephemeral container builds that exact dependency tree, then serves the output |

Repositories with no lockfile (libraries) skip the build and show the README plus
an install snippet instead. Public GitHub only, in v1.

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
npm test              # 39 unit tests
npm run test:e2e      # build + 11 Playwright tests
```

Unit tests cover the core logic plus the production hardening paths. The Docker
runner is tested against a fake Engine API, so the upload/run/download path is
verified without a daemon installed.

`e2e/audit.spec.ts` is a sweep over every route that fails on console errors, page
exceptions, 5xx responses, missing stylesheet regressions, and horizontal
overflow at mobile, tablet and desktop widths. It also asserts the share button
does not claim a copy succeeded when the clipboard write was denied.

## Deployment

- **Docker** — `Dockerfile` has `runner` (web, no build tooling) and `worker`
  (full build stage) targets, plus `docker-compose.yml` for the full stack.
- **Fly.io** — see `fly.toml`. The web machine runs no daemon and no docker CLI;
  point `TM_DOCKER_HOST` at a separate builder host.

## Limitations

- Public GitHub repositories only; private repos are not supported.
- Server-mode previews (`npm start`) still require a local runner. Publishing a
  container port to a *remote* daemon would make the preview network-reachable,
  which is a different security decision from the build path, so it stays gated.
- The remote-daemon build path is verified against a fake Engine API rather than a
  live daemon.
- Node's `--permission` model is not used as isolation; it is not a security
  boundary.
- In-memory state means one process. Scale out with Postgres + Redis.

## License

MIT — see [LICENSE](LICENSE).