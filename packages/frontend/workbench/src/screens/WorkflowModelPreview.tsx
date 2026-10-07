import React, { useEffect, useRef, useState } from "react";
import { Box, LoaderCircle, RotateCcw } from "lucide-react";
import type { ModelViewerElement } from "@google/model-viewer";

export function WorkflowModelPreview({
  src,
  name,
}: {
  src: string;
  name: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const viewer = useRef<ModelViewerElement | null>(null);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let disposed = false;
    let model: ModelViewerElement | undefined;
    setLoaded(false);
    setError("");
    setProgress(0);
    const timeout = setTimeout(
      () => setError("模型加载超时，可重试或下载查看。"),
      60_000,
    );
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
          setError("");
        }
      });
      model.addEventListener("error", () => {
        if (!disposed) {
          clearTimeout(timeout);
          setError(
            "模型无法渲染，可能是文件格式或设备图形能力不支持。可重试或下载查看。",
          );
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
        setError("3D 查看器加载失败，请重试。");
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
          <span>正在加载模型 · {progress}%</span>
        </div>
      ) : null}
      {error ? (
        <div className="artifact-stage-message" role="alert">
          <Box size={30} />
          <p>{error}</p>
          <button
            className="tool-button"
            onClick={() => setRevision((value) => value + 1)}
          >
            重试预览
          </button>
        </div>
      ) : null}
      {loaded && !error ? (
        <div className="artifact-stage-tools">
          <span>拖动旋转 · 滚轮缩放 · 右键或双指平移</span>
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
            重置视角
          </button>
        </div>
      ) : null}
    </div>
  );
}
