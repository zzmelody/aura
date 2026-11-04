import { readdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import {
  codexProviderProfile,
  readAiServices,
  customProfiles,
} from "@aura/dsh-auth";

export const dshHostEntry = fileURLToPath(
  new URL("./host-entry.ts", import.meta.url),
);
export const defaultFlowRoot = fileURLToPath(
  new URL("../flow", import.meta.url),
);
export const defaultActionRoot = fileURLToPath(
  new URL("../action", import.meta.url),
);

/**
 * Declares each preset directory as one `dsh-agent-preset` row. DSH 0.2 no
 * longer scans preset roots, so `<id>/preset.yml` supplies the display fields
 * (flat `key: value` lines) and `<id>/agent.cordis.yml` the child plugin list,
 * spliced in by indentation.
 */
async function presetRows(root: string): Promise<string> {
  const ids = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const rows = await Promise.all(
    ids.map(async (id, order) => {
      const meta = await readFile(join(root, id, "preset.yml"), "utf8");
      const fields = new Map(
        [...meta.matchAll(/^(name|description):[ \t]*(.+?)[ \t]*$/gm)].map(
          ([, key, value]) => [key, value],
        ),
      );
      const plugins = (
        await readFile(join(root, id, "agent.cordis.yml"), "utf8")
      )
        .replace(/\r\n/g, "\n")
        .trimEnd()
        .split("\n")
        .map((line) => (line ? `          ${line}` : line))
        .join("\n");
      const display = ["name", "description"]
        .filter((key) => fields.has(key))
        .map((key) => `        ${key}: ${JSON.stringify(fields.get(key))}\n`)
        .join("");
      return `    - id: ${JSON.stringify(`preset-${id}`)}
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: ${JSON.stringify(id)}
${display}        order: ${order}
        plugins:
${plugins}
`;
    }),
  );
  return rows.join("");
}

export async function provisionProfile(
  dshHome: string,
  flowRoots: readonly string[] = [defaultFlowRoot],
  actionRoots: readonly string[] = [defaultActionRoot],
  root: string = dirname(dirname(dshHome)),
  demoURL?: string,
) {
  const dir = join(dshHome, "profiles", "aura-flow");
  // HMR compares watched paths with canonical Node module URLs (not /var symlinks).
  const flowWatchRoots = await Promise.all(
    flowRoots.map((root) => realpath(resolve(root)).catch(() => resolve(root))),
  );
  const actionWatchRoots = await Promise.all(
    actionRoots.map((root) =>
      realpath(resolve(root)).catch(() => resolve(root)),
    ),
  );
  const seen = new Set<string>();
  const watchRoots = [...flowWatchRoots, ...actionWatchRoots].filter((path) => {
    const key = process.platform === "win32" ? path.toLowerCase() : path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // DSH HMR matches path.relative() with picomatch's POSIX defaults. On Windows
  // the original globs miss backslashes and recursively watch dependencies/git.
  const ignored = [
    "**/node_modules",
    "**/.*",
    String.raw`**\\node_modules`,
    String.raw`**\\.*`,
  ];
  // A sibling root must not be watched as ../action: ignored dot directories
  // would otherwise suppress it. Different-drive roots stay absolute.
  let watchBase = dirname(watchRoots[0] ?? resolve(dshHome));
  for (const watchRoot of watchRoots.slice(1))
    while (
      relative(watchBase, watchRoot).startsWith("..") &&
      !isAbsolute(relative(watchBase, watchRoot))
    ) {
      const parent = dirname(watchBase);
      if (parent === watchBase) break;
      watchBase = parent;
    }
  // Coding tools stay mounted so a coding agent can read, edit and run code in
  // its project directory. Every other agent scope keeps them out through the
  // fail-closed `tools.restrict({ allow: [] })` allow-list each chat and Flow
  // session already applies, so re-admitting a tool here grants it only to a
  // scope that names it explicitly.
  const disabled = [
    "tool-jobs",
    "llm-retry",
    "command-goal",
    "tool-subagent-fork",
    "workflow-worker-thread",
    "tool-workflow",
    "tool-ralph",
    // Workspace instructions are mounted on the bound conversation Agent.
    // The host-wide DSH loader would also apply to Flow Agents.
    "agent-instructions",
    "session-title-llm",
  ];
  const profiles = customProfiles(await readAiServices(root));
  const modelPolicies = Object.entries(profiles).flatMap(
    ([provider, profile]) =>
      (profile.models ?? []).flatMap((model) =>
        typeof model.contextWindow === "number"
          ? [
              {
                provider,
                model: model.id,
                ...compactModelPolicy(model.contextWindow),
              },
            ]
          : [],
      ),
  );
  const patch =
    disabled.map((id) => `- id: ${id}\n  disabled: true\n`).join("\n") +
    `
- id: compaction-basic
  config:
    auto: false
    headroomTokens: 4096
    maxTokens: 2048
    compactionRetries: 0
    maxOverflowRetries: 0
    modelPolicies: ${JSON.stringify(modelPolicies)}
- id: subagent
  config:
    maxActiveSubagents: 2
    maxDepth: 1
- id: tool-subagent
  config:
    provider: spawn
    toolName: subagent
    agentPreset: coding-researcher
    allowedAgentPresets: [coding-researcher, coding-reviewer]
- id: web
  config:
    searchProvider: deepseek-search-api
    fetchProvider: deepseek-fetch-api
- id: web-deepseek-api
  config:
    apiKeyEnv: AURA_DEEPSEEK_WEB_KEY
    sendOriginalQuestion: false
- id: tool-web
  config:
    fetch: true
    searchMaxQueries: 1
- id: sdk-jsonrpc-server
  disabled: true
- id: hmr
  disabled: false
  config:
    base: ${JSON.stringify(pathToFileURL(watchBase).href)}
    root: ${JSON.stringify(watchRoots)}
    ignored: ${JSON.stringify(ignored)}
    debounce: 100
- id: sdk-app-startup
  config:
    profile: aura-flow
- id: settings
  config:
    path: !!js dshHomePath('aura-flow-settings.yaml')
# DSH 0.2's DeepSeek adapter speaks only the Messages protocol, while the demo
# model is a local OpenAI-compatible server. The demo keeps the
# \`deepseek-official\` route id, so stored Runs replay unchanged, but is served
# by pi-ai; the native adapters stay off to avoid a duplicate route.
- id: llm-deepseek
  disabled: true
- id: llm-deepseek-account
  disabled: true
- id: llm-pi-ai
  config:
    providers:
      openai-codex: ${JSON.stringify(await codexProviderProfile())}
      deepseek-official:
        displayName: Aura Demo
        api: openai-completions
        # A literal, not a !!js expression: settings updates re-validate this
        # route and expect a plain string.
        baseURL: ${JSON.stringify(demoURL ?? process.env.AURA_DEMO_BASE_URL ?? "http://127.0.0.1:1/v1")}
        apiKeyEnv: AURA_DEMO_KEY
        defaultMaxTokens: 4096
        defaultContextWindow: 32768
        models:
          - { id: deepseek-v4-flash, input: [text], reasoningEfforts: false }
          - { id: deepseek-v4-pro, input: [text], reasoningEfforts: false }
${Object.entries(profiles)
  .map(([id, profile]) => `      ${id}: ${JSON.stringify(profile)}`)
  .join("\n")}
- id: session-persistence-jsonl
  config:
    root: !!js dshHomePath('aura-flow-sessions')
    compression: none
- id: storage-json
  config:
    root: !!js dshHomePath('aura-flow-storages')
- insert:
    - id: aura-agent-team
      name: ${JSON.stringify(new URL("./coding/team-plugin.ts", import.meta.url).href)}
      config:
        maxMembers: 2
    - id: aura-host-diagnostics
      name: ${JSON.stringify(new URL("./diagnostics-plugin.ts", import.meta.url).href)}
    - id: aura-orchestration
      name: ${JSON.stringify(new URL("./plugin.ts", import.meta.url).href)}
    # Coding mode pauses for human decisions; this registers the
    # ask_user_question tool over the userQuestions seam, which Aura answers
    # through its own coding routes.
    - id: tool-ask-user
      name: '@deepseek-ai/dsh-tool-ask-user'
    # dsh-base leaves this to the shipped Web presets, which Aura excludes; a
    # coding agent declares its finished files through it.
    - id: tool-present
      name: '@deepseek-ai/dsh-tool-present'
      config:
        maxFiles: 8
    - id: workspace-registry
      name: '@deepseek-ai/dsh-workspace'
    - id: client-connection
      name: '@deepseek-ai/dsh-client-connection'
    - id: client-file-upload
      name: '@deepseek-ai/dsh-client-file-upload'
    - id: session-controller
      name: '@deepseek-ai/dsh-api-session-controller'
      config:
        nativeOpen: false
    - id: agent-preset-registry
      name: '@deepseek-ai/dsh-agent-preset-registry'
      config:
        default: researcher-v1
    # Durable reminders delivered as follow-ups into their coding session;
    # the coding allow-list admits the four schedule_* tools.
    - id: schedule
      name: '@deepseek-ai/dsh-schedule'
    - id: tool-schedule
      name: '@deepseek-ai/dsh-tool-schedule'
${await presetRows(fileURLToPath(new URL("../presets", import.meta.url)))}`;
  const options = { mode: 0o600, dirMode: 0o700 };
  await writeFileAtomic(
    join(dir, "package.json"),
    JSON.stringify({
      name: "aura-flow-profile",
      private: true,
      type: "module",
      dsh: {
        profile: {
          bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-sdk-app"],
          patchReload: "startup",
        },
      },
    }),
    options,
  );
  await writeFileAtomic(join(dir, "cordis.patch.yml"), patch, options);
}

/** Scale summary headroom for smaller user-configured context windows. */
export function compactModelPolicy(contextWindow: number) {
  const headroomTokens = Math.max(
    256,
    Math.min(4096, Math.floor(contextWindow * 0.05)),
  );
  return { headroomTokens, maxTokens: Math.min(2048, headroomTokens) };
}
