import React, {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  AudioLines,
  Box,
  ChevronLeft,
  ChevronRight,
  Download,
  Expand,
  Image as ImageIcon,
  LoaderCircle,
  Minus,
  Play,
  Plus,
  X,
} from "lucide-react";
import type {
  FlowPhase,
  WorkflowArtifact,
  WorkflowArtifacts as ArtifactList,
} from "@aura/protocol/types";
import {
  artifactSize,
  artifactUrl,
  visibleArtifacts,
} from "../workflowArtifacts";
import {
  useWorkflowMessages,
  workflowText,
  type WorkflowTranslate,
} from "../workflow-messages.ts";
import { formatNumber } from "@aura/i18n/runtime";
import { isWorkflowOpen, workflowApi } from "../workflowSessions";

const ModelPreview = lazy(() =>
  import("./WorkflowModelPreview").then((module) => ({
    default: module.WorkflowModelPreview,
  })),
);
interface ArtifactContextValue {
  artifacts: WorkflowArtifact[];
  endpoint: string;
  runId: string;
  pending: boolean;
  error: boolean;
  open(artifact: WorkflowArtifact, group: WorkflowArtifact[]): void;
  retry(): void;
}
const ArtifactContext = createContext<ArtifactContextValue | undefined>(
  undefined,
);

export function WorkflowArtifactProvider({
  endpoint,
  runId,
  phase,
  children,
}: {
  endpoint: string;
  runId: string;
  phase: FlowPhase;
  children: React.ReactNode;
}) {
  const [artifacts, setArtifacts] = useState<WorkflowArtifact[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [selection, setSelection] = useState<{
    artifact: WorkflowArtifact;
    group: WorkflowArtifact[];
  }>();
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let first = true;
    async function poll() {
      try {
        const result = await workflowApi<ArtifactList>(
          endpoint,
          `/runs/${encodeURIComponent(runId)}/artifacts${first && revision ? "?retry=1" : ""}`,
          undefined,
          abort.signal,
        );
        first = false;
        if (abort.signal.aborted) return;
        setArtifacts(result.artifacts);
        setPending(result.pending);
        setError(false);
        if (result.pending || isWorkflowOpen(phase))
          timer = setTimeout(poll, 1800);
      } catch {
        if (!abort.signal.aborted) {
          setError(true);
          setPending(false);
          if (isWorkflowOpen(phase)) timer = setTimeout(poll, 5000);
        }
      }
    }
    void poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [endpoint, runId, phase, revision]);
  const open = useCallback(
    (artifact: WorkflowArtifact, group: WorkflowArtifact[]) =>
      setSelection({ artifact, group }),
    [],
  );
  return (
    <ArtifactContext.Provider
      value={{ artifacts, endpoint, runId, pending, error, open, retry }}
    >
      {children}
      {selection ? (
        <ArtifactDialog
          endpoint={endpoint}
          runId={runId}
          selection={selection}
          select={(artifact) => setSelection({ ...selection, artifact })}
          close={() => setSelection(undefined)}
          retry={retry}
        />
      ) : null}
    </ArtifactContext.Provider>
  );
}

function Thumbnail({
  artifact,
  src,
}: {
  artifact: WorkflowArtifact;
  src: string;
}) {
  const [failed, setFailed] = useState(false);
  return artifact.thumbnailId && !failed ? (
    <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} />
  ) : (
    <span className="artifact-card-placeholder">
      {artifact.kind === "model" ? (
        <Box size={34} className="aura-icon--display" />
      ) : artifact.kind === "video" ? (
        <Play size={34} className="aura-icon--display" />
      ) : (
        <ImageIcon size={30} className="aura-icon--display" />
      )}
    </span>
  );
}
function artifactMeta(
  artifact: WorkflowArtifact,
  t: WorkflowTranslate = workflowText,
) {
  if (artifact.status === "unavailable") return t("fileUnavailable");
  if (artifact.status === "unsupported") return t("formatUnsupported");
  return [
    artifact.durationSeconds !== undefined
      ? formatDuration(artifact.durationSeconds)
      : artifact.width && artifact.height
        ? `${formatNumber(artifact.width)} × ${formatNumber(artifact.height)}`
        : undefined,
    artifact.format.toUpperCase(),
    artifactSize(artifact.bytes),
  ]
    .filter(Boolean)
    .join(" · ");
}

function formatDuration(seconds: number) {
  const whole = Math.max(0, Math.round(seconds));
  return `${formatNumber(Math.floor(whole / 60), { useGrouping: false })}:${formatNumber(whole % 60, { useGrouping: false, minimumIntegerDigits: 2 })}`;
}

/** Keep the model in the conversation; load its viewer only near the viewport. */
function InlineModel({
  artifact,
  group,
}: {
  artifact: WorkflowArtifact;
  group: WorkflowArtifact[];
}) {
  const { t } = useWorkflowMessages();
  const context = useContext(ArtifactContext)!;
  const frame = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const ready = artifact.status === "ready";
  useEffect(() => {
    if (!ready || !frame.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "120px" },
    );
    observer.observe(frame.current);
    return () => observer.disconnect();
  }, [ready]);
  return (
    <figure
      className="artifact-inline artifact-inline-model"
      aria-label={t("namedModel", { name: artifact.name })}
    >
      <figcaption>
        <span className="artifact-inline-icon" aria-hidden="true">
          <Box size={18} />
        </span>
        <span className="artifact-inline-copy">
          <strong title={artifact.name}>{artifact.name}</strong>
          <small>
            {t("modelMetadata", { metadata: artifactMeta(artifact, t) })}
          </small>
        </span>
        <span className="artifact-inline-actions">
          {ready ? (
            <button
              type="button"
              className="icon-control"
              aria-label={t("enlargeNamedPreview", { name: artifact.name })}
              title={t("enlargePreview")}
              onClick={() => context.open(artifact, group)}
            >
              <Expand size={15} />
            </button>
          ) : (
            <button className="text-control" onClick={context.retry}>
              {t("reloadArtifact")}
            </button>
          )}
          {artifact.status !== "unavailable" ? (
            <a
              className="icon-control"
              href={artifactUrl(
                context.endpoint,
                context.runId,
                artifact.artifactId,
                "content",
                true,
              )}
              download={artifact.name}
              aria-label={t("downloadNamedArtifact", { name: artifact.name })}
              title={t("download")}
            >
              <Download size={15} />
            </a>
          ) : null}
        </span>
      </figcaption>
      <div ref={frame} className="artifact-model-frame">
        {ready && visible ? (
          <Suspense
            fallback={
              <div className="artifact-stage-message" role="status">
                {t("loadingViewer")}
              </div>
            }
          >
            <ModelPreview
              src={artifactUrl(
                context.endpoint,
                context.runId,
                artifact.artifactId,
              )}
              name={artifact.name}
            />
          </Suspense>
        ) : ready ? (
          <Thumbnail
            artifact={artifact}
            src={artifactUrl(
              context.endpoint,
              context.runId,
              artifact.artifactId,
              "thumbnail",
            )}
          />
        ) : (
          <div className="artifact-stage-message">
            <Box size={30} className="aura-icon--display" />
            <span>
              {artifact.status === "unsupported"
                ? t("modelUnsupported")
                : t("modelUnavailable")}
            </span>
          </div>
        )}
      </div>
    </figure>
  );
}

/** Playable media sits directly in the run output; no dialog round-trip. */
function InlineMedia({
  artifact,
  group,
}: {
  artifact: WorkflowArtifact;
  group: WorkflowArtifact[];
}) {
  const { t } = useWorkflowMessages();
  const context = useContext(ArtifactContext)!;
  const src = artifactUrl(context.endpoint, context.runId, artifact.artifactId);
  const ready = artifact.status === "ready";
  return (
    <figure className={`artifact-inline artifact-inline-${artifact.kind}`}>
      {ready && artifact.kind === "video" ? (
        <video src={src} controls playsInline preload="metadata" />
      ) : null}
      <figcaption>
        <span className="artifact-inline-icon" aria-hidden="true">
          {artifact.kind === "audio" ? (
            <AudioLines size={16} />
          ) : (
            <Play size={16} />
          )}
        </span>
        <span className="artifact-inline-copy">
          <strong title={artifact.name}>{artifact.name}</strong>
          <small>{artifactMeta(artifact, t)}</small>
        </span>
        {ready ? (
          <span className="artifact-inline-actions">
            {artifact.kind === "video" ? (
              <button
                type="button"
                className="icon-control"
                aria-label={t("enlargeNamedPreview", { name: artifact.name })}
                title={t("enlargePreview")}
                onClick={() => context.open(artifact, group)}
              >
                <Expand size={15} />
              </button>
            ) : null}
            <a
              className="icon-control"
              href={artifactUrl(
                context.endpoint,
                context.runId,
                artifact.artifactId,
                "content",
                true,
              )}
              download={artifact.name}
              aria-label={t("downloadNamedArtifact", { name: artifact.name })}
              title={t("download")}
            >
              <Download size={15} />
            </a>
          </span>
        ) : (
          <button className="text-control" onClick={context.retry}>
            {t("reloadArtifact")}
          </button>
        )}
      </figcaption>
      {ready && artifact.kind === "audio" ? (
        <audio src={src} controls preload="metadata" />
      ) : null}
    </figure>
  );
}

export function WorkflowArtifactGallery({
  runId,
  stepKey,
  attempt,
}: {
  runId?: string;
  stepKey?: string;
  attempt?: number;
}) {
  const { t } = useWorkflowMessages();
  const context = useContext(ArtifactContext);
  if (!context) return null;
  const artifacts = visibleArtifacts(
    context.artifacts,
    runId && stepKey ? { runId, stepKey, attempt } : undefined,
  );
  const summary = !stepKey;
  if (!artifacts.length && (!summary || (!context.pending && !context.error)))
    return null;
  // A finished video already carries its narration; keep that audio in the
  // step details instead of stacking a second player in the run summary.
  const shown =
    summary && artifacts.some((artifact) => artifact.kind === "video")
      ? artifacts.filter((artifact) => artifact.kind !== "audio")
      : artifacts;
  const media = shown.filter(
    (artifact) => artifact.kind === "audio" || artifact.kind === "video",
  );
  const models = shown.filter((artifact) => artifact.kind === "model");
  const cards = shown.filter(
    (artifact) => !media.includes(artifact) && artifact.kind !== "model",
  );
  const fileCards = cards.length ? (
    <div className="artifact-grid">
      {cards.map((artifact) => (
        <button
          key={artifact.artifactId}
          type="button"
          className="artifact-card"
          onClick={() => context.open(artifact, cards)}
          aria-label={t("previewNamedArtifact", { name: artifact.name })}
        >
          <div className="artifact-card-image">
            <Thumbnail
              key={artifact.thumbnailId ?? artifact.id}
              artifact={artifact}
              src={artifactUrl(
                context.endpoint,
                context.runId,
                artifact.artifactId,
                "thumbnail",
              )}
            />
            <span className="artifact-kind">
              {artifact.format.toUpperCase()}
            </span>
            <span className="artifact-card-expand">
              <Expand size={16} />
            </span>
          </div>
          <div className="artifact-card-caption">
            <strong title={artifact.name}>{artifact.name}</strong>
            <small>{artifactMeta(artifact, t)}</small>
          </div>
        </button>
      ))}
    </div>
  ) : null;
  return (
    <section
      className="workflow-artifacts"
      aria-label={summary ? t("runArtifacts") : t("stepArtifacts")}
    >
      {models.length ? (
        <div className="artifact-inline-list">
          {models.map((artifact) => (
            <InlineModel
              key={artifact.artifactId}
              artifact={artifact}
              group={models}
            />
          ))}
        </div>
      ) : null}
      {media.length ? (
        <div className="artifact-inline-list">
          {media.map((artifact) => (
            <InlineMedia
              key={artifact.artifactId}
              artifact={artifact}
              group={shown}
            />
          ))}
        </div>
      ) : null}
      {models.length && cards.length ? (
        <details className="artifact-reference-files">
          <summary>{t("referenceFiles", { count: cards.length })}</summary>
          {fileCards}
        </details>
      ) : (
        fileCards
      )}
      {summary && context.pending && !shown.length ? (
        <p className="artifact-status" role="status">
          <LoaderCircle size={14} className="workflow-spinner" />
          {t("preparingArtifacts")}
        </p>
      ) : null}
      {summary && context.error ? (
        <p className="artifact-status" role="alert">
          {t("artifactsUnavailable")}
          <button className="text-control" onClick={context.retry}>
            {t("retry")}
          </button>
        </p>
      ) : null}
    </section>
  );
}

/** True once a summary gallery has ready media, so path-only output can fold. */
export function useHasArtifacts() {
  const context = useContext(ArtifactContext);
  return Boolean(
    context?.artifacts.some((artifact) => artifact.status === "ready"),
  );
}

function ArtifactDialog({
  endpoint,
  runId,
  selection,
  select,
  close,
  retry,
}: {
  endpoint: string;
  runId: string;
  selection: { artifact: WorkflowArtifact; group: WorkflowArtifact[] };
  select(artifact: WorkflowArtifact): void;
  close(): void;
  retry(): void;
}) {
  const { t } = useWorkflowMessages();
  const dialog = useRef<HTMLDialogElement>(null);
  const { artifact, group } = selection;
  const index = group.findIndex((item) => item.id === artifact.id);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current!;
    element.showModal();
    return () => {
      element.close();
      previous?.focus();
    };
  }, []);
  const move = (direction: number) =>
    select(group[(index + direction + group.length) % group.length]);
  return (
    <dialog
      ref={dialog}
      className="artifact-dialog"
      aria-label={t("previewNamedArtifact", { name: artifact.name })}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === dialog.current) close();
      }}
      onKeyDown={(event) => {
        if (
          event.target === dialog.current ||
          (event.target as HTMLElement).tagName === "BUTTON"
        ) {
          if (event.key === "ArrowLeft" && group.length > 1) move(-1);
          if (event.key === "ArrowRight" && group.length > 1) move(1);
        }
      }}
    >
      <div className="artifact-dialog-inner">
        <header className="artifact-dialog-header">
          <div>
            {artifact.kind === "model" ? (
              <Box size={18} />
            ) : artifact.kind === "video" ? (
              <Play size={18} />
            ) : (
              <ImageIcon size={18} />
            )}
            <span>
              <strong>{artifact.name}</strong>
              <small>
                {artifact.format.toUpperCase()}
                {artifact.bytes ? ` · ${artifactSize(artifact.bytes)}` : ""}
              </small>
            </span>
          </div>
          <div className="artifact-dialog-actions">
            {artifact.status !== "unavailable" ? (
              <a
                className="tool-button"
                href={artifactUrl(
                  endpoint,
                  runId,
                  artifact.artifactId,
                  "content",
                  true,
                )}
                download={artifact.name}
              >
                <Download size={15} />
                {t("download")}
              </a>
            ) : null}
            <button
              className="icon-control"
              aria-label={t("closePreview")}
              onClick={close}
              autoFocus
            >
              <X size={20} />
            </button>
          </div>
        </header>
        <div className="artifact-preview-body">
          {artifact.status !== "ready" ? (
            <div className="artifact-stage-message" role="status">
              <Box size={32} />
              <p>
                {artifact.status === "unavailable"
                  ? t("missingArtifact")
                  : t("fileUnsupported")}
              </p>
              {artifact.status === "unavailable" ? (
                <button
                  className="tool-button"
                  onClick={() => {
                    retry();
                    close();
                  }}
                >
                  {t("reloadFile")}
                </button>
              ) : null}
            </div>
          ) : artifact.kind === "video" ? (
            <video
              className="artifact-video-preview"
              src={artifactUrl(endpoint, runId, artifact.artifactId)}
              controls
              playsInline
              preload="metadata"
            />
          ) : artifact.kind === "audio" ? (
            <audio
              src={artifactUrl(endpoint, runId, artifact.artifactId)}
              controls
              preload="metadata"
            />
          ) : artifact.kind === "subtitle" ? (
            <p>{t("subtitleHint")}</p>
          ) : artifact.kind === "model" ? (
            <Suspense
              fallback={
                <div className="artifact-stage-message" role="status">
                  {t("loadingViewer")}
                </div>
              }
            >
              <ModelPreview
                key={artifact.artifactId}
                src={artifactUrl(endpoint, runId, artifact.artifactId)}
                name={artifact.name}
              />
            </Suspense>
          ) : (
            <ImagePreview
              key={artifact.artifactId}
              src={artifactUrl(endpoint, runId, artifact.artifactId)}
              name={artifact.name}
            />
          )}
        </div>
        <footer className="artifact-dialog-footer">
          <span>
            {artifact.kind === "image"
              ? t("imageGestureHint")
              : artifact.kind === "video"
                ? t("videoPreview")
                : artifact.kind === "model"
                  ? t("modelPreview")
                  : artifact.kind === "audio"
                    ? t("audioPreview")
                    : t("filePreview")}
          </span>
          {group.length > 1 ? (
            <div>
              <button
                className="icon-control"
                aria-label={t("previousFile")}
                onClick={() => move(-1)}
              >
                <ChevronLeft size={18} />
              </button>
              <span>
                {formatNumber(index + 1)} / {formatNumber(group.length)}
              </span>
              <button
                className="icon-control"
                aria-label={t("nextFile")}
                onClick={() => move(1)}
              >
                <ChevronRight size={18} />
              </button>
            </div>
          ) : null}
        </footer>
      </div>
    </dialog>
  );
}

export function ImagePreview({ src, name }: { src: string; name: string }) {
  const { t } = useWorkflowMessages();
  const stage = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [revision, setRevision] = useState(0);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const zoom = useCallback(
    (factor: number) =>
      setView((value) => ({
        ...value,
        scale: Math.max(0.25, Math.min(8, value.scale * factor)),
      })),
    [],
  );
  useEffect(() => {
    const element = stage.current!;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      zoom(Math.exp(-event.deltaY * 0.002));
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [zoom]);
  const distance = () => {
    const [a, b] = [...pointers.current.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };
  return (
    <div
      className="artifact-image-stage"
      ref={stage}
      onPointerDown={(event) => {
        if ((event.target as HTMLElement).closest("button, a")) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        pointers.current.set(event.pointerId, {
          x: event.clientX,
          y: event.clientY,
        });
      }}
      onPointerMove={(event) => {
        const previous = pointers.current.get(event.pointerId);
        if (!previous) return;
        const before = distance();
        pointers.current.set(event.pointerId, {
          x: event.clientX,
          y: event.clientY,
        });
        if (pointers.current.size > 1 && before > 0) zoom(distance() / before);
        else
          setView((value) => ({
            ...value,
            x: value.x + event.clientX - previous.x,
            y: value.y + event.clientY - previous.y,
          }));
      }}
      onPointerUp={(event) => pointers.current.delete(event.pointerId)}
      onPointerCancel={(event) => pointers.current.delete(event.pointerId)}
      onLostPointerCapture={(event) => pointers.current.delete(event.pointerId)}
    >
      <img
        key={revision}
        src={src + (revision ? `?retry=${revision}` : "")}
        alt={name}
        draggable={false}
        onLoad={() => setStatus("ready")}
        onError={() => setStatus("error")}
        style={{
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
          visibility: status === "ready" ? "visible" : "hidden",
        }}
      />
      {status !== "ready" ? (
        <div
          className="artifact-stage-message"
          role={status === "error" ? "alert" : "status"}
        >
          {status === "loading" ? (
            <>
              <LoaderCircle className="workflow-spinner" size={24} />
              <span>{t("loadingImage")}</span>
            </>
          ) : (
            <>
              <ImageIcon size={30} />
              <p>{t("imageLoadFailed")}</p>
              <button
                className="tool-button"
                onClick={() => {
                  setStatus("loading");
                  setRevision((value) => value + 1);
                }}
              >
                {t("retryPreview")}
              </button>
            </>
          )}
        </div>
      ) : null}
      <div
        className="artifact-image-tools"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button
          className="icon-control"
          aria-label={t("zoomOutImage")}
          onClick={() => zoom(0.8)}
        >
          <Minus size={16} />
        </button>
        <span>
          {formatNumber(view.scale, {
            style: "percent",
            maximumFractionDigits: 0,
          })}
        </span>
        <button
          className="icon-control"
          aria-label={t("zoomInImage")}
          onClick={() => zoom(1.25)}
        >
          <Plus size={16} />
        </button>
        <button
          className="tool-button"
          onClick={() => setView({ scale: 1, x: 0, y: 0 })}
        >
          <Expand size={14} />
          {t("fitWindow")}
        </button>
      </div>
    </div>
  );
}
