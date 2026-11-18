import { defineProject } from "vitest/config";

export default defineProject({
  define: { "import.meta.env.PROXY_URL": JSON.stringify("http://127.0.0.1:8787") },
  test: { name: "extension", environment: "happy-dom" },
});
