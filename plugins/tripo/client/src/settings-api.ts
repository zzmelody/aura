import type { ConnectionSettings } from '../../shared/settings.ts';

const errors: Record<string, string> = {
  tripo_settings_forbidden: 'Tripo 设置和连接检查仅供本机使用。',
  tripo_budget_invalid: '每项额度须大于 0 且不超过 1,000,000。',
  tripo_budget_stale: '预算已更新，请重新读取后保存。',
  tripo_budget_busy: '账本正在处理付费记录，请稍后再保存。',
  tripo_key_missing: '请先保存 Tripo API Key。',
  tripo_check_failed: '连接失败，请检查地区、Key 和网络。',
  page_operation_failed: '暂时无法读取或保存 Tripo 设置。',
};

export function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  return (
    (Object.hasOwn(errors, message) && errors[message]) ||
    message ||
    'Tripo 设置操作失败。'
  );
}

export async function saveConnection(
  endpoint: string,
  input: {
    revision: string;
    region: ConnectionSettings['region'];
    key?: string;
    clearKey?: boolean;
  },
  signal: AbortSignal,
): Promise<ConnectionSettings> {
  // The dedicated local HTTP route accepts the write-only key outside page operations.
  const response = await fetch(new URL('/tripo/settings', endpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  });
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    throw new Error(
      typeof result?.message === 'string'
        ? result.message
        : 'Tripo 连接设置保存失败。',
    );
  }
  return response.json();
}
