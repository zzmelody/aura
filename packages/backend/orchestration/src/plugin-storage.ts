import type { Context } from "@deepseek-ai/cordis";
import type { DomainSpec, Domain } from "@deepseek-ai/dsh-storage-domain";
import { join } from "node:path";
import type { PluginCompatibility } from "@aura/protocol/types";
import type { PluginStorage } from "./backend-api.ts";

/** Domain leases survive provider replacements without reopening or rewriting data. */
export class PluginDomainStorage {
  private readonly domains = new Map<
    string,
    {
      owner: string;
      domain: Domain<DomainSpec>;
      refs: number;
      signature: string;
    }
  >();
  private readonly facility: Context["storageDomain"];
  private readonly home: string;
  private pending: Promise<unknown> = Promise.resolve();
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.pending.then(operation);
    this.pending = task.catch(() => undefined);
    return task;
  }
  constructor(facility: Context["storageDomain"], home: string) {
    this.facility = facility;
    this.home = home;
  }
  forPlugin(id: string, grants: PluginCompatibility = {}): PluginStorage {
    const namespace = `plugin_${Buffer.from(id).toString("hex")}_`;
    return Object.freeze({
      namespace,
      open: (spec: DomainSpec) =>
        this.serial(async () => {
          if (
            !spec.name.startsWith(namespace) &&
            !grants.storageDomains?.includes(spec.name)
          )
            throw new Error("plugin_storage_forbidden");
          let lease = this.domains.get(spec.name);
          const signature = JSON.stringify([
            spec.version,
            spec.layout,
            Object.keys(spec.tables ?? {}).sort(),
          ]);
          if (lease && lease.owner !== id)
            throw new Error("plugin_storage_conflict");
          if (lease && lease.signature !== signature)
            throw new Error("plugin_storage_revision_conflict");
          if (!lease) {
            lease = {
              owner: id,
              domain: await this.facility.open(spec),
              refs: 0,
              signature,
            };
            this.domains.set(spec.name, lease);
          }
          lease.refs++;
          let closed = false;
          return {
            table: (name: string) => lease!.domain.table(name),
            close: () =>
              this.serial(async () => {
                if (closed) return;
                closed = true;
                if (--lease!.refs === 0) {
                  this.domains.delete(spec.name);
                  await lease!.domain.close();
                }
              }),
          };
        }),
      directory: (name: string) => {
        if (
          !grants.directories?.includes(name) ||
          !/^[a-z][a-z0-9_-]*$/u.test(name)
        )
          throw new Error("plugin_storage_forbidden");
        return join(this.home, name);
      },
    });
  }
}
