import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "vite";

const chrome =
  process.env.CHROME_BIN ??
  (process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : undefined);

test(
  "side draft restoration preserves quoted inserts, edits and separate conversation drafts",
  {
    skip:
      !chrome || !existsSync(chrome)
        ? "Set CHROME_BIN to check React draft restoration in Chrome"
        : false,
    timeout: 30_000,
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "aura-conversation-draft-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const entry = join(root, "fixture.ts");
    await writeFile(
      entry,
      `import React from ${JSON.stringify(fileURLToPath(import.meta.resolve("react")))};
import { createRoot } from ${JSON.stringify(fileURLToPath(import.meta.resolve("react-dom/client")))};
import { flushSync } from ${JSON.stringify(fileURLToPath(import.meta.resolve("react-dom")))};
import { useConversationDraft } from ${JSON.stringify(fileURLToPath(new URL("../src/features/coding/useConversationDraft.ts", import.meta.url)))};
let current;
function Composer(props) {
  current = useConversationDraft(props.id, props.seed);
  return React.createElement("textarea", { value: current.draft, readOnly: true });
}
const root = createRoot(document.getElementById("root"));
const render = (id, seed) => flushSync(() => root.render(React.createElement(Composer, { id, seed })));
const edit = (value) => flushSync(() => current.setDraft(value));
const results = [];
render("side-a", "saved draft");
edit((value) => value + "\\n\\n> first quote");
// A parent render can still carry the previous saved value after an insert.
render("side-a", "");
results.push(current.draft);
edit((value) => value + "\\n\\n> second quote");
results.push(current.draft);
render("side-b", "other draft");
results.push(current.draft);
edit("edited B");
render("side-a", "old seed");
results.push(current.draft);
edit("");
render("side-a", "stale saved draft");
results.push(current.draft);
render("side-b", "other draft");
results.push(current.draft);
flushSync(() => current.moveDraft("opened-conversation"));
render("opened-conversation", "");
results.push(current.draft);
root.unmount();
const restored = createRoot(document.getElementById("root"));
flushSync(() => restored.render(React.createElement(Composer, { id: "side-a", seed: results[1] })));
results.push(current.draft);
document.getElementById("result").textContent = JSON.stringify(results);
document.currentScript.remove();
`,
    );
    const output = join(root, "bundle");
    await build({
      configFile: false,
      root,
      logLevel: "error",
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      build: {
        outDir: output,
        minify: true,
        lib: {
          entry,
          formats: ["iife"],
          name: "DraftFixture",
          fileName: "fixture",
        },
      },
    });
    const script = await readFile(join(output, "fixture.iife.js"), "utf8");
    const page = join(root, "fixture.html");
    await writeFile(
      page,
      `<div id="root"></div><pre id="result"></pre><script>${script.replaceAll("</script", "<\\/script")}</script>`,
    );
    const { stdout } = await promisify(execFile)(chrome!, [
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      `--user-data-dir=${join(root, "chrome")}`,
      "--dump-dom",
      pathToFileURL(page).href,
    ]);
    const json = /<pre id="result">([^<]+)<\/pre>/u.exec(stdout)?.[1];
    assert.ok(json, stdout);
    const first = "saved draft\n\n> first quote";
    const both = `${first}\n\n> second quote`;
    assert.deepEqual(JSON.parse(json.replaceAll("&gt;", ">")), [
      first,
      both,
      "other draft",
      both,
      "",
      "edited B",
      "edited B",
      both,
    ]);
  },
);
