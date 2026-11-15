import { Sessions } from '../../src/service/auth';

const DAY = 24 * 3600 * 1000;

test('верный пароль даёт токен из 64 hex-символов, неверный — null', () => {
  const s = new Sessions('secret');
  const token = s.login('secret')!;
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  expect(s.valid(token)).toBe(true);
  expect(s.login('wrong')).toBeNull();
  expect(s.login('')).toBeNull();
  expect(s.valid(undefined)).toBe(false);
  expect(s.valid('nope')).toBe(false);
});

test('токен истекает через 30 дней', () => {
  let now = 1_000_000;
  const s = new Sessions('secret', () => now);
  const token = s.login('secret')!;
  now += 30 * DAY - 1;
  expect(s.valid(token)).toBe(true);
  now += 2;
  expect(s.valid(token)).toBe(false);
});

test('logout отзывает токен', () => {
  const s = new Sessions('secret');
  const a = s.login('secret')!;
  const b = s.login('secret')!;
  s.logout(a);
  expect(s.valid(a)).toBe(false);
  expect(s.valid(b)).toBe(true);
});
