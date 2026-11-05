// @ts-check
import { ActionFailure, defineAction } from '@aura/plugin-sdk/action';

export default defineAction({
  title: '生成 Tripo 游戏模型',
  description:
    '用四张一致视图生成可用于游戏的 GLB 模型。付费阶段使用 Tripo 插件账本。',
  parameters: {
    prompt: { type: 'string', required: true },
    referenceImagePath: { type: 'string' },
    referenceImage: {
      type: 'object',
      additionalProperties: false,
      properties: {
        attachmentId: { type: 'string', required: true },
        mediaType: {
          type: 'string',
          enum: ['image/png', 'image/jpeg', 'image/webp'],
          required: true,
        },
        bytes: { type: 'integer', required: true },
        width: { type: 'integer', required: true },
        height: { type: 'integer', required: true },
      },
    },
    outputDirectory: { type: 'string' },
    assetName: { type: 'string' },
    imageModel: {
      type: 'string',
      enum: ['chat_image_2.5_flare', 'chat_image_2.5_sunburst'],
    },
    imageQuality: {
      type: 'string',
      enum: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    faceLimit: { type: 'integer' },
    generationKey: { type: 'string' },
    scope: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', required: true },
        noNewPaidWork: { type: 'boolean' },
      },
    },
  },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: (_input, output) => [
      { type: 'text', text: JSON.stringify(output) },
    ],
  },
  timeoutMs: 600_000,
  recovery: 'manual',
  async execute(context, input) {
    const service =
      /** @type {{ invoke: import('../../backend/asset-service.ts').TripoAssetService['invoke'] } | undefined} */ (
        context.services?.tripo
      );
    if (!service) {
      throw new ActionFailure('Tripo 后端暂不可用。');
    }
    return service.invoke('generate', input, context.signal, context.artifacts);
  },
});
