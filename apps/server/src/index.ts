import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { createGeminiExtractor } from "./gemini.ts";
import { openOrderStore } from "./store.ts";

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function main(): void {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(
        `${err.message}\n\nCopy apps/server/.env.example to apps/server/.env and fill it in.`,
      );
      process.exit(1);
    }
    throw err;
  }

  const store = openOrderStore(config.DB_PATH, log);
  const app = createApp({
    allowedOrigins: config.ALLOWED_ORIGINS,
    extractor: createGeminiExtractor({
      apiKey: config.GEMINI_API_KEY,
      model: config.GEMINI_MODEL,
      apiRevision: config.GEMINI_API_REVISION,
      timeoutMs: config.GEMINI_TIMEOUT_MS,
    }),
    store,
    log,
  });

  const server = serve({ fetch: app.fetch, hostname: config.HOST, port: config.PORT }, (info) => {
    console.log(
      `Order parser proxy on http://${info.address}:${info.port} (model ${config.GEMINI_MODEL}, history ${config.DB_PATH})`,
    );
  });

  const shutdown = () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
