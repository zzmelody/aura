import type { Context } from "@deepseek-ai/cordis";
import type { ComponentType } from "react";

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
let current: NativeMask | undefined;
const listeners = new Set<() => void>();
export const secretMaskSnapshot = () => current;
export function subscribeSecretMask(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Narrow host for DSH's public UserText rule and renderer registration seams.
 * The published plugin owns all recognition, masking and reveal behavior.
 */
export function installSecretMask(
  ctx: Context,
  plugin: { apply(ctx: Context): unknown },
) {
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
    translate: (key) => dictionaries.zh?.[key] ?? key,
  };
  current = mask;
  for (const listener of listeners) listener();
  ctx.effect(() => () => {
    if (current === mask) current = undefined;
    for (const listener of listeners) listener();
  });
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
