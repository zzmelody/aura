/** Reads a bounded request body; the server owns Node HTTP and Buffer handling. */
export async function readJson(req, limit = 256 * 1024) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw new Error("请求过大。");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
