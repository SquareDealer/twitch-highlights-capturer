import type { ThrEvents, ThrHandlers } from './types';

/** Method names per API group; the single source for both the server's allow-list and the web client. */
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

/** `POST` target of one API call; the body is the JSON array of arguments. */
export const rpcPath = (group: string, method: string) => `/api/rpc/${group}/${method}`;
export const EVENTS_PATH = '/api/events';
export const HOTKEY_PATH = '/api/hotkey';
