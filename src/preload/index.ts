import { contextBridge, ipcRenderer } from 'electron';
import { eventChannel, invokeChannel, THR_EVENTS, THR_METHODS } from '@shared/ipc';

const api: Record<string, unknown> = {};
for (const [group, methods] of Object.entries(THR_METHODS)) {
  const bridge: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of methods) bridge[method] = (...args) => ipcRenderer.invoke(invokeChannel(group, method), ...args);
  api[group] = bridge;
}
api.on = (event: string, cb: (payload: unknown) => void) => {
  if (!(THR_EVENTS as string[]).includes(event)) throw new Error(`Unknown event: ${event}`);
  const listener = (_e: unknown, payload: unknown) => cb(payload);
  ipcRenderer.on(eventChannel(event), listener);
  return () => void ipcRenderer.removeListener(eventChannel(event), listener);
};

contextBridge.exposeInMainWorld('thr', api);
