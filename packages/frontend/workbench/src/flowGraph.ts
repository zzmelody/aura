import { parse, type Node } from "acorn";

type AstNode = Node & Record<string, unknown>;

export type FlowGraphNode = {
  id: string;
  kind: "input" | "agent" | "tool" | "condition" | "loop" | "output";
  label: string;
  subtitle: string;
  preset?: string;
  prompt?: string;
  binding?: string;
  line?: number;
  parallel?: boolean;
  control?: string;
};

export type FlowGraphEdge = {
  id: string;
  source: string;
  target: string;
  label?: string;
  back?: boolean;
};

export type FlowGraph = {
  title: string;
  description: string;
  inputFields: string[];
  outputFields: string[];
  concurrency?: number;
  nodes: FlowGraphNode[];
  edges: FlowGraphEdge[];
  warnings: string[];
  error?: string;
};

const isNode = (value: unknown): value is AstNode =>
  Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as { type?: unknown }).type === "string" &&
    typeof (value as { start?: unknown }).start === "number" &&
    typeof (value as { end?: unknown }).end === "number",
  );

function walk(
  node: AstNode,
  visit: (node: AstNode, ancestors: AstNode[]) => void,
  ancestors: AstNode[] = [],
) {
  visit(node, ancestors);
  const next = [...ancestors, node];
  for (const [key, value] of Object.entries(node)) {
    if (["start", "end", "loc", "range"].includes(key)) continue;
    if (isNode(value)) walk(value, visit, next);
    else if (Array.isArray(value))
      for (const item of value) if (isNode(item)) walk(item, visit, next);
  }
}

function identifier(node: AstNode | undefined): string | undefined {
  return node?.type === "Identifier" && typeof node.name === "string"
    ? node.name
    : undefined;
}

function propertyName(node: AstNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "Identifier" && typeof node.name === "string")
    return node.name;
  if (node.type === "Literal" && typeof node.value === "string")
    return node.value;
  return undefined;
}

function objectProperty(object: AstNode | undefined, name: string) {
  if (object?.type !== "ObjectExpression" || !Array.isArray(object.properties))
    return undefined;
  for (const candidate of object.properties) {
    if (!isNode(candidate) || candidate.type !== "Property") continue;
    if (
      propertyName(candidate.key as AstNode) === name &&
      isNode(candidate.value)
    )
      return candidate.value;
  }
  return undefined;
}

function literal(node: AstNode | undefined): string | number | undefined {
  if (
    node?.type === "Literal" &&
    (typeof node.value === "string" || typeof node.value === "number")
  )
    return node.value;
  if (
    node?.type === "TemplateLiteral" &&
    Array.isArray(node.expressions) &&
    node.expressions.length === 0 &&
    Array.isArray(node.quasis)
  ) {
    const quasi = node.quasis[0] as
      { value?: { cooked?: unknown } } | undefined;
    return typeof quasi?.value?.cooked === "string"
      ? quasi.value.cooked
      : undefined;
  }
  return undefined;
}

function callName(node: AstNode | undefined) {
  if (node?.type !== "CallExpression" || !isNode(node.callee)) return undefined;
  if (node.callee.type === "Identifier") return identifier(node.callee);
  if (node.callee.type !== "MemberExpression" || !isNode(node.callee.property))
    return undefined;
  return propertyName(node.callee.property);
}

function sourceText(source: string, node: AstNode | undefined, limit = 180) {
  if (!node) return undefined;
  const value = source.slice(node.start, node.end).replace(/\s+/g, " ").trim();
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function schemaFields(object: AstNode | undefined) {
  if (object?.type !== "CallExpression" || callName(object) !== "object")
    return [];
  const argument = Array.isArray(object.arguments)
    ? object.arguments[0]
    : undefined;
  if (!isNode(argument) || argument.type !== "ObjectExpression") return [];
  return (argument.properties as unknown[])
    .filter(isNode)
    .filter((property) => property.type === "Property")
    .map((property) => propertyName(property.key as AstNode))
    .filter((name): name is string => Boolean(name));
}

function isAgentCall(node: AstNode) {
  if (node.type !== "CallExpression" || !isNode(node.callee)) return false;
  if (
    node.callee.type === "Identifier" &&
    ["agent", "callAgent", "invokeAgent"].includes(
      identifier(node.callee) ?? "",
    )
  )
    return true;
  if (node.callee.type !== "MemberExpression") return false;
  return (
    isNode(node.callee.object) &&
    identifier(node.callee.object) === "ctx" &&
    isNode(node.callee.property) &&
    propertyName(node.callee.property) === "agent"
  );
}

function toolName(node: AstNode) {
  if (node.type !== "CallExpression" || !isNode(node.callee)) return undefined;
  const directName = callName(node);
  const contextCall =
    node.callee.type === "MemberExpression" &&
    isNode(node.callee.object) &&
    identifier(node.callee.object) === "ctx";
  const directCall = node.callee.type === "Identifier";
  if (
    (contextCall || directCall) &&
    [
      "action",
      "callAction",
      "invokeAction",
      "tool",
      "invokeTool",
      "callTool",
      "useTool",
    ].includes(directName ?? "")
  ) {
    const first =
      Array.isArray(node.arguments) && isNode(node.arguments[0])
        ? node.arguments[0]
        : undefined;
    const configured =
      literal(objectProperty(first, "action")) ??
      literal(objectProperty(first, "name")) ??
      literal(objectProperty(first, "tool")) ??
      literal(objectProperty(first, "id")) ??
      literal(first);
    return typeof configured === "string" ? configured : "工具调用";
  }
  if (node.callee.type !== "MemberExpression") return undefined;
  const object = node.callee.object;
  const property = isNode(node.callee.property)
    ? propertyName(node.callee.property)
    : undefined;
  if (!property || !isNode(object)) return undefined;
  if (identifier(object) === "tools") return property;
  if (
    object.type === "MemberExpression" &&
    isNode(object.object) &&
    isNode(object.property) &&
    identifier(object.object) === "ctx" &&
    propertyName(object.property) === "tools"
  )
    return property;
  return undefined;
}

function isToolCall(node: AstNode) {
  return Boolean(toolName(node));
}

function isPromiseAll(node: AstNode) {
  if (node.type !== "CallExpression" || !isNode(node.callee)) return false;
  const callee = node.callee;
  return (
    callee.type === "MemberExpression" &&
    isNode(callee.object) &&
    identifier(callee.object) === "Promise" &&
    isNode(callee.property) &&
    propertyName(callee.property) === "all"
  );
}

function bindingFor(call: AstNode, ancestors: AstNode[]) {
  let declaration: AstNode | undefined;
  for (let index = ancestors.length - 1; index >= 0; index--) {
    if (ancestors[index].type === "VariableDeclarator") {
      declaration = ancestors[index];
      break;
    }
  }
  if (!declaration || !isNode(declaration.id)) return undefined;
  const direct = identifier(declaration.id);
  if (direct) return direct;
  if (
    declaration.id.type !== "ArrayPattern" ||
    !Array.isArray(declaration.id.elements)
  )
    return undefined;
  const promise = ancestors.find(isPromiseAll);
  const array =
    promise && Array.isArray(promise.arguments)
      ? promise.arguments[0]
      : undefined;
  if (
    !isNode(array) ||
    array.type !== "ArrayExpression" ||
    !Array.isArray(array.elements)
  )
    return undefined;
  const index = array.elements.findIndex((element) => element === call);
  const element = declaration.id.elements[index];
  return isNode(element) ? identifier(element) : undefined;
}

type FlowSource = { id: string; label?: string };

function childNodes(node: AstNode) {
  const result: AstNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (["start", "end", "loc", "range"].includes(key)) continue;
    if (isNode(value)) result.push(value);
    else if (Array.isArray(value))
      for (const item of value) if (isNode(item)) result.push(item);
  }
  return result;
}

function visibleCalls(root: AstNode) {
  const calls: { call: AstNode; ancestors: AstNode[] }[] = [];
  const visit = (node: AstNode, ancestors: AstNode[], rootNode: boolean) => {
    if (
      !rootNode &&
      [
        "FunctionDeclaration",
        "FunctionExpression",
        "ArrowFunctionExpression",
      ].includes(node.type)
    )
      return;
    const next = [...ancestors, node];
    for (const child of childNodes(node)) visit(child, next, false);
    if (isAgentCall(node) || isToolCall(node))
      calls.push({ call: node, ancestors });
  };
  visit(root, [], true);
  return calls;
}

function statements(node: AstNode | undefined) {
  if (!node) return [];
  if (node.type === "BlockStatement" && Array.isArray(node.body))
    return node.body.filter(isNode);
  return [node];
}

type IteratorCall = {
  callback: AstNode;
  collection: AstNode;
  method: string;
  parallel: boolean;
};

function iteratorCall(root: AstNode): IteratorCall | undefined {
  let found: IteratorCall | undefined;
  const visit = (node: AstNode, ancestors: AstNode[], rootNode: boolean) => {
    if (found) return;
    if (
      !rootNode &&
      [
        "FunctionDeclaration",
        "FunctionExpression",
        "ArrowFunctionExpression",
      ].includes(node.type)
    )
      return;
    if (
      node.type === "CallExpression" &&
      isNode(node.callee) &&
      node.callee.type === "MemberExpression" &&
      isNode(node.callee.object) &&
      isNode(node.callee.property) &&
      ["map", "flatMap", "forEach"].includes(
        propertyName(node.callee.property) ?? "",
      )
    ) {
      const callback = Array.isArray(node.arguments)
        ? node.arguments.find(
            (argument) =>
              isNode(argument) &&
              ["FunctionExpression", "ArrowFunctionExpression"].includes(
                argument.type,
              ),
          )
        : undefined;
      if (isNode(callback)) {
        found = {
          callback,
          collection: node.callee.object,
          method: propertyName(node.callee.property) ?? "map",
          parallel: ancestors.some(isPromiseAll),
        };
        return;
      }
    }
    const next = [...ancestors, node];
    for (const child of childNodes(node)) visit(child, next, false);
  };
  visit(root, [], true);
  return found;
}

/**
 * Builds a presentation graph from Aura Flow source without evaluating it. Only
 * orchestration primitives are visible: input, output, agents, tools, branches,
 * and loops. Other JavaScript statements only preserve execution order.
 */
export function buildFlowGraph(source: string): FlowGraph {
  const empty: FlowGraph = {
    title: "未命名 Flow",
    description: "",
    inputFields: [],
    outputFields: [],
    nodes: [],
    edges: [],
    warnings: [],
  };
  let program: AstNode;
  try {
    program = parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      locations: true,
    }) as unknown as AstNode;
  } catch (cause) {
    return {
      ...empty,
      error: cause instanceof Error ? cause.message : "代码语法无法解析。",
    };
  }

  let definition: AstNode | undefined;
  walk(program, (node) => {
    if (
      !definition &&
      node.type === "CallExpression" &&
      callName(node) === "defineFlow" &&
      Array.isArray(node.arguments) &&
      isNode(node.arguments[0])
    )
      definition = node.arguments[0];
  });
  if (definition?.type !== "ObjectExpression")
    return { ...empty, error: "没有找到 defineFlow({ ... }) 定义。" };

  const title = literal(objectProperty(definition, "title"));
  const description = literal(objectProperty(definition, "description"));
  const concurrency = literal(objectProperty(definition, "concurrency"));
  const run = objectProperty(definition, "run");
  const inputFields = schemaFields(objectProperty(definition, "input"));
  const outputFields = schemaFields(objectProperty(definition, "output"));
  const graph: FlowGraph = {
    ...empty,
    title: typeof title === "string" ? title : empty.title,
    description: typeof description === "string" ? description : "",
    concurrency: typeof concurrency === "number" ? concurrency : undefined,
    inputFields,
    outputFields,
  };
  if (!run || !isNode(run.body))
    return { ...graph, error: "Flow 中没有可读取的 run()。" };

  const usedIds = new Set<string>();
  const uniqueId = (base: string) => {
    let id = base;
    let suffix = 2;
    while (usedIds.has(id)) id = `${base}-${suffix++}`;
    usedIds.add(id);
    return id;
  };

  const input: FlowGraphNode = {
    id: "$input",
    kind: "input",
    label: "Flow 输入",
    subtitle: inputFields.length ? inputFields.join(" · ") : "无输入参数",
  };
  const output: FlowGraphNode = {
    id: "$output",
    kind: "output",
    label: "Flow 输出",
    subtitle: outputFields.length ? outputFields.join(" · ") : "结构化结果",
  };
  graph.nodes = [input];

  const edges = new Map<string, FlowGraphEdge>();
  const addEdge = (
    sourceId: string,
    targetId: string,
    label?: string,
    back = false,
  ) => {
    const id = `${sourceId}->${targetId}:${label ?? ""}`;
    if ((sourceId !== targetId || back) && !edges.has(id))
      edges.set(id, { id, source: sourceId, target: targetId, label, back });
  };

  let generatedAgent = 0;
  let generatedTool = 0;
  const connect = (incoming: FlowSource[], target: string) => {
    for (const sourceNode of incoming)
      addEdge(sourceNode.id, target, sourceNode.label);
  };

  const makeCallNode = (call: AstNode, ancestors: AstNode[]): FlowGraphNode => {
    const config =
      Array.isArray(call.arguments) && isNode(call.arguments[0])
        ? call.arguments[0]
        : undefined;
    const binding = bindingFor(call, ancestors);
    if (isAgentCall(call)) {
      generatedAgent++;
      const staticId = literal(objectProperty(config, "id"));
      const label = literal(objectProperty(config, "label"));
      const preset = literal(objectProperty(config, "preset"));
      const base =
        (typeof staticId === "string" && staticId) ||
        binding ||
        `agent-${generatedAgent}`;
      if (typeof staticId !== "string")
        graph.warnings.push(`第 ${generatedAgent} 个 Agent 使用动态 ID。`);
      return {
        id: uniqueId(base),
        kind: "agent",
        label: typeof label === "string" ? label : base,
        subtitle: typeof preset === "string" ? preset : "Agent",
        preset: typeof preset === "string" ? preset : undefined,
        prompt: sourceText(source, objectProperty(config, "prompt")),
        binding,
        line: call.loc?.start.line,
        parallel: ancestors.some(isPromiseAll),
      };
    }
    generatedTool++;
    const name = toolName(call) ?? `tool-${generatedTool}`;
    const label = literal(objectProperty(config, "label"));
    const details =
      objectProperty(config, "input") ??
      objectProperty(config, "args") ??
      (Array.isArray(call.arguments) && isNode(call.arguments[1])
        ? call.arguments[1]
        : undefined);
    return {
      id: uniqueId(`tool-${name}`),
      kind: "tool",
      label: typeof label === "string" ? label : name,
      subtitle: "工具调用",
      prompt: sourceText(source, details),
      binding,
      line: call.loc?.start.line,
      parallel: ancestors.some(isPromiseAll),
    };
  };

  const processCalls = (
    node: AstNode,
    incoming: FlowSource[],
    forceParallel = false,
  ) => {
    const calls = visibleCalls(node);
    if (!calls.length) return incoming;
    const groups = new Map<number, typeof calls>();
    for (const item of calls) {
      const promise = item.ancestors.find(isPromiseAll);
      const phase = promise?.start ?? item.call.start;
      groups.set(phase, [...(groups.get(phase) ?? []), item]);
    }
    let exits = incoming;
    for (const group of [...groups.values()]) {
      const nodes = group.map(({ call, ancestors }) =>
        makeCallNode(call, ancestors),
      );
      if (forceParallel)
        for (const visibleNode of nodes) visibleNode.parallel = true;
      graph.nodes.push(...nodes);
      for (const node of nodes) connect(exits, node.id);
      exits = nodes.map(({ id }) => ({ id }));
    }
    return exits;
  };

  let outputConnected = false;
  function processIterator(
    iterator: IteratorCall,
    statement: AstNode,
    incoming: FlowSource[],
  ): FlowSource[] {
    const expression = `${sourceText(source, iterator.collection, 64) ?? "集合"}.${iterator.method}(…)`;
    const loop: FlowGraphNode = {
      id: uniqueId(`loop-${statement.loc?.start.line ?? statement.start}`),
      kind: "loop",
      label: "遍历",
      subtitle: expression,
      prompt: expression,
      line: statement.loc?.start.line,
    };
    graph.nodes.push(loop);
    connect(incoming, loop.id);
    const firstBodyNode = graph.nodes.length;
    const body = isNode(iterator.callback.body)
      ? iterator.callback.body.type === "BlockStatement"
        ? processStatement(
            iterator.callback.body,
            [{ id: loop.id, label: "迭代" }],
            false,
          )
        : processCalls(
            iterator.callback.body,
            [{ id: loop.id, label: "迭代" }],
            iterator.parallel,
          )
      : [];
    if (iterator.parallel)
      for (const visibleNode of graph.nodes.slice(firstBodyNode))
        if (visibleNode.kind === "agent" || visibleNode.kind === "tool")
          visibleNode.parallel = true;
    for (const exit of body) addEdge(exit.id, loop.id, "继续", true);
    return [{ id: loop.id, label: "完成" }];
  }

  function processStatement(
    statement: AstNode,
    incoming: FlowSource[],
    flowReturn = true,
  ): FlowSource[] {
    if (statement.type === "BlockStatement")
      return processBlock(statements(statement), incoming, flowReturn);

    if (statement.type === "IfStatement" && isNode(statement.test)) {
      const condition: FlowGraphNode = {
        id: uniqueId(
          `condition-${statement.loc?.start.line ?? statement.start}`,
        ),
        kind: "condition",
        label: "条件判断",
        subtitle: sourceText(source, statement.test, 86) ?? "if",
        prompt: sourceText(source, statement.test),
        line: statement.loc?.start.line,
      };
      graph.nodes.push(condition);
      connect(incoming, condition.id);
      const yes = isNode(statement.consequent)
        ? processStatement(
            statement.consequent,
            [{ id: condition.id, label: "是" }],
            flowReturn,
          )
        : [{ id: condition.id, label: "是" }];
      const no = isNode(statement.alternate)
        ? processStatement(
            statement.alternate,
            [{ id: condition.id, label: "否" }],
            flowReturn,
          )
        : [{ id: condition.id, label: "否" }];
      return [...yes, ...no];
    }

    if (
      statement.type === "SwitchStatement" &&
      isNode(statement.discriminant)
    ) {
      const condition: FlowGraphNode = {
        id: uniqueId(
          `condition-${statement.loc?.start.line ?? statement.start}`,
        ),
        kind: "condition",
        label: "分支判断",
        subtitle: sourceText(source, statement.discriminant, 86) ?? "switch",
        prompt: sourceText(source, statement.discriminant),
        line: statement.loc?.start.line,
      };
      graph.nodes.push(condition);
      connect(incoming, condition.id);
      const exits: FlowSource[] = [];
      if (Array.isArray(statement.cases)) {
        for (const caseNode of statement.cases.filter(isNode)) {
          const test = isNode(caseNode.test)
            ? sourceText(source, caseNode.test, 40)
            : "默认";
          exits.push(
            ...processBlock(
              Array.isArray(caseNode.consequent)
                ? caseNode.consequent.filter(isNode)
                : [],
              [{ id: condition.id, label: test }],
              flowReturn,
            ),
          );
        }
      }
      return exits.length ? exits : [{ id: condition.id }];
    }

    if (
      [
        "ForStatement",
        "ForOfStatement",
        "ForInStatement",
        "WhileStatement",
        "DoWhileStatement",
      ].includes(statement.type)
    ) {
      const expression =
        (isNode(statement.test) && statement.test) ||
        (isNode(statement.right) && statement.right) ||
        statement;
      const loop: FlowGraphNode = {
        id: uniqueId(`loop-${statement.loc?.start.line ?? statement.start}`),
        kind: "loop",
        label: "循环",
        subtitle: sourceText(source, expression, 86) ?? "运行时迭代",
        prompt: sourceText(source, expression),
        line: statement.loc?.start.line,
      };
      graph.nodes.push(loop);
      connect(incoming, loop.id);
      const body = isNode(statement.body)
        ? processStatement(
            statement.body,
            [{ id: loop.id, label: "迭代" }],
            flowReturn,
          )
        : [];
      for (const exit of body) addEdge(exit.id, loop.id, "继续", true);
      return [{ id: loop.id, label: "完成" }];
    }

    if (statement.type === "ReturnStatement") {
      let exits = incoming;
      if (isNode(statement.argument)) {
        const iterator = iteratorCall(statement.argument);
        exits = iterator
          ? processIterator(iterator, statement, exits)
          : processCalls(statement.argument, exits);
      }
      if (!flowReturn) return exits;
      for (const exit of exits) addEdge(exit.id, output.id, exit.label);
      outputConnected = true;
      return [];
    }

    if (statement.type === "TryStatement" && isNode(statement.block)) {
      const normal = processStatement(statement.block, incoming, flowReturn);
      const handler =
        isNode(statement.handler) && isNode(statement.handler.body)
          ? processStatement(statement.handler.body, incoming, flowReturn)
          : [];
      const combined = [...normal, ...handler];
      return isNode(statement.finalizer)
        ? processStatement(statement.finalizer, combined, flowReturn)
        : combined;
    }

    const iterator = iteratorCall(statement);
    if (iterator) return processIterator(iterator, statement, incoming);

    if (
      ["FunctionDeclaration", "ClassDeclaration", "EmptyStatement"].includes(
        statement.type,
      )
    )
      return incoming;
    return processCalls(statement, incoming);
  }

  function processBlock(
    block: AstNode[],
    incoming: FlowSource[],
    flowReturn = true,
  ) {
    let exits = incoming;
    for (const statement of block) {
      if (!exits.length) break;
      exits = processStatement(statement, exits, flowReturn);
    }
    return exits;
  }

  const exits = processBlock(statements(run.body), [{ id: input.id }]);
  graph.nodes.push(output);
  if (!outputConnected)
    for (const exit of exits.length ? exits : [{ id: input.id }])
      addEdge(exit.id, output.id, exit.label);
  graph.edges = [...edges.values()];
  graph.warnings = [...new Set(graph.warnings)];
  return graph;
}

export type FlowGraphLayoutNode = FlowGraphNode & {
  x: number;
  y: number;
  level: number;
};

export function layoutFlowGraph(graph: FlowGraph) {
  const incoming = new Map(
    graph.nodes.map((node) => [node.id, [] as string[]]),
  );
  for (const edge of graph.edges)
    if (!edge.back) incoming.get(edge.target)?.push(edge.source);
  const levels = new Map<string, number>([["$input", 0]]);
  for (let pass = 0; pass < graph.nodes.length; pass++) {
    for (const node of graph.nodes) {
      if (node.id === "$input") continue;
      const parents = incoming.get(node.id) ?? [];
      const known = parents
        .map((id) => levels.get(id))
        .filter((level): level is number => level !== undefined);
      if (known.length) levels.set(node.id, Math.max(...known) + 1);
    }
  }
  const maxFlowLevel = Math.max(
    0,
    ...graph.nodes
      .filter((node) => node.kind !== "input" && node.kind !== "output")
      .map((node) => levels.get(node.id) ?? 1),
  );
  levels.set("$output", maxFlowLevel + 1);
  const columns = new Map<number, FlowGraphNode[]>();
  for (const node of graph.nodes) {
    const level = levels.get(node.id) ?? 1;
    columns.set(level, [...(columns.get(level) ?? []), node]);
  }
  const maxRows = Math.max(
    1,
    ...[...columns.values()].map((nodes) => nodes.length),
  );
  const height = Math.max(390, maxRows * 126 + 116);
  const width = Math.max(760, (Math.max(...columns.keys()) + 1) * 232 + 88);
  const nodes: FlowGraphLayoutNode[] = [];
  for (const [level, column] of columns) {
    const blockHeight = (column.length - 1) * 126;
    const startY = (height - blockHeight) / 2 - 43;
    column.forEach((node, index) =>
      nodes.push({
        ...node,
        level,
        x: 44 + level * 232,
        y: startY + index * 126,
      }),
    );
  }
  return { width, height, nodes };
}
