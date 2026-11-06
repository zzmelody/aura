import type { WorkflowArtifact } from "@aura/protocol/types";
import { language } from "@aura/i18n/runtime";

export function artifactUrl(
  endpoint: string,
  runId: string,
  artifactId: string,
  variant: "content" | "thumbnail" = "content",
  download = false,
) {
  return `${endpoint.replace(/\/$/, "")}/flows/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}/${variant}${download ? "?download=1" : ""}`;
}
export function visibleArtifacts(
  artifacts: WorkflowArtifact[],
  filter?: { runId: string; stepKey: string; attempt?: number },
) {
  const unique = new Map<string, WorkflowArtifact>();
  for (const artifact of artifacts) {
    if (
      filter &&
      (artifact.runId !== filter.runId ||
        artifact.stepKey !== filter.stepKey ||
        (filter.attempt !== undefined && artifact.attempt !== filter.attempt))
    )
      continue;
    if (!unique.has(artifact.artifactId))
      unique.set(artifact.artifactId, artifact);
  }
  return [...unique.values()];
}
export function artifactSize(
  bytes: number,
  locale: string = language.getSnapshot().locale,
): string {
  const large = bytes >= 1024 * 1024;
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: large ? "megabyte" : "kilobyte",
    unitDisplay: "short",
    minimumFractionDigits: large ? 1 : 0,
    maximumFractionDigits: large ? 1 : 0,
  }).format(
    large ? bytes / (1024 * 1024) : Math.max(1, Math.round(bytes / 1024)),
  );
}
