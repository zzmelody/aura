import type { Task } from '@vastai/tripo-sdk';
import type { TripoTask } from './types.ts';
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function optionalEpochMilliseconds(value: unknown): number | undefined {
  const timestamp = optionalNumber(value);
  if (timestamp === undefined) return undefined;
  return timestamp < 100_000_000_000 ? timestamp * 1_000 : timestamp;
}

function safeUrl(value: unknown): string | undefined {
  const text = optionalString(value);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function compactOutput(output: Task['output']): TripoTask['output'] {
  if (!output || typeof output !== 'object') return undefined;
  const result = {
    modelUrl: safeUrl(output.model_url ?? output.model),
    modelUrls: Array.isArray(output.model_urls)
      ? output.model_urls.flatMap((value) => {
          const url = safeUrl(value);
          return url ? [url] : [];
        })
      : undefined,
    baseModelUrl: safeUrl(output.base_model),
    pbrModelUrl: safeUrl(output.pbr_model),
    renderedImageUrl: safeUrl(
      output.rendered_image_url ?? output.rendered_image,
    ),
    riggable: optionalBoolean(output.riggable),
    rigType: optionalString(output.rig_type),
  };
  return Object.values(result).some((value) => value !== undefined)
    ? result
    : undefined;
}

export function toPublicTask(task: Task): TripoTask {
  return {
    taskId: task.task_id,
    type: task.type,
    status: task.status,
    progress: optionalNumber(task.progress),
    createdAt:
      optionalEpochMilliseconds(task.create_time) ??
      (typeof task.created_at === 'string'
        ? Date.parse(task.created_at) || undefined
        : undefined),
    output: compactOutput(task.output),
    error:
      task.error_message || task.error_msg || task.error_code !== undefined
        ? {
            code: optionalNumber(task.error_code),
            message: 'Tripo 任务未能完成。',
          }
        : undefined,
  };
}
