# Desktop system-proxy integration test

Run after `npm run compile` and after preparing the desktop Electron runtime:

```sh
node test/integration/ai-network/run.mjs --require-system-proxy
```

Omit `--require-system-proxy` on a machine whose system policy is direct access. This test needs a desktop session and internet access for the public IANA fetch and search. It uses the existing Playwright dependency and writes its report to `.build/ai-network/report.json`; `AI_NETWORK_REPORT` can select another output path.

The test launches a separate AI Studio instance with a temporary user profile and workspace. It never changes OS proxy settings, existing profiles, credentials, or open user windows. Model requests use synthetic credentials against a local fixture only.

Coverage:

- Compare the renderer/default session and app network context against a fresh Electron session explicitly configured with `mode: system`.
- Ignore conflicting legacy `http.proxy` settings and, on macOS/Windows, conflicting shell proxy and `NO_PROXY` values.
- Exercise the real ToolExecutor → IPC → WebFetch `net.request` and WebSearch `net.fetch` paths against public sources.
- Exercise the real renderer model Provider streaming and embeddings against a local service, with system route resolution verified for that service.
- In an isolated ephemeral session, test PAC routing, switching proxy A to B, PAC DIRECT exceptions, explicit bypass rules, and failed proxy connections. The latter targets a reachable local origin and verifies it receives no direct fallback request.
- Run the isolated transport matrix through renderer `fetch`, session `fetch`, and main-process `net.request`.

A direct route returned by OS/PAC policy is valid. This test does not claim all destinations must traverse a proxy. The runtime must follow the selected system route, including bypass rules. The isolated proxy tests validate Chromium behavior; the production-path tests validate the application's integration with its system-configured session. Linux shell variables may be part of system proxy discovery, so the test does not inject conflicting shell settings on Linux.
