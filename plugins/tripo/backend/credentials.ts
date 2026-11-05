import { readFile } from 'node:fs/promises';
export async function readStoredApiKey(
  path: string,
): Promise<string | undefined> {
  try {
    const value = (await readFile(path, 'utf8')).trim();
    return value || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Backend-only Tripo v3 adapter. It never exposes the API key or raw envelopes. */
