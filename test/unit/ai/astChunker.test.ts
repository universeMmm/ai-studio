/*---------------------------------------------------------------------------------------------
 *  AI Studio - AST Chunker Tests
 *--------------------------------------------------------------------------------------------*/

import * as assert from "assert";
import { astChunkFile } from "../../../src/vs/platform/ai/common/astChunker.js";

suite("AST Chunker", () => {

	test("chunks TypeScript class definition", () => {
		const code = "import { foo } from './bar';\n\nclass Calculator {\n  add(a: number, b: number): number {\n    return a + b;\n  }\n}\n";
		const chunks = astChunkFile("/test/calc.ts", code, "typescript");
		assert.ok(chunks.length >= 1);
		assert.ok(chunks.some(c => c.kind === 'class'), "should find a class chunk");
	});

	test("chunks TypeScript function", () => {
		const code = "export function hello(name: string): string {\n  return 'Hello, ' + name;\n}\n";
		const chunks = astChunkFile("/test/hello.ts", code, "typescript");
		assert.ok(chunks.some(c => c.kind === 'function' && c.name === 'hello'));
	});

	test("chunks Python class and method", () => {
		const code = "class Dog:\n  def bark(self):\n    return 'woof'\n\n  def fetch(self, item):\n    return item\n";
		const chunks = astChunkFile("/test/dog.py", code, "python");
		assert.ok(chunks.some(c => c.kind === 'class' && c.name === 'Dog'));
		assert.ok(chunks.some(c => c.kind === 'function' && c.name === 'bark'));
	});

	test("chunks Go struct", () => {
		const code = "package main\n\ntype Server struct {\n  port int\n}\n\nfunc (s *Server) Start() error {\n  return nil\n}\n";
		const chunks = astChunkFile("/test/server.go", code, "go");
		assert.ok(chunks.some(c => c.kind === 'class' && c.name === 'Server'));
	});

	test("falls back to regex for unsupported languages", () => {
		const code = "def hello\n  puts 'hi'\nend\n";
		const chunks = astChunkFile("/test/hi.rb", code, "ruby");
		assert.ok(chunks.length >= 1, "should produce at least 1 chunk via regex fallback");
	});

	test("single-line module returns 1 chunk", () => {
		const code = "console.log('hello');";
		const chunks = astChunkFile("/test/one-liner.js", code, "javascript");
		assert.strictEqual(chunks.length, 1);
		assert.strictEqual(chunks[0].kind, 'module');
	});

	test("empty file returns 1 module chunk", () => {
		const chunks = astChunkFile("/test/empty.ts", "", "typescript");
		assert.strictEqual(chunks.length, 1);
	});

	test("boundary at line 1 produces correct startLine", () => {
		const code = "function first() {}\nfunction second() {}\n";
		const chunks = astChunkFile("/test/two.ts", code, "typescript");
		const funcs = chunks.filter(c => c.kind === 'function');
		assert.strictEqual(funcs.length, 2);
		assert.strictEqual(funcs[0].startLine, 1);
		assert.strictEqual(funcs[1].startLine, 2);
	});

});
