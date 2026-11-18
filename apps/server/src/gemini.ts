import { AppError } from "./errors.ts";
import { RESPONSE_JSON_SCHEMA, SYSTEM_INSTRUCTION } from "./prompt.ts";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";

export interface GeminiOptions {
  apiKey: string;
  model: string;
  apiRevision: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

export interface StructuredExtractor {
  readonly model: string;
  extract(input: string): Promise<unknown>;
}

interface InteractionStep {
  type?: string;
  content?: { type?: string; text?: string }[];
}

interface InteractionResponse {
  status?: string;
  steps?: InteractionStep[];
  errors?: { code?: string; message?: string }[];
}

function shorten(s: string, max = 300): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

async function upstreamMessage(res: Response): Promise<string> {
  try {
    type GoogleError = { error?: { message?: string } };
    // Google sometimes wraps the error object in a one-element array.
    const raw = (await res.json()) as GoogleError | GoogleError[];
    const body = Array.isArray(raw) ? raw[0] : raw;
    return shorten(body?.error?.message ?? res.statusText);
  } catch {
    return res.statusText;
  }
}

/** Returns the text of the last model_output step, joining consecutive text blocks. */
export function outputText(interaction: InteractionResponse): string | null {
  const outputs = (interaction.steps ?? []).filter((s) => s.type === "model_output");
  const last = outputs.at(-1);
  if (!last?.content) return null;
  const text = last.content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("");
  return text.trim() === "" ? null : text;
}

export function createGeminiExtractor(opts: GeminiOptions): StructuredExtractor {
  const doFetch = opts.fetch ?? fetch;

  return {
    model: opts.model,
    async extract(input: string): Promise<unknown> {
      let res: Response;
      try {
        res = await doFetch(ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": opts.apiKey,
            "Api-Revision": opts.apiRevision,
          },
          body: JSON.stringify({
            model: opts.model,
            system_instruction: SYSTEM_INSTRUCTION,
            input,
            response_format: {
              type: "text",
              mime_type: "application/json",
              schema: RESPONSE_JSON_SCHEMA,
            },
            generation_config: { thinking_level: "low" },
            store: false,
          }),
          signal: AbortSignal.timeout(opts.timeoutMs),
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === "TimeoutError") {
          throw new AppError(
            "upstream_timeout",
            504,
            `Gemini did not respond within ${opts.timeoutMs} ms`,
          );
        }
        throw new AppError(
          "upstream_error",
          502,
          `Could not reach Gemini: ${(err as Error).message}`,
        );
      }

      if (res.status === 429) {
        throw new AppError(
          "upstream_rate_limited",
          429,
          `Gemini rate limit: ${await upstreamMessage(res)}`,
        );
      }
      if (!res.ok) {
        throw new AppError(
          "upstream_error",
          502,
          `Gemini returned HTTP ${res.status}: ${await upstreamMessage(res)}`,
        );
      }

      let interaction: InteractionResponse;
      try {
        interaction = (await res.json()) as InteractionResponse;
      } catch {
        throw new AppError("upstream_error", 502, "Gemini returned a non-JSON response");
      }

      if (interaction.status === "failed") {
        const reason =
          interaction.errors?.map((e) => e.message ?? e.code).join("; ") || "unknown reason";
        throw new AppError("upstream_error", 502, `Gemini interaction failed: ${shorten(reason)}`);
      }
      if (interaction.status !== "completed") {
        throw new AppError(
          "invalid_model_output",
          502,
          `Gemini interaction ended with status "${interaction.status ?? "missing"}"`,
        );
      }

      const text = outputText(interaction);
      if (text === null) {
        throw new AppError("invalid_model_output", 502, "Gemini returned no text output");
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new AppError("invalid_model_output", 502, "Gemini output was not valid JSON");
      }
    },
  };
}
