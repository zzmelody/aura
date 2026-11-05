// @ts-check
import { ActionFailure, defineAction } from '@aura/plugin-sdk/action';

export default defineAction({
  title: '读取 Tripo 付费账本',
  description: '查看一个 scope 的付费阶段与待结算状态。',
  parameters: { scope: { type: 'string', required: true } },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: (_input, output) => [
      { type: 'text', text: JSON.stringify(output) },
    ],
  },
  recovery: 'idempotent',
  async execute(context, input) {
    const service =
      /** @type {{ invoke: import('../../backend/asset-service.ts').TripoAssetService['invoke'] } | undefined} */ (
        context.services?.tripo
      );
    if (!service) {
      throw new ActionFailure('Tripo 后端暂不可用。');
    }
    return service.invoke('ledger', input, context.signal, context.artifacts);
  },
});
