import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { GeneratedArtifacts } from "../src/generated-artifacts.ts";
import { VEYA_MATERIAL_MAKER_CAPABILITY, VeyaMaterialMakerCapability, validatePtex } from "../src/veya-material-maker.ts";

const graph = {
  type: "graph", name: "g", nodes: [
    { type: "perlin", name: "perlin_0", parameters: { scale_x: 4, scale_y: 4 } },
    { type: "material", name: "Material", parameters: { size: 11 } },
  ],
  connections: [{ from: "perlin_0", from_port: 0, to: "Material", to_port: 0 }],
};

test("whitelist rejects custom GLSL, export scripts and image nodes", () => {
  assert.equal(validatePtex({ type: "graph", nodes: [{ type: "shader", name: "s", shader_model: { code: "void main(){}" } }] }).ok, false);
  assert.equal(validatePtex({ type: "graph", nodes: [{ type: "material", name: "Material", custom: "func process_option_x(s): return s" }] }).ok, false);
  assert.equal(validatePtex({ type: "graph", nodes: [{ type: "image", name: "photo" }, { type: "material", name: "Material" }] }).ok, false);
  assert.equal(validatePtex({ type: "graph", nodes: [{ type: "voronoi", name: "v" }, { type: "material", name: "Material" }] }).ok, false);
  assert.equal(validatePtex(graph).ok, true);
});

test("successful bake registers albedo even when the process exits nonzero", async () => {
  const root = await mkdtemp(join(tmpdir(), "aura-material-maker-"));
  try {
    const png = await sharp({ create: { width: 2048, height: 2048, channels: 4, background: { r: 120, g: 80, b: 40, alpha: 1 } } }).png().toBuffer();
    let bakes = 0;
    const capability = new VeyaMaterialMakerCapability(new GeneratedArtifacts(join(root, "store")), {
      async saveImage() { return { attachmentId: "sha256:" + "a".repeat(64) }; },
    }, {
      async bake({ outputDir }) {
        bakes++;
        await writeFile(join(outputDir, "material_albedo.png"), png);
        return { exitCode: 1 };
      },
    }, "material_maker.exe", root);
    const first = await capability.invoke(VEYA_MATERIAL_MAKER_CAPABILITY, "bake", { generationKey: "b".repeat(64), ptex: graph }, new AbortController().signal) as { status: string, maps: { albedo: { artifactId: string } } };
    assert.equal(first.status, "ready");
    const second = await capability.invoke(VEYA_MATERIAL_MAKER_CAPABILITY, "bake", { generationKey: "b".repeat(64), ptex: graph }, new AbortController().signal) as { status: string };
    assert.equal(second.status, "ready");
    assert.equal(bakes, 1);
    await assert.rejects(capability.invoke(VEYA_MATERIAL_MAKER_CAPABILITY, "bake", { generationKey: "b".repeat(64), ptex: { ...graph, name: "changed" } }, new AbortController().signal), /material_identity_conflict/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("missing albedo is a bake failure, not a retryable crash", async () => {
  const capability = new VeyaMaterialMakerCapability({} as GeneratedArtifacts, { async saveImage() { return {}; } }, {
    async bake() { return { exitCode: 0 }; },
  }, "material_maker.exe");
  const result = await capability.invoke(VEYA_MATERIAL_MAKER_CAPABILITY, "bake", { ptex: graph }, new AbortController().signal) as { status: string };
  assert.equal(result.status, "bake_failed");
});

test("pinned Veya build is found from the plugin root and env overrides it", async () => {
  const { resolveMaterialMakerExecutable, veyaProjectRootsFromPlugins } = await import("../src/veya-material-maker.ts");
  const root = await mkdtemp(join(tmpdir(), "aura-mm-resolve-"));
  try {
    const commit = "e".repeat(40);
    await mkdir(join(root, "tools"), { recursive: true });
    await writeFile(join(root, "tools", "material-maker-dependency.json"), JSON.stringify({ commit }));
    const roots = veyaProjectRootsFromPlugins([join(root, "aura-plugin"), undefined]);
    assert.equal(resolveMaterialMakerExecutable(roots, {}), "", "no build yet");
    const output = join(root, "build", "material-maker", commit);
    await mkdir(output, { recursive: true });
    const exe = join(output, process.platform === "win32" ? "material_maker.exe" : "material_maker");
    await writeFile(exe, "x");
    assert.equal(resolveMaterialMakerExecutable(roots, {}), "", "incomplete build without BUILD_OK");
    await writeFile(join(output, "BUILD_OK"), commit);
    assert.equal(resolveMaterialMakerExecutable(roots, {}), exe);
    assert.equal(resolveMaterialMakerExecutable(roots, { VEYA_MATERIAL_MAKER: "C:/override.exe" }), "C:/override.exe");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("opt-in: real pinned Material Maker bakes an admitted graph", { skip: !process.env.VEYA_MATERIAL_MAKER_LIVE }, async () => {
  const { readFile: read } = await import("node:fs/promises");
  const { resolveMaterialMakerExecutable } = await import("../src/veya-material-maker.ts");
  const veya = process.env.VEYA_MATERIAL_MAKER_LIVE!;
  const executable = resolveMaterialMakerExecutable([veya], {});
  assert.ok(executable, "pinned Material Maker build is missing; run tools/build-material-maker.ps1");
  const ptex = JSON.parse(await read(join(executable, "..", "examples", "rusted_metal.ptex"), "utf8"));
  const root = await mkdtemp(join(tmpdir(), "aura-mm-live-"));
  try {
    const capability = new VeyaMaterialMakerCapability(new GeneratedArtifacts(join(root, "store")),
      { async saveImage() { return { attachmentId: "sha256:" + "a".repeat(64) }; } }, undefined, executable);
    const result = await capability.invoke(VEYA_MATERIAL_MAKER_CAPABILITY, "bake", { ptex }, new AbortController().signal) as
      { status: string; reason?: string; maps?: Record<string, { artifactId: string; width: number }> };
    assert.equal(result.status, "ready", result.reason);
    assert.equal(result.maps?.albedo?.width, 2048);
    assert.ok(result.maps?.orm?.artifactId);
  } finally { await rm(root, { recursive: true, force: true }); }
});
