import type { FeedClip, ClipStatus } from '../service/types';
import type { StreamStatus } from '../service/streams';

export type PublicClip = Omit<FeedClip, 'mp4Path' | 'jsonPath'>;

let onUnauthorized: (() => void) | undefined;
/** Called when any regular API call (except the login attempt itself) answers 401. */
export function setUnauthorizedHandler(fn: (() => void) | undefined): void {
  onUnauthorized = fn;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface CuttingState {
  paused: boolean;
  reason: string | null;
}
export interface ModeState {
  multiStream: boolean;
  limit: number;
}
export interface AppState {
  streams: StreamStatus[];
  mode: ModeState;
  cutting: CuttingState;
}
export interface Notice {
  level: 'info' | 'warning' | 'error';
  message: string;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiError(0, 'Нет связи с сервером');
  }
  if (res.status === 204) return undefined as T;
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/login') onUnauthorized?.();
    const message = (data as { error?: string } | null)?.error;
    throw new ApiError(res.status, message ?? `Ошибка сервера (${res.status})`);
  }
  return data as T;
}

export const api = {
  login: (password: string) => request<void>('POST', '/api/login', { password }),
  logout: () => request<void>('POST', '/api/logout'),
  state: () => request<AppState>('GET', '/api/state'),
  probe: (url: string) => request<{ channel: string; qualities: string[] }>('POST', '/api/probe', { url }),
  startStream: (url: string, quality: string) => request<StreamStatus>('POST', '/api/streams', { url, quality }),
  stopStream: (id: string) => request<void>('DELETE', `/api/streams/${encodeURIComponent(id)}`),
  manualClip: (id: string) => request<PublicClip>('POST', `/api/streams/${encodeURIComponent(id)}/manual-clip`),
  setMode: (multiStream: boolean) => request<ModeState>('PUT', '/api/mode', { multiStream }),
  clips: (query: { streamer?: string; status?: ClipStatus; limit?: number } = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined) q.set(k, String(v));
    const qs = q.toString();
    return request<PublicClip[]>('GET', `/api/clips${qs ? `?${qs}` : ''}`);
  },
  setClipStatus: (id: string, status: 'new' | 'taken' | 'rejected') =>
    request<PublicClip>('POST', `/api/clips/${encodeURIComponent(id)}/status`, { status }),
};

export interface SubscribeHandlers {
  streams?: (s: StreamStatus[]) => void;
  clip?: (c: PublicClip) => void;
  /** Fired on every reconnect (not the first connect): state may have been missed. */
  open?: () => void;
  notice?: (n: Notice) => void;
  cutting?: (c: CuttingState) => void;
  unauthorized?: () => void;
}

/** SSE subscription with automatic reconnect; returns an unsubscribe function. */
export function subscribe(h: SubscribeHandlers): () => void {
  let es: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let opened = false;

  const on = <T,>(name: string, fn?: (v: T) => void) =>
    es!.addEventListener(name, (e) => {
      try {
        fn?.(JSON.parse((e as MessageEvent<string>).data) as T);
      } catch {
        /* malformed frame */
      }
    });

  const connect = () => {
    if (closed) return;
    es = new EventSource('/api/events');
    on('streams', h.streams);
    on('clip', h.clip);
    on('notice', h.notice);
    on('cutting', h.cutting);
    es.onopen = () => {
      if (opened) h.open?.();
      opened = true;
    };
    es.onerror = () => {
      if (es!.readyState !== EventSource.CLOSED) return; // browser reconnects by itself
      es!.close();
      // A closed stream usually means the session ended: ask the API to find out.
      api.state().then(
        () => (timer = setTimeout(connect, 3000)),
        (err) => {
          if (err instanceof ApiError && err.status === 401) h.unauthorized?.();
          else timer = setTimeout(connect, 3000);
        },
      );
    };
  };
  connect();

  return () => {
    closed = true;
    clearTimeout(timer);
    es?.close();
  };
}
