import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { DesktopStartup } from "../apps/desktop/src/startup.ts";
import {
  createLanguageController,
  languageStorageKey,
  locales,
  registerCatalogs,
} from "@aura/i18n/runtime";
import {
  desktopCatalogs,
  desktopText,
  type DesktopMessageKey,
} from "../apps/desktop/src/desktop-messages.ts";

const source = ts.transpileModule(
  await readFile(
    new URL("../apps/desktop/src/startup.ts", import.meta.url),
    "utf8",
  ),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;

function browser(
  options: {
    reduced?: boolean;
    icon?: boolean;
    saved?: string;
    languageSaved?: string;
    languages?: string[];
  } = {},
) {
  let writes = 0;
  const controller = createLanguageController({
    languages: options.languages ?? ["zh-CN"],
    storage: {
      getItem: (key) =>
        key === languageStorageKey ? (options.languageSaved ?? null) : null,
      setItem: () => {
        writes++;
      },
    },
  });
  registerCatalogs("desktop", desktopCatalogs, controller.i18n);
  const events = new Map<string, () => void>();
  const mediaEvents = new Map<string, () => void>();
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const field = { disposals: 0, reduced: false };
  const animations: Array<{ canceled: boolean }> = [];
  let nextTimer = 0;
  let reloads = 0;
  class Element {
    inert = false;
    hidden = false;
    isConnected = true;
    textContent = "";
    dataset: Record<string, string> = {};
    attributes = new Map<string, string>();
    listeners = new Map<string, () => void>();
    remove() {
      this.isConnected = false;
    }
    removeAttribute(name: string) {
      this.attributes.delete(name);
    }
    setAttribute(name: string, value: string) {
      this.attributes.set(name, value);
    }
    addEventListener(name: string, callback: () => void) {
      this.listeners.set(name, callback);
    }
    removeEventListener(name: string) {
      this.listeners.delete(name);
    }
    getBoundingClientRect() {
      return { left: 10, top: 20, width: 20, height: 20 };
    }
    querySelector() {
      return options.icon === false ? null : new Element();
    }
    animate() {
      const animation = { canceled: false };
      animations.push(animation);
      return { cancel: () => (animation.canceled = true) };
    }
  }
  const elements = new Map(
    [
      "desktop-startup",
      "root",
      "desktop-startup-scene",
      "desktop-startup-message",
      "desktop-startup-reload",
      "desktop-startup-field",
      "desktop-startup-tagline",
    ].map((id) => [id, new Element()]),
  );
  const root = elements.get("root")!;
  const surface = elements.get("desktop-startup")!;
  const reload = elements.get("desktop-startup-reload")!;
  const message = elements.get("desktop-startup-message")!;
  root.inert = true;
  root.setAttribute("aria-hidden", "true");
  reload.hidden = true;
  const media = {
    matches: options.reduced ?? false,
    addEventListener: (name: string, callback: () => void) =>
      mediaEvents.set(name, callback),
    removeEventListener: (name: string) => mediaEvents.delete(name),
  };
  const exports: { startDesktopStartup?: () => DesktopStartup } = {};
  const document = {
    title: "",
    documentElement: { lang: "", dir: "" },
    hidden: false,
    getElementById: (id: string) => elements.get(id),
    body: { append: (element: Element) => (element.isConnected = true) },
  };
  runInNewContext(source, {
    exports,
    require: (name: string) => {
      if (name === "@aura/i18n/runtime") return { language: controller };
      if (name === "./desktop-messages.ts")
        return {
          desktopText: (key: DesktopMessageKey) =>
            desktopText(key, controller.i18n),
        };
      assert.equal(name, "./startup-field.ts");
      return {
        startStartupField: () => ({
          setReducedMotion: (value: boolean) => (field.reduced = value),
          dispose: () => field.disposals++,
        }),
      };
    },
    document,
    window: {
      addEventListener: (name: string, callback: () => void) =>
        events.set(name, callback),
      removeEventListener: (name: string) => events.delete(name),
    },
    location: { reload: () => reloads++ },
    localStorage: { getItem: () => options.saved ?? null },
    HTMLCanvasElement: Element,
    matchMedia: () => media,
    setTimeout: (callback: () => void, delay: number) => {
      timers.set(++nextTimer, { callback, delay });
      return nextTimer;
    },
    clearTimeout: (id: number) => timers.delete(id),
  });
  assert.ok(exports.startDesktopStartup);
  const startup = exports.startDesktopStartup();
  function tick(delay: number) {
    for (const [id, timer] of [...timers]) {
      if (timer.delay !== delay) continue;
      timers.delete(id);
      timer.callback();
    }
  }
  return {
    startup,
    root,
    surface,
    reload,
    message,
    media,
    mediaEvents,
    document,
    events,
    field,
    timers,
    animations,
    controller,
    writes: () => writes,
    tagline: elements.get("desktop-startup-tagline")!,
    tick,
    reloads: () => reloads,
  };
}

test("startup waits for the committed workbench and repeated ready notifications do not restart exit", () => {
  const page = browser();
  assert.equal(page.root.inert, true);
  assert.equal(page.animations.length, 0);
  page.document.title = "Aura · My conversation";
  page.startup.ready({ reduced: false });
  assert.equal(page.document.title, "Aura · My conversation");
  assert.equal(page.root.inert, false);
  assert.equal(page.root.attributes.has("aria-hidden"), false);
  assert.equal(page.surface.inert, true);
  assert.equal(page.surface.dataset.state, "leaving");
  page.startup.ready({ reduced: false });
  assert.equal(page.animations.length, 1);
  page.tick(520);
  assert.equal(page.surface.isConnected, false);
  assert.equal(page.field.disposals, 1);
  assert.equal(page.animations[0].canceled, true);
  assert.equal(page.timers.size + page.mediaEvents.size + page.events.size, 0);
});

test("system and application reduced motion preferences both skip the exit animation", () => {
  for (const system of [false, true]) {
    const page = browser({ reduced: system });
    page.startup.ready({ reduced: !system });
    assert.equal(page.field.reduced, true);
    assert.equal(page.surface.isConnected, false);
    assert.equal(page.root.inert, false);
    assert.equal(page.animations.length, 0);
    assert.equal(page.timers.size, 0);
  }
});

test("the saved motion preference is honored before the workbench loads and malformed storage is tolerated", () => {
  const page = browser({ saved: '{"version":1,"reduceMotion":true}' });
  assert.equal(page.field.reduced, true);
  assert.equal(page.surface.dataset.reduced, "true");
  page.startup.dispose();
  for (const saved of ["{", "null", "[]", '{"reduceMotion":"true"}']) {
    const invalid = browser({ saved });
    assert.equal(invalid.field.reduced, false);
    invalid.startup.dispose();
  }
});

test("slow startup offers a user initiated reload without pretending the workbench is ready", () => {
  const page = browser();
  page.tick(10_000);
  assert.match(page.message.textContent, /继续等待/);
  assert.equal(page.root.inert, true);
  assert.equal(page.reload.hidden, false);
  assert.equal(page.reloads(), 0);
  page.reload.listeners.get("click")!();
  assert.equal(page.reloads(), 1);
  page.startup.dispose();
});

test("a renderer failure interrupts exit and keeps an actionable error surface", () => {
  const page = browser();
  page.startup.ready({ reduced: false });
  page.startup.fail();
  assert.equal(page.surface.dataset.state, "failed");
  assert.equal(page.surface.inert, false);
  assert.equal(page.root.inert, true);
  assert.equal(page.reload.hidden, false);
  assert.match(page.message.textContent, /加载失败/);
  page.startup.ready({ reduced: false });
  page.tick(520);
  assert.equal(page.surface.isConnected, true);
  assert.equal(page.animations[0].canceled, true);
  assert.equal(page.timers.size + page.mediaEvents.size, 0);
  assert.equal(page.events.size, 1);
  page.reload.listeners.get("click")!();
  assert.equal(page.reloads(), 1);
});

test("startup reads the saved language before rendering and language changes retain slow and failed states", async () => {
  const page = browser({
    languageSaved: '{"language":"fr"}',
    languages: ["ja"],
  });
  assert.equal(page.document.documentElement.lang, "fr");
  assert.equal(page.message.textContent, desktopCatalogs.fr.startupLoading);
  assert.equal(page.writes(), 0);
  page.tick(10_000);
  const field = page.field;
  const surface = page.surface;
  for (const locale of locales) {
    await page.controller.select(locale);
    const expected = desktopCatalogs[locale];
    assert.equal(page.document.documentElement.lang, locale);
    assert.equal(page.document.documentElement.dir, "ltr");
    assert.equal(page.document.title, expected.startupTitle);
    assert.equal(
      page.surface.attributes.get("aria-label"),
      expected.startupOpening,
    );
    assert.equal(page.message.textContent, expected.startupSlow);
    assert.equal(page.tagline.textContent, expected.tagline);
    assert.equal(page.reload.textContent, expected.reload);
    assert.equal(page.reload.hidden, false);
    assert.equal(page.surface, surface);
    assert.equal(page.field, field);
    assert.equal(page.field.disposals, 0);
    assert.equal(page.animations.length + page.reloads(), 0);
  }
  page.startup.fail();
  for (const locale of locales) {
    await page.controller.select(locale);
    assert.equal(
      page.message.textContent,
      desktopCatalogs[locale].startupFailed,
    );
    assert.equal(page.root.inert, true);
    assert.equal(page.surface, surface);
  }
  assert.equal(page.writes(), locales.length * 2);
  page.events.get("pagehide")!();
  const last = page.message.textContent;
  await page.controller.select("en");
  assert.equal(page.message.textContent, last);
  assert.equal(page.events.size, 0);
});

test("unsupported or damaged startup preferences follow the system without repairing storage", () => {
  for (const languageSaved of ["{", '{"language":"invalid"}', "null"]) {
    const page = browser({ languageSaved, languages: ["de-DE", "ko-KR"] });
    assert.equal(page.document.documentElement.lang, "ko");
    assert.equal(page.writes(), 0);
    page.startup.dispose();
  }
  const fallback = browser({ languages: ["de-DE"] });
  assert.equal(fallback.document.documentElement.lang, "en");
  fallback.startup.dispose();
});

test("late renderer errors can restore the error surface after successful startup", () => {
  const page = browser();
  page.startup.ready({ reduced: true });
  assert.equal(page.surface.isConnected, false);
  page.startup.fail();
  assert.equal(page.surface.isConnected, true);
  assert.equal(page.root.inert, true);
  assert.equal(page.reload.hidden, false);
  page.reload.listeners.get("click")!();
  assert.equal(page.reloads(), 1);
});

test("enabling reduced motion during exit or closing the page releases the animation", () => {
  const page = browser({ icon: false });
  page.startup.ready({ reduced: false });
  page.media.matches = true;
  page.mediaEvents.get("change")!();
  assert.equal(page.surface.isConnected, false);
  assert.equal(page.animations[0].canceled, true);
  assert.equal(page.timers.size, 0);
  const closing = browser();
  closing.events.get("pagehide")!();
  assert.equal(closing.field.disposals, 1);
  assert.equal(closing.timers.size, 0);
  assert.equal(closing.reload.listeners.size, 0);
});
