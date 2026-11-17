import type { UiState } from '@shared/types';
import { parseHotkeyAction, resolveHotkey, type KeyInput } from '../../src/shared/hotkeys';

const key = (code: string, o: Partial<KeyInput> = {}): KeyInput => ({ type: 'keyDown', code, control: false, alt: false, shift: false, meta: false, isAutoRepeat: false, ...o });
const watch: UiState = { mode: 'watch', textInputFocused: false };
const editor: UiState = { mode: 'editor', textInputFocused: false };
const other: UiState = { mode: 'other', textInputFocused: false };

test.each([1, 2, 3, 4, 5, 6, 7, 8, 9])('Digit%i в режиме просмотра → marker', (n) =>
  expect(resolveHotkey(key(`Digit${n}`), watch)).toEqual({ kind: 'marker', type: n }),
);

test('Numpad5 → marker 5', () => expect(resolveHotkey(key('Numpad5'), watch)).toEqual({ kind: 'marker', type: 5 }));

test.each([
  ['ввод текста', key('Digit2'), { mode: 'watch', textInputFocused: true }],
  ['редактор', key('Digit2'), editor],
  ['другой экран', key('Digit2'), other],
  ['Ctrl+2', key('Digit2', { control: true }), watch],
  ['Alt+2', key('Digit2', { alt: true }), watch],
  ['Shift+2', key('Digit2', { shift: true }), watch],
  ['Win+2', key('Digit2', { meta: true }), watch],
  ['auto-repeat', key('Digit2', { isAutoRepeat: true }), watch],
  ['keyUp', key('Digit2', { type: 'keyUp' }), watch],
  ['Digit0', key('Digit0'), watch],
  ['Numpad0', key('Numpad0'), watch],
  ['буква', key('KeyA'), watch],
  ['F2', key('F2'), watch],
])('%s → null', (_n, input, ui) => expect(resolveHotkey(input, ui as UiState)).toBeNull());

test('F8 и F9 работают в watch и editor, не работают в other', () => {
  for (const ui of [watch, editor, { mode: 'watch', textInputFocused: true } as UiState]) {
    expect(resolveHotkey(key('F8'), ui)).toEqual({ kind: 'replay' });
    expect(resolveHotkey(key('F9'), ui)).toEqual({ kind: 'toggleEditor' });
  }
  expect(resolveHotkey(key('F8'), other)).toBeNull();
  expect(resolveHotkey(key('F9'), other)).toBeNull();
  expect(resolveHotkey(key('F8', { control: true }), watch)).toBeNull();
  expect(resolveHotkey(key('F9', { isAutoRepeat: true }), watch)).toBeNull();
});

test('Ctrl+S → save только в редакторе, в том числе при фокусе в поле названия', () => {
  expect(resolveHotkey(key('KeyS', { control: true }), editor)).toEqual({ kind: 'save' });
  expect(resolveHotkey(key('KeyS', { control: true }), { mode: 'editor', textInputFocused: true })).toEqual({ kind: 'save' });
  expect(resolveHotkey(key('KeyS', { control: true }), watch)).toBeNull();
  expect(resolveHotkey(key('KeyS'), editor)).toBeNull();
  expect(resolveHotkey(key('KeyS', { control: true, shift: true }), editor)).toBeNull();
  expect(resolveHotkey(key('KeyS', { control: true, isAutoRepeat: true }), editor)).toBeNull();
});

test.each([
  [{ kind: 'marker', type: 7 }, { kind: 'marker', type: 7 }],
  [{ kind: 'replay', extra: 1 }, { kind: 'replay' }],
  [{ kind: 'toggleEditor' }, { kind: 'toggleEditor' }],
  [{ kind: 'save' }, { kind: 'save' }],
  [{ kind: 'marker', type: '7' }, null],
  [{ kind: 'marker' }, null],
  [{ kind: 'exit' }, null],
  [undefined, null],
])('parseHotkeyAction(%j) → %j', (input, expected) => expect(parseHotkeyAction(input)).toEqual(expected));
