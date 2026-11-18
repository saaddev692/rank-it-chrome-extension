/** Messages the app tab sends to the background service worker. */
export type BackgroundRequest =
  | { type: "watch:configure"; enabled: boolean; resetCursor: boolean }
  | { type: "watch:check-now" }
  | { type: "watch:seen" };

export type BackgroundResponse = { ok: true; result: unknown } | { ok: false; error: string };

export function isBackgroundRequest(value: unknown): value is BackgroundRequest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  switch (v["type"]) {
    case "watch:configure":
      return typeof v["enabled"] === "boolean" && typeof v["resetCursor"] === "boolean";
    case "watch:check-now":
    case "watch:seen":
      return true;
    default:
      return false;
  }
}

export async function sendToBackground(request: BackgroundRequest): Promise<unknown> {
  const response = (await chrome.runtime.sendMessage(request)) as BackgroundResponse | undefined;
  if (!response) throw new Error("No response from the background worker");
  if (!response.ok) throw new Error(response.error);
  return response.result;
}
