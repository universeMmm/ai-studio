/*---------------------------------------------------------------------------------------------
 *  Copyright (c) AI Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = name => readFileSync(path.join(root, name), 'utf8');
const manifest = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
	assert.deepEqual(lock.packages[''][field], manifest[field], `package-lock.json root ${field} is out of sync`);
}
for (const name of Object.keys(lock.packages)) {
	assert.ok(!/(?:^|\/)@github\/copilot(?:[-/]|$)/.test(name), `Removed Copilot dependency returned: ${name}`);
}

function checkBuildFiles(directory) {
	for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
		if (entry.name === 'node_modules' || entry.name.startsWith('.')) { continue; }
		const name = path.join(directory, entry.name);
		if (entry.isDirectory()) { checkBuildFiles(name); }
		else if (/\.(?:ts|yml)$/.test(name)) {
			assert.ok(!/downloadCopilotVsix\.ts|product-copilot[^\s'"/]*\.yml|@github\/copilot/.test(read(name)), `Removed Copilot build dependency returned: ${name}`);
		}
	}
}
checkBuildFiles('build');

// Match the desktop compiler's case-insensitive Agent Host exclusion on both
// case-sensitive (Linux) and case-insensitive (Windows/macOS) filesystems.
const configPath = path.join(root, 'src/tsconfig.json');
const config = ts.readConfigFile(configPath, ts.sys.readFile);
assert.equal(config.error, undefined);
for (const useCaseSensitiveFileNames of [true, false]) {
	const parsed = ts.parseJsonConfigFileContent(config.config, { ...ts.sys, useCaseSensitiveFileNames }, path.dirname(configPath));
	assert.equal(parsed.errors.length, 0);
	assert.ok(parsed.fileNames.length > 1000, 'Typecheck source set unexpectedly empty');
	for (const name of parsed.fileNames) {
		assert.ok(!/agentHost/i.test(path.relative(root, name)), `Disabled host included as typecheck root (caseSensitive=${useCaseSensitiveFileNames}): ${name}`);
	}
}

// Check the actual static runtime graph, rather than banning protocol names in
// retained upstream tests or type-only imports. The desktop compiler omits host
// implementation files; reaching one at runtime would ship a missing JS module.
const visited = new Set();
const pending = ['src/main.ts', 'src/vs/workbench/workbench.desktop.main.ts'];
while (pending.length) {
	const name = pending.pop();
	if (visited.has(name)) { continue; }
	visited.add(name);
	const source = ts.createSourceFile(name, read(name), ts.ScriptTarget.Latest, true);
	const add = specifier => {
		assert.ok(!/^@github\/copilot(?:[-/]|$)/.test(specifier), `Removed SDK imported by ${name}`);
		if (!specifier.startsWith('.')) { return; }
		const target = path.normalize(path.join(path.dirname(name), specifier.replace(/\.js$/, '.ts')));
		if (!target.endsWith('.ts') || target.endsWith('.d.ts') || !existsSync(path.join(root, target))) { return; }
		assert.ok(!/agentHost/i.test(target) || /noAgentHost/i.test(target), `Disabled Agent Host runtime reachable: ${name} -> ${target}`);
		pending.push(target);
	};
	const visit = node => {
		if (ts.isImportDeclaration(node)) {
			const clause = node.importClause;
			const bindings = clause?.namedBindings;
			const typesOnly = clause?.isTypeOnly || (clause && !clause.name && bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every(item => item.isTypeOnly));
			if (!typesOnly && ts.isStringLiteral(node.moduleSpecifier)) { add(node.moduleSpecifier.text); }
		} else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
			if (!node.exportClause || !ts.isNamedExports(node.exportClause) || node.exportClause.elements.some(item => !item.isTypeOnly)) { add(node.moduleSpecifier.text); }
		} else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length && ts.isStringLiteral(node.arguments[0])) {
			add(node.arguments[0].text);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
}
console.log(`AI dependency and runtime boundaries passed (${visited.size} source modules).`);
