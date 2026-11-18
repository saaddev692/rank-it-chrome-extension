const SAFE = Symbol("safe-html");

/** A string that is already valid HTML and must not be escaped again. */
export interface SafeHtml {
  readonly [SAFE]: string;
}

export function raw(markup: string): SafeHtml {
  return { [SAFE]: markup };
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

type Value = SafeHtml | string | number | readonly SafeHtml[] | null | undefined;

function render(value: Value): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map((v: SafeHtml) => v[SAFE]).join("");
  if (typeof value === "object") return (value as SafeHtml)[SAFE];
  return escapeHtml(String(value));
}

/** Tagged template: interpolated strings and numbers are HTML-escaped; SafeHtml is inserted as is. */
export function html(strings: TemplateStringsArray, ...values: Value[]): SafeHtml {
  let out = strings[0] ?? "";
  values.forEach((value, i) => {
    out += render(value) + (strings[i + 1] ?? "");
  });
  return raw(out);
}

export function toHtmlString(value: SafeHtml): string {
  return value[SAFE];
}
