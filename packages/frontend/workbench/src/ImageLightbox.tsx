import { useToolMessages } from "./tool-messages.ts";
import React, { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Image as ImageIcon, X } from "lucide-react";
import { ImagePreview } from "./screens/WorkflowArtifacts";

export interface LightboxImage {
  /** Stable key; also used to pick the starting image. */
  key: string;
  src: string;
  name: string;
}

/** Thumbnails that open the in-app viewer; each one is a keyboard button. */
export function ImageThumbnails({
  images,
  className,
  lazy = false,
}: {
  images: LightboxImage[];
  className: string;
  lazy?: boolean;
}) {
  const { t } = useToolMessages();
  const [open, setOpen] = useState<string>();
  if (!images.length) return null;
  return (
    <div className={className}>
      {images.map((image) => (
        <button
          key={image.key}
          type="button"
          className="image-thumbnail"
          title={image.name}
          aria-label={t("viewLarge", { name: image.name })}
          onClick={() => setOpen(image.key)}
        >
          <img
            src={image.src}
            alt={image.name}
            loading={lazy ? "lazy" : undefined}
          />
        </button>
      ))}
      {open ? (
        <ImageLightbox
          images={images}
          initial={open}
          close={() => setOpen(undefined)}
        />
      ) : null}
    </div>
  );
}

/**
 * In-app full-size viewer for chat images. Links with `target="_blank"` to the
 * local runtime are denied by the desktop window handler, so images open here.
 */
export function ImageLightbox({
  images,
  initial,
  close,
}: {
  images: LightboxImage[];
  initial: string;
  close(): void;
}) {
  const { t } = useToolMessages();
  const dialog = useRef<HTMLDialogElement>(null);
  const [index, setIndex] = useState(() =>
    Math.max(
      0,
      images.findIndex((image) => image.key === initial),
    ),
  );
  const image = images[Math.min(index, images.length - 1)];
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current!;
    element.showModal();
    return () => {
      element.close();
      previous?.focus({ preventScroll: true });
    };
  }, []);
  if (!image) return null;
  const move = (direction: number) =>
    setIndex((value) => (value + direction + images.length) % images.length);
  return (
    <dialog
      ref={dialog}
      className="artifact-dialog"
      aria-label={t("viewImage", { name: image.name })}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === dialog.current) close();
      }}
      onKeyDown={(event) => {
        if (images.length < 2) return;
        if (event.key === "ArrowLeft") move(-1);
        if (event.key === "ArrowRight") move(1);
      }}
    >
      <div className="artifact-dialog-inner">
        <header className="artifact-dialog-header">
          <div>
            <ImageIcon size={18} />
            <span>
              <strong>{image.name}</strong>
            </span>
          </div>
          <div className="artifact-dialog-actions">
            <button
              type="button"
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
          <ImagePreview key={image.key} src={image.src} name={image.name} />
        </div>
        <footer className="artifact-dialog-footer">
          <span>{t("zoomHint")}</span>
          {images.length > 1 ? (
            <div>
              <button
                type="button"
                className="icon-control"
                aria-label={t("previousImage")}
                onClick={() => move(-1)}
              >
                <ChevronLeft size={18} />
              </button>
              <span>
                {t("imagePosition", { index: index + 1, total: images.length })}
              </span>
              <button
                type="button"
                className="icon-control"
                aria-label={t("nextImage")}
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
