import type { PluginHttpHost } from '@aura/plugin-sdk/backend';
import { FlowError } from '@aura/plugin-sdk/errors';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { methods } from './requests.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export default function createTripoHttp(host: PluginHttpHost) {
  const app = new Hono().basePath('/tripo');
  const jsonLimit = bodyLimit({
    maxSize: 32 * 1024,
    onError: (context) => context.json({ message: 'Tripo 请求过大。' }, 413),
  });
  app.get('/status', async (context) =>
    context.json(
      await host.request<Record<string, unknown>>(
        methods.status,
        {},
        context.req.raw.signal,
      ),
    ),
  );
  app.post('/settings', jsonLimit, async (context) => {
    if (!host.localConfiguration)
      return context.json({ message: 'Tripo 设置仅供本机使用。' }, 403);
    const body = await context.req.json().catch(() => undefined);
    if (!isRecord(body))
      return context.json({ message: 'Tripo 设置无效。' }, 400);
    return context.json(
      await host.request<Record<string, unknown>>(
        methods.save,
        body,
        context.req.raw.signal,
      ),
    );
  });
  app.post('/check', async (context) => {
    if (!host.localConfiguration)
      return context.json({ message: 'Tripo 连接检查仅供本机使用。' }, 403);
    return context.json(
      await host.request<Record<string, unknown>>(
        methods.check,
        {},
        context.req.raw.signal,
      ),
    );
  });
  app.post('/tasks/text-to-model', jsonLimit, async (context) => {
    const input = await context.req.json().catch(() => undefined);
    if (!isRecord(input))
      return context.json({ message: '无效的 Tripo 文生模型请求。' }, 400);
    const requestId = context.req.header('Idempotency-Key');
    return context.json(
      await host.request<Record<string, unknown>>(
        methods.textToModel,
        { ...input, requestId },
        context.req.raw.signal,
      ),
      202,
    );
  });
  app.post('/tasks/image-to-model', jsonLimit, async (context) => {
    const input = await context.req.json().catch(() => undefined);
    if (!isRecord(input))
      return context.json({ message: '无效的 Tripo 图生模型请求。' }, 400);
    const requestId = context.req.header('Idempotency-Key');
    return context.json(
      await host.request<Record<string, unknown>>(
        methods.imageToModel,
        { ...input, requestId },
        context.req.raw.signal,
      ),
      202,
    );
  });
  app.get('/tasks/:taskId', async (context) =>
    context.json(
      await host.request<Record<string, unknown>>(
        methods.getTask,
        { taskId: context.req.param('taskId') },
        context.req.raw.signal,
      ),
    ),
  );
  app.onError((error, context) => {
    if (error instanceof FlowError)
      return context.json(
        { message: error.message },
        error.status as ContentfulStatusCode,
      );
    return context.json({ message: 'Tripo 请求未能完成。' }, 502);
  });
  return { fetch: (request: Request) => app.fetch(request) };
}
