import { EVENTS_PATH, rpcPath, THR_EVENTS, THR_METHODS } from '@shared/api';
import type { ThrApi, ThrEvents } from '@shared/types';

type Listener = (payload: unknown) => void;

async function call(group: string, method: string, args: unknown[]): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(rpcPath(group, method), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
  } catch {
    throw new Error('Нет связи с приложением — проверьте, что окно терминала с ним не закрыто');
  }
  const body = (await res.json().catch(() => ({}))) as { value?: unknown; error?: string };
  if (!res.ok) throw new Error(body.error ?? `Ошибка ${res.status}`);
  return body.value;
}

/**
 * `window.thr` over HTTP: every method is a `POST /api/rpc/<group>/<method>`, events arrive by SSE.
 * Same shape as the Electron preload bridge, so the views did not change.
 */
export function createThrClient(opts: { onConnection?: (connected: boolean) => void } = {}): ThrApi {
  const api: Record<string, unknown> = {};
  for (const [group, methods] of Object.entries(THR_METHODS)) {
    const bridge: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    for (const method of methods) bridge[method] = (...args) => call(group, method, args);
    api[group] = bridge;
  }

  const listeners = new Map<string, Set<Listener>>();
  const source = new EventSource(EVENTS_PATH);
  for (const event of THR_EVENTS) {
    source.addEventListener(event, (e) => {
      let payload: unknown;
      try {
        payload = JSON.parse((e as MessageEvent<string>).data);
      } catch {
        return;
      }
      for (const cb of listeners.get(event) ?? []) cb(payload);
    });
  }
  // EventSource reconnects by itself; the page only needs to know whether the backend is reachable.
  source.addEventListener('open', () => opts.onConnection?.(true));
  source.addEventListener('error', () => opts.onConnection?.(source.readyState === EventSource.OPEN));

  api.on = (event: keyof ThrEvents, cb: Listener) => {
    if (!THR_EVENTS.includes(event)) throw new Error(`Unknown event: ${event}`);
    let set = listeners.get(event);
    if (!set) listeners.set(event, (set = new Set()));
    set.add(cb);
    return () => void set.delete(cb);
  };
  return api as unknown as ThrApi;
}
