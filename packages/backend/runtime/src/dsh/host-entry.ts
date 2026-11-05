import { loadLayeredEnv } from "@deepseek-ai/dsh-app-boot";
import { runProfile } from "@deepseek-ai/dsh/profile-boot";
import { finishDshLoad } from "./host-bootstrap.ts";
import {
  HOST_DIAGNOSTIC_PREFIX,
  hostErrorDiagnostics,
} from "./host-diagnostics.ts";

try {
  await runProfile({
    profile: "aura-flow",
    environment: loadLayeredEnv("dsh"),
    patchFiles: [],
    args: [],
  });
} catch (error) {
  finishDshLoad?.(true);
  const diagnostics = hostErrorDiagnostics(error)
    .map(
      (diagnostic) =>
        `${HOST_DIAGNOSTIC_PREFIX}${JSON.stringify(diagnostic)}\n`,
    )
    .join("");
  await new Promise<void>((resolve) =>
    process.stderr.write(diagnostics, () => resolve()),
  );
  process.exit(1);
}
