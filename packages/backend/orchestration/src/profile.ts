import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";

const require = createRequire(import.meta.url);
export const dshBin = join(
  dirname(require.resolve("@deepseek-ai/dsh/package.json")),
  "lib",
  "bin.js",
);
export const defaultFlowRoot = fileURLToPath(
  new URL("../flow", import.meta.url),
);

export async function provisionProfile(
  dshHome: string,
  flowRoot = defaultFlowRoot,
) {
  const dir = join(dshHome, "profiles", "aura-flow");
  const disabled = [
    "tool-bash",
    "tool-pwsh",
    "tool-jobs",
    "tool-fs",
    "tool-fs-search",
    "tool-str-replace-editor",
    "skill-filesystem",
    "tool-skill",
    "command-goal",
    "tool-goal",
    "plan-mode",
    "compaction-basic",
    "command-compact",
    "tool-result-pruner",
    "tool-subagent-control",
    "tool-subagent-list-agents",
    "tool-subagent",
    "tool-subagent-fork",
    "workflow-worker-thread",
    "tool-workflow",
    "tool-ralph",
    "agent-instructions",
    "tool-todo",
    "tool-web",
    "session-title-llm",
  ];
  const patch =
    disabled.map((id) => `- id: ${id}\n  disabled: true\n`).join("\n") +
    `
- id: sdk-jsonrpc-server
  disabled: true
- id: hmr
  disabled: false
  config:
    base: ${JSON.stringify(pathToFileURL(flowRoot).href)}
    root: ['.']
    ignored: ['**/node_modules', '**/.*']
    debounce: 100
- id: sdk-app-startup
  config:
    profile: aura-flow
- id: settings
  config:
    path: !!js dshHomePath('aura-flow-settings.yaml')
- id: llm-deepseek
  config:
    apiKeyEnv: AURA_DEMO_KEY
    baseURL: !!js process.env.AURA_DEMO_BASE_URL
    thinking: disabled
    maxTokens: 4096
- id: llm-pi-ai
  config:
    providers:
      openai-codex:
        reasoning: medium
        transport: sse
        cacheRetention: short
- id: session-persistence-jsonl
  config:
    root: !!js dshHomePath('aura-flow-sessions')
    compression: none
- id: storage-json
  config:
    root: !!js dshHomePath('aura-flow-storages')
- insert:
    - id: aura-orchestration
      name: ${JSON.stringify(new URL("./plugin.ts", import.meta.url).href)}
    - id: workspace-registry
      name: '@deepseek-ai/dsh-workspace'
    - id: session-controller
      name: '@deepseek-ai/dsh-api-session-controller'
      config:
        nativeOpen: false
    - id: agent-presets
      name: '@deepseek-ai/dsh-agent-presets'
      config:
        default: researcher-v1
        includeShippedRoot: false
        includeUserRoot: true
        roots:
          - path: ${JSON.stringify(fileURLToPath(new URL("../presets", import.meta.url)))}
            trust: system
`;
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
