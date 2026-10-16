/** What a changed file is, from its extension. Drives the recap icon. */
export type FileKind =
  | "code"
  | "style"
  | "markup"
  | "config"
  | "markdown"
  | "image"
  | "video"
  | "audio"
  | "archive"
  | "data"
  | "shell"
  | "lock"
  | "text"
  | "unknown";

const KINDS: Record<string, FileKind> = {
  ts: "code",
  tsx: "code",
  js: "code",
  jsx: "code",
  mjs: "code",
  cjs: "code",
  py: "code",
  go: "code",
  rs: "code",
  java: "code",
  kt: "code",
  kts: "code",
  swift: "code",
  rb: "code",
  php: "code",
  c: "code",
  h: "code",
  cc: "code",
  cpp: "code",
  cxx: "code",
  hpp: "code",
  cs: "code",
  scala: "code",
  dart: "code",
  lua: "code",
  r: "code",
  css: "style",
  scss: "style",
  sass: "style",
  less: "style",
  html: "markup",
  htm: "markup",
  xml: "markup",
  svg: "markup",
  vue: "markup",
  svelte: "markup",
  astro: "markup",
  json: "config",
  jsonc: "config",
  yaml: "config",
  yml: "config",
  toml: "config",
  ini: "config",
  env: "config",
  conf: "config",
  md: "markdown",
  mdx: "markdown",
  rst: "markdown",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  ico: "image",
  bmp: "image",
  avif: "image",
  mp4: "video",
  webm: "video",
  mov: "video",
  mkv: "video",
  mp3: "audio",
  wav: "audio",
  ogg: "audio",
  flac: "audio",
  zip: "archive",
  tar: "archive",
  gz: "archive",
  tgz: "archive",
  "7z": "archive",
  rar: "archive",
  csv: "data",
  tsv: "data",
  xlsx: "data",
  xls: "data",
  sqlite: "data",
  db: "data",
  sql: "data",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  ps1: "shell",
  bat: "shell",
  cmd: "shell",
  lock: "lock",
  lockb: "lock",
  txt: "text",
  log: "text",
};

/** Last path segment after `/` or `\`. */
export function fileName(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return slash >= 0 ? path.slice(slash + 1) : path;
}

/** Directory portion, without a trailing slash. Empty when the path is a name. */
export function fileDir(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return slash >= 0 ? path.slice(0, slash) : "";
}

/**
 * A path as the user should see it: relative to the project when it lives
 * inside, otherwise the original. Absolute Windows and POSIX roots both count.
 */
export function displayPath(path: string, directory?: string): string {
  if (!directory) return path.replaceAll("\\", "/");
  const root = directory.replace(/[/\\]+$/u, "").replaceAll("\\", "/");
  const normalised = path.replaceAll("\\", "/");
  if (normalised === root) return fileName(normalised);
  const prefix = `${root}/`;
  if (normalised.startsWith(prefix)) return normalised.slice(prefix.length);
  if (normalised.toLowerCase().startsWith(prefix.toLowerCase()))
    return normalised.slice(prefix.length);
  return normalised;
}

/** Full path for copying: relative paths resolve against the project. */
export function fullPath(path: string, directory: string): string {
  return /^([a-zA-Z]:[\\/]|[\\/])/u.test(path)
    ? path
    : `${directory.replace(/[\\/]+$/u, "")}/${path}`;
}

/** Kinds whose content is not text, so a line diff means nothing. */
export const BINARY_KINDS: ReadonlySet<FileKind> = new Set([
  "image",
  "video",
  "audio",
  "archive",
]);

export function fileKind(path: string): FileKind {
  const name = fileName(path);
  if (name === "Dockerfile" || name.startsWith("Dockerfile.")) return "shell";
  if (name === "Makefile" || name === "GNUmakefile") return "shell";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "unknown";
  return KINDS[name.slice(dot + 1).toLowerCase()] ?? "unknown";
}
