import { defaultConfig } from '../../src/service/config';
import { settingsFromConfig } from '../../src/service/profileSettings';
import { fromForm, parseNumber, toForm } from '../../src/web/tuning';

const SEED = settingsFromConfig(defaultConfig('/d'));

it.each([['0,05', 0.05], [' 12 ', 12], ['1.5', 1.5], ['-3', -3]])('parses %s', (t, v) => expect(parseNumber(t)).toBe(v));
it.each(['', '  ', 'abc', '1,2,3', '5 с'])('rejects %j', (t) => expect(parseNumber(t)).toBeNull());
it('round-trips the defaults through the form', () => expect(fromForm(toForm(SEED))).toEqual({ ok: true, value: SEED }));
it('shows decimals with a comma', () => expect(toForm(SEED)['detector.chat.minTriggerShare']).toBe('0,05'));
it('names the field that is not a number', () => {
  expect(fromForm({ ...toForm(SEED), 'cut.postRollMs': '' })).toEqual({ ok: false, path: 'cut.postRollMs', error: '«Запас после события»: нужно число' });
});
it('splits dictionaries by line', () => {
  const r = fromForm({ ...toForm(SEED), 'detector.chat.laughWords': '^lol$\r\n\n ^kek$ ' });
  expect(r.ok && r.value.detector.chat.laughWords).toEqual(['^lol$', '', ' ^kek$ ']); // the server cleans them
});
