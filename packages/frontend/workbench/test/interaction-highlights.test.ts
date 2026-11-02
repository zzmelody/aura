import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { palettes } from "@aura/ui/theme";

const chrome =
  process.env.CHROME_BIN ??
  (process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : undefined);
const run = promisify(execFile);

test(
  "theme highlights belong to the whole field, preserve semantic states and work after lazy styles load",
  {
    skip:
      !chrome || !existsSync(chrome)
        ? "Set CHROME_BIN to check interaction highlights in Chrome"
        : false,
    timeout: 30_000,
  },
  async (t) => {
    const temporary = await mkdtemp(join(tmpdir(), "aura-highlights-"));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    const styles = await Promise.all(
      [
        "styles.css",
        "workspace-chrome.css",
        "screens/settings.css",
        "screens/feature-page.css",
        "screens/automation.css",
        "screens/chat.css",
        "screens/chat-model-controls.css",
        "features/coding/composer.css",
        "features/coding/composer-commands.css",
        "features/coding/tools.css",
        "features/coding/coding.css",
      ].map((file) =>
        readFile(new URL(`../src/${file}`, import.meta.url), "utf8"),
      ),
    );
    const fixture = join(temporary, "highlights.html");
    await writeFile(
      fixture,
      `<!doctype html><html><head><style>${styles.join("\n")}</style></head>
<body><main class="aura-root workbench" data-reduced="true" style="display:block">
  <div class="settings-endpoint"><input id="endpoint"></div>
  <div class="settings-form-grid"><input id="key"><select id="region"><option>Region</option></select></div>
  <div class="workflow-input-field"><textarea id="description"></textarea></div>
  <div class="session-title-field"><input id="title"></div>
  <div class="automation-dialog"><input id="schedule"></div>
  <div class="workflow-card-search"><input id="workflow-search"></div>
  <div class="workflow-path-input"><input id="path"></div>
  <div class="automation-search"><input id="automation-search"></div>
  <div class="session-heading"><div class="session-search"><input id="session-search"></div></div>
  <div class="composer-menu-search"><input id="command-search"></div>
  <section class="coding-studio chat-screen"><div class="coding-pane"><div class="chat-composer"><textarea id="main"></textarea></div></div><aside class="coding-side coding-pane"><div class="chat-composer"><textarea id="side"></textarea></div></aside></section>
  <div class="chat-screen"><div class="chat-composer"><textarea id="demo"></textarea></div></div>
  <input id="invalid" aria-invalid="true">
  <input id="disabled" disabled>
  <button id="menu" class="workbench-menu-item"><span>Menu</span><kbd>Enter</kbd></button>
  <button id="command" class="composer-menu-option" aria-selected="true"><span class="composer-menu-icon">/</span><span>Command</span><span class="composer-menu-tail">3</span></button>
  <button id="model" class="chat-model-menu-item" aria-checked="true">Model</button>
  <button id="disabled-option" class="composer-menu-option" aria-selected="true" aria-disabled="true">Unavailable</button>
  <button id="danger" class="workbench-menu-item danger">Delete</button>
  <button id="primary" class="primary-button">Create</button>
  <button id="toggle-button" class="icon-control" aria-pressed="true">Selected tool</button>
  <button id="disabled-button" class="primary-button" disabled>Unavailable</button>
  <button id="danger-primary" class="primary-button danger" style="background-color:var(--danger)">Delete permanently</button>
  <button id="aura-toggle" class="aura-switch" role="switch" aria-checked="true" style="background-color:var(--accent)"><span style="background-color:var(--primaryText)"></span></button>
  <label class="workflow-switch"><input id="workflow-toggle" type="checkbox" checked><span></span></label>
  <label class="dsh-switch"><input id="plugin-toggle" type="checkbox" checked><span></span></label>
  <label class="dsh-switch"><input id="disabled-toggle" type="checkbox" disabled><span></span></label>
  <div id="session-row" class="session-row selected" data-row-highlight><button id="session-title" class="session-item row-control selected">新的运行</button><div class="session-row-tail"><button id="session-archive" class="icon-control session-archive row-control">Archive</button></div></div>
  <div class="coding-tool-tab active" data-row-highlight><button class="row-control" role="tab" aria-selected="true">Terminal</button><button class="icon-control row-control">Close</button></div>
  <div class="workspace-nav-child selected" data-row-highlight><button class="row-control selected">Studio</button><button class="icon-control studio-close row-control">Close</button></div>
  <div class="workspace-folder-head" data-row-highlight><button class="session-folder-heading row-control">Workspace</button><div class="workspace-folder-actions"><button class="icon-control row-control">Menu</button><button class="icon-control row-control">New</button></div></div>
  <div class="history-row" data-row-highlight><button class="history-session row-control">History</button><button class="icon-control row-control">Archive</button></div>
  <div class="workflow-card-summary" data-row-highlight><button class="workflow-card-open row-control">Workflow</button><div class="workflow-card-actions"><button class="icon-control row-control">Edit</button><button class="icon-control workflow-run-icon row-control">Run</button></div></div>
  <div class="coding-recap-file-row" data-row-highlight><span>File</span><span class="coding-recap-actions"><button class="icon-control row-control">Copy</button><button class="icon-control row-control">Reveal</button></span></div>
</main><pre id="result"></pre><script>
addEventListener("load", () => {
const inspect = () => {
  if (!document.hasFocus()) {
    window.focus();
    setTimeout(inspect, 20);
    return;
  }
const root = document.querySelector("main");
const results = [];
const color = (value) => {
  const node = document.createElement("span");
  node.style.color = value;
  root.append(node);
  const result = getComputedStyle(node).color;
  node.remove();
  return result;
};
const appearance = (node) => {
  const style = getComputedStyle(node);
  return {outline: style.outlineStyle, shadow: style.boxShadow, image: style.backgroundImage, border: style.borderTopColor, color: style.color, transition: style.transitionDuration, hasFocus: node.matches(":focus")};
};
for (const [theme, palette] of Object.entries(${JSON.stringify(palettes)})) {
  for (const [key, value] of Object.entries(palette)) root.style.setProperty("--" + key, value);
  const fields = [];
  for (const id of ["endpoint", "key", "region", "description", "title", "schedule"]) {
    const node = document.getElementById(id);
    node.focus();
    fields.push({id, focused: appearance(node)});
    node.blur();
    fields[fields.length - 1].blurred = appearance(node);
  }
  const wrappers = [];
  for (const id of ["workflow-search", "path", "automation-search", "session-search", "command-search", "main", "side", "demo"]) {
    const node = document.getElementById(id);
    node.focus();
    wrappers.push({id, input: appearance(node), field: appearance(node.parentElement)});
  }
  const options = [];
  for (const id of ["menu", "command", "model", "disabled-option", "danger"]) {
    const node = document.getElementById(id);
    node.focus();
    options.push({id, ...appearance(node), children: Array.from(node.children).map(appearance)});
  }
  document.getElementById("invalid").focus();
  const invalid = appearance(document.getElementById("invalid"));
  const editor = document.getElementById("main");
  editor.setAttribute("aria-invalid", "true");
  editor.focus();
  const invalidComposite = appearance(editor.parentElement);
  editor.removeAttribute("aria-invalid");
  const switches = ["aura-toggle", "workflow-toggle", "plugin-toggle"].map(id => {
    const input = document.getElementById(id);
    const track = input.matches("button") ? input : input.nextElementSibling;
    input.focus();
    const checked = appearance(track);
    if(input.matches("button")) input.setAttribute("aria-checked", "false");
    else input.checked = false;
    const unchecked = appearance(track);
    if(input.matches("button")) input.setAttribute("aria-checked", "true");
    else input.checked = true;
    const thumb = input.matches("button") ? getComputedStyle(input.firstElementChild).backgroundColor : getComputedStyle(track, "::after").backgroundColor;
    return {id, checked, unchecked, thumb};
  });
  const buttons = ["primary", "toggle-button", "disabled-button"].map(id => ({id, ...appearance(document.getElementById(id))}));
  document.getElementById("danger-primary").focus();
  const dangerPrimary = appearance(document.getElementById("danger-primary"));
  const session = ["session-title", "session-archive"].map(id => {
    const input = document.getElementById(id);
    input.focus();
    return {id, button: appearance(input), row: appearance(document.getElementById("session-row"))};
  });
  const rows = Array.from(root.querySelectorAll("[data-row-highlight]")).flatMap(row => Array.from(row.querySelectorAll(".row-control")).map(input => {
    input.focus();
    return {kind: row.className, control: appearance(input), row: appearance(row)};
  }));
  const menuTrigger = root.querySelector(".workspace-folder-actions .row-control");
  menuTrigger.classList.add("menu-open");
  document.getElementById("menu").focus();
  const openMenu = {trigger: appearance(menuTrigger), row: appearance(menuTrigger.closest("[data-row-highlight]"))};
  menuTrigger.classList.remove("menu-open");
  results.push({theme, danger: color(palette.danger), thumb: color(palette.primaryText), fields, wrappers, options, invalid, invalidComposite, buttons, switches, session, rows, openMenu, dangerPrimary, disabled: appearance(document.getElementById("disabled")), disabledSwitch: appearance(document.getElementById("disabled-toggle").nextElementSibling)});
}
document.getElementById("result").textContent = JSON.stringify(results);
};
window.focus();
setTimeout(inspect, 0);
});
</script></body></html>`,
    );
    const { stdout } = await run(
      chrome!,
      [
        "--headless",
        "--disable-gpu",
        "--no-sandbox",
        "--disable-breakpad",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${join(temporary, "profile")}`,
        "--dump-dom",
        "--virtual-time-budget=1000",
        pathToFileURL(fixture).href,
      ],
      { encoding: "utf8", timeout: 20_000, maxBuffer: 2_000_000 },
    );
    const match = stdout.match(/<pre id="result">([^<]+)<\/pre>/);
    assert.ok(match, "Chrome returns the focus measurements");
    interface Appearance {
      outline: string;
      shadow: string;
      image: string;
      border: string;
      color: string;
      transition: string;
      hasFocus: boolean;
    }
    const results = JSON.parse(match[1]!) as Array<{
      theme: string;
      danger: string;
      thumb: string;
      fields: Array<{ id: string; focused: Appearance; blurred: Appearance }>;
      wrappers: Array<{ id: string; input: Appearance; field: Appearance }>;
      options: Array<Appearance & { id: string; children: Appearance[] }>;
      invalid: Appearance;
      invalidComposite: Appearance;
      dangerPrimary: Appearance;
      buttons: Array<Appearance & { id: string }>;
      switches: Array<{
        id: string;
        checked: Appearance;
        unchecked: Appearance;
        thumb: string;
      }>;
      disabledSwitch: Appearance;
      session: Array<{ id: string; button: Appearance; row: Appearance }>;
      rows: Array<{ kind: string; control: Appearance; row: Appearance }>;
      openMenu: { trigger: Appearance; row: Appearance };
      disabled: Appearance;
    }>;
    assert.equal(results.length, 2);
    for (const result of results) {
      for (const field of result.fields) {
        assert.equal(field.focused.hasFocus, true);
        assert.notEqual(
          field.focused.shadow,
          "none",
          `${result.theme}: ${field.id}`,
        );
        assert.notEqual(field.focused.image, "none", "Focus has a subtle tint");
        assert.equal(
          field.focused.outline,
          "none",
          "Avoid a second square focus outline",
        );
        assert.equal(field.blurred.image, "none", "The highlight ends on blur");
        assert.equal(field.focused.transition, "0s", "Respect reduced motion");
      }
      for (const wrapper of result.wrappers) {
        assert.notEqual(
          wrapper.field.shadow,
          "none",
          `${result.theme}: ${wrapper.id}`,
        );
        assert.notEqual(
          wrapper.field.image,
          "none",
          "Highlight the entire rounded field",
        );
        assert.equal(wrapper.input.shadow, "none");
        assert.equal(
          wrapper.input.outline,
          "none",
          "Nested editors never have a second focus ring",
        );
        assert.equal(wrapper.input.image, "none");
      }
      for (const option of result.options) {
        for (const child of option.children) {
          assert.equal(
            child.image,
            "none",
            "Menu icons and shortcuts share the option's background",
          );
          assert.equal(child.shadow, "none");
        }
        if (option.id === "disabled-option")
          assert.equal(
            option.image,
            "none",
            "Unavailable options never look selected",
          );
        else
          assert.notEqual(
            option.image,
            "none",
            `${result.theme}: ${option.id}`,
          );
      }
      assert.equal(result.invalid.border, result.danger);
      assert.equal(result.invalidComposite.border, result.danger);
      assert.equal(result.invalidComposite.image, "none");
      assert.equal(
        result.options.find((option) => option.id === "danger")?.color,
        result.danger,
      );
      assert.equal(result.disabled.image, "none");
      assert.equal(
        result.dangerPrimary.image,
        result.options.find((option) => option.id === "danger")?.image,
        "Destructive primary buttons retain the danger gradient",
      );
      assert.equal(result.disabledSwitch.shadow, "none");
      assert.equal(result.disabledSwitch.image, "none");
      for (const button of result.buttons)
        if (button.id === "disabled-button") {
          assert.equal(button.shadow, "none");
          assert.equal(button.image, "none");
        } else assert.notEqual(button.image, "none", button.id);
      for (const toggle of result.switches) {
        assert.equal(
          toggle.thumb,
          result.thumb,
          "Switch thumbs share the primary foreground in both themes",
        );
        assert.notEqual(toggle.checked.image, "none", toggle.id);
        assert.notEqual(toggle.checked.shadow, "none", toggle.id);
        assert.equal(
          toggle.unchecked.image,
          "none",
          "An off switch keeps its neutral track",
        );
      }
      for (const control of result.session) {
        assert.equal(
          control.button.image,
          "none",
          "No curved inner highlight splits the session row",
        );
        assert.equal(control.button.shadow, "none");
        assert.equal(control.button.outline, "none");
        assert.notEqual(control.row.image, "none");
        assert.equal(
          control.row.outline,
          "solid",
          "Keyboard focus outlines the entire row",
        );
      }
      for (const row of result.rows) {
        assert.equal(
          row.control.image,
          "none",
          `${row.kind}: child backgrounds must not split the row`,
        );
        assert.equal(row.control.shadow, "none", row.kind);
        assert.equal(row.control.outline, "none", row.kind);
        assert.notEqual(row.row.image, "none", row.kind);
        assert.equal(
          row.row.outline,
          "solid",
          `${row.kind}: focus belongs to the whole row`,
        );
      }
      assert.equal(result.openMenu.trigger.image, "none");
      assert.notEqual(
        result.openMenu.row.image,
        "none",
        "Opening a portaled menu keeps its original row highlighted",
      );
    }
  },
);
