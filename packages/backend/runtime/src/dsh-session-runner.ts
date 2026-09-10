import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  JsonRpcLineTransport,
  type InitializeResult,
  type SessionEventNotification,
} from "@deepseek-ai/dsh-sdk-protocol";
import type { ChatEvent, ChatMessage } from "@aura/protocol/types";
import { errorMessage } from "./http-server.ts";
import type { DshRoute, DshRunnerOptions } from "./types.ts";

interface TurnSettlement {
  resolve(): void;
  reject(reason?: unknown): void;
}

/** Owns short-lived DSH SDK processes and their cancellation boundaries. */
export class DshSessionRunner {
  readonly #options: DshRunnerOptions;
  readonly #children = new Map<ChildProcessWithoutNullStreams, Promise<void>>();
  #closing = false;

  constructor(options: DshRunnerOptions) {
    this.#options = options;
  }

  async stream(
    messages: ChatMessage[],
    emit: (event: ChatEvent) => void,
    route: DshRoute,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.#closing) throw new Error("Aura runtime is shutting down.");

    const abortSignal = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);

    const child = spawn(
      process.execPath,
      [this.#options.dshExecutable, "--profile", "aura-sdk"],
      {
        cwd: this.#options.root,
        windowsHide: true,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          DSH_HOME: this.#options.dshHome,
          DSH_TELEMETRY_DISABLED: "1",
          AURA_DEMO_KEY: "demo-only-not-a-real-key",
          AURA_DEMO_BASE_URL: this.#options.demoModelUrl,
          NO_PROXY: "127.0.0.1,localhost",
          no_proxy: "127.0.0.1,localhost",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });
    this.#children.set(child, exited);

    // Consume provider diagnostics without copying potentially sensitive output
    // into Aura errors or logs.
    child.stderr.resume();
    const rpc = new JsonRpcLineTransport(child.stdout, child.stdin);
    const sessionId = randomUUID();
    let ended = false;
    let textSeen = false;
    let settle!: TurnSettlement;
    const completed = new Promise<void>((resolve, reject) => {
      settle = { resolve, reject };
    });
    void completed.catch(() => undefined);

    child.once("error", (error) => settle.reject(error));
    child.once("exit", (code, signal) => {
      if (!ended)
        settle.reject(
          new Error(
            `DSH exited early (code=${code ?? "none"}, signal=${signal ?? "none"}).`,
          ),
        );
    });
    const onAbort = () => {
      settle.reject(abortSignal.reason);
      child.kill();
    };
    abortSignal.addEventListener("abort", onAbort, { once: true });
    rpc.onNotification((method, parameters) => {
      if (method !== "session.event") return;
      const notification = parameters as unknown as SessionEventNotification;
      if (notification.sessionId !== sessionId) return;
      const event = notification.event;
      if (
        event.type === "assistant/chunk" &&
        event.data.chunk.type === "text-delta"
      ) {
        textSeen = true;
        emit({ type: "delta", text: event.data.chunk.text });
      }
      if (event.type === "turn/end") {
        ended = true;
        if (event.data.reason.kind === "completed" && textSeen)
          settle.resolve();
        else
          settle.reject(
            new Error(`DSH turn ended: ${JSON.stringify(event.data.reason)}`),
          );
      }
    });
    rpc.start();

    try {
      const result = (await rpc.request(
        "initialize",
        {
          cwd: this.#options.root,
          provider: route.provider,
          model: route.model,
          reasoningEffort: route.reasoningEffort,
          maxTokens: route.maxTokens,
        },
        abortSignal,
      )) as InitializeResult;
      if (result.serverInfo?.name !== "deepseek-harness-sdk-runtime")
        throw new Error("DSH handshake failed.");

      await rpc.request(
        "session/prompt",
        {
          sessionId,
          contentBlocks: [
            {
              type: "text",
              text: `AURA_HISTORY_V1\n${JSON.stringify({ messages })}`,
            },
          ],
        },
        abortSignal,
      );
      await completed;
      await rpc.request("shutdown", {}, abortSignal);
      emit(
        route.mode === "codex-subscription"
          ? {
              type: "done",
              engine: "deepseek-harness",
              mode: route.mode,
              model: route.model,
            }
          : {
              type: "done",
              engine: "deepseek-harness",
              mode: route.mode,
            },
      );
    } catch (error) {
      console.error("[Aura DSH session]", errorMessage(error));
      emit({
        type: "error",
        message: "DSH 请求暂时不可用，请检查服务终端和登录状态后重试。",
      });
    } finally {
      abortSignal.removeEventListener("abort", onAbort);
      rpc.close();
      child.stdin.end();
      if (child.exitCode === null) child.kill();
      await exited;
      this.#children.delete(child);
    }
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    const exits = [...this.#children.values()];
    for (const child of this.#children.keys()) child.kill();
    await Promise.all(exits);
  }
}
