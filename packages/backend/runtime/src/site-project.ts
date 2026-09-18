import { access, readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { SitePackageManager, SiteProject } from "@aura/protocol/types";
import { localSiteUrl } from "./site-network.ts";

const managers: SitePackageManager[] = ["pnpm", "npm", "yarn", "bun"];
const scriptPattern = /^[a-zA-Z0-9:_-]+$/;
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function manifestAt(directory: string) {
  if (!isAbsolute(directory)) throw new Error("项目目录必须是本机绝对路径。");
  const normalized = resolve(directory);
  if (!(await stat(normalized).catch(() => null))?.isDirectory())
    throw new Error("找不到这个项目目录。");
  let manifest: unknown;
  try {
    manifest = JSON.parse(
      await readFile(join(normalized, "package.json"), "utf8"),
    );
  } catch {
    throw new Error("这个目录里没有可读取的 package.json。");
  }
  if (!isRecord(manifest)) throw new Error("package.json 必须是一个对象。");
  const scripts = Object.fromEntries(
    Object.entries(isRecord(manifest.scripts) ? manifest.scripts : {}).filter(
      ([name, command]) =>
        scriptPattern.test(name) &&
        typeof command === "string" &&
        command.trim(),
    ),
  ) as Record<string, string>;
  if (!Object.keys(scripts).length)
    throw new Error("package.json 里没有可运行的 scripts。");
  return { normalized, manifest, scripts };
}

async function detectManager(
  manifest: Record<string, unknown>,
  directory: string,
): Promise<SitePackageManager> {
  const declared =
    typeof manifest.packageManager === "string"
      ? manifest.packageManager.split("@")[0]
      : "";
  if (managers.includes(declared as SitePackageManager))
    return declared as SitePackageManager;
  for (const [file, manager] of [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
  ] as const) {
    if (
      await access(join(directory, file)).then(
        () => true,
        () => false,
      )
    )
      return manager;
  }
  return "npm";
}

function defaultUrl(
  manifest: Record<string, unknown>,
  command: string,
): string {
  const deps = {
    ...(isRecord(manifest.dependencies) ? manifest.dependencies : {}),
    ...(isRecord(manifest.devDependencies) ? manifest.devDependencies : {}),
  };
  const explicitPort = command.match(
    /(?:^|\s)(?:--port(?:=|\s+)|-p\s+)(\d+)(?=\s|$)/,
  )?.[1];
  const inferred =
    /^vite(?:\s|$)/.test(command) || "vite" in deps
      ? 5173
      : "@angular/cli" in deps
        ? 4200
        : 3000;
  const port =
    explicitPort && Number(explicitPort) > 0 && Number(explicitPort) <= 65535
      ? Number(explicitPort)
      : inferred;
  return `http://127.0.0.1:${port}`;
}

export async function describeProject(directory: string): Promise<SiteProject> {
  const { normalized, manifest, scripts } = await manifestAt(directory);
  const names = Object.keys(scripts);
  const script =
    ["dev", "start", "serve"].find((name) => names.includes(name)) ?? names[0];
  return {
    directory: normalized,
    name:
      typeof manifest.name === "string" && manifest.name.trim()
        ? manifest.name.trim()
        : basename(normalized),
    packageManager: await detectManager(manifest, normalized),
    scripts: names,
    script,
    url: defaultUrl(manifest, scripts[script]),
  };
}

export async function siteProjectInput(
  input: unknown,
): Promise<{ project: SiteProject; command: string }> {
  if (!isRecord(input) || typeof input.directory !== "string")
    throw new Error("未选择项目目录。");
  const project = await describeProject(input.directory);
  const { scripts } = await manifestAt(project.directory);
  const script =
    typeof input.script === "string" ? input.script : project.script;
  if (!Object.hasOwn(scripts, script))
    throw new Error("所选启动脚本已不存在，请重新选择目录。");
  const url = localSiteUrl(
    typeof input.url === "string" ? input.url : project.url,
  ).toString();
  return { project: { ...project, script, url }, command: scripts[script] };
}

/** Only direct commands with literal arguments: never append flags to a shell pipeline/wrapper. */
export function sitePortFlags(
  command: string,
  port: number,
  hostname = "127.0.0.1",
): string[] | null {
  const tokens = command.trim().split(/\s+/);
  if (
    tokens.includes("--") ||
    tokens.some((token) => !/^[a-zA-Z0-9_./:=,@+-]+$/.test(token))
  )
    return null;
  if (
    tokens[0] === "vite" &&
    (!tokens[1] ||
      tokens[1].startsWith("-") ||
      tokens[1] === "dev" ||
      tokens[1] === "serve")
  )
    return ["--host", hostname, "--port", String(port), "--strictPort"];
  if (tokens[0] === "next" && ["dev", "start"].includes(tokens[1]))
    return ["--hostname", hostname, "--port", String(port)];
  if (
    (tokens[0] === "ng" && tokens[1] === "serve") ||
    (tokens[0] === "vue-cli-service" && tokens[1] === "serve")
  )
    return ["--host", hostname, "--port", String(port)];
  return null;
}

function stripOptions(
  tokens: string[],
  names: string[],
  consumesValue = true,
): string[] {
  const result: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const name = names.find(
      (candidate) =>
        token === candidate || token.startsWith(`${candidate}=`)
    );
    if (!name) {
      result.push(token);
      continue;
    }
    if (token === name && consumesValue && tokens[index + 1]) index++;
  }
  return result;
}

/** Rewrites only the recognized direct dev-server command before spawning it. */
export function siteDirectCommand(
  command: string,
  flags: string[],
): { command: string; args: string[] } | null {
  const tokens = command.trim().split(/\s+/);
  if (
    !tokens.length ||
    tokens.includes("--") ||
    tokens.some((token) => !/^[a-zA-Z0-9_./:=,@+-]+$/.test(token))
  )
    return null;
  const name = tokens[0];
  const direct =
    (name === "vite" &&
      (!tokens[1] ||
        tokens[1].startsWith("-") ||
        tokens[1] === "dev" ||
        tokens[1] === "serve")) ||
    (name === "next" && ["dev", "start"].includes(tokens[1])) ||
    (name === "ng" && tokens[1] === "serve") ||
    (name === "vue-cli-service" && tokens[1] === "serve");
  if (!direct) return null;

  let args = tokens.slice(1);
  if (name === "vite") {
    args = stripOptions(args, ["--host", "-H"]);
    args = stripOptions(args, ["--port", "-p"]);
    args = stripOptions(args, ["--strictPort"], false);
  } else if (name === "next") {
    args = stripOptions(args, ["--hostname"]);
    args = stripOptions(args, ["--port", "-p"]);
  } else {
    args = stripOptions(args, ["--host", "-H"]);
    args = stripOptions(args, ["--port", "-p"]);
  }
  return { command: name, args: [...args, ...flags] };
}

export function siteScriptArgs(
  project: SiteProject,
  flags: string[],
): string[] {
  return [
    "run",
    project.script,
    ...(flags.length && project.packageManager === "npm" ? ["--"] : []),
    ...flags,
  ];
}
