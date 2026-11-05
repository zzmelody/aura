// @ts-check
import { ActionFailure, defineAction } from '@aura/plugin-sdk/action';

export default defineAction({
  title: '生成 Tripo 图片',
  description: '生成一张图片并返回受管资产 ID。付费阶段使用 Tripo 插件账本。',
  parameters: {
    prompt: { type: 'string', required: true },
    model: {
      type: 'string',
      enum: ['chat_image_2.5_flare', 'chat_image_2.5_sunburst'],
    },
    quality: { type: 'string', enum: ['low', 'medium', 'high'] },
    generationKey: { type: 'string' },
    scope: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', required: true },
        noNewPaidWork: { type: 'boolean' },
      },
    },
    attach: { type: 'boolean' },
  },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: (_input, output) => [
      { type: 'text', text: JSON.stringify(output) },
    ],
  },
  timeoutMs: 180_000,
  recovery: 'manual',
  async execute(context, input) {
    const service =
      /** @type {{ invoke: import('../../backend/asset-service.ts').TripoAssetService['invoke'] } | undefined} */ (
        context.services?.tripo
      );
    if (!service) {
      throw new ActionFailure('Tripo 后端暂不可用。');
    }
    return service.invoke('image', input, context.signal, context.artifacts);
  },
});
