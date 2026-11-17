// @vitest-environment jsdom
import { takeDriveHash } from '../../src/web/nav';

afterEach(() => window.history.replaceState(null, '', '/'));

it('notices the return from Google once and cleans the address', () => {
  window.history.replaceState(null, '', '/?x=1#drive');
  expect(takeDriveHash()).toBe(true);
  expect(window.location.hash).toBe('');
  expect(window.location.search).toBe('?x=1');
  expect(takeDriveHash()).toBe(false); // a later reload opens the usual tab
});
it('leaves other addresses alone', () => {
  window.history.replaceState(null, '', '/#other');
  expect(takeDriveHash()).toBe(false);
  expect(window.location.hash).toBe('#other');
});
