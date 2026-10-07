/**
 * Accepts an HTTP origin without embedded credentials, paths or query parameters.
 */
export function validateEndpoint(input: string): string | null {
  try {
    const url = new URL(input.trim());
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      return null;
    return url.origin;
  } catch {
    // URL parsing rejects malformed user-entered addresses.
    return null;
  }
}
