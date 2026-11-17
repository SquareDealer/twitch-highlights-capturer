import { HOTKEY_PATH } from '@shared/api';
import { resolveHotkey } from '@shared/hotkeys';
import type { UiState } from '@shared/types';

export const isTextInput = (el: Element | null) =>
  el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el instanceof HTMLElement && el.isContentEditable);

/**
 * Keyboard shortcuts in the browser. Electron caught keys for the whole window; a page only sees keys
 * while focus is in its own document, so focus is taken back from the Twitch frame right after a click
 * on the player (the click itself still reaches the player).
 */
export function installHotkeys(getMode: () => UiState['mode']): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    const wallMs = Date.now(); // first thing: the marker is anchored to this moment
    const ui: UiState = { mode: getMode(), textInputFocused: isTextInput(document.activeElement) };
    const action = resolveHotkey(
      { type: 'keyDown', code: e.code, control: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey, isAutoRepeat: e.repeat },
      ui,
    );
    if (!action) return;
    e.preventDefault(); // Ctrl+S would otherwise open the browser's "Save page" dialog
    e.stopPropagation();
    void fetch(HOTKEY_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, wallMs, ui }),
      keepalive: true,
    }).catch(() => undefined);
  };

  const sink = document.createElement('div');
  sink.tabIndex = -1;
  sink.setAttribute('aria-hidden', 'true');
  sink.style.cssText = 'position:fixed;width:0;height:0;overflow:hidden;outline:none';
  document.body.appendChild(sink);

  const onBlur = () => {
    // The window loses focus both when the user switches apps and when a frame inside it takes focus;
    // only the latter is undone.
    setTimeout(() => {
      if (document.activeElement instanceof HTMLIFrameElement) sink.focus({ preventScroll: true });
    }, 0);
  };

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('blur', onBlur);
  return () => {
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('blur', onBlur);
    sink.remove();
  };
}
