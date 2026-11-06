import type { ConnectionSettings } from '../../shared/settings.ts';

export function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  return message || 'operationFailed';
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
      typeof result?.message === 'string' ? result.message : 'operationFailed',
    );
  }
  return response.json();
}
