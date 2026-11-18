/**
 * Auto-check settings and progress, kept in chrome.storage.local. Holds no credentials: only
 * the on/off switch, the Gmail history cursor and IDs of messages still waiting to be parsed.
 */
export interface WatchState {
  enabled: boolean;
  /** Account the cursor belongs to; a different signed-in account resets the cursor. */
  account: string | null;
  historyId: string | null;
  /** Matching messages not parsed yet (e.g. the proxy was down); retried on the next check. */
  pending: { id: string; attempts: number }[];
  lastCheckedAt: string | null;
  lastError: string | null;
  /** Orders parsed automatically since the user last opened the app (drives the badge). */
  unseen: number;
}

export const DEFAULT_WATCH_STATE: WatchState = {
  enabled: false,
  account: null,
  historyId: null,
  pending: [],
  lastCheckedAt: null,
  lastError: null,
  unseen: 0,
};

export interface WatchStateStore {
  get(): Promise<WatchState>;
  patch(update: Partial<WatchState>): Promise<WatchState>;
}

const KEY = "watch";

export function chromeWatchStateStore(
  storage: chrome.storage.StorageArea = chrome.storage.local,
): WatchStateStore {
  async function get(): Promise<WatchState> {
    const stored = (await storage.get(KEY))[KEY] as Partial<WatchState> | undefined;
    return { ...DEFAULT_WATCH_STATE, ...stored };
  }
  return {
    get,
    async patch(update) {
      const next = { ...(await get()), ...update };
      await storage.set({ [KEY]: next });
      return next;
    },
  };
}

export const WATCH_STATE_KEY = KEY;
