import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ThrEvents } from '@shared/types';

/**
 * Server-sent events: the push channel from the backend to every open page
 * (the Electron version used `webContents.send`).
 */
export class EventHub {
  private readonly clients = new Set<ServerResponse>();
  private readonly heartbeat: NodeJS.Timeout;

  constructor(heartbeatMs = 15_000) {
    // A comment line keeps proxies and the browser from dropping an idle stream.
    this.heartbeat = setInterval(() => this.write(': ping\n\n'), heartbeatMs);
    this.heartbeat.unref?.();
  }

  get size(): number {
    return this.clients.size;
  }

  attach(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    res.write('retry: 1000\n\n');
    this.clients.add(res);
    const drop = () => this.clients.delete(res);
    req.on('close', drop);
    res.on('close', drop);
  }

  send<K extends keyof ThrEvents>(event: K, payload: ThrEvents[K]): void {
    this.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const res of this.clients) res.end();
    this.clients.clear();
  }

  private write(chunk: string): void {
    for (const res of this.clients) {
      if (!res.writableEnded) res.write(chunk);
    }
  }
}
