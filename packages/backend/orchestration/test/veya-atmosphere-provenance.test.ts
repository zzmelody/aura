import assert from "node:assert/strict";
import test from "node:test";
import { expectedAtmosphereSources, environmentShaderPins, matchesEnvironmentShader } from "../src/veya-atmosphere-provenance.ts";
import { materialIdentity, materialSubmissionFingerprint } from "../src/veya-creator-materials.ts";

const sources = { schema_version: 1, shader_sha256: "a".repeat(64), recipe_sha256: "b".repeat(64), template_sha256: "c".repeat(64) };
const camel = { schemaVersion: 1, shaderSha256: sources.shader_sha256, recipeSha256: sources.recipe_sha256, templateSha256: sources.template_sha256 };
const request = { presetId: "blue_hour", seed: 1, source: "procedural", cloudAmount: 0, cloudScale: 1, haze: 0, warmth: 0, brightness: 0 };
test("atmosphere fingerprints preserve legacy work and distinguish exact native source identities", () => {
  const legacy = materialSubmissionFingerprint("veya.atmosphere.build", request);
  assert.equal(legacy, materialIdentity(["blue_hour", 1, "procedural", 0, 1, 0, 0, 0, null]));
  const next = materialSubmissionFingerprint("veya.atmosphere.build", { ...request, expectedSources: camel });
  assert.notEqual(next, legacy);
  assert.equal(next, materialSubmissionFingerprint("veya.atmosphere.build", { preset_id: "blue_hour", seed: 1, source: "procedural",
    cloud_amount: 0, cloud_scale: 1, haze: 0, warmth: 0, brightness: 0, expected_sources: sources, request_id: "another" }));
  for (const key of ["shader_sha256", "recipe_sha256", "template_sha256"])
    assert.notEqual(next, materialSubmissionFingerprint("veya.atmosphere.build", { ...request, expected_sources: { ...sources, [key]: "d".repeat(64) } }));
  assert.deepEqual(expectedAtmosphereSources({ expectedSources: camel }), sources);
  for (const input of [{ expected_sources: null }, { expected_sources: {} }, { expectedSources: camel, expected_sources: sources },
    { expected_sources: { ...sources, schema_version: 2 } }, { expected_sources: { ...sources, shader_sha256: "A".repeat(64) } },
    { expected_sources: { ...sources, extra: "bypass" } }, { expectedSources: { ...camel, shaderSha256: "res://anything" } }])
    assert.throws(() => materialSubmissionFingerprint("veya.atmosphere.build", { ...request, ...input }), /invalid_atmosphere_sources/);
});

test("environment shader claims require exact native resource and shader hashes", () => {
  const atmosphere = { assetId: "sky", contentHash: "d".repeat(64), shaderHash: sources.shader_sha256 };
  const [pin] = environmentShaderPins({ atmosphere, nested: { atmosphere } }); assert.ok(pin);
  assert.equal(environmentShaderPins({ atmosphere }).length, 1);
  const native = { type: "environment", content_hash: atmosphere.contentHash, atmosphere: { shader_sha256: sources.shader_sha256 } };
  assert.equal(matchesEnvironmentShader(pin, native), true);
  for (const value of [{ ...native, type: "model" }, { ...native, content_hash: "e".repeat(64) }, { ...native, atmosphere: {} }])
    assert.equal(matchesEnvironmentShader(pin, value), false);
  assert.throws(() => environmentShaderPins({ atmosphere: { ...atmosphere, shaderHash: "guessed" } }), /provenance_invalid/);
  assert.throws(() => environmentShaderPins([atmosphere, { ...atmosphere, shaderHash: "f".repeat(64) }]), /provenance_invalid/);
});
