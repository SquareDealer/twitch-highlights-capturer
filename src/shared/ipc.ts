import type { ThrEvents, ThrHandlers } from './types';

/** Method names per API group; the single source for both ipcMain registration and the preload bridge. */
export const THR_METHODS: { [G in keyof ThrHandlers]: Array<keyof ThrHandlers[G] & string> } = {
  capture: ['start', 'stop', 'status'],
  player: ['reportLatency'],
  ui: ['setState'],
  markers: ['setComment', 'update', 'remove'],
  moment: ['active', 'discardActive'],
  drafts: ['list', 'open', 'extend', 'discard'],
  clips: ['export', 'list', 'failed', 'showInFolder', 'sync', 'syncAll'],
  drive: ['status', 'connect', 'disconnect'],
  settings: ['get', 'set'],
};

export const THR_EVENTS: Array<keyof ThrEvents> = ['capture:status', 'marker:prompt', 'moment:changed', 'drafts:changed', 'clips:changed', 'nav', 'editor:save', 'notice'];

export const invokeChannel = (group: string, method: string) => `thr:${group}.${method}`;
export const eventChannel = (event: string) => `thr:event:${event}`;
