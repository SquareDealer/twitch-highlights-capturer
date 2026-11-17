import type { HotkeyAction } from '@shared/hotkeys';
import type { ThrHandlers, UiState } from '@shared/types';
import { NotFoundError } from '../../src/server/http';
import { createWebApi } from '../../src/server/rpc';

let hotkeys: Array<{ action: HotkeyAction; wallMs: number }>;
let ui: UiState[];
let started: unknown[];

const api = {
  capture: { start: async (...a: unknown[]) => void started.push(a), stop: async () => undefined, status: async () => ({ ok: 1 }) },
  ui: { setState: async (s: UiState) => void ui.push(s) },
} as unknown as ThrHandlers;

const NOW = 1_000_000;
const web = () => createWebApi({ api, handleHotkey: (action, wallMs) => void hotkeys.push({ action, wallMs }) }, () => NOW);

beforeEach(() => {
  hotkeys = [];
  ui = [];
  started = [];
});

test('вызывает разрешённый метод с аргументами', async () => {
  expect(await web().call('capture', 'status', [])).toEqual({ ok: 1 });
  await web().call('capture', 'start', ['shroud', 2]);
  expect(started).toEqual([['shroud', 2]]);
});

test.each([
  ['capture', 'nope'],
  ['nope', 'start'],
  ['__proto__', 'constructor'],
  ['capture', 'constructor'],
  ['toString', 'call'],
])('%s.%s → NotFoundError', async (group, method) => {
  await expect(web().call(group, method, [])).rejects.toBeInstanceOf(NotFoundError);
});

test('hotkey: действие и время нажатия из страницы, экран обновляется до обработки', () => {
  web().hotkey({ action: { kind: 'marker', type: 3 }, wallMs: NOW - 120, ui: { mode: 'watch', textInputFocused: false } });
  expect(hotkeys).toEqual([{ action: { kind: 'marker', type: 3 }, wallMs: NOW - 120 }]);
  expect(ui).toEqual([{ mode: 'watch', textInputFocused: false }]);
});

test('hotkey: время далеко от часов сервера или не число → используется время сервера', () => {
  web().hotkey({ action: { kind: 'replay' }, wallMs: NOW - 60_000 });
  web().hotkey({ action: { kind: 'replay' }, wallMs: 'soon' });
  web().hotkey({ action: { kind: 'replay' } });
  expect(hotkeys.map((h) => h.wallMs)).toEqual([NOW, NOW, NOW]);
});

test.each([
  [null],
  [{}],
  [{ action: { kind: 'marker', type: 0 } }],
  [{ action: { kind: 'marker', type: 10 } }],
  [{ action: { kind: 'marker', type: 2.5 } }],
  [{ action: { kind: 'shutdown' } }],
  [{ action: 'replay' }],
])('hotkey: некорректное действие %j игнорируется', (body) => {
  web().hotkey(body);
  expect(hotkeys).toEqual([]);
});
