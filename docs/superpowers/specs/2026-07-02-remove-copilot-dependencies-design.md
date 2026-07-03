# Remove Copilot Dependencies and Replace Chat Service — Design Spec

**Date:** 2026-07-02
**Status:** Approved
**Approach:** Plan A — Keep VS Code Chat framework, remove Copilot provider, clean branding

---

## 1. Goal

Remove all GitHub Copilot dependencies from the AI Studio (VS Code fork) and make the in-house AI agent system the sole chat provider. The product is a Cursor competitor: **editor-only, no subscription, user brings their own API key**.

## 2. Architecture Target

```
Before:                              After:
VS Code Chat Framework               VS Code Chat Framework
├── Copilot Agent (default)          └── AI Studio Agent (sole default)
├── AI Studio Agent (core)
└── setup agents

Product identity: GitHub Copilot     Product identity: AI Studio
LLM backend: @github/copilot-sdk     LLM backend: IAIModelService (in-house)
Auth: GitHub OAuth                   Auth: user API key (SecretStorage)
```

## 3. Layers (risk-ordered, low → high)

### L1: Build System

Remove all Copilot packaging tasks, CI pipelines, and npm dependencies.

| File | Action |
|------|--------|
| `package.json` | Remove `@github/copilot`, `@github/copilot-sdk` deps; remove `copilot:setup`/`copilot:get_token` scripts |
| `build/npm/dirs.ts` | Remove `extensions/copilot` from dirs list |
| `build/lib/copilot.ts` | **Delete entire file** |
| `build/gulpfile.extensions.ts` | Remove `compileCopilotExtensionBuildTask`, remove `.vscode/extensions/*` tsconfig paths |
| `build/gulpfile.vscode.ts` | Remove `prepareCopilotRipgrepShimTask` and all references to `build/lib/copilot.ts` |
| `build/gulpfile.reh.ts` | Remove Copilot ripgrep shim for remote extension host |
| `build/lib/extensions.ts` | Remove `packageCopilotExtensionStream`, remove Copilot import/usage |
| `build/hygiene.ts` | Remove `checkCopilotEnginesVersion` |
| `build/filters.ts` | Remove `extensions/copilot/**` exclusions |
| `build/.moduleignore` | Remove Copilot package stripping rules |
| `build/azure-pipelines/copilot/` | **Delete entire directory** |
| `build/azure-pipelines/product-copilot*.yml` | **Delete** |
| `build/azure-pipelines/common/downloadCopilotVsix.ts` | **Delete** |
| `build/copilot-migrate-pr.ts` | **Delete** |
| `build/npm/postinstall.ts` | Remove ESM patch for `@github/copilot-sdk`, remove `.claude/CLAUDE.md` symlink |

### L2: product.json

Rewrite the entire `defaultChatAgent` block. AI Studio has no backend service, no OAuth, no subscription — all URLs that point to GitHub Copilot services are replaced with empty strings or AI Studio equivalents.

**Key changes:**
- `chatExtensionId`: `"ai-studio.chat"`
- `chatExtensionOutputId`: `"ai-studio.chat.AI Studio Chat.log"`
- All `github.copilot.*` command IDs → `aiStudio.*`
- `providerScopes`: empty (no OAuth)
- `entitlementUrl`, `tokenEntitlementUrl`, `mcpRegistryDataUrl`: `""`
- `documentationUrl`, `termsStatementUrl`, `privacyStatementUrl`: `""` (Chat framework handles empty URLs gracefully)
- `builtInExtensionsEnabledWithAutoUpdates`: `[]` (was `["GitHub.copilot-chat"]`)

### L3: Constants and Context Key Rename

| File | Change |
|------|--------|
| `src/vs/workbench/contrib/chat/common/languageModels.ts` | `COPILOT_VENDOR_ID = 'copilot'` → `AI_STUDIO_VENDOR_ID = 'ai-studio'`; audit all 14 references |
| `src/vs/workbench/services/chat/common/chatEntitlementService.ts` | Rename `github.copilot.*` context keys → `aiStudio.*`; replace Copilot plan names with AI Studio equivalents |
| All other `src/` files referencing `github.copilot` | Rename context key strings, command IDs, setting IDs |

**Important:** `@vscode/copilot-api` npm package is **kept** — it is the VS Code extension API layer that third-party extensions use to provide language model providers. It is NOT Copilot-specific despite the name.

### L4: Chat Framework Hardcoded Strings

| File | Line | Change |
|------|------|--------|
| `chatListRenderer.ts` | 116 | `COPILOT_USERNAME = 'GitHub Copilot'` → `'AI Studio'` |
| `chatWidget.ts` | 1073 | Disclaimer text: remove "Copilot" from `"By continuing with {0} Copilot..."` |
| `chatQuick.ts` | 281 | Same disclaimer fix |
| `chatWidget.ts` | 1212 | `'@copilot '` prefix → `'@ai-studio '`; replace `aka.ms/coding-agent-docs` URL |
| `chatSetupProviders.ts` | 110 | Agent display name: don't append " Copilot" |
| `chatSetupProviders.ts` | 178 | Error message: replace "GitHub Copilot" |
| `chatSetupProviders.ts` | 611,618,792 | Tool prefix `copilot_` → `ai_studio_` |
| `chat.contribution.ts` (electron) | 273,316 | Session type `'copilotcli'` → `'aiStudioCli'` |

### L5: Chat Agent Switch

**This is the critical path.** The AI Studio agent (`aiStudioChatAgent.ts`) is already registered as `isDefault: true, isCore: true`. No code changes needed — this layer is about **verification**:

1. Confirm `ai-studio.chat` is registered before any other default agent
2. Confirm Chat panel opens with AI Studio agent as default
3. Confirm all 9 built-in tools work through the agent loop
4. Confirm inline chat, terminal chat, and editor chat locations all delegate correctly
5. Confirm `chatSetupProviders.ts` does not block Chat panel rendering when Copilot is absent

### L6: Extension API Types (Deferred)

`src/vscode-dts/vscode.d.ts` and proposal files contain Copilot-related API types (`CopilotRelated`, `CopilotChat`, etc.). These are deferred — they don't affect compilation or runtime, and changing them risks breaking third-party extension compatibility.

---

## 4. Verification Strategy

After each layer, verify compilation succeeds:

```bash
npm run compile
```

Full verification checklist:
1. `npm run compile` passes with zero errors
2. `npm run test-node` passes
3. Chat panel opens via `Ctrl+L`
4. AI Studio agent responds to prompts
5. Tool execution works (read_file, search_content, etc.)
6. No "Copilot" text visible in Chat UI
7. Status bar shows AI Studio model name
8. Settings UI shows `ai.*` config, not `github.copilot.*`

---

## 5. Risk Mitigation

**Biggest risk: Chat framework refuses to render without a recognized provider.**

Mitigation: The `ChatEntitlementService` short-circuits when `defaultChatAgent` is absent (line 411). AI Studio HAS `defaultChatAgent` configured, so the chat framework initializes normally. The AI Studio agent registers as `isDefault: true, isCore: true` before any extension-based agents load. If all else fails, `activateDefaultAgent` failures are caught silently (`.catch(e => this.logService.error(e))`).

**Second risk: Hard-to-find `github.copilot` string references cause runtime errors.**

Mitigation: Global grep for `github\.copilot` across all `.ts` files before final commit. Run the app and verify no errors in console.

**Third risk: Build system changes break CI.**

Mitigation: AI Studio is a fork — Microsoft's CI pipelines don't apply. Only local `npm run compile` matters.

---

## 6. Out of Scope

- Rewriting the Chat panel UI (kept as-is from VS Code)
- Removing `@vscode/copilot-api` (needed for extension API compatibility)
- Renaming Copilot-related types in `vscode.d.ts` (deferred to L6)
- Adding new AI features beyond the existing in-house agent system
