/*---------------------------------------------------------------------------------------------
 *  AI Studio — Task Manager
 *  Manages agent tasks with dependency graphs, state machine, and cycle detection.
 *  Replaces the older AgentPlan auto-generation with Claude Code-style task tracking.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import type { Task, TaskStatus } from './aiTypes.js';

export const ITaskManager = createDecorator<ITaskManager>('taskManager');

export interface ITaskManager {
	readonly _serviceBrand: undefined;
	readonly tasks: readonly Task[];
	readonly onDidChange: Event<Task[]>;

	create(subject: string, description: string, activeForm?: string, blocks?: string[], blockedBy?: string[], metadata?: Record<string, unknown>): Task;
	update(id: string, patch: { status?: TaskStatus; owner?: string; subject?: string; description?: string; activeForm?: string; addBlocks?: string[]; addBlockedBy?: string[]; metadata?: Record<string, unknown> }): Task | null;
	get(id: string): Task | null;
	list(filter?: { status?: TaskStatus; owner?: string }): Task[];
	getAvailable(): Task[];
	clear(): void;
}

export class TaskManager implements ITaskManager {
	declare readonly _serviceBrand: undefined;

	private _tasks: Task[] = [];
	private readonly _onDidChange = new Emitter<Task[]>();
	readonly onDidChange = this._onDidChange.event;

	get tasks(): readonly Task[] { return this._tasks; }

	private _nextId(): string {
		return 'task_' + Math.random().toString(16).slice(2, 10);
	}

	create(
		subject: string,
		description: string,
		activeForm?: string,
		blocks?: string[],
		blockedBy?: string[],
		metadata?: Record<string, unknown>,
	): Task {
		if (blockedBy?.length) {
			const existingIds = new Set(this._tasks.map(t => t.id));
			for (const id of blockedBy) {
				if (!existingIds.has(id)) {
					throw new Error(`Task "${id}" referenced in blockedBy does not exist`);
				}
			}
		}
		const task: Task = {
			id: this._nextId(),
			subject,
			description,
			activeForm,
			status: 'pending',
			blocks: blocks || [],
			blockedBy: blockedBy || [],
			metadata,
		};
		this._tasks.push(task);
		this._onDidChange.fire([...this._tasks]);
		return task;
	}

	update(id: string, patch: {
		status?: TaskStatus; owner?: string; subject?: string;
		description?: string; activeForm?: string;
		addBlocks?: string[]; addBlockedBy?: string[];
		metadata?: Record<string, unknown>;
	}): Task | null {
		const task = this._tasks.find(t => t.id === id);
		if (!task) return null;
		if (patch.status) {
			if (task.status === 'deleted') return null;
			task.status = patch.status;
		}
		if (patch.owner !== undefined) task.owner = patch.owner;
		if (patch.subject !== undefined) task.subject = patch.subject;
		if (patch.description !== undefined) task.description = patch.description;
		if (patch.activeForm !== undefined) task.activeForm = patch.activeForm;
		if (patch.metadata) {
			task.metadata = { ...(task.metadata || {}), ...patch.metadata };
		}
		if (patch.addBlocks?.length) {
			for (const blockedId of patch.addBlocks) {
				if (!task.blocks.includes(blockedId)) task.blocks.push(blockedId);
			}
			if (this._hasCycle()) {
				for (const blockedId of patch.addBlocks) {
					const idx = task.blocks.indexOf(blockedId);
					if (idx >= 0) task.blocks.splice(idx, 1);
				}
				throw new Error('Adding blocks would create a dependency cycle');
			}
		}
		if (patch.addBlockedBy?.length) {
			for (const blockerId of patch.addBlockedBy) {
				if (!task.blockedBy.includes(blockerId)) task.blockedBy.push(blockerId);
			}
			if (this._hasCycle()) {
				for (const blockerId of patch.addBlockedBy) {
					const idx = task.blockedBy.indexOf(blockerId);
					if (idx >= 0) task.blockedBy.splice(idx, 1);
				}
				throw new Error('Adding blockedBy would create a dependency cycle');
			}
		}
		this._onDidChange.fire([...this._tasks]);
		return task;
	}

	get(id: string): Task | null {
		return this._tasks.find(t => t.id === id) || null;
	}

	list(filter?: { status?: TaskStatus; owner?: string }): Task[] {
		let result = this._tasks.filter(t => t.status !== 'deleted');
		if (filter?.status) result = result.filter(t => t.status === filter.status);
		if (filter?.owner) result = result.filter(t => t.owner === filter.owner);
		return result;
	}

	getAvailable(): Task[] {
		return this._tasks.filter(t => {
			if (t.status !== 'pending') return false;
			if (!t.blockedBy.length) return true;
			return t.blockedBy.every(id => {
				const blocker = this._tasks.find(b => b.id === id);
				return blocker && blocker.status === 'completed';
			});
		});
	}

	clear(): void {
		this._tasks = [];
		this._onDidChange.fire([]);
	}

	private _hasCycle(): boolean {
		const visited = new Set<string>();
		const inStack = new Set<string>();
		const dfs = (id: string): boolean => {
			if (inStack.has(id)) return true;
			if (visited.has(id)) return false;
			visited.add(id);
			inStack.add(id);
			const task = this._tasks.find(t => t.id === id);
			if (task) {
				for (const blockedId of task.blocks) {
					if (dfs(blockedId)) return true;
				}
			}
			inStack.delete(id);
			return false;
		};
		for (const t of this._tasks) {
			if (dfs(t.id)) return true;
		}
		return false;
	}
}
