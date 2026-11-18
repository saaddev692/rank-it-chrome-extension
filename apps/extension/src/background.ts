import { withAccessToken } from "./auth.ts";
import { ExtensionError } from "./errors.ts";
import { createGmailClient } from "./gmail.ts";
import { type BackgroundRequest, isBackgroundRequest } from "./messages.ts";
import { parseEmailViaProxy } from "./proxy-client.ts";
import { chromeWatchStateStore } from "./watch-state.ts";
import { type CheckResult, checkForNewOrders } from "./watcher.ts";

const ALARM = "gmail-watch";
const state = chromeWatchStateStore();

// The UI runs in a tab rather than a popup: the OAuth consent window steals focus, which
// would close a popup and lose the sign-in result.
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL("app.html");
  // getContexts finds our own tab without needing the "tabs" permission.
  const [existing] = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.TAB],
    documentUrls: [url],
  });
  if (existing && existing.tabId !== -1) {
    await chrome.tabs.update(existing.tabId, { active: true });
    if (existing.windowId !== -1) await chrome.windows.update(existing.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url });
});

async function syncAlarm(): Promise<void> {
  const { enabled } = await state.get();
  if (enabled) {
    // 1 minute is the shortest period Chrome allows for packed extensions.
    await chrome.alarms.create(ALARM, { periodInMinutes: 1 });
  } else {
    await chrome.alarms.clear(ALARM);
  }
}

async function updateBadge(): Promise<void> {
  const { unseen, lastError, enabled } = await state.get();
  if (enabled && lastError) {
    await chrome.action.setBadgeBackgroundColor({ color: "#b42318" });
    await chrome.action.setBadgeText({ text: "!" });
  } else {
    await chrome.action.setBadgeBackgroundColor({ color: "#1d4ed8" });
    await chrome.action.setBadgeText({ text: unseen > 0 ? String(Math.min(unseen, 99)) : "" });
  }
}

let running: Promise<CheckResult> | null = null;

/** Runs one check; concurrent triggers (alarm + "Check now") share the same run. */
function runCheck(): Promise<CheckResult> {
  running ??= checkForNewOrders({
    state,
    withGmail: (fn) => withAccessToken((token) => fn(createGmailClient(token))),
    parse: (request) => parseEmailViaProxy(request),
  })
    .catch(async (err: unknown) => {
      const message =
        err instanceof ExtensionError && err.kind === "not_signed_in"
          ? "Auto-check paused: sign in again to resume."
          : err instanceof Error
            ? err.message
            : String(err);
      await state.patch({ lastError: message, lastCheckedAt: new Date().toISOString() });
      throw err;
    })
    .finally(() => {
      running = null;
      void updateBadge();
    });
  return running;
}

async function handle(request: BackgroundRequest): Promise<unknown> {
  switch (request.type) {
    case "watch:configure": {
      await state.patch({
        enabled: request.enabled,
        lastError: null,
        ...(request.resetCursor ? { historyId: null, pending: [] } : {}),
      });
      await syncAlarm();
      return request.enabled ? runCheck() : { status: "disabled" };
    }
    case "watch:check-now":
      return runCheck();
    case "watch:seen":
      await state.patch({ unseen: 0 });
      await updateBadge();
      return { ok: true };
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !isBackgroundRequest(message)) return false;
  handle(message).then(
    (result) => sendResponse({ ok: true, result }),
    (err: unknown) =>
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
  );
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) runCheck().catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => void syncAlarm().then(updateBadge));
chrome.runtime.onStartup.addListener(() => void syncAlarm().then(updateBadge));
