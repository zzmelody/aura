import assert from "node:assert/strict";
import test from "node:test";
import { fontStacks, palettes } from "@aura/ui/theme";
import {
  appearancePalette,
  appearanceVariables,
  defaultAppearance,
  normalizeAppearance,
  readAppearance,
  saveAppearance,
} from "../src/appearance.ts";

function fixture() {
  const values = new Map<string, string>([
    ["aura.workspace.v1", '{"theme":"light","sessions":[{"id":"keep"}]}'],
    ["aura.coding.side-width", "450"],
  ]);
  const writes: string[] = [];
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
      writes.push(key);
    },
    removeItem: (key: string) => {
      values.delete(key);
      writes.push(key);
    },
  };
  return { values, writes, storage };
}

test("appearance edits survive reload and resetting preserves other local preferences", () => {
  const { values, writes, storage } = fixture();
  const previous = [...values];
  assert.deepEqual(readAppearance(storage), defaultAppearance);
  assert.deepEqual(writes, [], "Opening settings must not write preferences");
  const custom = {
    accent: "#14B8A6",
    font: "serif",
    radius: "rounded",
  } as const;
  assert.equal(saveAppearance(storage, custom), true);
  assert.deepEqual(readAppearance(storage), custom);
  assert.deepEqual(writes, ["aura.appearance.v1"]);
  assert.equal(saveAppearance(storage, { ...defaultAppearance }), true);
  assert.deepEqual(readAppearance(storage), defaultAppearance);
  assert.deepEqual([...values], previous);
});

test("invalid or unavailable appearance storage falls back without writing or importing CSS", () => {
  const { storage, values, writes } = fixture();
  for (const value of ["{broken", "null", "[]", '"hello"']) {
    values.set("aura.appearance.v1", value);
    assert.deepEqual(readAppearance(storage), defaultAppearance);
  }
  values.set(
    "aura.appearance.v1",
    JSON.stringify({
      accent: "url(https://example.com/image)",
      font: "evil; background: red",
      radius: 999,
      css: "body { display: none }",
    }),
  );
  assert.deepEqual(readAppearance(storage), defaultAppearance);
  assert.deepEqual(writes, []);
  const unavailable = {
    getItem: () => {
      throw new Error("Storage blocked");
    },
    setItem: () => {
      throw new Error("Storage full");
    },
    removeItem: () => {
      throw new Error("Storage blocked");
    },
  };
  assert.deepEqual(readAppearance(unavailable), defaultAppearance);
  assert.equal(
    saveAppearance(unavailable, { ...defaultAppearance, accent: "#ABCDEF" }),
    false,
  );
  assert.equal(saveAppearance(unavailable, { ...defaultAppearance }), false);
  assert.deepEqual(
    normalizeAppearance({ accent: "#a1b2c3", font: "mono", radius: "square" }),
    {
      accent: "#A1B2C3",
      font: "mono",
      radius: "square",
    },
  );
});

function luminance(color: string): number {
  const channels = color.startsWith("#")
    ? [color.slice(1, 3), color.slice(3, 5), color.slice(5, 7)].map((part) =>
        Number.parseInt(part, 16),
      )
    : color
        .match(/\d+(?:\.\d+)?/gu)!
        .slice(0, 3)
        .map(Number);
  const weights = [0.2126, 0.7152, 0.0722];
  return channels.reduce((total, channel, index) => {
    const value = channel / 255;
    return (
      total +
      weights[index] *
        (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    );
  }, 0);
}
function contrast(first: string, second: string): number {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

function blended(first: string, second: string, amount: number): string {
  const channels = [1, 3, 5].map((offset) => {
    const a = Number.parseInt(first.slice(offset, offset + 2), 16);
    const b = Number.parseInt(second.slice(offset, offset + 2), 16);
    return a + (b - a) * amount;
  });
  return `rgb(${channels.join(", ")})`;
}

test("custom colors retain readable accent text and white button labels in both themes", () => {
  for (const dark of [true, false]) {
    const base = dark ? palettes.dark : palettes.light;
    assert.deepEqual(appearancePalette(dark, { ...defaultAppearance }), base);
    for (const accent of [
      "#000000",
      "#FFFFFF",
      "#FFFF00",
      "#FF0000",
      "#00FF00",
      "#0000FF",
      "#14B8A6",
      "#F59E0B",
      "#777777",
      "#F43F5E",
    ]) {
      const colors = appearancePalette(dark, { ...defaultAppearance, accent });
      assert.ok(
        contrast(colors.primaryText, colors.primary) >= 4.5,
        `${accent}: button label`,
      );
      for (const fill of [
        blended(colors.primary, colors.glow, 0.14),
        blended(colors.primary, colors.accent, 0.08),
      ])
        assert.ok(
          contrast(colors.primaryText, fill) >= 4.5,
          `${accent}: button gradient`,
        );
      for (const background of [
        colors.background,
        colors.surface,
        colors.elevated,
        colors.soft,
        colors.user,
      ])
        assert.ok(
          contrast(colors.accent, background) >= 4.5,
          `${accent}: accent on ${background}`,
        );
      for (const key of [
        "text",
        "secondary",
        "muted",
        "success",
        "danger",
        "warning",
      ] as const)
        assert.equal(
          colors[key],
          base[key],
          `${key} must keep its semantic role`,
        );
    }
  }
});

test("document variables provide font fallbacks and radius preferences without changing code fonts", () => {
  const custom = {
    ...defaultAppearance,
    font: "serif",
    radius: "rounded",
  } as const;
  const variables = appearanceVariables(palettes.dark, custom);
  assert.equal(variables["--font-text"], fontStacks.serif);
  assert.equal(variables["--font-mono"], fontStacks.mono);
  assert.ok(
    !variables["--font-text"].includes("var("),
    "Font variables cannot reference themselves",
  );
  assert.equal(variables["--radius-scale"], "1.5");
  assert.equal(
    appearanceVariables(palettes.dark, { ...custom, radius: "square" })[
      "--radius-scale"
    ],
    "0",
  );
});
