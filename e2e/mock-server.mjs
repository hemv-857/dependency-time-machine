#!/usr/bin/env node
/*
 * Hermetic mock for external APIs used in E2E/CI:
 *   :3112  → GitHub REST + OSV + npm registry
 * Fixture repo "demo/demo": two commits, a minor bump + a fake advisory,
 * and a zero-dependency app that builds a static page (no registry needed).
 */
import http from 'node:http';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.MOCK_PORT || 3112);
const C1 = 'c1111111111111111111111111111111111111111';
const C2 = 'c2222222222222222222222222222222222222222';

const tmp = mkdtempSync(path.join(tmpdir(), 'tm-e2e-'));
const makeTree = (dir, files) => {
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content);
};
const t1 = path.join(tmp, C1);
const t2 = path.join(tmp, C2);
makeTree(t1, {
  'package.json': JSON.stringify({ name: 'demo-app', version: '1.0.0', scripts: { build: 'node make-dist.js' } }),
  'package-lock.json': JSON.stringify({
    name: 'demo-app',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: { '': { name: 'demo-app' }, 'node_modules/left-pad': { version: '1.0.0' } },
  }),
  'make-dist.js': `require('node:fs').mkdirSync('dist',{recursive:true});require('node:fs').writeFileSync('dist/index.html','<h1>Hello from the past</h1><p>demo-app @ 2023</p>');`,
});
makeTree(t2, {
  'package.json': JSON.stringify({ name: 'demo-app', version: '2.0.0' }),
  'package-lock.json': JSON.stringify({
    name: 'demo-app',
    version: '2.0.0',
    lockfileVersion: 3,
    packages: { '': { name: 'demo-app' }, 'node_modules/left-pad': { version: '1.3.0' } },
  }),
  'README.md': '# demo-app\n\nA fixture for the time machine tests.\n',
});

const tgz = (dir) => {
  const out = `${dir}.tgz`;
  execSync(`tar -czf '${out}' -C '${path.dirname(dir)}' '${path.basename(dir)}'`);
  return out;
};
const TGZ1 = tgz(t1);
const TGZ2 = tgz(t2);

const RELEASES = [
  { tag_name: 'v1.0.0', name: 'First stable', published_at: '2023-05-01T00:00:00Z', body: 'Initial release of the demo app.', html_url: `https://github.com/demo/demo/releases/v1.0.0` },
  { tag_name: 'v2.0.0', name: 'The Big One', published_at: '2024-07-01T00:00:00Z', body: 'Rewrote the whole core. Blazing fast. Breaking changes everywhere.', html_url: `https://github.com/demo/demo/releases/v2.0.0` },
];

const REPO = {
  full_name: 'demo/demo',
  html_url: 'https://github.com/demo/demo',
  default_branch: 'main',
  created_at: '2023-01-01T00:00:00Z',
  private: false,
  description: 'fixture repo',
};

const commit = (sha, date) => [{ sha, commit: { committer: { date }, message: 'fixture commit' }, html_url: `https://github.com/demo/demo/commit/${sha}` }];

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  const send = (code, body, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': type, 'x-ratelimit-remaining': '5000' });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };

  if (p === '/repos/demo/demo') return send(200, REPO);
  if (p === '/repos/demo/demo/commits') {
    if (url.searchParams.has('until')) {
      const until = Date.parse(url.searchParams.get('until'));
      return send(200, until < Date.parse('2024-01-01T00:00:00Z') ? commit(C1, '2023-05-20T10:00:00Z') : commit(C2, '2024-08-01T10:00:00Z'));
    }
    return send(200, commit(C2, '2024-08-01T10:00:00Z'));
  }
  if (p === `/repos/demo/demo/commits/${C1}`) return send(200, commit(C1, '2023-05-20T10:00:00Z')[0]);
  if (p === `/repos/demo/demo/commits/${C2}`) return send(200, commit(C2, '2024-08-01T10:00:00Z')[0]);
  if (p === '/repos/demo/demo/releases') return send(200, RELEASES);
  if (p === '/repos/demo/demo/tags') return send(200, RELEASES.map((r) => ({ name: r.tag_name, commit: { sha: r.tag_name === 'v1.0.0' ? C1 : C2 } })));
  if (p === `/repos/demo/demo/tarball/${C1}`) return send(200, readFileSync(TGZ1), 'application/x-gzip');
  if (p === `/repos/demo/demo/tarball/${C2}`) return send(200, readFileSync(TGZ2), 'application/x-gzip');
  if (p === '/v1/querybatch' && req.method === 'POST') {
    let raw = '';
    req.on('data', (d) => (raw += d));
    return req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const results = (body.queries || []).map((q) => ({
        vulns:
          q.package?.name === 'left-pad' && q.version === '1.0.0'
            ? [{ id: 'GHSA-demo-0001', aliases: ['CVE-2023-99999'], summary: 'Prototype pollution in left-pad fixture', database_specific: { severity: 'HIGH' } }]
            : [],
      }));
      send(200, { results });
    });
  }
  if (p === '/left-pad') {
    return send(200, {
      repository: { url: 'git+https://github.com/demo/left-pad.git' },
      time: { '1.0.0': '2023-01-05T00:00:00Z', '1.3.0': '2024-02-05T00:00:00Z' },
    });
  }
  send(404, { message: `mock: no route for ${p}` });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] external APIs on http://127.0.0.1:${PORT}`);
});

process.on('SIGTERM', () => {
  server.close();
  rmSync(tmp, { recursive: true, force: true });
});
