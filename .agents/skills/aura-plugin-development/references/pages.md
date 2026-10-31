# Optional workbench pages

The original backend-only v1 contract stays compatible. Optional
`contributes.pages` and capability providers extend it for complete workbench
pages. Verify the checked-out host and `@aura/plugin-ui` before authoring one.

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
- Pages call only their own provider using the supplied `invoke`; providers
  explicitly list `pageOperations`. Validate inputs and bound JSON/media output.
  Credentials never cross this boundary.
- Long work belongs to a provider-owned job: return status immediately,
  coalesce starts, poll status and cancel owned work on close. Import/open
  must not start work. Cancel stale frontend requests and clean up subscriptions.
- Preserve old Action/Flow-only manifests. Test disable, ownership refusal,
  failed startup cleanup and concurrent browser host replacement.
- A page shares the browser realm and a provider is trusted local Node.js code;
  an ErrorBoundary and operation allowlist do not constitute a security sandbox.
- Development setup and builds are explicit commands. Aura startup never installs
  dependencies or builds packages. Failed revisions retain the last working version.
  A frontend replacement remounts that plugin page. Use a separate explicit
  build watch command during authoring; never turn host discovery into a build.

- Product pages may reuse public `@aura/workbench/plugin` generic workflow widgets/native
  adapters and `@aura/workbench/transport` Run/media transports. The renderer seeds
  these modules in DSH; runtime graph externals must list them. Business JSON goes
  through the plugin's own provider; existing binary upload/download streams and
  generic durable Run controls remain bounded public host APIs.

## Run result renderers

A page bundle MAY also render the output area of Flow Runs, so plugin-specific
results never need host code. The host has no built-in result views beyond the
generic JSON/rich-text output.

```tsx
ctx.auraWorkbench.result(
  defineResult({
    id: "video-composition",
    match: ({ output }) => isComposition(output),
    render: ({ endpoint, output }) => <VideoResult endpoint={endpoint} value={output} />,
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
