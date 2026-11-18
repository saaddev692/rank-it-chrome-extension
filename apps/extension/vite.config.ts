import { resolve } from "node:path";
import { defineConfig, loadEnv } from "vite";
import { buildManifest, readBuildSettings } from "./manifest.ts";

export default defineConfig(({ mode }) => {
  const settings = readBuildSettings(loadEnv(mode, import.meta.dirname, ""));

  return {
    define: {
      "import.meta.env.PROXY_URL": JSON.stringify(settings.proxyUrl),
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      sourcemap: true,
      rollupOptions: {
        input: {
          app: resolve(import.meta.dirname, "app.html"),
          background: resolve(import.meta.dirname, "src/background.ts"),
        },
        output: {
          entryFileNames: (chunk) =>
            chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js",
        },
      },
    },
    plugins: [
      {
        name: "emit-manifest",
        generateBundle() {
          this.emitFile({
            type: "asset",
            fileName: "manifest.json",
            source: JSON.stringify(buildManifest(settings), null, 2),
          });
        },
      },
    ],
  };
});
