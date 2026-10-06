import { getStore } from '@/server/store';
import { subscribe } from '@/server/events';
import { toPublic } from '@/server/public';

export const dynamic = 'force-dynamic';

const TERMINAL = new Set(['ready', 'degraded', 'failed']);

/** SSE progress stream: `snapshot` (initial), `stage` (progress), `done` (final full snapshot). */
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const store = getStore();
  const row = await store.getSnapshot(params.id);
  if (!row) return Response.json({ error: 'not_found' }, { status: 404 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      send('snapshot', toPublic(row));
      if (TERMINAL.has(row.status)) {
        send('done', toPublic(row));
        closed = true;
        controller.close();
        return;
      }

      const unsubscribe = subscribe(row.id, (event) => {
        if (event !== 'done') return;
        store.getSnapshot(row.id).then((fresh) => {
          send('done', fresh ? toPublic(fresh) : { id: row.id, status: 'failed' });
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        });
      });

      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(': ping\n\n'));
        } catch {
          closed = true;
        }
      }, 15_000);

      req.signal.addEventListener('abort', () => {
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
