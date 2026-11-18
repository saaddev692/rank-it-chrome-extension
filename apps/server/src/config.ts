import { z } from "zod";

const ConfigSchema = z.object({
  GEMINI_API_KEY: z.string().trim().min(1, "GEMINI_API_KEY is required"),
  GEMINI_MODEL: z.string().trim().min(1).default("gemini-3.8-flash"),
  GEMINI_API_REVISION: z.string().trim().min(1).default("2026-05-20"),
  GEMINI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000).default(30_000),
  ALLOWED_ORIGINS: z
    .string()
    .trim()
    .min(1, "ALLOWED_ORIGINS is required (e.g. chrome-extension://<id>)")
    .transform((v) =>
      v
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean),
    )
    .pipe(
      z
        .array(
          z
            .string()
            .regex(
              /^chrome-extension:\/\/[a-p]{32}$/,
              "each origin must look like chrome-extension://<32-char id>",
            ),
        )
        .min(1),
    ),
  HOST: z.string().trim().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  DB_PATH: z.string().trim().min(1, "DB_PATH is required").default("./data/orders.db"),
});

export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`Invalid server configuration:\n${details}`);
  }
  return result.data;
}
