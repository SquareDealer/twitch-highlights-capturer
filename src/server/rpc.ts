import { THR_METHODS } from '@shared/api';
import { parseHotkeyAction, type HotkeyAction } from '@shared/hotkeys';
import type { ThrHandlers } from '@shared/types';
import { NotFoundError, type WebApi } from './http';

/** How far a key press timestamp from the page may be from the server clock before it is replaced. */
const MAX_CLOCK_SKEW_MS = 5_000;

/**
 * Adapts the app core to the HTTP layer (replaces the Electron `ipcMain` registration):
 * only methods listed in `THR_METHODS` can be called.
 */
export function createWebApi(core: { api: ThrHandlers; handleHotkey(action: HotkeyAction, wallMs: number): void }, now: () => number = Date.now): WebApi {
  const allowed = THR_METHODS as Record<string, string[]>;
  const methods = core.api as unknown as Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>>;
  return {
    async call(group, method, args) {
      if (!Object.prototype.hasOwnProperty.call(allowed, group) || !allowed[group]!.includes(method)) {
        throw new NotFoundError(`Неизвестный метод: ${group}.${method}`);
      }
      return methods[group]![method]!(...args);
    },
    hotkey(body) {
      const b = (body ?? {}) as { action?: unknown; wallMs?: unknown; ui?: unknown };
      const action = parseHotkeyAction(b.action);
      if (!action) return;
      // The page stamps the press first thing (the marker is anchored to it). Browser and server share
      // the machine's clock, so the stamp is used unless it is clearly off.
      const t = now();
      const wallMs = typeof b.wallMs === 'number' && Number.isFinite(b.wallMs) && Math.abs(t - b.wallMs) <= MAX_CLOCK_SKEW_MS ? b.wallMs : t;
      // The screen the key was pressed on travels with it, so F9 toggles relative to what the user sees.
      if (b.ui && typeof b.ui === 'object') void core.api.ui.setState(b.ui as never);
      core.handleHotkey(action, wallMs);
    },
  };
}
