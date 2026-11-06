import { conversationMessage as message } from "./conversation-messages.ts";
import { errorMessage, type MessageReference } from "@aura/i18n/runtime";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SetStateAction } from "react";
import type { ChatImage } from "@aura/core/types";
import {
  CHAT_IMAGE_LIMIT,
  chatImageType,
  uploadChatImage,
} from "./chatImages.ts";

export type Attachment = {
  key: string;
  preview: string;
  name: string;
  image?: ChatImage;
  error?: string | MessageReference;
};

/**
 * Images from the clipboard: screenshots and copied browser images often
 * arrive only as clipboard items, with an empty `files` list.
 */
export function pastedImages(data: DataTransfer, now = Date.now()): File[] {
  const files = Array.from(data.files);
  if (!files.length)
    for (const item of Array.from(data.items))
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
  return files
    .filter((file) => chatImageType(file))
    .map((file, index) => {
      // Clipboard images are usually all named "image.png"; keep them apart.
      if (file.name && file.name !== "image.png") return file;
      const type = chatImageType(file) ?? "image/png";
      return new File(
        [file],
        `粘贴的图片-${now}-${index + 1}.${type.split("/")[1]}`,
        {
          type,
        },
      );
    });
}

/**
 * Composer image attachments: pick, paste or drop, upload immediately, and
 * keep a local preview until the message is sent.
 */
export function useImageAttachments(endpoint: string, scope = "draft") {
  const [drafts, setDrafts] = useState<Record<string, Attachment[]>>({});
  const [errors, setErrors] = useState<
    Record<string, string | MessageReference>
  >({});
  const attachments = drafts[scope] ?? [];
  const error = errors[scope] ?? "";
  // Upload callbacks retain the scope they started in, even after navigation.
  const setAttachments = useCallback(
    (change: SetStateAction<Attachment[]>) =>
      setDrafts((current) => ({
        ...current,
        [scope]:
          typeof change === "function" ? change(current[scope] ?? []) : change,
      })),
    [scope],
  );
  const setError = useCallback(
    (message: string | MessageReference) =>
      setErrors((current) => ({ ...current, [scope]: message })),
    [scope],
  );
  const previews = useRef(new Set<string>());
  useEffect(() => {
    const urls = previews.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, []);

  function release(preview: string) {
    URL.revokeObjectURL(preview);
    previews.current.delete(preview);
  }

  function attach(files: FileList | File[]) {
    setError("");
    const accepted = Array.from(files).filter((file) => chatImageType(file));
    if (!accepted.length) {
      setError(message("imageType"));
      return;
    }
    const room = CHAT_IMAGE_LIMIT - attachments.length;
    if (accepted.length > room)
      setError(message("imageLimit", { limit: CHAT_IMAGE_LIMIT }));
    for (const file of accepted.slice(0, Math.max(0, room))) {
      const key = crypto.randomUUID();
      const preview = URL.createObjectURL(file);
      previews.current.add(preview);
      setAttachments((current) => [
        ...current,
        { key, preview, name: file.name || "image" },
      ]);
      uploadChatImage(endpoint, file)
        .then((image) =>
          setAttachments((current) =>
            current.map((item) =>
              item.key === key ? { ...item, image } : item,
            ),
          ),
        )
        .catch((cause: unknown) =>
          setAttachments((current) =>
            current.map((item) =>
              item.key === key
                ? {
                    ...item,
                    error: errorMessage(cause, message("uploadFailed")),
                  }
                : item,
            ),
          ),
        );
    }
  }

  function detach(key: string) {
    setAttachments((current) => {
      const item = current.find((value) => value.key === key);
      if (item) release(item.preview);
      return current.filter((value) => value.key !== key);
    });
  }

  function clear() {
    // Sent messages render from the server copy, so local previews can go.
    for (const item of attachments) release(item.preview);
    setAttachments([]);
    setError("");
  }

  /** Transfers a completed attachment draft when its first turn gets an ID. */
  function moveTo(nextScope: string) {
    if (nextScope === scope) return;
    setDrafts((current) => {
      const { [scope]: selected, ...rest } = current;
      return selected ? { ...rest, [nextScope]: selected } : current;
    });
    setErrors((current) => {
      const { [scope]: selected, ...rest } = current;
      return selected ? { ...rest, [nextScope]: selected } : current;
    });
  }

  return {
    attachments,
    /** Uploaded images, ready to send. */
    ready: attachments.flatMap((item) => (item.image ? [item.image] : [])),
    uploading: attachments.some((item) => !item.image && !item.error),
    full: attachments.length >= CHAT_IMAGE_LIMIT,
    error,
    setError,
    attach,
    detach,
    clear,
    moveTo,
  };
}

export type ImageAttachments = ReturnType<typeof useImageAttachments>;
