import type { IncomingMessage, ServerResponse } from 'node:http';

// Pure-JS constant-time compare (no node:crypto) so fetch() also runs on edge
// runtimes; scans max length + mixes length diff to avoid early exit timing.
export function constantTimeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export function json(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Bridges a fetch-style handler onto Node's http request/response pair. */
export function nodeHandler(
  handle: (req: Request) => Promise<Response>,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('error', () => {
      res.writeHead(400).end();
    });
    req.on('end', () => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers.set(key, value);
        else if (Array.isArray(value)) for (const v of value) headers.append(key, v);
      }
      const method = req.method ?? 'GET';
      const url = `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`;
      const body = method === 'GET' || method === 'HEAD' ? undefined : Buffer.concat(chunks);
      handle(new Request(url, { method, headers, body }))
        .then(async (response) => {
          res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
          res.end(Buffer.from(await response.arrayBuffer()));
        })
        .catch(() => {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false }));
        });
    });
  };
}
