#!/usr/bin/env node
/*
 * Tiny zero-dependency static file server used to serve ephemeral snapshot
 * previews. Usage: node static-server.cjs <rootDir> <port>
 * SPA fallback to index.html so client-side routes work inside the iframe.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(process.argv[2] || '.');
const port = Number(process.argv[3] || 4100);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
};

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    let p = decodeURIComponent(url.pathname);
    if (p.includes('..')) p = '/';
    let file = path.join(root, p);
    if (!file.startsWith(root)) {
      res.writeHead(403);
      return res.end('forbidden');
    }
    let st = fs.existsSync(file) ? fs.statSync(file) : null;
    if (st && st.isDirectory()) {
      file = path.join(file, 'index.html');
      st = fs.existsSync(file) ? fs.statSync(file) : null;
    }
    if (!st) {
      // SPA fallback
      const fallback = path.join(root, 'index.html');
      if (fs.existsSync(fallback)) {
        file = fallback;
        st = fs.statSync(file);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('not found');
      }
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('error');
  }
});

server.listen(port, '127.0.0.1', () => {
  process.send && process.send({ ready: true });
});
