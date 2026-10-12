import { info as sandboxInfo } from '@/server/sandbox';

export const dynamic = 'force-dynamic';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'host', 'content-length', 'accept-encoding',
]);

async function proxy(req: Request, sandboxId: string, path: string[] | undefined): Promise<Response> {
  const sb = sandboxInfo(sandboxId);
  if (!sb) {
    return Response.json(
      {
        error: 'expired',
        message: 'This ephemeral instance has expired (TTL 10 min). Hit Rebuild to spin it back up.',
      },
      { status: 410 }
    );
  }
  const url = new URL(req.url);
  // sb.host is derived from config (loopback, or the daemon address for a remote
  // builder) — never from the request — so this proxy cannot be steered into
  // an internal address by a caller.
  const target = `http://${sb.host}:${sb.port}/${(path || []).join('/')}${url.search}`;
  const headers = new Headers();
  req.headers.forEach((v, k) => {
    if (!HOP_BY_HOP.has(k.toLowerCase())) headers.set(k, v);
  });

  const upstream = await fetch(target, {
    method: req.method,
    headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : await req.arrayBuffer(),
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });

  const resHeaders = new Headers();
  upstream.headers.forEach((v, k) => {
    if (!HOP_BY_HOP.has(k.toLowerCase())) resHeaders.set(k, v);
  });
  resHeaders.set('X-Time-Machine-Sandbox', sandboxId);
  return new Response(upstream.body, { status: upstream.status, headers: resHeaders });
}

// Next 15+ delivers route params as a Promise.
type Ctx = { params: Promise<{ sandbox: string; path?: string[] }> };

const route = async (req: Request, ctx: Ctx) => {
  const { sandbox, path } = await ctx.params;
  return proxy(req, sandbox, path);
};

export const GET = route;
export const POST = route;
export const PUT = route;
export const PATCH = route;
export const DELETE = route;
export const HEAD = route;
export const OPTIONS = route;
