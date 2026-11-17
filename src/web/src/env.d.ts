import type { ThrApi } from '@shared/types';

declare global {
  interface Window {
    thr: ThrApi;
  }
}
export {};
