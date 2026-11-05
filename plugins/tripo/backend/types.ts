export type TripoRegion = 'global' | 'china';
export type TripoFeature = 'text-to-model' | 'image-to-model' | 'task-status';

/** Credential-free capability status exposed by the backend. */
export interface TripoIntegrationStatus {
  configured: boolean;
  region: TripoRegion;
  apiVersion: 'v3';
  features: TripoFeature[];
}

export interface TripoGenerationOptions {
  model?: string;
  texture?: boolean;
  pbr?: boolean;
  faceLimit?: number;
  textureQuality?: 'standard' | 'detailed';
  geometryQuality?: 'standard' | 'detailed';
  quad?: boolean;
  generateParts?: boolean;
}

export interface TripoTextToModelRequest extends TripoGenerationOptions {
  prompt: string;
  negativePrompt?: string;
}

export interface TripoImageToModelRequest extends TripoGenerationOptions {
  image: { url: string } | { fileToken: string };
}

export interface TripoCreateTaskResponse {
  taskId: string;
}

export type TripoTaskStatus =
  | 'queued'
  | 'running'
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'unknown'
  | 'banned'
  | 'expired';

/** Stable projection of a Tripo task; undocumented upstream fields are omitted. */
export interface TripoTask {
  taskId: string;
  type: string;
  status: TripoTaskStatus;
  progress?: number;
  createdAt?: number;
  output?: {
    modelUrl?: string;
    modelUrls?: string[];
    baseModelUrl?: string;
    pbrModelUrl?: string;
    renderedImageUrl?: string;
    riggable?: boolean;
    rigType?: string;
  };
  error?: { code?: number; message?: string };
}
