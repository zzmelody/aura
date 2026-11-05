import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FlowError } from '@aura/plugin-sdk/errors';
import { z } from '@aura/plugin-sdk/flow';

const region = z.enum(['global', 'china']);
const key = z.string().trim().min(1).max(256).regex(/^\S+$/u);
const storedSettings = z.object({
  revision: z.string(),
  region,
  key: key.optional(),
});
const editSettings = storedSettings
  .extend({ clearKey: z.boolean().optional() })
  .strict()
  .refine((value) => !(value.clearKey && value.key));

export function tripoSettings(directory: string) {
  const path = join(directory, 'settings.json');
  const read = async (): Promise<z.infer<typeof storedSettings>> => {
    try {
      return storedSettings.parse(JSON.parse(await readFile(path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new FlowError('Tripo 插件设置无法读取。', 500);
      }
      const defaultRegion = region.safeParse(
        process.env.AURA_TRIPO_REGION?.trim().toLowerCase() || 'global',
      );
      if (!defaultRegion.success)
        throw new FlowError('Tripo 插件地区设置无效。', 500);
      return { revision: '0', region: defaultRegion.data };
    }
  };
  const environmentKey = () => process.env.TRIPO_API_KEY?.trim() || undefined;
  return {
    async connection() {
      const settings = await read();
      return {
        region: settings.region,
        apiKey: environmentKey() ?? settings.key,
      };
    },
    async status() {
      const { revision } = await read();
      return { revision, readOnly: Boolean(environmentKey()) };
    },
    async save(input: unknown) {
      const parsed = editSettings.safeParse(input);
      if (!parsed.success) throw new FlowError('Tripo 设置无效。', 400);
      if (environmentKey())
        throw new FlowError('Tripo Key 由启动环境提供。', 409);
      const previous = await read();
      if (previous.revision !== parsed.data.revision) {
        throw new FlowError('Tripo 设置已更新，请重新读取后保存。', 409);
      }
      const { region, key, clearKey } = parsed.data;
      const next = {
        revision: randomUUID(),
        region,
        key: clearKey ? undefined : (key ?? previous.key),
      };
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(next), {
          flag: 'wx',
          mode: 0o600,
        });
        await rename(temporary, path);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    },
  };
}
