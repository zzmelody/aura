/** Generic file/media primitives; product layouts and rendering policy live in plugins. */
export {
  GeneratedArtifacts,
  publishBytes,
  readBoundedFile,
} from "./artifacts/generated.ts";
export { artifactHash, inspectArtifact } from "./artifacts/media.ts";
export { artifactResponse, type ArtifactFile } from "./artifacts/http.ts";
export { wavDuration } from "./wav.ts";
export { default as sharp } from "sharp";
export { default as ffmpegPath } from "ffmpeg-static";
export { probeVideo } from "./local-ai/media.ts";
