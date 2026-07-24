/*---------------------------------------------------------------------------------------------
 *  AI Studio — Agent Orchestration Tool Definitions
 *  Tools for sub-agent spawning, task management, inter-agent communication,
 *  and user memory recall. These complement the 11 built-in tools in aiTools.ts.
 *--------------------------------------------------------------------------------------------*/

import type { AITool } from './aiTypes.js';

export function getAgentTools(): AITool[] {
	return [
		// --- Agent (sub-agent spawner) ---
		{
			name: 'Agent',
			description: `Launch a new agent to handle complex, multi-step tasks autonomously.

The Agent tool launches specialized agents (subprocesses) that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.

Available agent types and the tools they have access to:
- general-purpose: General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. (Tools: all)
- Explore: Fast agent specialized for exploring codebases. Use for finding files by patterns, searching code for keywords, or answering questions about the codebase. (Tools: read_file, search_content, search_files, search_pattern, list_directory, read_lints, web_fetch, web_search)
- Plan: Software architect agent for designing implementation plans. (Tools: read_file, search_content, search_files, search_pattern, list_directory, read_lints, web_fetch, web_search)
- verification: Use this agent to verify that implementation work is correct before reporting completion. Outputs PASS/FAIL/PARTIAL verdict with evidence. (Tools: read_file, search_content, search_files, list_directory, run_command, read_lints)

Usage notes:
- Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses
- When the agent is done, it will return a single message back to you
- You can optionally run agents in the background using the run_in_background parameter
- Clearly tell the agent whether you expect it to write code or just to do research`,
			input_schema: {
				type: 'object',
				properties: {
					subagent_type: {
						type: 'string',
						description: 'The type of specialized agent to use for this task',
						enum: ['general-purpose', 'Explore', 'Plan', 'verification'],
					},
					description: { type: 'string', description: 'A short (3-5 word) description of the task' },
					prompt: { type: 'string', description: 'The task for the agent to perform' },
					run_in_background: { type: 'boolean', description: 'Set to true to run this agent in the background. You will be notified when it completes.' },
					name: { type: 'string', description: 'Name for the spawned agent. Makes it addressable via SendMessage.' },
					isolation: { type: 'string', enum: ['worktree'], description: 'Isolation mode. "worktree" creates a temporary git worktree for the sub-agent.' },
				},
				required: ['description', 'prompt'],
			},
		},

		// --- TaskCreate ---
		{
			name: 'TaskCreate',
			description: 'Create a new task in the task list. Tasks track work items with dependency graphs.',
			input_schema: {
				type: 'object',
				properties: {
					subject: { type: 'string', description: 'A brief, actionable title in imperative form' },
					description: { type: 'string', description: 'What needs to be done' },
					activeForm: { type: 'string', description: 'Present continuous form for UI spinner (e.g., "Running tests")' },
					blocks: { type: 'array', items: { type: 'string' }, description: 'Task IDs that this task blocks' },
					blockedBy: { type: 'array', items: { type: 'string' }, description: 'Task IDs that must complete first' },
				},
				required: ['subject', 'description'],
			},
		},

		// --- TaskUpdate ---
		{
			name: 'TaskUpdate',
			description: 'Update task status, owner, dependencies, or metadata. Use addBlocks/addBlockedBy to set up dependencies.',
			input_schema: {
				type: 'object',
				properties: {
					id: { type: 'string', description: 'The task ID to update' },
					status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'deleted'], description: 'New status' },
					owner: { type: 'string', description: 'New owner (agent name)' },
					subject: { type: 'string', description: 'New subject' },
					description: { type: 'string', description: 'New description' },
					activeForm: { type: 'string', description: 'New active form text' },
					addBlocks: { type: 'array', items: { type: 'string' }, description: 'Task IDs that this task now blocks' },
					addBlockedBy: { type: 'array', items: { type: 'string' }, description: 'Task IDs that now block this task' },
				},
				required: ['id'],
			},
		},

		// --- TaskList ---
		{
			name: 'TaskList',
			description: 'List all tasks with status, owner, and dependencies.',
			input_schema: {
				type: 'object',
				properties: {},
				required: [],
			},
		},

		// --- TaskGet ---
		{
			name: 'TaskGet',
			description: 'Get full details of a specific task.',
			input_schema: {
				type: 'object',
				properties: {
					id: { type: 'string', description: 'The task ID to retrieve' },
				},
				required: ['id'],
			},
		},

		// --- SendMessage ---
		{
			name: 'SendMessage',
			description: `Send a message to another agent.

| \`to\` | |
|---|---|
| \`"agent-name"\` | Teammate by name |
| \`"*"\` | Broadcast to all teammates — expensive, use only when everyone genuinely needs it |

Your plain text output is NOT visible to other agents — to communicate, you MUST call this tool.
Messages from teammates are delivered automatically; you don't check an inbox.
Refer to teammates by name, never by UUID.

## Protocol responses

If you receive a message with type: "shutdown_request" or type: "plan_approval_request", respond with the matching _response type.
Approving shutdown terminates the sub-agent. Rejecting plan sends the teammate back to revise.`,
			input_schema: {
				type: 'object',
				properties: {
					to: { type: 'string', description: 'Recipient: teammate name, or "*" for broadcast to all' },
					summary: { type: 'string', description: 'A 5-10 word summary shown as a preview in the UI' },
					message: { type: 'string', description: 'Plain text message content, or JSON for protocol messages' },
				},
				required: ['to', 'message'],
			},
		},

		// --- LocalMemoryRecall ---
		{
			name: 'LocalMemoryRecall',
			description: 'Search and recall user memories from ~/.ai-studio/memory/. Use to load context about user preferences, past feedback, or project information.',
			input_schema: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'Search query to match against memory names and descriptions' },
				},
				required: ['query'],
			},
		},

		// --- AskUserQuestion (Phase 3) ---
		{
			name: 'AskUserQuestion',
			description: 'Ask the user a question and wait for their response. Use when you need to clarify requirements or get a decision before proceeding.',
			input_schema: {
				type: 'object',
				properties: {
					question: { type: 'string', description: 'The question to ask the user' },
					header: { type: 'string', description: 'Short label displayed as a chip (max 12 chars)' },
					options: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								label: { type: 'string', description: 'Display label for this option' },
								description: { type: 'string', description: 'Explanation of what this option means' },
							},
							required: ['label', 'description'],
						},
						description: 'Available choices (2-4 options). The user can also provide custom text.',
						} as any,

					multiSelect: { type: 'boolean', description: 'Allow multiple answers (default false)' },
				},
				required: ['question', 'options'],
			},
		},

		// --- EnterPlanMode (Phase 3) ---
		{
			name: 'EnterPlanMode',
			description: 'Enter plan mode — restrict tools to read-only, explore the codebase, and write an implementation plan to a plan file. Call ExitPlanMode when the plan is ready for user approval.',
			input_schema: {
				type: 'object',
				properties: {},
				required: [],
			},
		},

		// --- ExitPlanMode (Phase 3) ---
		{
			name: 'ExitPlanMode',
			description: 'Exit plan mode and present the implementation plan for user approval. The plan must already be written to a plan file.',
			input_schema: {
				type: 'object',
				properties: {
					planFile: { type: 'string', description: 'Path to the written plan file (required)' },
				},
				required: ['planFile'],
			},
		},
	];
}
