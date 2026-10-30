import { join } from "node:path";
import type { FlowRun } from "@aura/protocol/types";
import { PluginDomainStorage } from "../packages/backend/orchestration/src/plugin-storage.ts";
import { GeneratedArtifacts } from "../packages/backend/orchestration/src/artifacts/generated.ts";

/** In-memory provider backend for loading bundled plugin providers in tests. */
export function memoryBackend(root: string) {
  const records = new Map<string, Map<string, unknown>>();
  const storage = new PluginDomainStorage(
    {
      open: async (spec: { name: string }) => ({
        table: (name: string) => {
          const key = `${spec.name}/${name}`;
          let table = records.get(key);
          if (!table) {
            table = new Map();
            records.set(key, table);
          }
          return {
            get: (id: string) => table!.get(id),
            entries: () => table!.entries(),
            put: async (id: string, value: unknown) => {
              table!.set(id, structuredClone(value));
            },
            delete: async (id: string) => table!.delete(id),
            update: async (id: string, change: (input: unknown) => unknown) => {
              const value = change(table!.get(id));
              table!.set(id, structuredClone(value));
              return value;
            },
          };
        },
        close: async () => {},
      }),
    } as unknown as ConstructorParameters<typeof PluginDomainStorage>[0],
    root,
  );
  const runs = new Map<string, FlowRun>();
  return {
    storage,
    artifacts: new GeneratedArtifacts(join(root, "artifacts")),
    cwd: root,
    workflows: {
      start: async (): Promise<FlowRun> => {
        throw new Error("Model execution is outside this fixture.");
      },
      get: (id: string) => {
        const run = runs.get(id);
        if (!run) throw new Error("missing");
        return run;
      },
      runs: { entries: () => runs.entries() },
    },
  };
}
