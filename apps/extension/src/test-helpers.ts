/** Encodes text the way the Gmail API returns body data (base64url, no padding). */
export function b64url(text: string, encoding: "utf-8" | "latin1" = "utf-8"): string {
  const bytes =
    encoding === "utf-8"
      ? new TextEncoder().encode(text)
      : Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
