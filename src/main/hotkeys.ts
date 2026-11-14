import type { WebContents } from 'electron';
import type { MarkerType, UiState } from '@shared/types';

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

/**
 * Listens on the window's webContents, so keys are caught even when focus sits inside the Twitch iframe.
 * The wall-clock time is taken before anything else: it is what the marker gets anchored to.
 */
export function attachHotkeys(webContents: WebContents, getUi: () => UiState, onAction: (a: HotkeyAction, wallMs: number) => void): void {
  webContents.on('before-input-event', (event, input) => {
    const wallMs = Date.now();
    const action = resolveHotkey(
      { type: input.type as KeyInput['type'], code: input.code, control: input.control, alt: input.alt, shift: input.shift, meta: input.meta, isAutoRepeat: input.isAutoRepeat },
      getUi(),
    );
    if (!action) return;
    event.preventDefault();
    onAction(action, wallMs);
  });
}
