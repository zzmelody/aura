import { createHash } from 'node:crypto';
import { defineBackend } from '@aura/plugin-sdk/backend';
import { FlowError } from '@aura/plugin-sdk/errors';
import type { ActionContext } from '@aura/plugin-sdk/action';
import { TripoAssetService } from './asset-service.ts';
import { TripoBudgetError, TripoBudgetJournal } from './budget.ts';
import { readBudgetSettings, saveBudgetSettings } from './budget-config.ts';
import { methods } from './requests.ts';
import { createTripoService, TripoNotConfiguredError } from './service.ts';
import { tripoSettings } from './settings.ts';
import { parseImageRequest, parseTextRequest } from './task-input.ts';

export default defineBackend({
  async open(host) {
    const settings = tripoSettings(host.dataDir);
    const tripo = await createTripoService({
      region: 'global',
      resolveOptions: settings.connection,
    });
    const assets = new TripoAssetService({
      tripo,
      ledgerDirectory: host.dataDir,
      artifacts: host.media,
      attachments: host.attachments,
    });
    let active = 0;
    let saving = false;

    async function useService<T>(operation: () => Promise<T>): Promise<T> {
      if (saving) throw new FlowError('Tripo 设置正在保存。', 409);
      active++;
      try {
        return await operation();
      } finally {
        active--;
      }
    }

    async function status() {
      await tripo.refresh();
      return { ...tripo.status(), ...(await settings.status()) };
    }

    async function check(signal: AbortSignal) {
      await useService(() => tripo.checkConnection(signal));
      return { connected: true };
    }

    return {
      pageOperations: ['settings', 'save-budget', 'check'],
      async invoke(operation, input, { signal }) {
        const localConfiguration = host.localConfiguration === true;
        if (operation === 'settings') {
          const [connection, budget] = await Promise.all([
            useService(status),
            localConfiguration ? readBudgetSettings(host.dataDir) : null,
          ]);
          return { connection, budget, localConfiguration };
        }
        if (!localConfiguration) throw new Error('tripo_settings_forbidden');
        if (operation === 'save-budget') {
          try {
            return await saveBudgetSettings(host.dataDir, input);
          } catch (error) {
            if (error instanceof TripoBudgetError)
              throw new Error('tripo_budget_busy', { cause: error });
            throw error;
          }
        }
        if (operation === 'check') {
          try {
            return await check(signal);
          } catch (error) {
            if (error instanceof TripoNotConfiguredError)
              throw new Error('tripo_key_missing', { cause: error });
            throw new Error('tripo_check_failed', { cause: error });
          }
        }
        throw new Error('tripo_settings_forbidden');
      },
      services: {
        tripo: {
          invoke: (
            operation: string,
            input: unknown,
            signal: AbortSignal,
            publish?: ActionContext['artifacts'],
          ) =>
            useService(() => assets.invoke(operation, input, signal, publish)),
        },
      },
      requests: {
        prefixes: ['aura.tripo/'],
        async handle(method, input, signal) {
          if (method === methods.legacyCapability) {
            if (typeof input.operation !== 'string')
              throw new FlowError('Tripo 操作无效。', 400);
            const operation = input.operation;
            return useService(() =>
              assets.invoke(operation, input.input, signal),
            );
          }
          try {
            switch (method) {
              case methods.status:
                return await useService(status);
              case methods.save:
                if (saving || active)
                  throw new FlowError('请等待 Tripo 操作结束后再保存。', 409);
                saving = true;
                try {
                  if (
                    await TripoBudgetJournal.hasPendingHttpTasks(host.dataDir)
                  )
                    throw new FlowError(
                      '请查询并结算已提交的 Tripo 任务后再保存。',
                      409,
                    );
                  await settings.save(input);
                  return await status();
                } finally {
                  saving = false;
                }
              case methods.check:
                return await check(signal);
              case methods.textToModel:
              case methods.imageToModel: {
                const { requestId, ...generation } = input;
                if (
                  typeof requestId !== 'string' ||
                  !/^[A-Za-z0-9_.:-]{1,128}$/u.test(requestId)
                )
                  throw new FlowError(
                    'Tripo 任务需要有效的 Idempotency-Key。',
                    400,
                  );
                const key = createHash('sha256')
                  .update(`http:${requestId}`)
                  .digest('hex');
                const submission = (parsed: unknown) => {
                  const journal = new TripoBudgetJournal(
                    host.dataDir,
                    { method, generation: parsed },
                    key,
                  );
                  return {
                    prepare: () => journal.prepare('http', 'model'),
                    submitted: (taskId: string) =>
                      journal.submitted('http', taskId),
                  };
                };
                const submit = async () => {
                  if (method === methods.textToModel) {
                    const parsed = parseTextRequest(generation);
                    if (!parsed)
                      throw new FlowError('无效的 Tripo 文生模型请求。', 400);
                    return tripo.textToModel(
                      parsed,
                      signal,
                      submission(parsed),
                    );
                  }
                  const parsed = parseImageRequest(generation);
                  if (!parsed)
                    throw new FlowError('无效的 Tripo 图生模型请求。', 400);
                  return tripo.imageToModel(parsed, signal, submission(parsed));
                };
                const taskId = await useService(submit);
                return { taskId };
              }
              case methods.getTask: {
                const taskId = input.taskId;
                if (
                  typeof taskId !== 'string' ||
                  !/^[A-Za-z0-9_-]{1,200}$/u.test(taskId)
                )
                  throw new FlowError('无效的 Tripo task ID。', 400);
                return await useService(() =>
                  tripo.getTask(taskId, signal, async (state, credits) => {
                    if (
                      [
                        'success',
                        'failed',
                        'cancelled',
                        'banned',
                        'expired',
                      ].includes(state)
                    )
                      await TripoBudgetJournal.settleHttpTask(
                        host.dataDir,
                        taskId,
                        credits,
                      );
                  }),
                );
              }
              default:
                throw new FlowError('未知的 Tripo 操作。', 404);
            }
          } catch (error) {
            if (error instanceof FlowError) throw error;
            if (error instanceof TripoBudgetError)
              throw new FlowError(error.message, 409);
            if (error instanceof TripoNotConfiguredError)
              throw new FlowError('Tripo 尚未配置 API Key。', 503);
            if (
              method === methods.textToModel ||
              method === methods.imageToModel
            )
              throw new FlowError(
                'Tripo 任务提交结果未知，请核对付费账本。',
                502,
              );
            throw new FlowError(
              'Tripo 请求失败，请检查地区、密钥和网络。',
              502,
            );
          }
        },
      },
    };
  },
});
