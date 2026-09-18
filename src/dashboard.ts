import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TickResult } from './types.js';

/**
 * A dependency-free local dashboard.
 *
 * Ticks are pushed to the browser over Server-Sent Events, which is a plain
 * HTTP response that stays open - no websocket library, no build step, and it
 * reconnects on its own if the agent restarts.
 */
export interface Dashboard {
  publish(tick: TickResult): void;
  close(): void;
  readonly url: string;
}

const PAGE_PATH = resolve(process.cwd(), 'web/dashboard.html');

export function startDashboard(port = 5173): Dashboard {
  const clients = new Set<ServerResponse>();
  /** Replayed to a browser that connects mid-match, so it is never blank. */
  let lastTick: TickResult | null = null;

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';

    if (url === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      // Tell the browser to retry quickly if the agent restarts.
      res.write('retry: 1000\n\n');
      if (lastTick) res.write(`data: ${JSON.stringify(lastTick)}\n\n`);

      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (url === '/' || url.startsWith('/index')) {
      try {
        const html = readFileSync(PAGE_PATH, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Could not read ${PAGE_PATH}`);
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  server.listen(port);

  return {
    url: `http://localhost:${port}`,
    publish(tick: TickResult) {
      lastTick = tick;
      // Screenshot paths are large and of no use to the page.
      const payload = JSON.stringify(tick);
      for (const client of clients) {
        try {
          client.write(`data: ${payload}\n\n`);
        } catch {
          clients.delete(client);
        }
      }
    },
    close() {
      for (const client of clients) {
        try {
          client.end();
        } catch {
          // The connection is already gone; nothing to do.
        }
      }
      clients.clear();
      server.close();
    },
  };
}
