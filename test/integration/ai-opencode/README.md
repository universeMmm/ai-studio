# OpenCode V2 integration validation

This isolated harness runs the published, pinned `@opencode/sdk@2.2.5` inside an
Electron utility process. It exercises the actual SDK, SQLite session store,
permission service and tools. The model endpoint is a local deterministic SSE
fixture; no real model key or paid model request is used. The default AI Studio
runtime is not switched and the root application dependencies are unchanged.

From the repository root:

```sh
npm ci --prefix test/integration/ai-opencode --ignore-scripts --legacy-peer-deps
npm run test:ai:opencode
```

The default executable is the repository's macOS Electron development bundle.
Set `AI_STUDIO_ELECTRON` to another built Electron executable when needed. Run
outside a sandbox that forbids loopback servers or GUI/utility processes.
Output is written to `.build/opencode-validation/report.json`.

## What this verifies

- Loading the published SDK in the actual Electron/V8 runtime, with no upstream
  source edits or new agent loop.
- Real session creation, streamed model output and native permission handling.
- Native file reading and WebFetch, with denial as the default for other tools.
- Cancellation after a real text delta; the underlying HTTP stream must close.
- Persistent messages across host close/reopen and a new utility process,
  retaining message IDs without another model request.
- A real public request using the operating system proxy, despite conflicting
  shell proxy variables. PAC, proxy replacement, bypass rules and failed-proxy
  behavior use an isolated Electron process; OS settings are never changed.
- Every SDK HTTP request (including provider discovery) reaching the controlled
  proxy. The fixture model hostname has no DNS route, so direct model requests
  cannot silently pass.
- Authenticated HTTP requests rejecting redirects rather than forwarding keys.

## Integration boundary

The validation host uses Electron `net.fetch`, backed by the same system proxy
mode as AI Studio. OpenCode's default Effect HTTP client and model transports use
this fetch. Node HTTP/HTTPS and direct TCP are rejected in this isolated trial,
so unsupported transports fail visibly. No proxy address or proxy mode is added
to the application's settings.

Shell, external plugins, WebSocket model transports, browser automation and MCP
subprocess networking are not enabled by this trial. They need explicit host
integration before production rollout; a subprocess is not an OS sandbox.
The trial also disables model catalog downloads and external project/Claude
configuration. User configuration and credentials remain outside its temporary
directories.

The published SDK uses `await using`: it fails to parse in stock Node 22.23.2,
while the project's Electron 39.8.8 (V8 14.2) loads it successfully. Keep it in
the Electron utility process instead of importing it into the renderer or the
repository's Node 22 tooling. Native-module and packaging compatibility on
Windows/Linux remains a separate acceptance step.

Upstream: <https://github.com/anomalyco/opencode/tree/a62a74a2af953ffd7da728dc9849510b073ad79d/packages/sdk>
(MIT). The lockfile records the published dependency versions and integrity.
`--legacy-peer-deps` avoids installing unrelated optional peer ecosystems;
`--ignore-scripts` is sufficient for the tested macOS runtime.
