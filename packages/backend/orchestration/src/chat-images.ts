import type { GeneratedArtifacts } from "./artifacts/generated.ts";
import type { ChatTurn } from "./types.ts";
import { CHAT_IMAGE_LIMIT } from "@aura/protocol/types";
type ImagePart = {
  type: "image";
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  data: string;
  name: string;
};

/**
 * The newest images go to the model, up to the request limit; every message
 * keeps a text marker so the model knows which turn each picture belongs to.
 * Demo mode cannot see images and only receives the marker.
 */
export async function chatImages(
  turn: ChatTurn,
  store: Pick<GeneratedArtifacts, "readImage">,
  signal: AbortSignal,
) {
  const chosen = new Set<string>();
  if (turn.mode !== "demo")
    for (const message of [...turn.messages].reverse())
      for (const id of [...(message.images ?? [])].reverse())
        if (chosen.size < CHAT_IMAGE_LIMIT) chosen.add(id);
  const labels = new Map<string, string>();
  for (const message of turn.messages)
    for (const id of message.images ?? [])
      if (chosen.has(id) && !labels.has(id))
        labels.set(id, `图${labels.size + 1}`);
  const parts: ImagePart[] = [];
  for (const [id, label] of labels) {
    const image = await store.readImage(id, signal);
    parts.push({
      type: "image",
      mediaType: image.mediaType,
      data: image.bytes.toString("base64"),
      name: label,
    });
  }
  const history = turn.messages.map(({ role, text, images }) => {
    if (!images?.length) return { role, text };
    const note =
      turn.mode !== "demo"
        ? `[用户附图：${images.map((id) => labels.get(id) ?? "较早的图片，未随本次请求附带").join("、")}]`
        : `[用户附了 ${images.length} 张图片；演示模型无法查看图片内容]`;
    return { role, text: text ? `${text}\n${note}` : note };
  });
  return { history, parts };
}
