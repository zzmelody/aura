/** Native atmosphere source identity; never a model-supplied executable path. */
export type AtmosphereSources = { schema_version: 1; shader_sha256: string; recipe_sha256: string; template_sha256: string };
const object = (v: unknown): Record<string, any> | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : undefined;
const hash = /^[a-f0-9]{64}$/u;
export function expectedAtmosphereSources(input: unknown): AtmosphereSources | undefined {
  const value = object(input);
  if (!value) throw new Error("invalid_atmosphere_sources");
  const camel = Object.hasOwn(value, "expectedSources"), snake = Object.hasOwn(value, "expected_sources");
  if (!camel && !snake) return undefined;
  if (camel && snake) throw new Error("invalid_atmosphere_sources");
  const sources = object(value[camel ? "expectedSources" : "expected_sources"]);
  const keys = camel ? ["schemaVersion", "shaderSha256", "recipeSha256", "templateSha256"] : ["schema_version", "shader_sha256", "recipe_sha256", "template_sha256"];
  if (!sources || Object.keys(sources).length !== 4 || keys.some(k => !Object.hasOwn(sources, k)) || sources[keys[0]!] !== 1 ||
      keys.slice(1).some(k => typeof sources[k] !== "string" || !hash.test(sources[k]))) throw new Error("invalid_atmosphere_sources");
  return { schema_version: 1, shader_sha256: sources[keys[1]!], recipe_sha256: sources[keys[2]!], template_sha256: sources[keys[3]!] };
}
export type EnvironmentShaderPin = { assetId: string; contentHash: string; shaderHash: string };
export function environmentShaderPins(value: unknown): EnvironmentShaderPin[] {
  const pins = new Map<string, EnvironmentShaderPin>();
  function visit(v: unknown): void {
    if (Array.isArray(v)) { v.forEach(visit); return; }
    const record = object(v); if (!record) return;
    if (Object.hasOwn(record, "shaderHash")) {
      if (typeof record.assetId !== "string" || !/^[A-Za-z0-9_.:-]{1,192}$/u.test(record.assetId) || !hash.test(record.contentHash) ||
          typeof record.shaderHash !== "string" || !hash.test(record.shaderHash)) throw new Error("environment_shader_provenance_invalid");
      const pin = { assetId: record.assetId, contentHash: record.contentHash, shaderHash: record.shaderHash };
      const previous = pins.get(pin.assetId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(pin)) throw new Error("environment_shader_provenance_invalid");
      pins.set(pin.assetId, pin);
    }
    Object.values(record).forEach(visit);
  }
  visit(value); return [...pins.values()];
}
export function matchesEnvironmentShader(pin: EnvironmentShaderPin, native: unknown): boolean {
  const asset = object(native), atmosphere = object(asset?.atmosphere);
  return asset?.content_hash === pin.contentHash && ["environment", "Environment"].includes(asset.type) && atmosphere?.shader_sha256 === pin.shaderHash;
}
