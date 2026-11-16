import { defaultConfig } from '../../src/service/config';
import { FIELDS, settingsFromConfig, unsafePattern, validateSettings } from '../../src/service/profileSettings';

const base = () => settingsFromConfig(defaultConfig('/d'));
const set = (path: string, v: unknown) => { const s: any = base(); const k = path.split('.'); k.slice(0, -1).reduce((o, p) => o[p], s)[k.at(-1)!] = v; return s; };

it('copies exactly the profile keys from the service config', () => {
  const s = base();
  expect(s.cut).toEqual({ preRollMs: 15000, preRollLowConfidenceMs: 30000, postRollMs: 10000, maxClipMs: 90000, maxClipsPerHour: 20 });
  expect(Object.keys(s.detector.chat).sort()).toEqual(['activeWindowS', 'alpha', 'baselineS', 'endSpike', 'laughWords', 'minActive', 'minTriggerAuthors', 'minTriggerMessages', 'minTriggerShare', 'reactionWords', 'windowS']);
  expect(Object.keys(s.detector.audio).sort()).toEqual(['baselineS', 'spikeDb', 'spikeMinMs', 'spikeVad']);
});
it('accepts the defaults unchanged', () => expect(validateSettings(base())).toEqual({ ok: true, value: base() }));
it('has one FIELDS row per numeric setting', () => expect(FIELDS).toHaveLength(28));
it.each(FIELDS.map((f) => [f.path, f] as const))('rejects %s below min, above max and non-numbers', (path, f) => {
  for (const bad of [f.min - 1, f.max + 1, NaN, '5', null]) {
    const r = validateSettings(set(path, bad));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.path).toBe(path);
  }
});
it('requires integers for counters', () => {
  expect(validateSettings(set('detector.chat.minTriggerMessages', 2.5))).toMatchObject({ ok: false, error: '«Триггерных сообщений, не меньше»: нужно целое число' });
});
it('names the range in the error', () => {
  expect(validateSettings(set('detector.chat.windowS', 0))).toMatchObject({ ok: false, error: '«Окно подсчёта сообщений»: допустимо от 1 до 60' });
});
it('rejects the pairs the score formula divides by', () => {
  expect(validateSettings(set('detector.score.shareFull', 0.05))).toMatchObject({ ok: false, path: 'detector.score.shareFull' });
  expect(validateSettings(set('detector.score.audioFullDb', 10))).toMatchObject({ ok: false, path: 'detector.score.audioFullDb' });
  expect(validateSettings(set('cut.maxClipMs', 9000))).toMatchObject({ ok: false, path: 'cut.maxClipMs' });
});
it('cleans dictionaries: trims, drops empty lines and duplicates', () => {
  const r = validateSettings(set('detector.chat.laughWords', ['  ^lol$ ', '', '^lol$', '^kek$\r']));
  expect(r.ok && r.value.detector.chat.laughWords).toEqual(['^lol$', '^kek$']);
});
it('rejects invalid, too long, too many and hanging patterns', () => {
  const err = (v: unknown) => { const r = validateSettings(set('detector.chat.reactionWords', v)); return r.ok ? '' : r.error; };
  expect(err(['(('])).toBe('«Реакции»: неверный шаблон: ((');
  expect(err(['a'.repeat(101)])).toContain('длиннее 100 символов');
  expect(err(Array.from({ length: 101 }, (_, i) => `w${i}`))).toBe('«Реакции»: не больше 100 шаблонов');
  expect(err(['^([ах]+)+$'])).toContain('может подвесить детектор');
  expect(err('x')).toBe('«Реакции»: нужен список шаблонов');
});
it('flags repetition after a group and backreferences, allows optional groups', () => {
  expect(['^(a+)+$', '(ab)*', '(a){2,}', '(.)\\1'].map(unsafePattern)).toEqual([true, true, true, true]);
  expect(['^pog(gers|champ)?$', '^[ах]*ха[ах]*$', '^\\d+$'].map(unsafePattern)).toEqual([false, false, false]);
});
it('drops unknown keys and rejects non-objects', () => {
  const r = validateSettings({ ...base(), extra: 1, detector: { ...base().detector, weights: {} } });
  expect(r.ok && JSON.stringify(r.value)).toBe(JSON.stringify(base()));
  expect(validateSettings(null)).toEqual({ ok: false, error: 'Некорректные настройки профиля', path: '' });
});
