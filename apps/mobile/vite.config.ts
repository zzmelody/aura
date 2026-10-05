import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  base: "./",
  cacheDir: `../../.aura/vite/mobile/${command}`,
  optimizeDeps: { include: ["@google/model-viewer"] },
  plugins: [react()],
}));
