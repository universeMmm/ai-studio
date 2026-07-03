/*---------------------------------------------------------------------------------------------
 *  AI Studio — Built-in Tool Definitions
 *  Describes the 8 tools available to the AI agent.
 *--------------------------------------------------------------------------------------------*/

import { BuiltInToolName, type AITool } from './aiTypes.js';

/**
 * Returns the complete set of built-in tools the agent can use.
 * These match the Anthropic tool-use JSON Schema convention.
 */
export function getBuiltInTools(): AITool[] {
	return [
		{
			name: BuiltInToolName.ReadFile,
			description: 'Reads the content of a file at the given path. Returns line-numbered text.',
			input_schema: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'File path relative to the workspace root.' },
					offset: { type: 'number', description: 'First line to read (1-based, optional).' },
					limit: { type: 'number', description: 'Number of lines to read (optional).' },
				},
				required: ['path'],
			},
		},
		{
			name: BuiltInToolName.WriteFile,
			description: 'Writes content to a file, overwriting if it already exists.',
			input_schema: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'File path relative to the workspace root.' },
					content: { type: 'string', description: 'Content to write.' },
				},
				required: ['path', 'content'],
			},
		},
		{
			name: BuiltInToolName.EditFile,
			description: 'Performs an exact string-replacement edit on a file. old_string must be unique in the file unless replace_all is true.',
			input_schema: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'File path relative to the workspace root.' },
					old_string: { type: 'string', description: 'Exact text to replace.' },
					new_string: { type: 'string', description: 'Replacement text.' },
					replace_all: { type: 'boolean', description: 'Replace every occurrence (default false).' },
				},
				required: ['path', 'old_string', 'new_string'],
			},
		},
		{
			name: BuiltInToolName.SearchContent,
			description: 'Searches the codebase for a pattern using hybrid semantic + keyword search.',
			input_schema: {
				type: 'object',
				properties: {
					pattern: { type: 'string', description: 'Text or regex pattern to search for.' },
					caseSensitive: { type: 'boolean', description: 'Whether the search is case-sensitive (default false).' },
				},
				required: ['pattern'],
			},
		},
		{
			name: BuiltInToolName.SearchFiles,
			description: 'Finds files matching a glob pattern (e.g. "src/**/*.ts").',
			input_schema: {
				type: 'object',
				properties: {
					pattern: { type: 'string', description: 'Glob pattern to match file names against.' },
				},
				required: ['pattern'],
			},
		},
		{
			name: BuiltInToolName.SearchPattern,
			description: 'Searches the codebase using a raw ripgrep command. Use for complex multi-file searches where you need full control over grep flags. Returns up to 100 matching lines with file paths.',
			input_schema: {
				type: 'object',
				properties: {
					rg_args: { type: 'string', description: 'Arguments to pass to ripgrep (without the "rg" prefix). Example: "--type ts -l" or "--glob \"*.css\" --max-count 5 search_term".' },
				},
				required: ['rg_args'],
			},
		},
		{
			name: BuiltInToolName.RunCommand,
			description: 'Executes a shell command in the workspace root. Returns stdout. Timeout is 120s by default.',
			input_schema: {
				type: 'object',
				properties: {
					command: { type: 'string', description: 'The shell command to run.' },
					timeout: { type: 'number', description: 'Timeout in milliseconds (default 120000).' },
				},
				required: ['command'],
			},
		},
		{
			name: BuiltInToolName.ListDirectory,
			description: 'Lists files and subdirectories at the given path.',
			input_schema: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Directory path relative to the workspace root.' },
				},
				required: ['path'],
			},
		},
		{
			name: BuiltInToolName.ReadLints,
			description: 'Returns linter errors and warnings for the specified file, or across the workspace if no file is given.',
			input_schema: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'File path to check (optional; omit for workspace-wide diagnostics).' },
				},
				required: [],
			},
		},
	];
}
