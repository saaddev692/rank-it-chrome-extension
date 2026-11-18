import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.ts";

const ID = "abcdefghijklmnopabcdefghijklmnop";
const minimal = { GEMINI_API_KEY: "k", ALLOWED_ORIGINS: `chrome-extension://${ID}` };

describe("loadConfig", () => {
  it("applies defaults", () => {
    expect(loadConfig(minimal)).toEqual({
      GEMINI_API_KEY: "k",
      GEMINI_MODEL: "gemini-3.8-flash",
      GEMINI_API_REVISION: "2026-05-20",
      GEMINI_TIMEOUT_MS: 30_000,
      ALLOWED_ORIGINS: [`chrome-extension://${ID}`],
      HOST: "127.0.0.1",
      PORT: 8787,
      DB_PATH: "./data/orders.db",
    });
  });

  it("parses multiple origins and numeric overrides", () => {
    const other = "ponmlkjihgfedcbaponmlkjihgfedcba";
    const cfg = loadConfig({
      ...minimal,
      ALLOWED_ORIGINS: ` chrome-extension://${ID} , chrome-extension://${other},`,
      PORT: "9000",
      DB_PATH: "/tmp/history.db",
    });
    expect(cfg.ALLOWED_ORIGINS).toEqual([
      `chrome-extension://${ID}`,
      `chrome-extension://${other}`,
    ]);
    expect(cfg.PORT).toBe(9000);
    expect(cfg.DB_PATH).toBe("/tmp/history.db");
  });

  it.each([
    ["missing key", { ALLOWED_ORIGINS: minimal.ALLOWED_ORIGINS }, "GEMINI_API_KEY"],
    ["blank key", { ...minimal, GEMINI_API_KEY: "  " }, "GEMINI_API_KEY"],
    ["missing origins", { GEMINI_API_KEY: "k" }, "ALLOWED_ORIGINS"],
    [
      "placeholder origin",
      { ...minimal, ALLOWED_ORIGINS: "chrome-extension://your-extension-id-here" },
      "ALLOWED_ORIGINS",
    ],
    ["wildcard origin", { ...minimal, ALLOWED_ORIGINS: "*" }, "ALLOWED_ORIGINS"],
    ["web origin", { ...minimal, ALLOWED_ORIGINS: "https://example.com" }, "ALLOWED_ORIGINS"],
    ["bad port", { ...minimal, PORT: "70000" }, "PORT"],
    ["empty DB path", { ...minimal, DB_PATH: " " }, "DB_PATH"],
    ["tiny timeout", { ...minimal, GEMINI_TIMEOUT_MS: "5" }, "GEMINI_TIMEOUT_MS"],
  ])("rejects %s", (_label, env, field) => {
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(field);
  });

  it("does not echo the API key in errors", () => {
    const env = { GEMINI_API_KEY: "super-secret-value", ALLOWED_ORIGINS: "bad" };
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).not.toThrow("super-secret-value");
  });
});
