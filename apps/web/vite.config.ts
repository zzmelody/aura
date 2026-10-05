import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  base: "./",
  cacheDir: `../../.aura/vite/web/${command}`,
  optimizeDeps: { include: ["@google/model-viewer"] },
  plugins: [react()],
  server: { host: "127.0.0.1", port: 8081, strictPort: true },
}));
