import { timingSafeEqual } from "node:crypto";
import type {
  FlowCatalog,
  FlowRun,
  FlowStep,
  JsonValue,
} from "@aura/protocol/types";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { isRecord } from "./validation.ts";

/** The orchestration port this app needs; satisfied by OrchestrationHost. */
export interface ServiceFlowPort {
  request<T = unknown>(
    method: string,
    params?: object,
    signal?: AbortSignal,
  ): Promise<T>;
}

/** Where a waiting Run tree needs an answer: the deepest pending checkpoint. */
export interface ServiceCheckpoint {
  runId: string;
  stepKey: string;
  prompt: string;
  schema: JsonValue;
}

export interface ServiceRunView {
  runId: string;
  requestId: string;
  flowId: string;
  status: FlowRun["status"];
  report?: JsonValue;
  output?: JsonValue;
  error?: { code: string };
  checkpoint?: ServiceCheckpoint;
  /** Bounded projection from the plugin provider that serves this Flow. */
  view?: JsonValue;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const isUuid = (value: unknown): value is string =>
  typeof value === "string" && uuidPattern.test(value);

class InvalidRequest extends Error {}

/** Accepts exactly `keys` (each validated) and nothing else. */
function exact<T>(
  source: unknown,
  keys: Record<keyof T & string, (value: unknown) => boolean>,
): T {
  if (!isRecord(source)) throw new InvalidRequest();
  const names = Object.keys(keys);
  if (Object.keys(source).some((key) => !names.includes(key)))
    throw new InvalidRequest();
  for (const name of names)
    if (!keys[name as keyof T & string](source[name]))
      throw new InvalidRequest();
  return source as T;
}

const json = (value: unknown) =>
  value !== undefined &&
  (() => {
    try {
      JSON.stringify(value);
      return true;
    } catch {
      return false;
    }
  })();
const text = (max: number) => (value: unknown) =>
  typeof value === "string" && value.length > 0 && value.length <= max;

/** A bounded, path-free failure code. Plugins put an ActionFailure code first in their message. */
export function failureCode(
  run: Pick<FlowRun, "status" | "error">,
): string | undefined {
  if (run.status === "interrupted") return "interrupted";
  if (run.status !== "failed") return undefined;
  const code = /(?:^|:\s*)([a-z][a-z0-9_]{2,63})(?=$|[\s:.,;])/u.exec(
    run.error ?? "",
  )?.[1];
  return code ?? "failed";
}

function waitingCheckpoint(steps: readonly FlowStep[]) {
  return steps.find(
    (step) => step.kind === "checkpoint" && step.status === "waiting_input",
  );
}

/**
 * Generic HTTP surface for local clients of plugin service Flows. Only Flows a
 * plugin publishes with `service: true` can be started, and only their root
 * Runs can be read or commanded. Responses carry no paths or provider payloads.
 */
export class ServiceRuns {
  readonly token: string;
  readonly #flows: ServiceFlowPort;

  constructor(flows: ServiceFlowPort, token: string) {
    this.#flows = flows;
    this.token = token;
  }

  authorized(header: string | undefined): boolean {
    const actual = Buffer.from(
      header?.startsWith("Bearer ") ? header.slice(7) : "",
    );
    const expected = Buffer.from(this.token);
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  }

  async flows() {
    const catalog = await this.#flows.request<FlowCatalog>("catalog");
    return catalog.flows
      .filter((flow) => flow.service)
      .map((flow) => ({ id: flow.id, available: flow.available }));
  }

  async start(source: unknown): Promise<ServiceRunView> {
    const body = exact<{ requestId: string; flowId: string; input: JsonValue }>(
      source,
      { requestId: isUuid, flowId: text(130), input: json },
    );
    const run = await this.#flows.request<FlowRun>(
      "services/start",
      {
        requestId: body.requestId,
        flowId: body.flowId,
        input: body.input,
      },
      AbortSignal.timeout(90_000),
    );
    return this.#view(run);
  }

  async get(runId: string): Promise<ServiceRunView> {
    return this.#view(await this.#root(runId));
  }

  async answer(runId: string, source: unknown): Promise<ServiceRunView> {
    const body = exact<{
      commandId: string;
      checkpointRunId: string;
      stepKey: string;
      answer: JsonValue;
    }>(source, {
      commandId: isUuid,
      checkpointRunId: isUuid,
      stepKey: text(512),
      answer: json,
    });
    const root = await this.#root(runId);
    const checkpoint = await this.#checkpoint(root);
    if (
      !checkpoint ||
      checkpoint.runId !== body.checkpointRunId ||
      checkpoint.stepKey !== body.stepKey
    )
      throw new ServiceError("checkpoint_not_waiting", 409);
    await this.#flows.request("answer", {
      id: body.checkpointRunId,
      stepKey: body.stepKey,
      requestId: body.commandId,
      output: body.answer,
    });
    return this.#view(await this.#root(root.id));
  }

  async command(
    runId: string,
    operation: "cancel" | "resume",
    source: unknown,
  ): Promise<ServiceRunView> {
    if (operation === "resume" && isRecord(source) && "input" in source) {
      // Resume with input lets the serving provider re-admit data, such as a refreshed scope.
      const body = exact<{ commandId: string; input: JsonValue }>(source, {
        commandId: isUuid,
        input: json,
      });
      const root = await this.#root(runId);
      await this.#flows.request("services/resume", {
        id: root.id,
        requestId: body.commandId,
        input: body.input,
      });
      return this.get(root.id);
    }
    const body = exact<{ commandId: string }>(source, { commandId: isUuid });
    const root = await this.#root(runId);
    await this.#flows.request(operation, {
      id: root.id,
      requestId: body.commandId,
    });
    return this.get(root.id);
  }

  /** Resolves a Run ID or the client's own requestId to a published root Run. */
  async #root(id: string): Promise<FlowRun> {
    if (!isUuid(id)) throw new ServiceError("run_not_found", 404);
    let run: FlowRun;
    try {
      run = await this.#flows.request<FlowRun>("get", { id });
    } catch {
      try {
        run = await this.#flows.request<FlowRun>("services/find", {
          requestId: id,
        });
      } catch {
        throw new ServiceError("run_not_found", 404);
      }
    }
    const published = (await this.flows()).some(
      (flow) => flow.id === run.flow.id,
    );
    if (run.parent || !published) throw new ServiceError("run_not_found", 404);
    return run;
  }

  async #checkpoint(
    run: FlowRun,
    depth = 0,
  ): Promise<ServiceCheckpoint | undefined> {
    if (run.status !== "waiting_input" || depth > 8) return undefined;
    const own = waitingCheckpoint(run.steps);
    if (own?.kind === "checkpoint")
      return {
        runId: run.id,
        stepKey: own.stepKey!,
        prompt: own.prompt,
        schema: own.outputSchema,
      };
    for (const step of run.steps) {
      if (step.kind !== "flow" || !step.childRunId) continue;
      const child = await this.#flows.request<FlowRun>("get", {
        id: step.childRunId,
      });
      const found = await this.#checkpoint(child, depth + 1);
      if (found) return found;
    }
    return undefined;
  }

  async #view(run: FlowRun): Promise<ServiceRunView> {
    const code = failureCode(run);
    const checkpoint = await this.#checkpoint(run);
    const view = await this.#flows
      .request<JsonValue | null>("services/view", { id: run.id })
      .catch(() => null);
    return {
      runId: run.id,
      requestId: run.requestId,
      flowId: run.flow.id,
      status: run.status,
      ...(run.report === undefined ? {} : { report: run.report }),
      ...(run.status === "completed" && run.output !== undefined
        ? { output: run.output }
        : {}),
      ...(code ? { error: { code } } : {}),
      ...(checkpoint ? { checkpoint } : {}),
      ...(view === null || view === undefined ? {} : { view }),
    };
  }
}

export class ServiceError extends Error {
  readonly status: 400 | 401 | 404 | 409 | 503;
  constructor(code: string, status: ServiceError["status"]) {
    super(code);
    this.status = status;
  }
}

export function createServiceApp(service: ServiceRuns) {
  const app = new Hono();
  app.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    if (!service.authorized(context.req.header("authorization")))
      return context.json({ code: "unauthorized" }, 401);
    await next();
  });
  app.use(
    "*",
    bodyLimit({
      maxSize: 256 * 1024,
      onError: (context) => context.json({ code: "request_too_large" }, 413),
    }),
  );
  app.get("/flows", async (context) =>
    context.json({ flows: await service.flows() }),
  );
  app.post("/runs", async (context) =>
    context.json(await service.start(await context.req.json()), 202),
  );
  app.get("/runs/:runId", async (context) =>
    context.json(await service.get(context.req.param("runId"))),
  );
  app.post("/runs/:runId/answer", async (context) =>
    context.json(
      await service.answer(
        context.req.param("runId"),
        await context.req.json(),
      ),
    ),
  );
  for (const operation of ["cancel", "resume"] as const)
    app.post(`/runs/:runId/${operation}`, async (context) =>
      context.json(
        await service.command(
          context.req.param("runId"),
          operation,
          await context.req.json(),
        ),
      ),
    );
  app.all("*", (context) => context.json({ code: "not_found" }, 404));
  app.onError((error, context) => {
    if (error instanceof ServiceError)
      return context.json({ code: error.message }, error.status);
    if (error instanceof InvalidRequest || error instanceof SyntaxError)
      return context.json({ code: "invalid_request" }, 400);
    // The orchestration bridge reports FlowError statuses; keep only the status, never the message.
    const status = (error as { status?: unknown }).status;
    if (status === 404) return context.json({ code: "run_not_found" }, 404);
    if (status === 409) return context.json({ code: "conflict" }, 409);
    // A plugin admission refusal arrives as 422 whose message is already a bounded snake_case code.
    if (status === 422) {
      const code = /^[a-z][a-z0-9_]{2,63}$/u.exec(error.message)?.[0];
      return context.json({ code: code ?? "invalid_request" }, 422);
    }
    if (status === 400) return context.json({ code: "invalid_request" }, 400);
    if (status === 503) return context.json({ code: "unavailable" }, 503);
    return context.json({ code: "internal" }, 500);
  });
  return app;
}
