import { defaultConfig } from '../../src/service/config';
import { FIELDS, checkField, checkPairs, factorySettings, migrateSettings, settingsFromConfig, unsafePattern, validateSettings } from '../../src/service/profileSettings';

const base = () => settingsFromConfig(defaultConfig('/d'));
const set = (path: string, v: unknown) => { const s: any = base(); const k = path.split('.'); k.slice(0, -1).reduce((o, p) => o[p], s)[k.at(-1)!] = v; return s; };

it('copies exactly the profile keys from the service config', () => {
  const s = base();
  expect(s.cut).toEqual({ preRollMs: 15000, preRollLowConfidenceMs: 30000, postRollMs: 10000, maxClipMs: 90000, maxClipsPerHour: 20 });
  expect(Object.keys(s.detector.chat).sort()).toEqual(['alpha', 'baselineS', 'endSpike', 'laughWords', 'minSpike', 'minTriggerAuthors', 'minTriggerMessages', 'minTriggerShare', 'reactionWords', 'windowS']);
  expect(Object.keys(s.detector.audio).sort()).toEqual(['baselineS', 'spikeDb', 'spikeMinMs', 'spikeVad']);
});
it('accepts the defaults unchanged', () => expect(validateSettings(base())).toEqual({ ok: true, value: base() }));
it('has one FIELDS row per numeric setting', () => expect(FIELDS).toHaveLength(27));
it.each(FIELDS.map((f) => [f.path, f] as const))('rejects %s below min, above max and non-numbers', (path, f) => {
  for (const bad of [f.min - 1, f.max + 1000, NaN, '5', null]) {
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
  expect(validateSettings(set('detector.score.shareFull', 0.5))).toMatchObject({ ok: false, path: 'detector.score.shareFull' });
  expect(validateSettings(set('detector.score.spikeFull', 2))).toMatchObject({ ok: false, path: 'detector.score.spikeFull' });
  expect(validateSettings(set('detector.chat.endSpike', 2.5))).toMatchObject({ ok: false, path: 'detector.chat.endSpike' });
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
it('flags more than three unbounded quantifiers, keeps every default pattern', () => {
  expect(unsafePattern('^[ах]*[ах]*[ах]*[ах]*[ах]*[ах]*[ах]*$')).toBe(true);
  expect(unsafePattern('^a+b{2,}c*d+$')).toBe(true); // four: {n,} counts too
  expect(unsafePattern(String.raw`^\*\+\*\+a+$`)).toBe(false); // escaped ones do not count
  expect(unsafePattern('^[ах]*ха[ах]*$')).toBe(false);
  const chat = defaultConfig('/d').detector.chat;
  expect([...chat.laughWords, ...chat.reactionWords].filter(unsafePattern)).toEqual([]);
  expect(validateSettings({ ...base(), detector: { ...base().detector, chat: { ...base().detector.chat, laughWords: ['^[ах]*[ах]*[ах]*[ах]*[ах]*[ах]*[ах]*$'] } } }))
    .toMatchObject({ ok: false, error: expect.stringContaining('шаблон может подвесить детектор') });
});
it('describes alpha and warmup correctly', () => {
  const hint = (p: string) => FIELDS.find((d) => d.path === p)!.hint;
  expect(hint('detector.chat.alpha')).toContain('больше — плавнее');
  expect(hint('detector.events.warmupS')).toContain('копит фон');
});

describe('the spike-then-composition keys', () => {
  it('has the factory defaults', () => {
    const s = factorySettings();
    expect([s.detector.chat.minSpike, s.detector.chat.minTriggerShare, s.detector.score.shareFull, s.detector.score.spikeFull, s.detector.chat.endSpike]).toEqual([2, 0.5, 0.9, 6, 1.5]);
  });
  it('bounds minSpike', () => {
    expect(validateSettings(set('detector.chat.minSpike', 1))).toMatchObject({ ok: false, path: 'detector.chat.minSpike' });
    expect(validateSettings(set('detector.chat.minSpike', 3)).ok).toBe(true);
  });
  it('marks the six basic fields in order', () => {
    expect(FIELDS.filter((f) => f.basic).map((f) => f.path)).toEqual([
      'detector.chat.minSpike', 'detector.chat.minTriggerShare', 'detector.chat.minTriggerMessages',
      'detector.chat.minTriggerAuthors', 'cut.preRollMs', 'cut.postRollMs',
    ]);
  });
  it('keeps every slider inside the allowed range', () => {
    for (const f of FIELDS) expect(f.sliderMin >= f.min && f.sliderMax <= f.max && f.sliderMin < f.sliderMax && f.step > 0, f.path).toBe(true);
  });
  it('checkField speaks display units', () => {
    const share = FIELDS.find((f) => f.path === 'detector.chat.minTriggerShare')!;
    expect(checkField(share, 0.5)).toBeNull();
    expect(checkField(share, 2)).toBe('«Состав: триггерных сообщений, не меньше»: допустимо от 1 до 100');
    expect(checkField(share, NaN)).toBe('«Состав: триггерных сообщений, не меньше»: нужно число');
    const pre = FIELDS.find((f) => f.path === 'cut.preRollMs')!;
    expect(checkField(pre, 999999)).toBe('«Запас до события»: допустимо от 0 до 120');
  });
  it('checkPairs names the field of each broken pair', () => {
    const vals = (over: Record<string, number>) => (p: string) => over[p] ?? (p.split('.').reduce((o: any, k) => o[k], factorySettings()) as number);
    expect(checkPairs(vals({}))).toBeNull();
    expect(checkPairs(vals({ 'detector.chat.endSpike': 3 }))?.path).toBe('detector.chat.endSpike');
    expect(checkPairs(vals({ 'detector.score.spikeFull': 2 }))?.path).toBe('detector.score.spikeFull');
    expect(checkPairs(vals({ 'detector.score.shareFull': 0.4 }))?.path).toBe('detector.score.shareFull');
    expect(checkPairs(vals({ 'detector.score.audioFullDb': 5 }))?.path).toBe('detector.score.audioFullDb');
    expect(checkPairs(vals({ 'cut.maxClipMs': 5000 }))?.path).toBe('cut.maxClipMs');
  });
});

describe('migrateSettings', () => {
  const old = (): any => {
    const s: any = factorySettings();
    delete s.detector.chat.minSpike;
    Object.assign(s.detector.chat, { minTriggerShare: 0.05, minActive: 10, activeWindowS: 300, endSpike: 3 });
    Object.assign(s.detector.score, { shareFull: 0.3, spikeFull: 2.5 });
    s.cut.preRollMs = 7000;
    return s;
  };
  it('resets the share thresholds, clamps the speed pair and drops the old keys', () => {
    const m = migrateSettings(old());
    expect(m.detector.chat).toMatchObject({ minSpike: 2, minTriggerShare: 0.5, endSpike: 2 });
    expect(m.detector.score).toMatchObject({ shareFull: 0.9, spikeFull: 3 });
    expect('minActive' in m.detector.chat || 'activeWindowS' in m.detector.chat).toBe(false);
    expect(m.cut.preRollMs).toBe(7000);
    expect(validateSettings(m).ok).toBe(true);
  });
  it('is idempotent', () => expect(migrateSettings(migrateSettings(old()))).toEqual(migrateSettings(old())));
  it('leaves new-shape settings alone apart from missing keys', () => {
    const s: any = factorySettings();
    s.detector.chat.minTriggerShare = 0.7;
    delete s.cut.postRollMs;
    const m = migrateSettings(s);
    expect(m.detector.chat.minTriggerShare).toBe(0.7);
    expect(m.cut.postRollMs).toBe(10000);
  });
  it('turns garbage into valid settings', () => {
    for (const junk of [{}, null, 'x', { detector: 5 }, { detector: { chat: { laughWords: 'no' } } }]) {
      expect(validateSettings(migrateSettings(junk)).ok).toBe(true);
    }
  });
});
