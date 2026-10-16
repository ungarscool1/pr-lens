import type { PrLensApi } from './index';

declare global {
  interface Window {
    prLens: PrLensApi;
  }
}

export {};
