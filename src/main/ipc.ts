import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { invokeChannel, THR_METHODS } from '@shared/ipc';
import type { ThrHandlers } from '@shared/types';

/**
 * Exposes `api` to the renderer. Calls are accepted only from the main frame of the app window,
 * so the embedded Twitch iframe (or any other frame) can never reach the main process.
 */
export function registerIpc(ipcMain: IpcMain, api: ThrHandlers, isTrusted: (event: IpcMainInvokeEvent) => boolean): void {
  for (const [group, methods] of Object.entries(THR_METHODS)) {
    for (const method of methods) {
      const fn = (api as unknown as Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>)[group]![method]!;
      ipcMain.handle(invokeChannel(group, method), (event, ...args: unknown[]) => {
        if (!isTrusted(event)) throw new Error('Forbidden');
        return fn(...args);
      });
    }
  }
}
