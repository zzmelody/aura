import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { getRequestListener } from "@hono/node-server";
import type { Plugin } from "vite";

/** Deploy decoder files with all three DOM hosts; no runtime dependency on a CDN. */
export function modelViewerAssets(): Plugin {
  const source = resolve(
    dirname(fileURLToPath(import.meta.resolve("three"))),
    "../examples/jsm/libs",
  );
  const files = [
    "draco/gltf/draco_wasm_wrapper.js",
    "draco/gltf/draco_decoder.wasm",
    "draco/gltf/draco_decoder.js",
    "basis/basis_transcoder.js",
    "basis/basis_transcoder.wasm",
    "meshopt_decoder.js",
  ];
  async function asset(file: string) {
    if (file !== "meshopt_decoder.js") return readFile(resolve(source, file));
    const module = await readFile(
      resolve(source, "meshopt_decoder.module.js"),
      "utf8",
    );
    return Buffer.from(
      module.replace(
        /export\s*\{\s*MeshoptDecoder\s*\};?/,
        "self.MeshoptDecoder = MeshoptDecoder;",
      ),
    );
  }
  const prefix = "model-decoders/";
  return {
    name: "aura-model-viewer-assets",
    async generateBundle() {
      for (const file of files)
        this.emitFile({
          type: "asset",
          fileName: `${prefix}${file}`,
          source: await asset(file),
        });
    },
    configureServer(server) {
      const app = new Hono();
      for (const file of files)
        app.get(`/${prefix}${file}`, async (context) => {
          context.header(
            "Content-Type",
            file.endsWith(".wasm") ? "application/wasm" : "text/javascript",
          );
          return context.body(new Uint8Array(await asset(file)));
        });
      const handler = getRequestListener(app.fetch);
      server.middlewares.use((request, response, next) => {
        if (request.url?.startsWith(`/${prefix}`))
          void handler(request, response);
        else next();
      });
    },
  };
}
