/**
 * `todowrite` tool — structured task/plan list (opencode/pi `plan` surface, Phase 4).
 *
 * The model writes a structured todo list to track multi-step work; the tool validates it and
 * echoes it back. (Phase 6's Plan→Execute→Monitor→Replan persists this to the Blackboard `plan`
 * slot; here the tool formalizes the list.)
 */
import { z } from 'zod';
import type { ToolRegistration } from './tool-registry-types.js';

const todoItemSchema = z.object({
    content: z.string().min(1),
    status: z.enum(['pending', 'in_progress', 'completed']),
    activeForm: z.string().min(1).optional(),
});
export type TodoItem = z.infer<typeof todoItemSchema>;

const todoWriteInputSchema = z.object({ todos: z.array(todoItemSchema).min(1).max(50) });
export type TodoWriteInput = z.infer<typeof todoWriteInputSchema>;

export const todoWriteToolRegistration: ToolRegistration<TodoWriteInput, TodoWriteInput> = {
    name: 'todowrite',
    description: 'Create or update a structured todo list to track multi-step work. Use this to plan before acting.',
    capabilityClasses: ['read'],
    guideline:
        'Write a todo list before multi-step work; mark items in_progress one at a time and completed when done.',
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
        const lines = output.todos.map((todo, index) => {
            const mark = todo.status === 'completed' ? '[x]' : todo.status === 'in_progress' ? '[~]' : '[ ]';
            return `${index + 1}. ${mark} ${todo.content}`;
        });
        return `Updated todo list:\n${lines.join('\n')}`;
    },
};
