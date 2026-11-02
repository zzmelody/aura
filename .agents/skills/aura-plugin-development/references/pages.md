# Optional workbench pages

Optional `contributes.pages` and `contributes.backend` extend the Action/Flow
contract for complete workbench pages. Verify the checked-out host and `@aura/plugin-ui` before authoring one.

- `pages` names one prebuilt DSH lazy-CJS bundle inside the plugin root.
  Browser TypeScript/React compiles before discovery; keep React, React DOM,
  Cordis and `@aura/plugin-ui` external to share the host runtime.
- Export `apply(ctx)` and register `ctx.auraWorkbench.page(definePage(...))`.
  Browser code uses the public UI SDK; backend code uses the backend SDK.
  Own styles and subscriptions through fibers. Do not import private Aura paths.
- The host wraps pages in a full-size viewport that follows the available
  workbench area on window/sidebar resize. Return a single page root, let it
  fill that viewport, and keep scrolling inside the page; do not measure and
  freeze its width from message contents or the initial window size.
- Pages call only their own backend with `invoke(operation, input, signal)`;
  the backend explicitly lists `pageOperations`. Validate inputs and bound
  JSON/media output. Credentials never cross this boundary.
- Long work belongs to a backend-owned job: return status immediately,
  coalesce starts, poll status and cancel owned work on close. Import/open
  must not start work. Cancel stale frontend requests and clean up subscriptions.
- Preserve old Action/Flow-only manifests. Test disable, ownership refusal,
  failed startup cleanup and concurrent browser host replacement.
- A page shares the browser realm and a backend is trusted local Node.js code;
  an ErrorBoundary and operation allowlist do not constitute a security sandbox.
- Development setup and builds are explicit commands. Aura startup never installs
  dependencies or builds packages.
- The runtime watches enabled built bundles and sends graph updates over SSE;
  backend revisions include static local helpers and switch when calls and
  plugin Flow Runs are idle. Failed revisions retain the last working version.
  A frontend replacement remounts that plugin page. Use a separate explicit
  build watch command during authoring; never turn host discovery into a build.

- Product pages may reuse public `@aura/workbench/plugin` generic workflow widgets/native
  adapters and `@aura/workbench/transport` Run/media transports. The renderer seeds
  these modules in DSH; runtime graph externals must list them. Business JSON goes
  through the plugin's own backend; existing binary upload/download streams and
  generic durable Run controls remain bounded public host APIs. Do not import workbench private source paths.

## Shared visual styles

Plugin pages and Run result views inherit Aura's shared styles in the same document.
The host already loads `@aura/ui/icons.css`; use its classes and variables directly
inside the supplied viewport. Keep plugin CSS focused on its own layout and
business content. Shared styles belong to the host lifecycle; do not inject a
second copy or import private workbench CSS. Standalone previews may import the
public stylesheet with a declared `@aura/ui` dependency and supply an `.aura-root`
with the theme variables.

- Inherit the host's font stack. Use `--font-text` and `--font-mono` where an
  explicit family is needed. Regular text and inputs use weight 400; emphasis
  and headings default to 600, with 500 available for intermediate hierarchy.
- Use `--text`, `--secondary`, `--muted` and `--caption` for text hierarchy;
  `--accent`, `--danger`, `--success` and `--warning` for semantic states.
  Surfaces and edges use `--background`, `--surface`, `--elevated`, `--input`,
  `--border` and `--hairline`. Primary actions use `--primary` / `--primaryText`.
  Input placeholders use `--muted` with opacity 1.
- Focus and selection can reuse `--focus-border`, `--focus-wash`,
  `--focus-shadow`, `--highlight-fill` and `--highlight-sheen`. Primary action
  gradients use `--control-fill`, `--control-hover-fill` and
  `--control-pressed-fill`. Keep compound rows visually continuous by painting
  the shared background on the row.

Lucide icons automatically receive Aura's line weight and retain their parent's
`currentColor`. Custom line SVGs opt in with `aura-icon`, a 24×24 `viewBox`,
`fill="none"` and `stroke="currentColor"`.

| Use | Shared class | Stroke or size |
| --- | --- | --- |
| Ordinary line icon | Lucide default or `aura-icon` | 1.6 |
| Main action | `aura-icon--emphasis` | 1.8 |
| Large placeholder | `aura-icon--display` | 1.25 |
| Filled symbol | `aura-icon--filled`, with the required SVG `fill` | 0 |
| Shared sizes | `aura-icon--xs`, `aura-icon--sm`, `aura-icon--md`, `aura-icon--lg` | 12/14/16/20px |
| Custom drawing | `aura-icon--custom` | Preserve its own geometry |

Tone classes are `aura-icon--secondary`, `--muted`, `--text`, `--accent`,
`--danger`, `--success` and `--on-primary` (each uses the `aura-icon` prefix).
When using a tone class, leave Lucide's `color` prop unset so its SVG stroke
follows `currentColor`. Let the outer control own disabled opacity rather than
dimming the icon again. Hover and selection change the control's colors and
background, not its stroke weight. Provide an accessible label for icon-only
buttons and mark their decorative SVGs `aria-hidden`.

```tsx
<>
  <button type="button" aria-label="搜索" className="plugin-search-button">
    <Search size={16} className="aura-icon--secondary" aria-hidden />
  </button>
  <Globe2
    size={40}
    className="aura-icon--display aura-icon--muted"
    aria-hidden
  />
  <svg
    className="aura-icon aura-icon--muted aura-icon--sm"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    aria-hidden
  >
    <path d="M4 12h16M12 4v16" />
  </svg>
</>
```

Public variables include `--aura-icon-stroke`, `--aura-icon-stroke-emphasis`,
`--aura-icon-stroke-display`, the sizes `--aura-icon-size-xs`,
`--aura-icon-size-sm`, `--aura-icon-size-md`, `--aura-icon-size-lg`, and the tone
aliases `--aura-icon-color`, `--aura-icon-muted`, `--aura-icon-active`.
A local `--aura-icon-stroke-width` override is available for a justified
exception; prefer the shared classes for ordinary UI.
Charts, flow connectors, logos and media canvases retain their own drawing rules.
Check the current public exports and stylesheet before relying on these features
when targeting an older Aura host.

## Run result renderers

A page bundle MAY also render the output area of Flow Runs, so plugin-specific
results never need host code. The host has no built-in result views beyond the
generic JSON/rich-text output.

```tsx
ctx.auraWorkbench.result(
  defineResult({
    id: "video-composition",
    match: ({ output }) => isComposition(output),
    render: ({ endpoint, output }) => (
      <VideoResult endpoint={endpoint} value={output} />
    ),
  }),
);
```

- `match(context)` receives `{ endpoint, pluginId, run: { id, flowId,
flowPluginId?, status, input? }, output }`. Keep it cheap and side-effect
  free; match on the output shape or on your own Flow IDs.
- Renderers are asked in registration order and the first match wins. A
  throwing `match` counts as no match; a throwing `render` falls back to the
  generic view. Neither is a security boundary.
- Renderers unregister with the plugin fiber, so disabling the plugin returns its
  Runs to the generic view. Ship result styles in the same bundle.
- Plugin-specific data formats belong to the plugin, not `@aura/protocol`.
