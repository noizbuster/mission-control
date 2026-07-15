/**
 * `todowrite` tool — structured task/plan list (opencode/pi `plan` surface, Phase 4).
 *
 * The model writes a structured todo list to track multi-step work; the tool validates it and
 * echoes it back. (Phase 6's Plan→Execute→Monitor→Replan persists this to the Blackboard `plan`
 * slot; here the tool formalizes the list.)
 *
 * Phase tracking (ported from oh-my-pi's todo, MIT): each item MAY carry an optional `phase`
 * name. When no item carries a phase, output is byte-identical to the original flat list
 * (baseline parity). When at least one item carries a phase, output groups items by phase in
 * first-seen order — items within a phase keep their relative array order, and numbering stays
 * global across the whole list so item indices are stable. Items without a phase render in a
 * leading unheaded block. The input contract is otherwise unchanged: a flat `todos` array.
 */
import { z } from 'zod';
import type { ToolRegistration } from './tool-registry-types';

const todoItemSchema = z.object({
    content: z.string().min(1),
    status: z.enum(['pending', 'in_progress', 'completed']),
    activeForm: z.string().min(1).optional(),
    phase: z.string().min(1).optional(),
});
export type TodoItem = z.infer<typeof todoItemSchema>;

const todoWriteInputSchema = z.object({ todos: z.array(todoItemSchema).min(1).max(50) });
export type TodoWriteInput = z.infer<typeof todoWriteInputSchema>;

/** A named group of items, in first-seen phase order. Empty-name groups hold unphased items. */
export interface TodoPhase {
    readonly phase: string;
    readonly items: readonly TodoItem[];
}

/**
 * Group todos into phases in first-seen order. Items without a phase land in a single leading
 * group whose `phase` is the empty string (rendered without a header). Items within a phase
 * preserve their input order. Pure function; does not mutate the input.
 */
export function groupTodosByPhase(todos: readonly TodoItem[]): readonly TodoPhase[] {
    const unphased: TodoItem[] = [];
    const order: string[] = [];
    const buckets = new Map<string, TodoItem[]>();
    for (const todo of todos) {
        const phase = todo.phase;
        if (phase === undefined || phase.length === 0) {
            unphased.push(todo);
            continue;
        }
        let bucket = buckets.get(phase);
        if (bucket === undefined) {
            bucket = [];
            buckets.set(phase, bucket);
            order.push(phase);
        }
        bucket.push(todo);
    }
    const groups: TodoPhase[] = [];
    if (unphased.length > 0) {
        groups.push({ phase: '', items: unphased });
    }
    for (const phase of order) {
        const bucket = buckets.get(phase);
        if (bucket !== undefined) groups.push({ phase, items: bucket });
    }
    return groups;
}

function hasAnyPhase(todos: readonly TodoItem[]): boolean {
    return todos.some((todo) => todo.phase !== undefined && todo.phase.length > 0);
}

function statusMark(status: TodoItem['status']): string {
    return status === 'completed' ? '[x]' : status === 'in_progress' ? '[~]' : '[ ]';
}

export const todoWriteToolRegistration: ToolRegistration<TodoWriteInput, TodoWriteInput> = {
    name: 'todowrite',
    description:
        'Create or update a structured todo list to track multi-step work. Use this to plan before acting. ' +
        'Items may carry an optional `phase` to group related tasks; phased items render grouped by phase.',
    capabilityClasses: ['read'],
    guideline:
        'Write a todo list before multi-step work; mark items in_progress one at a time and completed when done. ' +
        'Use the optional `phase` field to group tasks into ordered phases when the work is multi-stage.',
    parametersJsonSchema: {
        type: 'object',
        properties: {
            todos: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        content: { type: 'string' },
                        status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
                        activeForm: { type: 'string' },
                        phase: { type: 'string', description: 'Optional phase name; phased items render grouped.' },
                    },
                    required: ['content', 'status'],
                    additionalProperties: false,
                },
            },
        },
        required: ['todos'],
        additionalProperties: false,
    },
    inputSchema: todoWriteInputSchema,
    outputSchema: todoWriteInputSchema,
    outputLimit: { maxModelOutputChars: 4000 },
    execute: async (input) => ({ todos: input.todos }),
    toModelOutput: (output) => {
        const todos = output.todos;
        if (!hasAnyPhase(todos)) {
            const lines = todos.map((todo, index) => `${index + 1}. ${statusMark(todo.status)} ${todo.content}`);
            return `Updated todo list:\n${lines.join('\n')}`;
        }
        const groups = groupTodosByPhase(todos);
        const lines: string[] = [];
        let index = 0;
        for (const group of groups) {
            if (group.phase.length > 0) {
                lines.push(`[Phase: ${group.phase}]`);
            }
            for (const todo of group.items) {
                index += 1;
                lines.push(`  ${index}. ${statusMark(todo.status)} ${todo.content}`);
            }
        }
        return `Updated todo list:\n${lines.join('\n')}`;
    },
};
