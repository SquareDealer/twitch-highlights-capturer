import { relative } from 'node:path';
import { clipFolderName, clipPaths, sessionFolderName, slugify, STREAM_TITLE_CHARS } from '../../../src/main/export/paths';

test.each([
  ['Funny reaction', 'funny-reaction'],
  ['  Смешной   момент!! ', 'смешной-момент'],
  ['a<b>:c"/\\|?*d', 'abcd'],
  ['', 'clip'],
  ['???', 'clip'],
  ['CON', 'clip-con'],
  ['nul', 'clip-nul'],
  ['COM7', 'clip-com7'],
  ['name. ', 'name'],
  ['a__b--c', 'a-b-c'],
  ['..\\..\\evil', 'evil'],
  ['e\u0301te\u0301', 'été'],
  ['tab\there\nnewline', 'tab-here-newline'],
])('slugify(%j) = %j', (title, slug) => expect(slugify(title)).toBe(slug));

test('slugify обрезает до 60 символов и не оставляет дефис на конце', () => {
  const slug = slugify(`${'a'.repeat(59)} bbb`);
  expect(slug).toBe('a'.repeat(59));
  expect(slugify('я'.repeat(200))).toHaveLength(60);
});

const local = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi, 30);

test('папка эфира называется по началу названия стрима (первые 40 символов), а не по его id', () => {
  const at = local(2026, 11, 14, 18, 30);
  expect(sessionFolderName({ streamId: '987654321', streamTitle: 'Ranked до Immortal! | !tg' }, at)).toBe('ranked-до-immortal-tg_2026-11-14_18-30');
  const long = sessionFolderName({ streamId: '1', streamTitle: 'Очень длинное название стрима, которое точно не поместится в сорок символов' }, at);
  expect(long).toBe('очень-длинное-название-стрима-которое-то_2026-11-14_18-30');
  expect([...long.split('_')[0]!]).toHaveLength(STREAM_TITLE_CHARS);
  expect(sessionFolderName({ streamId: '1', streamTitle: 'a'.repeat(39) + ' bbb' }, at)).toBe(`${'a'.repeat(39)}_2026-11-14_18-30`); // no dangling dash
  expect(sessionFolderName({ streamId: '1', streamTitle: 'CON' }, at)).toBe('clip-con_2026-11-14_18-30');
});

test('без названия (пустое, только символы, старые записи) папка эфира называется по id', () => {
  const at = local(2026, 11, 14, 18, 30);
  expect(sessionFolderName({ streamId: '987654321', streamTitle: '' }, at)).toBe('987654321_2026-11-14_18-30');
  expect(sessionFolderName({ streamId: '987654321', streamTitle: '🔥🔥 !!! ???' }, at)).toBe('987654321_2026-11-14_18-30');
  expect(sessionFolderName({ streamId: '987654321' }, at)).toBe('987654321_2026-11-14_18-30');
  expect(sessionFolderName({ streamId: 'a/b:c' }, local(2026, 1, 2, 3, 4))).toBe('abc_2026-01-02_03-04');
  expect(sessionFolderName({ streamId: '', streamTitle: '' }, at)).toBe('unknown_2026-11-14_18-30');
});

test('имя папки клипа', () => {
  expect(clipFolderName(local(2026, 11, 14, 19, 42), 'funny-reaction', 'c0ffee-a42f')).toBe('2026-11-14_19-42_funny-reaction_a42f');
});

test('раскладка из спеки', () => {
  const session = { streamer: 'streamer_name', streamId: '987654321', startedAt: local(2026, 11, 14, 18, 30).toISOString() };
  const p = clipPaths('D:/TwitchHighlights', session, local(2026, 11, 14, 19, 42), 'Funny reaction', 'c0ffeea42f');
  const rel = (x: string) => relative('D:/TwitchHighlights', x).replace(/\\/g, '/');
  expect(rel(p.mp4Path)).toBe('streamer_name/987654321_2026-11-14_18-30/2026-11-14_19-42_funny-reaction_a42f/funny-reaction.mp4');
  expect(rel(p.markersPath)).toBe('streamer_name/987654321_2026-11-14_18-30/2026-11-14_19-42_funny-reaction_a42f/markers.json');
  expect(rel(p.dir)).toBe('streamer_name/987654321_2026-11-14_18-30/2026-11-14_19-42_funny-reaction_a42f');
  expect(p.slug).toBe('funny-reaction');
});

test('раскладка с названием стрима', () => {
  const session = { streamer: 'streamer_name', streamId: '987654321', streamTitle: 'Chill stream: день 3', startedAt: local(2026, 11, 14, 18, 30).toISOString() };
  const p = clipPaths('D:/TwitchHighlights', session, local(2026, 11, 14, 19, 42), 'Funny reaction', 'c0ffeea42f');
  expect(relative('D:/TwitchHighlights', p.mp4Path).replace(/\\/g, '/')).toBe('streamer_name/chill-stream-день-3_2026-11-14_18-30/2026-11-14_19-42_funny-reaction_a42f/funny-reaction.mp4');
});
