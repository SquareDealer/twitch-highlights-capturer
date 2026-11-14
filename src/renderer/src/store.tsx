import { createContext, useContext, useReducer, type Dispatch, type ReactNode } from 'react';
import type { CaptureStatus, Marker, Moment, Notice } from '@shared/types';

export type View = 'watch' | 'editor' | 'library' | 'settings';

export interface AppNotice extends Notice {
  id: number;
}

export interface AppState {
  view: View;
  editorDraftId: string | null;
  status: CaptureStatus;
  moment: Moment | null;
  prompt: Marker | null;
  notices: AppNotice[];
}

export type Action =
  | { type: 'view'; view: View; draftId?: string | null }
  | { type: 'status'; status: CaptureStatus }
  | { type: 'moment'; moment: Moment | null }
  | { type: 'prompt'; marker: Marker | null }
  | { type: 'notice'; notice: Notice }
  | { type: 'dismiss'; id: number };

export const initialState: AppState = {
  view: 'watch',
  editorDraftId: null,
  status: { session: null, bufferedMs: 0, pinnedBytes: 0, markerCount: 0 },
  moment: null,
  prompt: null,
  notices: [],
};

let noticeSeq = 0;

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'view':
      return {
        ...state,
        view: action.view,
        editorDraftId: action.view === 'editor' ? (action.draftId ?? null) : state.editorDraftId,
        prompt: action.view === 'watch' ? state.prompt : null,
      };
    case 'status':
      return { ...state, status: action.status };
    case 'moment':
      return { ...state, moment: action.moment };
    case 'prompt':
      return { ...state, prompt: action.marker };
    case 'notice':
      return { ...state, notices: [...state.notices.slice(-4), { ...action.notice, id: ++noticeSeq }] };
    case 'dismiss':
      return { ...state, notices: state.notices.filter((n) => n.id !== action.id) };
  }
}

const Ctx = createContext<{ state: AppState; dispatch: Dispatch<Action> } | null>(null);

export function AppStoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  return <Ctx.Provider value={{ state, dispatch }}>{children}</Ctx.Provider>;
}

export function useAppStore() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAppStore must be used inside AppStoreProvider');
  return ctx;
}
