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
import { isWorkflowOpen, workflowApi } from "../workflowSessions";

const ModelPreview = lazy(() => import("./WorkflowModelPreview"));
interface ArtifactContextValue {
  artifacts: WorkflowArtifact[];
  endpoint: string;
  runId: string;
  pending: boolean;
  error: string;
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
  const [error, setError] = useState("");
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
        setError("");
        if (result.pending || isWorkflowOpen(phase))
          timer = setTimeout(poll, 1800);
      } catch (cause) {
        if (!abort.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "产物读取失败");
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
        <Box size={34} strokeWidth={1} />
      ) : artifact.kind === "video" ? (
        <Play size={34} strokeWidth={1} />
      ) : (
        <ImageIcon size={30} strokeWidth={1} />
      )}
    </span>
  );
}
function artifactMeta(artifact: WorkflowArtifact) {
  if (artifact.status === "unavailable") return "文件不可用";
  if (artifact.status === "unsupported") return "格式不支持预览";
  return [
    artifact.durationSeconds !== undefined
      ? formatDuration(artifact.durationSeconds)
      : artifact.width && artifact.height
        ? `${artifact.width} × ${artifact.height}`
        : undefined,
    artifact.format.toUpperCase(),
    artifactSize(artifact.bytes),
  ]
    .filter(Boolean)
    .join(" · ");
}

function formatDuration(seconds: number) {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** Playable media sits directly in the run output; no dialog round-trip. */
function InlineMedia({
  artifact,
  group,
}: {
  artifact: WorkflowArtifact;
  group: WorkflowArtifact[];
}) {
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
          <small>{artifactMeta(artifact)}</small>
        </span>
        {ready ? (
          <span className="artifact-inline-actions">
            {artifact.kind === "video" ? (
              <button
                type="button"
                className="icon-control"
                aria-label={`放大预览 ${artifact.name}`}
                title="放大预览"
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
              aria-label={`下载 ${artifact.name}`}
              title="下载"
            >
              <Download size={15} />
            </a>
          </span>
        ) : (
          <button className="text-control" onClick={context.retry}>
            重新读取
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
  const cards = shown.filter((artifact) => !media.includes(artifact));
  return (
    <section
      className="workflow-artifacts"
      aria-label={summary ? "本次生成的文件" : "本步骤生成的文件"}
    >
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
      {cards.length ? (
        <div className="artifact-grid">
          {cards.map((artifact) => (
            <button
              key={artifact.artifactId}
              type="button"
              className="artifact-card"
              onClick={() => context.open(artifact, cards)}
              aria-label={`预览 ${artifact.name}`}
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
                  {artifact.kind === "model"
                    ? "3D · GLB"
                    : artifact.format.toUpperCase()}
                </span>
                <span className="artifact-card-expand">
                  <Expand size={16} />
                </span>
              </div>
              <div className="artifact-card-caption">
                <strong title={artifact.name}>{artifact.name}</strong>
                <small>{artifactMeta(artifact)}</small>
              </div>
            </button>
          ))}
        </div>
      ) : null}
      {summary && context.pending && !shown.length ? (
        <p className="artifact-status" role="status">
          <LoaderCircle size={14} className="workflow-spinner" />
          正在整理生成文件…
        </p>
      ) : null}
      {summary && context.error ? (
        <p className="artifact-status" role="alert">
          产物暂时无法读取。
          <button className="text-control" onClick={context.retry}>
            重试
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
      aria-label={`预览 ${artifact.name}`}
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
                下载
              </a>
            ) : null}
            <button
              className="icon-control"
              aria-label="关闭预览"
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
                  ? "原生成文件不存在或尚未成功登记。"
                  : "此文件不支持在线预览，可下载查看。"}
              </p>
              {artifact.status === "unavailable" ? (
                <button
                  className="tool-button"
                  onClick={() => {
                    retry();
                    close();
                  }}
                >
                  重新读取文件
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
            <p>UTF-8 字幕文件，可下载后导入剪辑软件。</p>
          ) : artifact.kind === "model" ? (
            <Suspense
              fallback={
                <div className="artifact-stage-message" role="status">
                  正在加载 3D 查看器…
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
              ? "滚轮或双指缩放 · 拖动查看细节"
              : artifact.kind === "video"
                ? "视频预览"
                : "3D 模型预览"}
          </span>
          {group.length > 1 ? (
            <div>
              <button
                className="icon-control"
                aria-label="上一个文件"
                onClick={() => move(-1)}
              >
                <ChevronLeft size={18} />
              </button>
              <span>
                {index + 1} / {group.length}
              </span>
              <button
                className="icon-control"
                aria-label="下一个文件"
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

function ImagePreview({ src, name }: { src: string; name: string }) {
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
              <span>正在加载图片…</span>
            </>
          ) : (
            <>
              <ImageIcon size={30} />
              <p>图片加载失败，可重试或下载查看。</p>
              <button
                className="tool-button"
                onClick={() => {
                  setStatus("loading");
                  setRevision((value) => value + 1);
                }}
              >
                重试预览
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
          aria-label="缩小图片"
          onClick={() => zoom(0.8)}
        >
          <Minus size={16} />
        </button>
        <span>{Math.round(view.scale * 100)}%</span>
        <button
          className="icon-control"
          aria-label="放大图片"
          onClick={() => zoom(1.25)}
        >
          <Plus size={16} />
        </button>
        <button
          className="tool-button"
          onClick={() => setView({ scale: 1, x: 0, y: 0 })}
        >
          <Expand size={14} />
          适应窗口
        </button>
      </div>
    </div>
  );
}
