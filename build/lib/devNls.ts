/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import ts from 'typescript';

const repo = path.resolve(import.meta.dirname, '../..');

/**
 * Development outputs keep string keys at call sites. Match both key and English
 * source text to the translation in its original module, so common keys such as
 * "open" do not accidentally pick an unrelated command or a different placeholder.
 * Packaged builds already have module-scoped, numeric keys and skip this step.
 */
export async function writeDevNLS(outDir: string): Promise<void> {
	const folder = path.join(repo, 'extensions/studio-language-pack-zh-cn/translations');
	const contents: Record<string, Record<string, string>> = Object.create(null);
	for (const filename of ['main.i18n.json', 'studio.i18n.json']) {
		const bundle: { contents: Record<string, Record<string, string>> } = JSON.parse(await fs.readFile(path.join(folder, filename), 'utf8'));
		for (const [id, messages] of Object.entries(bundle.contents)) {
			Object.assign(contents[id] ??= Object.create(null), messages);
		}
	}
	const messages: Record<string, string> = Object.create(null);
	for (const [moduleId, translations] of Object.entries(contents)) {
		const filename = path.join(repo, 'src', moduleId + '.ts');
		let source: string;
		try {
			source = await fs.readFile(filename, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				continue; // Some upstream modules are omitted from this distribution.
			}
			throw error;
		}
		const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest);
		const functions = new Set<string>();
		const namespaces = new Set<string>();
		const isLocalize = (name: string) => name === 'localize' || name === 'localize2';
		for (const statement of file.statements) {
			if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.moduleSpecifier.text.endsWith('/nls.js')) {
				continue;
			}
			const bindings = statement.importClause?.namedBindings;
			if (bindings && ts.isNamespaceImport(bindings)) {
				namespaces.add(bindings.name.text);
			} else if (bindings) {
				for (const binding of bindings.elements) {
					if (isLocalize((binding.propertyName ?? binding.name).text)) {
						functions.add(binding.name.text);
					}
				}
			}
		}
		function visit(node: ts.Node): void {
			if (ts.isCallExpression(node)) {
				const callee = node.expression;
				const matches = ts.isIdentifier(callee) ? functions.has(callee.text)
					: ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && namespaces.has(callee.expression.text) && isLocalize(callee.name.text);
				let [key, message] = node.arguments;
				if (matches && key && message && ts.isStringLiteralLike(message)) {
					if (ts.isObjectLiteralExpression(key)) {
						const field = key.properties.find(p => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'key');
						if (field && ts.isPropertyAssignment(field)) {
							key = field.initializer;
						}
					}
					if (ts.isStringLiteralLike(key) && translations[key.text]) {
						messages[key.text + '\u0004' + message.text] ??= translations[key.text];
					}
				}
			}
			ts.forEachChild(node, visit);
		}
		ts.forEachChild(file, visit);
	}
	await fs.mkdir(outDir, { recursive: true });
	await fs.writeFile(path.join(outDir, 'nls.dev.zh-cn.json'), JSON.stringify(messages));
}
