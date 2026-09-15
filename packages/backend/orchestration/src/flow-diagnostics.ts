import { parse, type Node } from "acorn";
import { FlowError } from "./schema.ts";
type Ast = Node & Record<string, unknown>;
const node = (value: unknown): value is Ast =>
  Boolean(value && typeof value === "object" && "type" in value);
const name = (value: unknown) =>
  node(value) && value.type === "Identifier" ? value.name : undefined;
function children(root: Ast): Ast[] {
  return Object.entries(root)
    .filter(([key]) => !["loc", "start", "end"].includes(key))
    .flatMap(([, value]) =>
      Array.isArray(value) ? value.filter(node) : node(value) ? [value] : [],
    );
}
/** Early diagnostics only; runtime scopes enforce the actual capability boundary. */
export function validateFlowSource(code: string) {
  const ast = parse(code, {
    ecmaVersion: "latest",
    sourceType: "module",
    locations: true,
  }) as unknown as Ast;
  function inspect(root: Ast, context?: string, shadowed = false) {
    if (
      root.type === "Property" &&
      name(root.key) === "run" &&
      node(root.value)
    ) {
      const params = root.value.params;
      const id = Array.isArray(params) ? name(params[0]) : undefined;
      if (typeof id === "string" && node(root.value.body))
        inspect(root.value.body, id);
      return;
    }
    if (
      context &&
      [
        "FunctionExpression",
        "ArrowFunctionExpression",
        "FunctionDeclaration",
      ].includes(root.type) &&
      Array.isArray(root.params)
    )
      shadowed ||= root.params.some((param) => name(param) === context);
    if (
      context &&
      root.type === "CallExpression" &&
      node(root.callee) &&
      root.callee.type === "MemberExpression"
    ) {
      const object = name(root.callee.object);
      const property = name(root.callee.property);
      if (
        object === "Promise" &&
        ["all", "allSettled", "race", "any"].includes(String(property))
      )
        throw new FlowError(
          `第 ${root.loc?.start.line} 行：Flow 并发请使用 scope.parallel，旧 Promise.${property} 写法已停用。`,
        );
      if (
        !shadowed &&
        object === context &&
        ["agent", "action", "memo", "checkpoint", "parallel"].includes(
          String(property),
        )
      )
        throw new FlowError(
          `第 ${root.loc?.start.line} 行：根 ${context} 只提供 sequence，请在回调作用域内调用 ${property}。`,
        );
    }
    for (const child of children(root)) inspect(child, context, shadowed);
  }
  inspect(ast);
}
