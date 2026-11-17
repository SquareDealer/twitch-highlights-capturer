// @vitest-environment jsdom
import { ApiError, api, setUnauthorizedHandler, subscribe } from '../../src/web/api';

class FakeES {
  static CLOSED = 2;
  static last: FakeES;
  readyState = 1;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeES.last = this;
  }
  addEventListener(_name?: string, _fn?: (e: { data: string }) => void) {}
  close() {}
}

afterEach(() => {
  vi.unstubAllGlobals();
  setUnauthorizedHandler(undefined);
});

it('calls open on the first connect too: changes between the initial load and the subscription are refetched', () => {
  vi.stubGlobal('EventSource', FakeES);
  const open = vi.fn();
  const stop = subscribe({ open });
  FakeES.last.onopen!();
  expect(open).toHaveBeenCalledTimes(1);
  FakeES.last.onopen!();
  expect(open).toHaveBeenCalledTimes(2);
  stop();
});

it('a 401 from a regular call fires the unauthorized hook, but a failed login does not', async () => {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'x' }), { status: 401 }));
  const hook = vi.fn();
  setUnauthorizedHandler(hook);
  await expect(api.state()).rejects.toBeInstanceOf(ApiError);
  expect(hook).toHaveBeenCalledTimes(1);
  await expect(api.login('p')).rejects.toBeInstanceOf(ApiError);
  expect(hook).toHaveBeenCalledTimes(1);
});

it('delivers profiles and tuning events', () => {
  const listeners = new Map<string, (e: { data: string }) => void>();
  class ES extends FakeES {
    override addEventListener(name?: string, fn?: (e: { data: string }) => void) {
      if (name && fn) listeners.set(name, fn);
    }
  }
  vi.stubGlobal('EventSource', ES);
  const profiles = vi.fn();
  const tuning = vi.fn();
  const stop = subscribe({ profiles, tuning });
  listeners.get('profiles')!({ data: JSON.stringify([{ id: 'p1' }]) });
  listeners.get('tuning')!({ data: JSON.stringify({ streamId: 's1', entry: { tMs: 1 } }) });
  expect(profiles).toHaveBeenCalledWith([{ id: 'p1' }]);
  expect(tuning).toHaveBeenCalledWith({ streamId: 's1', entry: { tMs: 1 } });
  stop();
});

it('delivers drive frames', () => {
  const listeners: Record<string, (e: { data: string }) => void> = {};
  class ES extends FakeES {
    override addEventListener(name?: string, fn?: (e: { data: string }) => void) {
      if (name && fn) listeners[name] = fn;
    }
  }
  vi.stubGlobal('EventSource', ES);
  const drive = vi.fn();
  const stop = subscribe({ drive });
  listeners.drive!({ data: JSON.stringify({ connected: true, sync: { running: true } }) });
  expect(drive).toHaveBeenCalledWith({ connected: true, sync: { running: true } });
  listeners.drive!({ data: '{oops' });
  expect(drive).toHaveBeenCalledTimes(1);
  stop();
});
