import type { MarkerType, UiState } from './types';

export type HotkeyAction = { kind: 'marker'; type: MarkerType } | { kind: 'replay' } | { kind: 'toggleEditor' } | { kind: 'save' };

export interface KeyInput {
  type: 'keyDown' | 'keyUp';
  code: string;
  control: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  isAutoRepeat: boolean;
}

/**
 * Maps a key press to an application action.
 * Digits create markers only while watching and only when no text field has focus;
 * F8/F9 work while watching or editing; Ctrl+S saves from the editor even while typing the title.
 */
export function resolveHotkey(input: KeyInput, ui: UiState): HotkeyAction | null {
  if (input.type !== 'keyDown' || input.isAutoRepeat || input.meta) return null;
  const plain = !input.control && !input.alt && !input.shift;
  const digit = /^(?:Digit|Numpad)([1-9])$/.exec(input.code);
  if (digit) {
    return plain && ui.mode === 'watch' && !ui.textInputFocused ? { kind: 'marker', type: Number(digit[1]) as MarkerType } : null;
  }
  const inApp = ui.mode === 'watch' || ui.mode === 'editor';
  if (input.code === 'F8') return plain && inApp ? { kind: 'replay' } : null;
  if (input.code === 'F9') return plain && inApp ? { kind: 'toggleEditor' } : null;
  if (input.code === 'KeyS') return input.control && !input.alt && !input.shift && ui.mode === 'editor' ? { kind: 'save' } : null;
  return null;
}

/** Validates an action that arrived over HTTP; anything malformed becomes null. */
export function parseHotkeyAction(value: unknown): HotkeyAction | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { kind?: unknown; type?: unknown };
  switch (v.kind) {
    case 'marker':
      return Number.isInteger(v.type) && (v.type as number) >= 1 && (v.type as number) <= 9 ? { kind: 'marker', type: v.type as MarkerType } : null;
    case 'replay':
    case 'toggleEditor':
    case 'save':
      return { kind: v.kind };
    default:
      return null;
  }
}
