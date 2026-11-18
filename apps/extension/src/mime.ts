/** Subset of the Gmail API `MessagePart` resource that we use. */
export interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailMessagePart[];
}

export function base64UrlToBytes(data: string): Uint8Array {
  const b64 = data.replaceAll("-", "+").replaceAll("_", "/").replaceAll(/\s/g, "");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function header(part: GmailMessagePart, name: string): string | null {
  const lower = name.toLowerCase();
  return part.headers?.find((h) => h.name.toLowerCase() === lower)?.value ?? null;
}

function charsetOf(part: GmailMessagePart): string {
  const contentType = header(part, "Content-Type") ?? "";
  return /charset="?([^";\s]+)"?/i.exec(contentType)?.[1]?.toLowerCase() ?? "utf-8";
}

/** Decodes body bytes using the part's declared charset, falling back to UTF-8 for unknown labels. */
export function decodePartData(part: GmailMessagePart, data: string): string {
  const bytes = base64UrlToBytes(data);
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charsetOf(part));
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  return decoder.decode(bytes);
}

function isAttachment(part: GmailMessagePart): boolean {
  if (part.filename) return true;
  return /^\s*attachment/i.test(header(part, "Content-Disposition") ?? "");
}

/**
 * Finds the first inline text/html and text/plain parts, depth-first, skipping attachments.
 * Large bodies may be returned with only an `attachmentId`, so callers must fetch those.
 */
export function findBodyParts(root: GmailMessagePart): {
  html: GmailMessagePart | null;
  text: GmailMessagePart | null;
} {
  let html: GmailMessagePart | null = null;
  let text: GmailMessagePart | null = null;
  const stack: GmailMessagePart[] = [root];
  while (stack.length > 0 && (!html || !text)) {
    const part = stack.shift()!;
    const type = part.mimeType?.toLowerCase() ?? "";
    if (type.startsWith("multipart/")) {
      stack.unshift(...(part.parts ?? []));
      continue;
    }
    if (isAttachment(part)) continue;
    if (type === "text/html" && !html) html = part;
    else if (type === "text/plain" && !text) text = part;
  }
  return { html, text };
}
