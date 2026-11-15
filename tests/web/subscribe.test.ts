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
  addEventListener() {}
  close() {}
}

afterEach(() => {
  vi.unstubAllGlobals();
  setUnauthorizedHandler(undefined);
});

it('calls open only on reconnects, not on the first connect', () => {
  vi.stubGlobal('EventSource', FakeES);
  const open = vi.fn();
  const stop = subscribe({ open });
  FakeES.last.onopen!();
  expect(open).not.toHaveBeenCalled();
  FakeES.last.onopen!();
  expect(open).toHaveBeenCalledTimes(1);
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
