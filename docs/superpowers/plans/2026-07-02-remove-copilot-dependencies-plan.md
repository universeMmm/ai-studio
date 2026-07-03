# Remove Copilot Dependencies & Replace Chat Service — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove all GitHub Copilot dependencies, branding, and provider registrations; make AI Studio's in-house agent the sole default chat provider.

**Architecture:** Six-layer approach (risk-ordered L1→L6). L1 removes build system references. L2 rewrites product.json. L3 renames constants and context keys. L4 cleans hardcoded Copilot strings in Chat UI. L5 verifies the AI Studio agent is the sole default. L6 is deferred (API types).

**Tech Stack:** TypeScript, Node.js, Gulp build system

**Spec:** `docs/superpowers/specs/2026-07-02-remove-copilot-dependencies-design.md`

---

## File Structure

| Layer | Files Modified | Files Deleted |
|-------|---------------|---------------|
| L1 | 11 modified | 8+ deleted |
| L2 | 1 modified | 0 |
| L3 | 4+ modified | 0 |
| L4 | 6 modified | 0 |
| L5 | 0 (verification only) | 0 |

---

### Task 1: L1 — Remove npm dependencies and scripts

**Files:**
- Modify: `package.json:78-105`

- [ ] **Step 1: Remove Copilot scripts and npm dependencies**

Edit `package.json`:

Remove lines 79-80 (the two copilot scripts):
```
Delete:
		"copilot:setup": "npm --prefix extensions/copilot run setup",
		"copilot:get_token": "npm --prefix extensions/copilot run get_token",
```

Remove lines 88-89 (the two @github/copilot production dependencies):
```
Delete:
		"@github/copilot": "1.0.49",
		"@github/copilot-sdk": "1.0.0-beta.4",
```

- [ ] **Step 2: Verify the edit is syntactically valid**

```bash
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))" && echo "OK"
```
Expected: `OK`

- [ ] **Step 3: Remove Copilot packages from node_modules**

```bash
rm -rf node_modules/@github/copilot node_modules/@github/copilot-sdk
```

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore: remove @github/copilot and @github/copilot-sdk npm dependencies

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: L1 — Remove extensions/copilot from build dirs list

**Files:**
- Modify: `build/npm/dirs.ts:18`

- [ ] **Step 1: Remove the line**

In `build/npm/dirs.ts`, remove line 18:
```
Delete:
	'extensions/copilot',
```

- [ ] **Step 2: Commit**

```bash
git add build/npm/dirs.ts
git commit -m "chore: remove extensions/copilot from npm dirs list

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: L1 — Remove extensions/copilot exclusions from build/filters.ts

**Files:**
- Modify: `build/filters.ts:67,133,213,235`

- [ ] **Step 1: Remove four `!extensions/copilot/**` lines**

In `build/filters.ts`, remove all four occurrences (each is preceded by a comment `// extensions/copilot has its own code style`):

Line ~67 area:
```
Delete both lines:
	// extensions/copilot has its own code style
	'!extensions/copilot/**',
```

Line ~133 area:
```
Delete both lines:
	// extensions/copilot has its own code style
	'!extensions/copilot/**',
```

Line ~213 area:
```
Delete both lines:
	// extensions/copilot has its own code style
	'!extensions/copilot/**',
```

Line ~235 area:
```
Delete both lines:
	// extensions/copilot has its own code style
	'!extensions/copilot/**',
```

- [ ] **Step 2: Commit**

```bash
git add build/filters.ts
git commit -m "chore: remove extensions/copilot exclusions from build filters

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: L1 — Remove copilot engines version check from build/hygiene.ts

**Files:**
- Modify: `build/hygiene.ts:25-55,295-315`

- [ ] **Step 1: Remove checkCopilotEnginesVersion function (lines 33-48)**

Delete the entire function:
```typescript
/**
 * Checks that engines.vscode in extensions/copilot/package.json matches ^{version} from the root package.json.
 * Returns an error message if mismatched, or undefined if OK.
 */
export function checkCopilotEnginesVersion(repoRoot: string): string | undefined {
	const rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
	const copilotPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'extensions/copilot/package.json'), 'utf8'));
	const expected = `^${rootPkg.version}`;
	const actual = copilotPkg?.engines?.vscode;
	if (actual !== expected) {
		return `engines.vscode in 'extensions/copilot/package.json' must be "${expected}" (the version from the root package.json), but found "${actual ?? '<missing>'}"`;
	}
	return undefined;
}
```

- [ ] **Step 2: Remove the caller in the hygiene function (lines 304-308)**

Delete:
```typescript
				// Check copilot engines.vscode version if relevant files are staged
				if (some.some(f => f === 'package.json' || f.startsWith('extensions/copilot/'))) {
					const copilotError = checkCopilotEnginesVersion(process.cwd());
					if (copilotError) {
						console.error(copilotError);
						process.exit(1);
					}
				}
```

- [ ] **Step 3: Commit**

```bash
git add build/hygiene.ts
git commit -m "chore: remove copilot engines version check from hygiene

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: L1 — Delete build/lib/copilot.ts

**Files:**
- Delete: `build/lib/copilot.ts`

- [ ] **Step 1: Delete the file**

```bash
rm build/lib/copilot.ts
```

- [ ] **Step 2: Commit**

```bash
git rm build/lib/copilot.ts
git commit -m "chore: delete build/lib/copilot.ts (Copilot native binary handling)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: L1 — Remove Copilot from build/lib/extensions.ts

**Files:**
- Modify: `build/lib/extensions.ts:307,459-484`

- [ ] **Step 1: Remove 'copilot' from excludedExtensions array (line 307)**

Change:
```typescript
const excludedExtensions = [
	'copilot',
	'vscode-api-tests',
```
To:
```typescript
const excludedExtensions = [
	'vscode-api-tests',
```

- [ ] **Step 2: Delete packageCopilotExtensionStream function (lines 459-484)**

Delete the entire function:
```typescript
/**
 * Package the built-in copilot extension specifically.
 * This is used by non-CI local builds where copilot is not downloaded as a VSIX
 * but must be compiled from source and included in the build.
 */
export function packageCopilotExtensionStream(disableMangle: boolean): Stream {
	const extensionPath = path.join(root, 'extensions', 'copilot');
	if (!fs.existsSync(extensionPath)) {
		return es.readArray([]);
	}

	const localExtensionsStream = minifyExtensionResources(
		fromLocal(extensionPath, false, disableMangle)
			.pipe(rename(p => p.dirname = `extensions/copilot/${p.dirname}`))
	);

	const productionDependencies = getProductionDependencies('extensions/copilot');
	const dependenciesSrc = productionDependencies.map(d => path.relative(root, d)).map(d => [`${d}/**`, `!${d}/**/{test,tests}/**`]).flat();

	return es.merge(
		localExtensionsStream,
		gulp.src(dependenciesSrc, { base: '.' })
			.pipe(util2.cleanNodeModules(path.join(root, 'build', '.moduleignore')))
			.pipe(util2.cleanNodeModules(path.join(root, 'build', `.moduleignore.${process.platform}`)))
	).pipe(util2.setExecutableBit(['**/*.sh']));
}
```

- [ ] **Step 3: Commit**

```bash
git add build/lib/extensions.ts
git commit -m "chore: remove copilot from extensions build (excludedExtensions + packageCopilotExtensionStream)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: L1 — Remove Copilot from build/gulpfile.extensions.ts

**Files:**
- Modify: `build/gulpfile.extensions.ts:287-291`

- [ ] **Step 1: Find and remove compileCopilotExtensionBuildTask**

Search for `compileCopilotExtensionBuildTask` in the file. Remove its definition and all references in task series.

The task definition pattern will look like:
```typescript
const compileCopilotExtensionBuildTask = task.define('compile-copilot-extension-build', ...);
```
Remove the entire task definition block.

Then in every task series that references `compileCopilotExtensionBuildTask`, remove it from the series array.

**Important:** This file also already has the `.vscode/extensions/*` paths commented out from our earlier fix. Verify those are still commented.

- [ ] **Step 2: Commit**

```bash
git add build/gulpfile.extensions.ts
git commit -m "chore: remove compileCopilotExtensionBuildTask from gulpfile.extensions

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: L1 — Remove Copilot from build/gulpfile.vscode.ts

**Files:**
- Modify: `build/gulpfile.vscode.ts:594-609,636,662,673`

- [ ] **Step 1: Remove prepareCopilotRipgrepShimTask function**

Delete the function at lines 594-609:
```typescript
function prepareCopilotRipgrepShimTask(platform: string, arch: string, destinationFolderName: string) {
	const outputDir = path.join(path.dirname(root), destinationFolderName);

	return async () => {
		const versionedResourcesFolder = util.getVersionedResourcesFolder(platform, commit!);
		const appBase = platform === 'darwin'
			? path.join(outputDir, `${product.nameLong}.app`, 'Contents', 'Resources', 'app')
			: path.join(outputDir, versionedResourcesFolder, 'resources', 'app');
		const appNodeModulesDir = path.join(appBase, 'node_modules');

		const builtInCopilotExtensionDir = path.join(appBase, 'extensions', 'copilot');
		prepareBuiltInCopilotRipgrepShim(platform, arch, builtInCopilotExtensionDir, appNodeModulesDir);
	};
}
```

- [ ] **Step 2: Remove the import of prepareBuiltInCopilotRipgrepShim**

Search for and remove the import line:
```typescript
import { prepareBuiltInCopilotRipgrepShim } from './lib/copilot.ts';
```
Or it may be imported from a destructured import like:
```typescript
import { getCopilotExcludeFilter, prepareBuiltInCopilotRipgrepShim } from './lib/copilot.ts';
```
If it's destructured with other exports, just remove `prepareBuiltInCopilotRipgrepShim, ` from the import. If it's the only import, remove the entire line.

- [ ] **Step 3: Remove prepareCopilotRipgrepShimTask from packageTasks array (line ~636)**

Remove the line:
```typescript
				prepareCopilotRipgrepShimTask(platform, arch, destinationFolderName)
```
from the `packageTasks` array.

- [ ] **Step 4: Remove compileCopilotExtensionBuildTask from task series (lines ~662, ~673)**

In both task series (with and without mangling), remove:
```typescript
				compileCopilotExtensionBuildTask,
```

- [ ] **Step 5: Remove any remaining copilot import if still referenced**

Search for `copilot` in the file to confirm no remaining references. If `getCopilotExcludeFilter` or `copilotPlatforms` are used elsewhere in this file, remove those references too.

- [ ] **Step 6: Commit**

```bash
git add build/gulpfile.vscode.ts
git commit -m "chore: remove copilot ripgrep shim and build tasks from gulpfile.vscode

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: L1 — Remove Copilot from build/gulpfile.reh.ts

**Files:**
- Modify: `build/gulpfile.reh.ts:497-505,556,570`

- [ ] **Step 1: Remove prepareCopilotRipgrepShimTaskREH function**

Delete the function at lines 497-505:
```typescript
function prepareCopilotRipgrepShimTaskREH(platform: string, arch: string, destinationFolderName: string) {
	return async () => {
		const outputDir = path.join(BUILD_ROOT, destinationFolderName);
		const nodeModulesDir = path.join(outputDir, 'node_modules');

		const builtInCopilotExtensionDir = path.join(outputDir, 'extensions', 'copilot');
		prepareBuiltInCopilotRipgrepShim(platform, arch, builtInCopilotExtensionDir, nodeModulesDir);
	};
}
```

- [ ] **Step 2: Remove the import of prepareBuiltInCopilotRipgrepShim**

As in Task 8 Step 2, remove the import from `./lib/copilot.ts`.

- [ ] **Step 3: Remove prepareCopilotRipgrepShimTaskREH from packageTasks (line ~556)**

Remove:
```typescript
				prepareCopilotRipgrepShimTaskREH(platform, arch, destinationFolderName)
```

- [ ] **Step 4: Remove compileCopilotExtensionBuildTask from task series (line ~570)**

Remove:
```typescript
				compileCopilotExtensionBuildTask,
```

- [ ] **Step 5: Commit**

```bash
git add build/gulpfile.reh.ts
git commit -m "chore: remove copilot ripgrep shim from gulpfile.reh

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: L1 — Clean build/.moduleignore

**Files:**
- Modify: `build/.moduleignore:217-244`

- [ ] **Step 1: Remove Copilot-related ignore rules**

Delete lines 217-244 (from `# @github/copilot - strip unneeded binaries and files` through the `@github/copilot-sdk/node_modules/@github/copilot-win32-x64/**` line):

```
Delete all lines from:
# @github/copilot - strip unneeded binaries and files
through:
@github/copilot-sdk/node_modules/@github/copilot-win32-x64/**
```

- [ ] **Step 2: Commit**

```bash
git add build/.moduleignore
git commit -m "chore: remove copilot package stripping rules from .moduleignore

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: L1 — Clean build/npm/postinstall.ts

**Files:**
- Modify: `build/npm/postinstall.ts:315-350`

- [ ] **Step 1: Remove the .claude/CLAUDE.md symlink creation (lines 319-329)**

Delete:
```typescript
	// Symlink .claude/ files to their canonical locations to test Claude agent harness
	const claudeDir = path.join(root, '.claude');
	fs.mkdirSync(claudeDir, { recursive: true });

	const claudeMdLink = path.join(claudeDir, 'CLAUDE.md');
	const claudeMdLinkType = ensureAgentHarnessLink(path.join('..', '.github', 'copilot-instructions.md'), claudeMdLink);
	if (claudeMdLinkType !== 'existing') {
		log('.', `Created ${claudeMdLinkType} .claude/CLAUDE.md -> .github/copilot-instructions.md`);
	}

	const claudeSkillsLink = path.join(claudeDir, 'skills');
	const claudeSkillsLinkType = ensureAgentHarnessLink(path.join('..', '.agents', 'skills'), claudeSkillsLink);
	if (claudeSkillsLinkType !== 'existing') {
		log('.', `Created ${claudeSkillsLinkType} .claude/skills -> .agents/skills`);
	}
```

- [ ] **Step 2: Remove the ESM patch for @github/copilot-sdk (lines 334-344)**

Delete:
```typescript
	// Temporary: patch @github/copilot-sdk session.js to fix ESM import
	// (missing .js extension on vscode-jsonrpc/node). Fixed upstream in v0.1.32.
	// TODO: Remove once @github/copilot-sdk is updated to >=0.1.32
	for (const dir of ['', 'remote']) {
		const sessionFile = path.join(root, dir, 'node_modules', '@github', 'copilot-sdk', 'dist', 'session.js');
		if (fs.existsSync(sessionFile)) {
			const content = fs.readFileSync(sessionFile, 'utf8');
			const patched = content.replace(/from "vscode-jsonrpc\/node"/g, 'from "vscode-jsonrpc/node.js"');
			if (content !== patched) {
				fs.writeFileSync(sessionFile, patched);
				log(dir || '.', 'Patched @github/copilot-sdk session.js (vscode-jsonrpc ESM import fix)');
			}
		}
	}
```

- [ ] **Step 3: Commit**

```bash
git add build/npm/postinstall.ts
git commit -m "chore: remove copilot-related postinstall steps (symlink + ESM patch)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: L1 — Delete Copilot CI pipelines and developer tools

**Files:**
- Delete: `build/azure-pipelines/copilot/` (entire directory)
- Delete: `build/azure-pipelines/product-copilot.yml`
- Delete: `build/azure-pipelines/product-copilot-recovery.yml`
- Delete: `build/azure-pipelines/common/downloadCopilotVsix.ts`
- Delete: `build/copilot-migrate-pr.ts`

- [ ] **Step 1: Delete the files**

```bash
rm -rf build/azure-pipelines/copilot
rm build/azure-pipelines/product-copilot.yml 2>/dev/null
rm build/azure-pipelines/product-copilot-recovery.yml 2>/dev/null
rm build/azure-pipelines/common/downloadCopilotVsix.ts 2>/dev/null
rm build/copilot-migrate-pr.ts 2>/dev/null
```

- [ ] **Step 2: Commit**

```bash
git rm -r build/azure-pipelines/copilot 2>/dev/null
git rm build/azure-pipelines/product-copilot.yml 2>/dev/null
git rm build/azure-pipelines/product-copilot-recovery.yml 2>/dev/null
git rm build/azure-pipelines/common/downloadCopilotVsix.ts 2>/dev/null
git rm build/copilot-migrate-pr.ts 2>/dev/null
git commit -m "chore: delete Copilot CI pipelines and developer tools

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: L1 — Verify compilation after build system cleanup

- [ ] **Step 1: Run compile**

```bash
npm run compile 2>&1
```

Expected: Compilation succeeds with zero errors. If errors appear, they will be from remaining references to deleted files — fix them before proceeding.

- [ ] **Step 2: If compile passes, commit any remaining stragglers**

```bash
git add -A
git diff --cached --stat
```

If there are additional changed files needed for compilation, commit them:
```bash
git commit -m "chore: fix remaining copilot references found during compilation

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: L2 — Rewrite product.json defaultChatAgent

**Files:**
- Modify: `product.json:88-141,222-223`

- [ ] **Step 1: Replace the entire defaultChatAgent block**

Replace `product.json` lines 88-141 (the entire `"defaultChatAgent"` block) with:

```json
	"defaultChatAgent": {
		"extensionId": "ai-studio",
		"chatExtensionId": "ai-studio.chat",
		"chatExtensionOutputId": "ai-studio.chat.AI Studio Chat.log",
		"chatExtensionOutputExtensionStateCommand": "aiStudio.debug.extensionState",
		"documentationUrl": "",
		"termsStatementUrl": "",
		"privacyStatementUrl": "",
		"skusDocumentationUrl": "",
		"publicCodeMatchesUrl": "",
		"managePlanUrl": "",
		"upgradePlanUrl": "",
		"signUpUrl": "",
		"provider": {
			"default": {
				"id": "ai-studio",
				"name": "AI Studio"
			}
		},
		"providerExtensionId": "",
		"providerUriSetting": "",
		"providerScopes": [],
		"entitlementUrl": "",
		"entitlementSignupLimitedUrl": "",
		"chatQuotaExceededContext": "",
		"completionsQuotaExceededContext": "",
		"walkthroughCommand": "",
		"completionsMenuCommand": "",
		"chatRefreshTokenCommand": "",
		"generateCommitMessageCommand": "",
		"resolveMergeConflictsCommand": "",
		"completionsAdvancedSetting": "",
		"completionsEnablementSetting": "",
		"nextEditSuggestionsSetting": "",
		"tokenEntitlementUrl": "",
		"mcpRegistryDataUrl": ""
	},
```

- [ ] **Step 2: Update builtInExtensionsEnabledWithAutoUpdates (line 222)**

Change:
```json
	"builtInExtensionsEnabledWithAutoUpdates": [
		"GitHub.copilot-chat"
	],
```
To:
```json
	"builtInExtensionsEnabledWithAutoUpdates": [],
```

- [ ] **Step 3: Verify JSON validity**

```bash
node -e "JSON.parse(require('fs').readFileSync('product.json','utf8'))" && echo "OK"
```
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add product.json
git commit -m "feat: rewrite defaultChatAgent to AI Studio — remove all Copilot URLs and GitHub OAuth config

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: L3 — Rename COPILOT_VENDOR_ID in languageModels.ts

**Files:**
- Modify: `src/vs/workbench/contrib/chat/common/languageModels.ts:45,249,640,727-729,793,892-893,2113,2123`

- [ ] **Step 1: Rename the constant definition (line 45)**

Change:
```typescript
export const COPILOT_VENDOR_ID = 'copilot';
```
To:
```typescript
export const AI_STUDIO_VENDOR_ID = 'ai-studio';
```

- [ ] **Step 2: Replace all COPILOT_VENDOR_ID references**

Global find-and-replace in this file: `COPILOT_VENDOR_ID` → `AI_STUDIO_VENDOR_ID`

This covers lines 249, 727, and 793.

- [ ] **Step 3: Rename AUTO_MODEL_IDENTIFIER (line 640)**

Change:
```typescript
const AUTO_MODEL_IDENTIFIER = 'copilot/auto';
```
To:
```typescript
const AUTO_MODEL_IDENTIFIER = 'ai-studio/auto';
```

- [ ] **Step 4: Update model cache prefix (lines 2113, 2123)**

Change:
```typescript
			free[entry.id] = { label: entry.label, featured: entry.featured, exists: this._modelCache.has(`copilot/${entry.id}`) };
```
To:
```typescript
			free[entry.id] = { label: entry.label, featured: entry.featured, exists: this._modelCache.has(`ai-studio/${entry.id}`) };
```

Change:
```typescript
			paid[entry.id] = { label: entry.label, featured: entry.featured, minVSCodeVersion: entry.minVSCodeVersion, exists: this._modelCache.has(`copilot/${entry.id}`) };
```
To:
```typescript
			paid[entry.id] = { label: entry.label, featured: entry.featured, minVSCodeVersion: entry.minVSCodeVersion, exists: this._modelCache.has(`ai-studio/${entry.id}`) };
```

- [ ] **Step 5: Update comment at line 892**

Change:
```typescript
						// Special case for copilot models - they are all user selectable unless marked otherwise
```
To:
```typescript
						// Special case for AI Studio models - they are all user selectable unless marked otherwise
```

- [ ] **Step 6: Commit**

```bash
git add src/vs/workbench/contrib/chat/common/languageModels.ts
git commit -m "refactor: rename COPILOT_VENDOR_ID to AI_STUDIO_VENDOR_ID in languageModels

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 16: L3 — Rename github.copilot context keys in chatEntitlementService.ts

**Files:**
- Modify: `src/vs/workbench/services/chat/common/chatEntitlementService.ts:60-74,460-479`

- [ ] **Step 1: Rename context keys (lines 69, 71, 73)**

Change:
```typescript
	export const clientByokEnabled = new RawContextKey<boolean>('github.copilot.clientByokEnabled', true, true);

	export const hasByokModels = new RawContextKey<boolean>('github.copilot.hasByokModels', false, true);
```
To:
```typescript
	export const clientByokEnabled = new RawContextKey<boolean>('aiStudio.clientByokEnabled', true, true);

	export const hasByokModels = new RawContextKey<boolean>('aiStudio.hasByokModels', false, true);
```

- [ ] **Step 2: Update context key reads (lines 470, 474, 478)**

Change:
```typescript
	get previewFeaturesDisabled(): boolean {
		return this.contextKeyService.getContextKeyValue<boolean>('github.copilot.previewFeaturesDisabled') === true;
	}
```
To:
```typescript
	get previewFeaturesDisabled(): boolean {
		return this.contextKeyService.getContextKeyValue<boolean>('aiStudio.previewFeaturesDisabled') === true;
	}
```

Change:
```typescript
	get clientByokEnabled(): boolean {
		return this.contextKeyService.getContextKeyValue<boolean>('github.copilot.clientByokEnabled') === true;
	}
```
To:
```typescript
	get clientByokEnabled(): boolean {
		return this.contextKeyService.getContextKeyValue<boolean>('aiStudio.clientByokEnabled') === true;
	}
```

Change:
```typescript
	get hasByokModels(): boolean {
		return this.contextKeyService.getContextKeyValue<boolean>('github.copilot.hasByokModels') === true;
	}
```
To:
```typescript
	get hasByokModels(): boolean {
		return this.contextKeyService.getContextKeyValue<boolean>('aiStudio.hasByokModels') === true;
	}
```

- [ ] **Step 3: Global search for remaining github.copilot context key references**

```bash
grep -rn "github\.copilot\." src/ --include="*.ts" 2>/dev/null
```

For each remaining reference, rename `github.copilot.` → `aiStudio.` in context key strings. These will be in files like:
- `src/vs/workbench/contrib/chat/browser/chat.contribution.ts`
- `src/vs/workbench/contrib/chat/common/chatParticipant.contribution.ts`
- `src/vs/workbench/contrib/chat/browser/actions/chatActions.ts`

**Important:** Do NOT rename `github.copilot` in `src/vscode-dts/` files (those are deferred L6).

- [ ] **Step 4: Run compile to verify**

```bash
npm run compile 2>&1
```
Expected: Zero errors. Fix any stragglers.

- [ ] **Step 5: Commit**

```bash
git add src/vs/workbench/services/chat/common/chatEntitlementService.ts
git add src/vs/workbench/contrib/chat/browser/chat.contribution.ts 2>/dev/null
git add src/vs/workbench/contrib/chat/common/chatParticipant.contribution.ts 2>/dev/null
git add src/vs/workbench/contrib/chat/browser/actions/chatActions.ts 2>/dev/null
git commit -m "refactor: rename github.copilot.* context keys to aiStudio.*

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 17: L4 — Clean Copilot strings in chatListRenderer.ts

**Files:**
- Modify: `src/vs/workbench/contrib/chat/browser/widget/chatListRenderer.ts:116`

- [ ] **Step 1: Rename COPILOT_USERNAME**

Change:
```typescript
const COPILOT_USERNAME = 'GitHub Copilot';
```
To:
```typescript
const COPILOT_USERNAME = 'AI Studio';
```

- [ ] **Step 2: Commit**

```bash
git add src/vs/workbench/contrib/chat/browser/widget/chatListRenderer.ts
git commit -m "refactor: rename COPILOT_USERNAME to AI Studio in chat list renderer

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 18: L4 — Clean Copilot strings in chatWidget.ts

**Files:**
- Modify: `src/vs/workbench/contrib/chat/browser/widget/chatWidget.ts:1073,1212`

- [ ] **Step 1: Remove "Copilot" from disclaimer text (line 1073)**

Change:
```typescript
					additionalMessage = new MarkdownString(localize({ key: 'settings', comment: ['{Locked="]({2})"}', '{Locked="]({3})"}'] }, "By continuing with {0} Copilot, you agree to {1}'s [Terms]({2}) and [Privacy Statement]({3}).", providers.default.name, providers.default.name, product.defaultChatAgent.termsStatementUrl, product.defaultChatAgent.privacyStatementUrl), { isTrusted: true });
```
To:
```typescript
					additionalMessage = new MarkdownString(localize({ key: 'settings', comment: ['{Locked="]({2})"}', '{Locked="]({3})"}'] }, "By continuing with {0}, you agree to {1}'s [Terms]({2}) and [Privacy Statement]({3}).", providers.default.name, providers.default.name, product.defaultChatAgent.termsStatementUrl, product.defaultChatAgent.privacyStatementUrl), { isTrusted: true });
```

- [ ] **Step 2: Update @copilot prefix check (line 1212)**

Change:
```typescript
				? new MarkdownString(localize('copilotCodingAgentMessage', "This chat session will be forwarded to the {0} [coding agent]({1}) where work is completed in the background. ", this._lockedAgent.prefix, 'https://aka.ms/coding-agent-docs') + DISCLAIMER, { isTrusted: true })
```
To:
```typescript
				? new MarkdownString(localize('codingAgentMessage', "This chat session will be forwarded to the {0} [coding agent]({1}) where work is completed in the background. ", this._lockedAgent.prefix, '') + DISCLAIMER, { isTrusted: true })
```

And change the condition from:
```typescript
			: (this._lockedAgent?.prefix === '@copilot '
```
To:
```typescript
			: (this._lockedAgent?.prefix === '@ai-studio '
```

- [ ] **Step 3: Commit**

```bash
git add src/vs/workbench/contrib/chat/browser/widget/chatWidget.ts
git commit -m "refactor: remove Copilot branding from chat widget disclaimer and coding agent text

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 19: L4 — Clean Copilot strings in chatQuick.ts

**Files:**
- Modify: `src/vs/workbench/contrib/chat/browser/chatQuick.ts`

- [ ] **Step 1: Find and fix disclaimer text**

Search for `Copilot` in the file:
```bash
grep -n "Copilot" src/vs/workbench/contrib/chat/browser/chatQuick.ts
```

Apply the same fix as Task 18 Step 1: remove "Copilot" from the localized disclaimer string.

- [ ] **Step 2: Commit**

```bash
git add src/vs/workbench/contrib/chat/browser/chatQuick.ts
git commit -m "refactor: remove Copilot branding from quick chat disclaimer

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 20: L4 — Clean Copilot strings in chatSetupProviders.ts

**Files:**
- Modify: `src/vs/workbench/contrib/chat/browser/chatSetup/chatSetupProviders.ts:110,178,611,618,792`

- [ ] **Step 1: Remove "Copilot" from agent display name (line 110)**

Change:
```typescript
		return SetupAgent.doRegisterAgent(instantiationService, chatAgentService, id, `${defaultChat.provider.default.name} Copilot` /* Do NOT change, this hides the username altogether in Chat */, true, description, location, mode, context, controller);
```
To:
```typescript
		return SetupAgent.doRegisterAgent(instantiationService, chatAgentService, id, `${defaultChat.provider.default.name}` /* Do NOT change, this hides the username altogether in Chat */, true, description, location, mode, context, controller);
```

- [ ] **Step 2: Update SETUP_NEEDED_MESSAGE (line 178)**

Change:
```typescript
private static readonly SETUP_NEEDED_MESSAGE = new MarkdownString(localize('settingUpCopilotNeeded', "You need to set up GitHub Copilot and be signed in to use Chat."));
```
To:
```typescript
private static readonly SETUP_NEEDED_MESSAGE = new MarkdownString(localize('settingUpAINeeded', "You need to configure your AI provider and API key to use Chat."));
```

- [ ] **Step 3: Rename tool prefix checks (lines 611, 618)**

Change:
```typescript
			if (tool.id.startsWith('copilot_')) {
```
To:
```typescript
			if (tool.id.startsWith('ai_studio_')) {
```
(Both occurrences — lines 611 and 618)

- [ ] **Step 4: Rename tool prefix in replaceToolInRequestModel (line 792)**

Change:
```typescript
		const toolId = toolPart.toolId.replace(/setup.tools\./, `copilot_`.toLowerCase());
```
To:
```typescript
		const toolId = toolPart.toolId.replace(/setup.tools\./, `ai_studio_`.toLowerCase());
```

- [ ] **Step 5: Commit**

```bash
git add src/vs/workbench/contrib/chat/browser/chatSetup/chatSetupProviders.ts
git commit -m "refactor: remove Copilot branding from chat setup providers (names, messages, tool prefixes)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 21: L4 — Clean Copilot strings in chat.contribution.ts (electron-browser)

**Files:**
- Modify: `src/vs/workbench/contrib/chat/electron-browser/chat.contribution.ts:273-358`

- [ ] **Step 1: Rename copilotcli to aiStudioCli**

In the function `getCopilotAgentInfo`, change:
```typescript
	return rootState.agents.find(a => a.provider === 'copilotcli');
```
To:
```typescript
	return rootState.agents.find(a => a.provider === 'aiStudioCli');
```

- [ ] **Step 2: Rename the function**

Change `getCopilotAgentInfo` to `getAgentInfo` (both definition and all call sites).

- [ ] **Step 3: Update error message**

Change:
```typescript
		throw new Error('Agent host did not register a copilotcli agent within the timeout period. Ensure the agent host is enabled and running.');
```
To:
```typescript
		throw new Error('Agent host did not register an aiStudioCli agent within the timeout period. Ensure the agent host is enabled and running.');
```

- [ ] **Step 4: Update comments**

Change all comments referencing "copilotcli" or "copilot" to use "aiStudioCli" or "AI Studio" respectively.

- [ ] **Step 5: Commit**

```bash
git add src/vs/workbench/contrib/chat/electron-browser/chat.contribution.ts
git commit -m "refactor: rename copilotcli agent host session type to aiStudioCli

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 22: L4 — Global find-and-replace remaining "github.copilot" command/setting IDs

**Files:**
- Various `src/` files — determined by grep

- [ ] **Step 1: Find all remaining references**

```bash
grep -rn "github\.copilot" src/ --include="*.ts" | grep -v "vscode-dts" | grep -v "node_modules"
```

- [ ] **Step 2: For each hit, determine if it's a command ID, setting ID, or context key**

Replace:
- `github.copilot.chat.quotaExceeded` → `aiStudio.chat.quotaExceeded`
- `github.copilot.completions.quotaExceeded` → `aiStudio.completions.quotaExceeded`
- `github.copilot.open.walkthrough` → `aiStudio.open.walkthrough`
- `github.copilot.toggleStatusMenu` → `aiStudio.toggleStatusMenu`
- `github.copilot.refreshToken` → `aiStudio.refreshToken`
- `github.copilot.git.generateCommitMessage` → `aiStudio.git.generateCommitMessage`
- `github.copilot.git.resolveMergeConflicts` → `aiStudio.git.resolveMergeConflicts`
- `github.copilot.advanced` → `aiStudio.advanced`
- `github.copilot.enable` → `aiStudio.enable`
- `github.copilot.nextEditSuggestions.enabled` → `aiStudio.nextEditSuggestions.enabled`

- [ ] **Step 3: Run compile to verify**

```bash
npm run compile 2>&1
```
Expected: Zero errors.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: global rename of github.copilot.* command/setting IDs to aiStudio.*

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 23: L5 — Verify compilation and tests

- [ ] **Step 1: Full compile**

```bash
npm run compile 2>&1
```
Expected: Zero errors, zero TypeScript warnings.

- [ ] **Step 2: Run unit tests**

```bash
npm run test-node 2>&1
```
Expected: All tests pass.

- [ ] **Step 3: Final grep for any remaining "copilot" references in src/**

```bash
grep -rn -i "copilot" src/ --include="*.ts" | grep -v "vscode-dts" | grep -v "node_modules" | grep -v "copilot-api"
```
Expected: No remaining references outside `src/vscode-dts/` and `@vscode/copilot-api` import.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: final cleanup — verify zero copilot references remain in src/

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 24: L5 — Manual verification checklist

These steps require the app to be running. Execute `./scripts/code.sh` and verify:

- [ ] **Step 1: Chat panel opens via Ctrl+L**
- [ ] **Step 2: AI Studio agent is the default (no Copilot setup prompt)**
- [ ] **Step 3: Chat panel shows no "Copilot" text in welcome screen**
- [ ] **Step 4: Status bar shows AI Studio model name**
- [ ] **Step 5: Settings include `ai.*` config, no `github.copilot.*`**
- [ ] **Step 6: `npm run test-node` still passes**

---

## Deferred: L6 — Extension API Types

Not in this plan. The files in `src/vscode-dts/` contain Copilot-related proposal API type names. They do not affect compilation or runtime. Changing them risks breaking third-party extensions that use `@vscode/copilot-api`.
