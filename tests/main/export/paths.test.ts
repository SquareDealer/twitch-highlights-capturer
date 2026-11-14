import { relative } from 'node:path';
import { clipFolderName, clipPaths, sessionFolderName, slugify } from '../../../src/main/export/paths';

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

test('имена папок сессии и клипа', () => {
  expect(sessionFolderName('987654321', local(2026, 11, 14, 18, 30))).toBe('987654321_2026-11-14_18-30');
  expect(sessionFolderName('a/b:c', local(2026, 1, 2, 3, 4))).toBe('abc_2026-01-02_03-04');
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
