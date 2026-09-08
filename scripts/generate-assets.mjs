import sharp from "sharp";
import { fileURLToPath } from "node:url";
const assets = fileURLToPath(
  new URL("../packages/frontend/mobile/assets/", import.meta.url),
);
await sharp(`${assets}/icon.svg`).png().toFile(`${assets}/icon.png`);
await sharp(`${assets}/icon.svg`)
  .resize(64, 64)
  .png()
  .toFile(`${assets}/favicon.png`);
console.log("Generated Aura app icon and favicon.");
