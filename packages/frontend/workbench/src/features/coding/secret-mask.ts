/// <reference types="vite/client" />
import { Context } from "@deepseek-ai/cordis";
import type { ComponentType } from "react";
import { language } from "@aura/i18n/runtime";
import { conversationText } from "../../conversation-messages.ts";

export const SECRET_MASK_MODULE = "@deepseek-ai/dsh-client-ui-secret-mask";
interface SecretNode {
  id: string;
  start: number;
  end: number;
  data: unknown;
}
interface SecretRule {
  match(
    text: string,
    from: number,
    context: { read(key: string): undefined },
  ): SecretNode | undefined;
}
interface SecretProps {
  node: SecretNode;
  raw: string;
  interactive: boolean;
  t(key: string): string;
}
interface NativeMask {
  rule: SecretRule;
  render: ComponentType<SecretProps>;
  translate(key: string): string;
}
export interface SecretMaskPlugin {
  apply(ctx: Context): unknown;
}

export interface SecretMaskState {
  phase: "idle" | "loading" | "ready" | "failed";
  mask?: NativeMask;
}

async function disposeScope(ctx?: Context) {
  try {
    await ctx?.fiber.dispose();
  } catch {
    // Scope retirement must not invalidate a working replacement or its retry state.
  }
}

/** App-lifetime ownership, independent of backend connections and page plugins. */
export class SecretMaskRuntime {
  private state: SecretMaskState = { phase: "idle" };
  private readonly listeners = new Set<() => void>();
  private readonly load: (signal: AbortSignal) => Promise<SecretMaskPlugin>;
  private readonly retryDelays: readonly number[];
  private root?: Context;
  private pending?: Promise<void>;
  private stop = new AbortController();

  constructor(
    load: (signal: AbortSignal) => Promise<SecretMaskPlugin>,
    retryDelays: readonly number[] = [500, 1500],
  ) {
    this.load = load;
    this.retryDelays = retryDelays;
  }

  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(state: SecretMaskState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  initialize = (refresh = false): Promise<void> => {
    if (this.pending) return this.pending;
    if (!refresh && this.state.phase !== "idle") return Promise.resolve();
    if (this.stop.signal.aborted) this.stop = new AbortController();
    const signal = this.stop.signal;
    this.pending = this.loadAndInstall(signal).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  };

  private async loadAndInstall(signal: AbortSignal) {
    const previous = this.state.mask;
    this.publish({ phase: "loading", ...(previous ? { mask: previous } : {}) });
    for (let attempt = 0; attempt <= this.retryDelays.length; attempt++) {
      let candidate: Context | undefined;
      try {
        signal.throwIfAborted();
        const plugin = await this.load(signal);
        signal.throwIfAborted();
        candidate = new Context();
        let mask: NativeMask | undefined;
        await candidate
          .plugin((ctx) => {
            mask = prepareSecretMask(ctx, plugin);
          })
          .await();
        signal.throwIfAborted();
        if (!mask) throw new Error("The secret mask did not initialize.");
        const previousRoot = this.root;
        this.root = candidate;
        candidate = undefined;
        this.publish({ phase: "ready", mask });
        // Retiring an old scope cannot invalidate the newly published instance.
        await disposeScope(previousRoot);
        return;
      } catch {
        await disposeScope(candidate);
        if (signal.aborted) return;
        if (attempt === this.retryDelays.length) {
          this.publish({
            phase: "failed",
            ...(previous ? { mask: previous } : {}),
          });
          return;
        }
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", finish);
            resolve();
          };
          const timer = setTimeout(finish, this.retryDelays[attempt]);
          signal.addEventListener("abort", finish, { once: true });
        });
      }
    }
  }

  /** Also supports isolated native-plugin fixtures and their owning scope. */
  install(ctx: Context, plugin: SecretMaskPlugin) {
    const mask = prepareSecretMask(ctx, plugin);
    this.publish({ phase: "ready", mask });
    ctx.effect(() => () => {
      if (this.state.mask === mask) this.publish({ phase: "idle" });
    });
  }

  async dispose() {
    this.stop.abort();
    await this.pending;
    await disposeScope(this.root);
    this.root = undefined;
    this.publish({ phase: "idle" });
  }
}

type SecretMaskLoader = (signal: AbortSignal) => Promise<SecretMaskPlugin>;
let loadClient: SecretMaskLoader | undefined;
const runtime = new SecretMaskRuntime(async (signal) => {
  if (!loadClient) throw new Error("The secret mask client is not configured.");
  return loadClient(signal);
});
export const secretMaskSnapshot = () => runtime.snapshot().mask;
export const secretMaskStateSnapshot = runtime.snapshot;
export const subscribeSecretMask = runtime.subscribe;
export function startSecretMask(load: SecretMaskLoader) {
  loadClient = load;
  return runtime.initialize();
}
export const retrySecretMask = () => runtime.initialize(true);
export const installSecretMask = (ctx: Context, plugin: SecretMaskPlugin) =>
  runtime.install(ctx, plugin);
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    void runtime.dispose();
  });

/** Narrow host for DSH's public UserText rule and renderer registration seams.
 * The published plugin owns all recognition, masking and reveal behavior.
 */
function prepareSecretMask(ctx: Context, plugin: SecretMaskPlugin): NativeMask {
  let rule: SecretRule | undefined;
  let render: ComponentType<SecretProps> | undefined;
  let dictionaries: Record<string, Record<string, string>> = {};
  const adapter = {
    effect: ctx.effect.bind(ctx),
    locale: {
      register(_namespace: string, values: typeof dictionaries) {
        dictionaries = values;
        return () => {};
      },
    },
    uiConversation: {
      userText: {
        register(value: SecretRule) {
          rule = value;
          return () => {};
        },
      },
    },
    slots: {
      inject(_slot: string, register: () => unknown) {
        return register();
      },
      register(_options: unknown, component: ComponentType<SecretProps>) {
        render = component;
        return () => {};
      },
    },
  };
  // The browser plugin only consumes these three registration seams. Do not
  // expose Aura's page registry or pretend to host a DSH Session Controller.
  plugin.apply(adapter as unknown as Context);
  if (!rule || !render) throw new Error("DSH 密钥遮罩插件未完成注册。");
  const mask: NativeMask = {
    rule,
    render,
    translate: (key) => {
      if (key === "secret.reveal") return conversationText("showSecret");
      if (key === "secret.hide") return conversationText("hideSecret");
      const locale = language.getSnapshot().locale;
      return (
        dictionaries[locale === "zh-CN" ? "zh" : locale]?.[key] ??
        dictionaries.en?.[key] ??
        key
      );
    },
  };
  return mask;
}

/** Segment one native rule's matches; UTF-16 offsets and original text are preserved. */
export function secretSegments(
  text: string,
  rule: SecretRule,
): Array<{ text: string; node?: SecretNode }> {
  const segments: Array<{ text: string; node?: SecretNode }> = [];
  let offset = 0;
  while (offset < text.length) {
    const node = rule.match(text, offset, { read: () => undefined });
    if (!node) {
      segments.push({ text: text.slice(offset) });
      break;
    }
    if (node.start < offset || node.end <= node.start || node.end > text.length)
      throw new Error("DSH 文本节点范围无效。");
    if (node.start > offset)
      segments.push({ text: text.slice(offset, node.start) });
    segments.push({ text: text.slice(node.start, node.end), node });
    offset = node.end;
  }
  return segments;
}
