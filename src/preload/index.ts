import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type { Result } from '../shared/errors';
import type { Channel, Input, Output, REVIEW_EVENT_CHANNEL } from '../shared/ipc';
import type { ReviewEvent } from '../shared/review';

// Type-only imports keep zod and every other runtime module out of the sandboxed preload.
const call =
  <C extends Channel>(channel: C) =>
  (...args: Input<C> extends undefined ? [] : [Input<C>]): Promise<Result<Output<C>>> =>
    ipcRenderer.invoke(channel, args[0]);

const reviewEvents: typeof REVIEW_EVENT_CHANNEL = 'review:event';

const api = {
  health: { check: call('health:check') },
  settings: {
    get: call('settings:get'),
    update: call('settings:update'),
    setOAuthToken: call('settings:setOAuthToken'),
  },
  github: {
    openPr: call('github:openPr'),
    openCompare: call('github:openCompare'),
    searchRefs: call('github:searchRefs'),
  },
  review: {
    start: call('review:start'),
    cancel: call('review:cancel'),
    onEvent(cb: (e: ReviewEvent) => void): () => void {
      const listener = (_e: IpcRendererEvent, payload: ReviewEvent): void => cb(payload);
      ipcRenderer.on(reviewEvents, listener);
      return () => ipcRenderer.removeListener(reviewEvents, listener);
    },
  },
  notes: {
    list: call('notes:list'),
    create: call('notes:create'),
    delete: call('notes:delete'),
    patchState: call('notes:patchState'),
  },
  deepDive: { open: call('deepDive:open') },
  promote: { preview: call('promote:preview'), confirm: call('promote:confirm') },
  shell: { openExternal: call('shell:openExternal') },
};

export type PrLensApi = typeof api;

contextBridge.exposeInMainWorld('prLens', api);
