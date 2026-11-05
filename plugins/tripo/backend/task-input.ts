import type {
  TripoGenerationOptions,
  TripoImageToModelRequest,
  TripoTextToModelRequest,
} from './types.ts';
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const generationKeys = new Set([
  'model',
  'texture',
  'pbr',
  'faceLimit',
  'textureQuality',
  'geometryQuality',
  'quad',
  'generateParts',
]);

function hasOnlyKeys(body: Record<string, unknown>, allowed: Set<string>) {
  return Object.keys(body).every((key) => allowed.has(key));
}

function optionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean';
}

function optionalQuality(
  value: unknown,
): value is 'standard' | 'detailed' | undefined {
  return value === undefined || value === 'standard' || value === 'detailed';
}

function parseGenerationOptions(
  body: Record<string, unknown>,
): TripoGenerationOptions | undefined {
  if (
    !optionalBoolean(body.texture) ||
    !optionalBoolean(body.pbr) ||
    !optionalBoolean(body.quad) ||
    !optionalBoolean(body.generateParts) ||
    !optionalQuality(body.textureQuality) ||
    !optionalQuality(body.geometryQuality) ||
    (body.model !== undefined &&
      (typeof body.model !== 'string' ||
        body.model.length < 1 ||
        body.model.length > 128)) ||
    (body.faceLimit !== undefined &&
      (!Number.isSafeInteger(body.faceLimit) ||
        (body.faceLimit as number) < 1 ||
        (body.faceLimit as number) > 1_000_000))
  )
    return undefined;

  return {
    model: body.model as string | undefined,
    texture: body.texture,
    pbr: body.pbr,
    faceLimit: body.faceLimit as number | undefined,
    textureQuality: body.textureQuality as 'standard' | 'detailed' | undefined,
    geometryQuality: body.geometryQuality as
      'standard' | 'detailed' | undefined,
    quad: body.quad,
    generateParts: body.generateParts,
  };
}

export function parseTextRequest(
  value: unknown,
): TripoTextToModelRequest | undefined {
  if (!isRecord(value)) return undefined;
  const allowed = new Set([...generationKeys, 'prompt', 'negativePrompt']);
  if (
    !hasOnlyKeys(value, allowed) ||
    typeof value.prompt !== 'string' ||
    value.prompt.trim().length < 1 ||
    value.prompt.length > 1_024 ||
    (value.negativePrompt !== undefined &&
      (typeof value.negativePrompt !== 'string' ||
        value.negativePrompt.length > 1_024))
  )
    return undefined;
  const options = parseGenerationOptions(value);
  return options
    ? {
        ...options,
        prompt: value.prompt,
        negativePrompt: value.negativePrompt as string | undefined,
      }
    : undefined;
}

export function parseImageRequest(
  value: unknown,
): TripoImageToModelRequest | undefined {
  if (!isRecord(value)) return undefined;
  const allowed = new Set([...generationKeys, 'image']);
  if (!hasOnlyKeys(value, allowed) || !isRecord(value.image)) return undefined;
  const imageKeys = Object.keys(value.image);
  let image: TripoImageToModelRequest['image'] | undefined;
  if (
    imageKeys.length === 1 &&
    typeof value.image.url === 'string' &&
    value.image.url.length <= 4_096
  ) {
    try {
      const url = new URL(value.image.url);
      if (url.protocol === 'https:' && !url.username && !url.password)
        image = { url: url.href };
    } catch {
      // The stable client validation response is returned below.
    }
  } else if (
    imageKeys.length === 1 &&
    typeof value.image.fileToken === 'string' &&
    /^[A-Za-z0-9_-]{1,512}$/.test(value.image.fileToken)
  ) {
    image = { fileToken: value.image.fileToken };
  }
  const options = parseGenerationOptions(value);
  return image && options ? { ...options, image } : undefined;
}
