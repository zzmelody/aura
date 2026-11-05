import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { Agent } from "@deepseek-ai/dsh-agent";

const maxInstructionBytes = 64 * 1024;
const unavailableFileCodes = new Set([
  "ENOENT",
  "ENOTDIR",
  "ELOOP",
  "EACCES",
  "EPERM",
]);

/** Read only a regular file in the directory recorded in the session header. */
async function readWorkspaceInstructions(
  directory: string,
  signal?: AbortSignal,
): Promise<string> {
  const path = join(directory, "AGENTS.md");
  signal?.throwIfAborted();
  try {
    const expected = await lstat(path);
    if (
      !expected.isFile() ||
      relative(directory, dirname(await realpath(path)))
    )
      return "";
    const file = await open(
      path,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    try {
      const current = await file.stat();
      if (
        !current.isFile() ||
        current.dev !== expected.dev ||
        current.ino !== expected.ino
      )
        return "";
      const buffer = Buffer.alloc(maxInstructionBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        signal?.throwIfAborted();
        const { bytesRead } = await file.read(
          buffer,
          length,
          buffer.length - length,
          length,
        );
        if (!bytesRead) break;
        length += bytesRead;
      }
      signal?.throwIfAborted();
      const truncated = length > maxInstructionBytes;
      const content = new TextDecoder().decode(
        buffer.subarray(0, Math.min(length, maxInstructionBytes)),
        { stream: truncated },
      );
      return content.trim()
        ? [
            "Workspace instructions from AGENTS.md",
            "Apply these instructions to work in this workspace. Higher-priority instructions and the user's current request take precedence.",
            content,
            ...(truncated ? ["[AGENTS.md truncated at 64 KiB]"] : []),
          ].join("\n\n")
        : "";
    } finally {
      await file.close();
    }
  } catch (error) {
    signal?.throwIfAborted();
    // An optional file may be absent, inaccessible or replaced during assembly.
    if (
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string" &&
      unavailableFileCodes.has(error.code)
    )
      return "";
    throw error;
  }
}

/** DSH owns prompt projection and refresh. Register only in the exact Agent scope. */
export function mountWorkspaceInstructions(agent: Agent, directory: string) {
  agent.ctx.on("system-prompt/assemble", async (_assembly, context, next) => {
    const assembled = await next();
    if (context.agent !== agent) return assembled;
    const text = await readWorkspaceInstructions(directory, context.signal);
    if (!text) return assembled;
    return {
      ...assembled,
      sections: [
        ...assembled.sections,
        { name: "aura:workspace-instructions", text, interpolate: false },
      ],
    };
  });
}
