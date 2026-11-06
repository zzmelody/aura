import React, { useEffect, useRef, useState } from "react";
import { Box, LoaderCircle, RotateCcw } from "lucide-react";
import type { ModelViewerElement } from "@google/model-viewer";
import {
  useWorkflowMessages,
  type WorkflowMessageKey,
} from "../workflow-messages.ts";
import { formatNumber } from "@aura/i18n/runtime";

export function WorkflowModelPreview({
  src,
  name,
}: {
  src: string;
  name: string;
}) {
  const { t } = useWorkflowMessages();
  const container = useRef<HTMLDivElement>(null);
  const viewer = useRef<ModelViewerElement | null>(null);
  const [error, setError] = useState<WorkflowMessageKey>();
  const [progress, setProgress] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let disposed = false;
    let model: ModelViewerElement | undefined;
    setLoaded(false);
    setError(undefined);
    setProgress(0);
    const timeout = setTimeout(() => setError("modelTimeout"), 60_000);
    async function load() {
      const { ModelViewerElement } = await import("@google/model-viewer");
      if (disposed) return;
      const base = new URL("model-decoders/", document.baseURI);
      ModelViewerElement.dracoDecoderLocation = new URL(
        "draco/gltf/",
        base,
      ).href;
      ModelViewerElement.ktx2TranscoderLocation = new URL("basis/", base).href;
      ModelViewerElement.meshoptDecoderLocation = new URL(
        "meshopt_decoder.js",
        base,
      ).href;
      ModelViewerElement.modelCacheSize = 0;
      model = document.createElement("model-viewer") as ModelViewerElement;
      model.setAttribute("camera-controls", "");
      model.setAttribute("touch-action", "none");
      model.setAttribute("interaction-prompt", "none");
      model.setAttribute("loading", "eager");
      model.setAttribute("camera-orbit", "0deg 75deg auto");
      model.setAttribute("camera-target", "auto auto auto");
      model.setAttribute("alt", name);
      model.addEventListener("load", () => {
        if (!disposed) {
          clearTimeout(timeout);
          setLoaded(true);
          setError(undefined);
        }
      });
      model.addEventListener("error", () => {
        if (!disposed) {
          clearTimeout(timeout);
          setError("modelRenderFailed");
        }
      });
      model.addEventListener("progress", (event) => {
        if (!disposed)
          setProgress(
            Math.round(
              (event as unknown as CustomEvent<{ totalProgress: number }>)
                .detail.totalProgress * 100,
            ),
          );
      });
      model.src = src;
      viewer.current = model;
      container.current?.appendChild(model);
    }
    void load().catch(() => {
      if (!disposed) {
        clearTimeout(timeout);
        setError("viewerLoadFailed");
      }
    });
    return () => {
      disposed = true;
      clearTimeout(timeout);
      model?.remove();
      viewer.current = null;
    };
  }, [src, name, revision]);
  return (
    <div className="artifact-model-stage">
      <div ref={container} className="artifact-model-canvas" />
      {!loaded && !error ? (
        <div className="artifact-stage-message" role="status">
          <LoaderCircle size={24} className="workflow-spinner" />
          <span>
            {t("loadingModelProgress", {
              progress: formatNumber(progress / 100, {
                style: "percent",
                maximumFractionDigits: 0,
              }),
            })}
          </span>
        </div>
      ) : null}
      {error ? (
        <div className="artifact-stage-message" role="alert">
          <Box size={30} />
          <p>{t(error)}</p>
          <button
            className="tool-button"
            onClick={() => setRevision((value) => value + 1)}
          >
            {t("retryPreview")}
          </button>
        </div>
      ) : null}
      {loaded && !error ? (
        <div className="artifact-stage-tools">
          <span>{t("modelGestureHint")}</span>
          <button
            className="tool-button"
            onClick={() => {
              const model = viewer.current;
              if (model) {
                model.cameraOrbit = "0deg 75deg auto";
                model.cameraTarget = "auto auto auto";
                model.fieldOfView = "auto";
                model.jumpCameraToGoal();
              }
            }}
          >
            <RotateCcw size={14} />
            {t("resetView")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
