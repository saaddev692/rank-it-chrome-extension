import { ORDER_SEARCH_QUERY } from "@oep/shared";
import { getAccessToken, signOut, withAccessToken } from "./auth.ts";
import { ExtensionError } from "./errors.ts";
import { createGmailClient } from "./gmail.ts";
import { sendToBackground } from "./messages.ts";
import { listOrders, parseEmailViaProxy } from "./proxy-client.ts";
import { describeWatchStatus, renderHistory } from "./render.ts";
import { describeSummary, searchAndParse } from "./search-and-parse.ts";
import { WATCH_STATE_KEY, type WatchState, chromeWatchStateStore } from "./watch-state.ts";

const watchState = chromeWatchStateStore();

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} missing from app.html`);
  return node as T;
}

const ui = {
  accountEmail: byId("account-email"),
  signIn: byId<HTMLButtonElement>("sign-in"),
  signOut: byId<HTMLButtonElement>("sign-out"),
  status: byId("status"),
  signedIn: byId("signed-in"),
  query: byId("query"),
  watchEnabled: byId<HTMLInputElement>("watch-enabled"),
  checkNow: byId<HTMLButtonElement>("check-now"),
  watchStatus: byId("watch-status"),
  search: byId<HTMLButtonElement>("search"),
  history: byId("history"),
  historyCount: byId("history-count"),
  refreshHistory: byId<HTMLButtonElement>("refresh-history"),
};

ui.query.textContent = ORDER_SEARCH_QUERY;

let account: string | null = null;
let parsedIds = new Set<string>();

function setStatus(message: string, isError = false): void {
  ui.status.textContent = message;
  ui.status.classList.toggle("error", isError);
}

function showError(err: unknown): void {
  if (err instanceof ExtensionError) {
    setStatus(err.message, true);
    if (err.kind === "not_signed_in" || err.kind === "scope_not_granted") showSignedOut();
    return;
  }
  console.error(err);
  setStatus(`Unexpected error: ${(err as Error).message}`, true);
}

async function busy(button: HTMLButtonElement, task: () => Promise<void>): Promise<void> {
  button.disabled = true;
  try {
    await task();
  } catch (err) {
    showError(err);
  } finally {
    button.disabled = false;
  }
}

function renderWatchStatus(state: WatchState): void {
  ui.watchEnabled.checked = state.enabled;
  ui.checkNow.disabled = !state.enabled;
  const { text, isError } = describeWatchStatus(state);
  ui.watchStatus.textContent = text;
  ui.watchStatus.classList.toggle("error", isError);
}

async function loadHistory(): Promise<void> {
  if (!account) return;
  const records = await listOrders(account);
  parsedIds = new Set(records.map((r) => r.messageId));
  ui.historyCount.textContent = `(${records.length})`;
  renderHistory(ui.history, records, (id) => void parseMessage(id, true));
}

function showSignedOut(): void {
  account = null;
  ui.accountEmail.textContent = "";
  ui.signIn.hidden = false;
  ui.signOut.hidden = true;
  ui.signedIn.hidden = true;
}

/**
 * Only Google auth decides signed-in vs signed-out. Anything after that (proxy down, history
 * request rejected) is shown as an error while staying signed in.
 */
async function showSignedIn(): Promise<void> {
  const profile = await withAccessToken((token) => createGmailClient(token).profile());
  account = profile.emailAddress.toLowerCase();
  ui.accountEmail.textContent = profile.emailAddress;
  ui.signIn.hidden = true;
  ui.signOut.hidden = false;
  ui.signedIn.hidden = false;
  setStatus("");

  try {
    renderWatchStatus(await watchState.get());
    await sendToBackground({ type: "watch:seen" });
    await loadHistory();
  } catch (err) {
    showError(err);
  }
}

async function parseMessage(id: string, force: boolean): Promise<void> {
  if (!account) return;
  const signedInAs = account;
  setStatus(force ? "Re-parsing with Gemini…" : "Fetching email from Gmail…");
  try {
    const email = await withAccessToken((token) => createGmailClient(token).getEmail(id));
    setStatus("Parsing with Gemini…");
    const { record, cached } = await parseEmailViaProxy({
      account: signedInAs,
      source: "manual",
      force,
      email,
    });
    await loadHistory();
    const count = record.order.items.length;
    setStatus(
      `Parsed ${count} item${count === 1 ? "" : "s"}${cached ? " (already in history)" : ""}.`,
    );
    ui.history
      .querySelector(`[data-message-id="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    showError(err);
  }
}

async function saveWatchSettings(enabled: boolean): Promise<void> {
  const before = await watchState.get();
  await sendToBackground({
    type: "watch:configure",
    enabled,
    // Turning auto-check on starts from "now"; mail that arrived while it was off is not back-filled.
    resetCursor: enabled && !before.enabled,
  });
}

ui.signIn.addEventListener("click", () =>
  busy(ui.signIn, async () => {
    setStatus("Waiting for Google sign-in…");
    await getAccessToken(true);
    await showSignedIn();
  }),
);

ui.signOut.addEventListener("click", () =>
  busy(ui.signOut, async () => {
    await sendToBackground({
      type: "watch:configure",
      enabled: false,
      resetCursor: true,
    });
    await signOut();
    showSignedOut();
    setStatus("Signed out, access revoked and auto-check turned off.");
  }),
);

ui.watchEnabled.addEventListener("change", () => {
  const enabled = ui.watchEnabled.checked;
  ui.watchEnabled.disabled = true;
  saveWatchSettings(enabled)
    .then(() =>
      setStatus(
        enabled
          ? "Auto-check is on. New matching mail will be parsed within a minute."
          : "Auto-check is off.",
      ),
    )
    .catch(showError)
    .finally(() => {
      ui.watchEnabled.disabled = false;
    });
});

ui.checkNow.addEventListener("click", () =>
  busy(ui.checkNow, async () => {
    setStatus("Checking for new mail…");
    await sendToBackground({ type: "watch:check-now" });
    setStatus("Check finished.");
  }),
);

ui.search.addEventListener("click", () =>
  busy(ui.search, async () => {
    if (!account) return;
    setStatus("Searching Gmail…");
    const summary = await searchAndParse({
      account,
      known: parsedIds,
      withGmail: (fn) => withAccessToken((token) => fn(createGmailClient(token))),
      parse: (request) => parseEmailViaProxy(request),
      onProgress: (done, total) => {
        if (done < total) setStatus(`Parsing ${done + 1} of ${total} with Gemini…`);
      },
    });
    await loadHistory();
    setStatus(describeSummary(summary), summary.failures.length > 0);
  }),
);

ui.refreshHistory.addEventListener("click", () => busy(ui.refreshHistory, loadHistory));

// The background worker writes progress to storage; reflect it live and pull in new records.
chrome.storage.onChanged.addListener((changes, area) => {
  const change = changes[WATCH_STATE_KEY];
  if (area !== "local" || !change?.newValue) return;
  const next = change.newValue as WatchState;
  const prev = change.oldValue as WatchState | undefined;
  renderWatchStatus(next);
  if (next.unseen > (prev?.unseen ?? 0)) {
    void loadHistory()
      .then(() => sendToBackground({ type: "watch:seen" }))
      .catch(showError);
    setStatus(`${next.unseen} new order${next.unseen === 1 ? "" : "s"} parsed automatically.`);
  }
});

// On load (including a page refresh) Chrome still holds the grant, so this signs in silently.
showSignedIn().catch((err: unknown) => {
  showSignedOut();
  if (!(err instanceof ExtensionError && err.kind === "not_signed_in")) showError(err);
});
