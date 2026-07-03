/*---------------------------------------------------------------------------------------------
 *  AI Studio - Token Counter Accuracy Benchmarks
 *  Validates against known tiktoken reference values (±35% tolerance).
 *--------------------------------------------------------------------------------------------*/

import * as assert from "assert";
import { countTokens } from "../../../src/vs/platform/ai/common/tokenCounter.js";

const REFERENCE_CASES: Array<[string, string, number]> = [
	["empty", "", 0],
	["hello", "Hello world", 2],
	["function", "function hello() { return 42; }", 10],
	["multi-line", "line1\nline2\nline3", 4],
	["import", "import { foo } from './bar';", 8],
	["comment", "// This is a single line comment", 8],
	["array reduce", "const sum = items.reduce((a: number, b: number) => a + b, 0);", 17],
	["prompt", "You are a helpful coding assistant. Write clean, efficient code. Use TypeScript.", 19],
];

suite("TokenCounter — Accuracy Benchmarks", () => {
	const TOLERANCE = 0.35;

	for (const [label, text, expected] of REFERENCE_CASES) {
		test(`"${label}" — expected ~${expected} tokens`, () => {
			const actual = countTokens(text);
			const lower = Math.floor(expected * (1 - TOLERANCE));
			const upper = Math.ceil(expected * (1 + TOLERANCE));
			assert.ok(
				actual >= lower && actual <= upper,
				`"${label}": expected ${expected} (±${Math.round(TOLERANCE * 100)}%), got ${actual} (range: ${lower}-${upper})`
			);
		});
	}

	test("monotonicity: longer text = more tokens", () => {
		const short = countTokens("const x = 1;");
		const long = countTokens("const x = 1;\nconst y = 2;\nfunction add(a: number, b: number): number {\n  return a + b;\n}");
		assert.ok(long > short, `Expected ${long} > ${short}`);
	});

	test("code vs prose token ratio is reasonable", () => {
		const prose = countTokens("This is a simple English sentence that anyone can read and understand.");
		const code = countTokens("const x: number = calculateSum(items.filter((i) => i.active));");
		const ratio = code / (prose || 1);
		assert.ok(ratio > 0.3, `Code/prose ratio should be >0.3, got ${ratio.toFixed(2)}`);
		assert.ok(ratio < 5.0, `Code/prose ratio should be <5.0, got ${ratio.toFixed(2)}`);
	});

});
