import { HTMLElement, type Node, NodeType, parse } from "node-html-parser";

export const MAX_PROMPT_CHARS = 100_000;

const SKIPPED_TAGS = new Set(["script", "style", "head", "title", "noscript", "template", "svg"]);
const BLOCK_TAGS = new Set([
  "p",
  "div",
  "tr",
  "table",
  "tbody",
  "thead",
  "tfoot",
  "center",
  "section",
  "article",
  "header",
  "footer",
  "ul",
  "ol",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
]);
const CELL_TAGS = new Set(["td", "th"]);
const STRIKE_TAGS = new Set(["s", "strike", "del"]);

export interface PreprocessedEmail {
  /** Compact text body with `[IMAGE url="…" alt="…"]` markers where images sit. */
  text: string;
  /** Every candidate image URL that appears in `text`; the model may only pick from these. */
  imageUrls: Set<string>;
  truncated: boolean;
}

function isHidden(el: HTMLElement): boolean {
  if (el.hasAttribute("hidden")) return true;
  const style = (el.getAttribute("style") ?? "").toLowerCase().replaceAll(/\s+/g, "");
  return style.includes("display:none") || style.includes("visibility:hidden");
}

function dimension(el: HTMLElement, attr: "width" | "height"): number | null {
  const fromAttr = el.getAttribute(attr);
  const fromStyle = new RegExp(`(?:^|;)\\s*${attr}\\s*:\\s*(\\d+)px`, "i").exec(
    el.getAttribute("style") ?? "",
  )?.[1];
  const raw = fromAttr ?? fromStyle;
  if (raw === undefined) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? null : n;
}

/** Tracking pixels and spacers are tiny; they are never product images. */
function isTrackingPixel(el: HTMLElement): boolean {
  const w = dimension(el, "width");
  const h = dimension(el, "height");
  return (w !== null && w <= 2) || (h !== null && h <= 2);
}

function httpUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" || url.protocol === "http:" ? trimmed : null;
  } catch {
    return null;
  }
}

function quoteAttr(value: string): string {
  return value.replaceAll('"', "'").replaceAll(/\s+/g, " ").trim();
}

function walk(node: Node, out: string[], images: Set<string>): void {
  if (node.nodeType === NodeType.TEXT_NODE) {
    // Source whitespace (including newlines from HTML formatting) is not layout; only <br> and blocks are.
    out.push(node.text.replaceAll(/\s+/g, " "));
    return;
  }
  if (!(node instanceof HTMLElement)) return;

  const tag = node.rawTagName?.toLowerCase() ?? "";
  if (SKIPPED_TAGS.has(tag) || isHidden(node)) return;

  if (tag === "br") {
    out.push("\n");
    return;
  }
  if (tag === "img") {
    const src = httpUrl(node.getAttribute("src"));
    if (src && !isTrackingPixel(node)) {
      images.add(src);
      const alt = quoteAttr(node.getAttribute("alt") ?? "");
      out.push(`\n[IMAGE url="${src}" alt="${alt}"]\n`);
    }
    return;
  }

  const isBlock = BLOCK_TAGS.has(tag);
  // Crossed-out prices (original price next to a sale price) must stay distinguishable.
  const struck =
    STRIKE_TAGS.has(tag) ||
    /text-decoration[^;]*line-through/i.test(node.getAttribute("style") ?? "");
  if (isBlock) out.push("\n");
  if (struck) out.push("~~");
  for (const child of node.childNodes) walk(child, out, images);
  if (struck) out.push("~~");
  if (isBlock) out.push("\n");
  else if (CELL_TAGS.has(tag)) out.push(" | ");
}

function tidy(raw: string): string {
  return raw
    .replaceAll("\u00a0", " ")
    .split("\n")
    .map((line) =>
      line
        .replaceAll(/[ \t]+/g, " ")
        .replaceAll(/(\s*\|\s*)+/g, " | ")
        .replace(/^\s*\|\s*/, "")
        .replace(/\s*\|\s*$/, "")
        .trim(),
    )
    .filter((line) => line !== "")
    .join("\n");
}

const PLAIN_TEXT_IMAGE_URL = /https?:\/\/[^\s"'<>]+\.(?:jpe?g|png|webp|gif)(?:\?[^\s"'<>]*)?/gi;

export function preprocessEmail(body: {
  html: string | null;
  text: string | null;
}): PreprocessedEmail {
  const images = new Set<string>();
  let text: string;

  if (body.html?.trim()) {
    const root = parse(body.html, { comment: false });
    const out: string[] = [];
    walk(root, out, images);
    text = tidy(out.join(""));
  } else {
    text = tidy(body.text ?? "");
    for (const match of text.matchAll(PLAIN_TEXT_IMAGE_URL)) images.add(match[0]);
  }

  const truncated = text.length > MAX_PROMPT_CHARS;
  if (truncated) text = text.slice(0, MAX_PROMPT_CHARS);
  return { text, imageUrls: images, truncated };
}
