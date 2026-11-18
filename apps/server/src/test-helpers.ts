import { type TemplateName, TEMPLATE_NAMES, fixture } from "@oep/test-emails";
import type { StructuredExtractor } from "./gemini.ts";

export const FIXTURE_NAMES: readonly TemplateName[] = TEMPLATE_NAMES;
export type FixtureName = TemplateName;

/** Rendered mock email as it would arrive from the retailer, plus the expected parse result. */
export const loadFixture = fixture;

/** Extractor double that records the prompt and returns a canned (or thrown) result. */
export function fakeExtractor(result: unknown | (() => unknown), model = "test-model") {
  const calls: string[] = [];
  const extractor: StructuredExtractor = {
    model,
    async extract(input) {
      calls.push(input);
      return typeof result === "function" ? (result as () => unknown)() : structuredClone(result);
    },
  };
  return { extractor, calls };
}

export function interactionResponse(text: string, status = "completed"): Response {
  return Response.json({
    id: "v1_test",
    status,
    created: "2026-11-18T00:00:00Z",
    updated: "2026-11-18T00:00:00Z",
    steps: [
      { type: "user_input", content: [{ type: "text", text: "prompt" }] },
      { type: "thought", content: [{ type: "text", text: "thinking" }] },
      { type: "model_output", content: [{ type: "text", text }] },
    ],
  });
}
