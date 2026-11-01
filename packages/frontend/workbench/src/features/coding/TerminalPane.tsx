import React, { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import type { Terminal } from "@xterm/xterm";
import type {
  WorkspaceTerminalInfo,
  WorkspaceTerminalOutput,
} from "@aura/protocol/types";
import { resizeTerminal, terminalEventsUrl, writeTerminal } from "./api";

function outputPage(value: unknown): value is WorkspaceTerminalOutput {
  if (
    !value ||
    typeof value !== "object" ||
    !("terminal" in value) ||
    !("data" in value) ||
    !("cursor" in value) ||
    !("reset" in value)
  )
    return false;
  const terminal = value.terminal;
  return (
    typeof value.data === "string" &&
    typeof value.cursor === "number" &&
    Number.isSafeInteger(value.cursor) &&
    value.cursor >= 0 &&
    typeof value.reset === "boolean" &&
    !!terminal &&
    typeof terminal === "object" &&
    "id" in terminal &&
    typeof terminal.id === "string" &&
    "projectId" in terminal &&
    typeof terminal.projectId === "string" &&
    "title" in terminal &&
    typeof terminal.title === "string" &&
    "directory" in terminal &&
    typeof terminal.directory === "string" &&
    "createdAt" in terminal &&
    typeof terminal.createdAt === "number" &&
    "status" in terminal &&
    ["running", "exited", "error"].includes(String(terminal.status)) &&
    "activity" in terminal &&
    ["idle", "busy", "unknown"].includes(String(terminal.activity))
  );
}

/** Lazily mounts a real terminal renderer; hiding preserves PTY and scrollback. */
export function TerminalPane({
  endpoint,
  info,
  visible,
  onInfo,
}: {
  endpoint: string;
  info: WorkspaceTerminalInfo;
  visible: boolean;
  onInfo(info: WorkspaceTerminalInfo): void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | undefined>(undefined);
  const [activated, setActivated] = useState(visible);
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const [connection, setConnection] = useState(0);
  const [renderer, setRenderer] = useState(0);
  const cursor = useRef(0);
  const visibility = useRef(visible);
  visibility.current = visible;
  const terminalId = info.id;
  const latestInfo = useRef(info);
  latestInfo.current = info;

  useEffect(() => {
    if (visible) setActivated(true);
  }, [visible]);
  useEffect(() => {
    if (!activated || !container.current) return;
    let disposed = false;
    let cleanup: (() => void) | undefined;
    const node = container.current;
    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")])
      .then(([{ Terminal }, { FitAddon }]) => {
        if (disposed) return;
        const instance = new Terminal({
          cursorBlink: true,
          fontSize: 13,
          fontFamily: '"Cascadia Mono", Consolas, monospace',
          scrollback: 5000,
          screenReaderMode: true,
        });
        const fit = new FitAddon();
        instance.loadAddon(fit);
        instance.open(node);
        terminal.current = instance;
        const theme = () => {
          const style = getComputedStyle(node);
          instance.options.theme = {
            background: getComputedStyle(document.body).backgroundColor,
            foreground: style.color,
            cursor: style.color,
          };
        };
        theme();
        const themeObserver = new MutationObserver(theme);
        themeObserver.observe(
          document.querySelector(".aura-root") ?? document.documentElement,
          {
            attributes: true,
            attributeFilter: ["style", "class", "data-theme"],
          },
        );
        let resizeTimer: ReturnType<typeof setTimeout> | undefined;
        let inputTimer: ReturnType<typeof setTimeout> | undefined;
        let input = "";
        let writes = Promise.resolve();
        let inputFailed = false;
        const flush = () => {
          if (disposed || inputFailed || !input) return;
          const data = input;
          input = "";
          writes = writes
            .then(async () => {
              if (disposed || inputFailed) return;
              for (let offset = 0; offset < data.length; offset += 8192)
                await writeTerminal(
                  endpoint,
                  terminalId,
                  data.slice(offset, offset + 8192),
                );
            })
            .catch(() => {
              if (disposed) return;
              inputFailed = true;
              input = "";
              instance.options.disableStdin = true;
              setError(
                "终端输入未确认，请重新连接后检查状态；输入不会自动重发。",
              );
            });
        };
        const dataListener = instance.onData((data) => {
          if (inputFailed) return;
          input += data;
          clearTimeout(inputTimer);
          inputTimer = setTimeout(flush, 16);
        });
        const measure = () => {
          if (!visibility.current || !node.clientWidth || !node.clientHeight)
            return;
          fit.fit();
          clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => {
            void resizeTerminal(
              endpoint,
              terminalId,
              Math.min(500, instance.cols),
              Math.min(200, instance.rows),
            ).catch(() => {
              if (!disposed) setError("终端尺寸同步失败，请重新连接。");
            });
          }, 120);
        };
        const observer = new ResizeObserver(measure);
        observer.observe(node);
        measure();
        cursor.current = 0;
        setConnection((value) => value + 1);
        if (visibility.current) instance.focus();
        cleanup = () => {
          clearTimeout(inputTimer);
          clearTimeout(resizeTimer);
          dataListener.dispose();
          observer.disconnect();
          themeObserver.disconnect();
          instance.dispose();
          terminal.current = undefined;
        };
      })
      .catch(() => {
        if (!disposed) setError("终端界面加载失败，请重新打开工具面板。");
      });
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [activated, endpoint, terminalId, renderer]);

  useEffect(() => {
    if (!connection || !terminal.current) return;
    const source = new EventSource(
      terminalEventsUrl(endpoint, terminalId, cursor.current),
    );
    let exited = false;
    source.onopen = () => {
      setConnected(true);
    };
    source.onerror = () => {
      setConnected(false);
      if (exited) source.close();
      else if (source.readyState === EventSource.CLOSED) {
        setError("终端已不存在或服务已重启，请新建终端。");
        onInfo({ ...latestInfo.current, status: "error" });
      }
    };
    source.addEventListener("unavailable", () => {
      source.close();
      setConnected(false);
      setError("终端已不可用或服务已重启，请新建终端。");
    });
    source.addEventListener("output", (event: MessageEvent<string>) => {
      try {
        const page: unknown = JSON.parse(event.data);
        if (!outputPage(page) || page.terminal.id !== terminalId)
          throw new Error("Invalid terminal output");
        if (page.reset) terminal.current?.reset();
        if (page.data) terminal.current?.write(page.data);
        cursor.current = page.cursor;
        onInfo(page.terminal);
        if (page.terminal.status !== "running") {
          exited = true;
          if (terminal.current) terminal.current.options.disableStdin = true;
          // The server drains queued output before ending its stream.
        }
      } catch {
        source.close();
        setConnected(false);
        setError("终端输出读取失败，请重新连接。");
      }
    });
    return () => source.close();
  }, [connection, endpoint, terminalId, onInfo]);
  useEffect(() => {
    if (visible && activated) terminal.current?.focus();
  }, [visible, activated]);

  return (
    <section
      id={`tool-panel-${info.id}`}
      role="tabpanel"
      aria-labelledby={`tool-tab-${info.id}`}
      className="coding-terminal coding-pane"
      hidden={!visible}
    >
      {error ? (
        <p className="coding-notice" role="alert">
          {error}
        </p>
      ) : null}
      <div
        ref={container}
        className="coding-terminal-screen"
        aria-label={`${info.title}交互终端`}
      />
      <footer className="coding-terminal-footer">
        <span title={info.directory}>{info.directory}</span>
        <span>
          {info.status === "running"
            ? connected
              ? "已连接"
              : "连接已断开"
            : `已退出${info.exitCode === undefined ? "" : ` · ${info.exitCode}`}`}
        </span>
        {info.status === "running" && (!connected || error) ? (
          <button
            type="button"
            onClick={() => {
              setError("");
              if (terminal.current)
                terminal.current.options.disableStdin = false;
              setRenderer((value) => value + 1);
            }}
          >
            重新连接
          </button>
        ) : null}
      </footer>
    </section>
  );
}
