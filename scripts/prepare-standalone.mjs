#!/usr/bin/env node
/*
 * Next.js `output: 'standalone'` emits a self-contained server but deliberately
 * leaves out `.next/static` and `public` — they still have to be copied in.
 *
 * Skip this and the server answers requests for /_next/static/* with the HTML
 * page (status 200, content-type text/html), so every stylesheet and chunk is
 * missing and the app renders completely unstyled with no error anywhere.
 * That is a silent failure, so it is handled as part of `npm run build`.
 */
import { cp, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const standalone = path.join(root, '.next', 'standalone');

async function exists(p) {
  return stat(p).then(() => true, () => false);
}

if (!(await exists(standalone))) {
  console.error('[standalone] .next/standalone not found — run `next build` first.');
  process.exit(1);
}

for (const [from, to] of [
  [path.join(root, '.next', 'static'), path.join(standalone, '.next', 'static')],
  [path.join(root, 'public'), path.join(standalone, 'public')],
]) {
  if (!(await exists(from))) continue;
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to, { recursive: true });
  console.log(`[standalone] ${path.relative(root, from)} -> ${path.relative(root, to)}`);
}