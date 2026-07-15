import { describe, expect, it } from 'vitest';
import { groupTodosByPhase, type TodoItem, todoWriteToolRegistration } from './todowrite-tool';

const reg = todoWriteToolRegistration;

function invoke(todos: TodoItem[]): string {
    return reg.toModelOutput?.({ todos }) ?? '';
}

describe('todowrite — baseline parity (no phase field)', () => {
    it('formats the flat numbered list exactly as before phases existed', () => {
        const text = invoke([
            { content: 'Scaffold crate', status: 'completed' },
            { content: 'Wire workspace', status: 'in_progress' },
            { content: 'Write tests', status: 'pending' },
        ]);
        expect(text).toBe('Updated todo list:\n1. [x] Scaffold crate\n2. [~] Wire workspace\n3. [ ] Write tests');
    });

    it('uses [x] for completed, [~] for in_progress, [ ] for pending', () => {
        const text = invoke([
            { content: 'done', status: 'completed' },
            { content: 'now', status: 'in_progress' },
            { content: 'later', status: 'pending' },
        ]);
        expect(text).toContain('1. [x] done');
        expect(text).toContain('2. [~] now');
        expect(text).toContain('3. [ ] later');
    });

    it('echoes the input todos unchanged through execute', async () => {
        const todos: TodoItem[] = [{ content: 'a', status: 'pending' }];
        const out = await reg.execute(
            { todos },
            { toolCallId: 'c', toolName: 'todowrite', signal: new AbortController().signal },
        );
        expect(out.todos).toEqual(todos);
    });
});

describe('todowrite — input schema accepts the phase field', () => {
    it('parses an item with a phase', () => {
        const parsed = reg.inputSchema.safeParse({
            todos: [{ content: 'x', status: 'pending', phase: 'Foundation' }],
        });
        expect(parsed.success).toBe(true);
    });

    it('still parses items without a phase (backward compatible)', () => {
        const parsed = reg.inputSchema.safeParse({
            todos: [{ content: 'x', status: 'pending' }],
        });
        expect(parsed.success).toBe(true);
    });
});

describe('groupTodosByPhase', () => {
    it('groups items by phase in first-seen order, preserving intra-phase order', () => {
        const groups = groupTodosByPhase([
            { content: 'Scaffold', status: 'pending', phase: 'Foundation' },
            { content: 'OAuth', status: 'completed', phase: 'Auth' },
            { content: 'Wire', status: 'in_progress', phase: 'Foundation' },
        ]);
        const [first, second] = groups;
        expect(first?.phase).toBe('Foundation');
        expect(second?.phase).toBe('Auth');
        expect(first?.items.map((item) => item.content)).toEqual(['Scaffold', 'Wire']);
        expect(second?.items.map((item) => item.content)).toEqual(['OAuth']);
    });

    it('collects unphased items into a leading empty-name group', () => {
        const groups = groupTodosByPhase([
            { content: 'misc', status: 'pending' },
            { content: 'Scaffold', status: 'pending', phase: 'Foundation' },
        ]);
        const [first, second] = groups;
        expect(first?.phase).toBe('');
        expect(first?.items.map((item) => item.content)).toEqual(['misc']);
        expect(second?.phase).toBe('Foundation');
    });

    it('returns no empty leading group when every item is phased', () => {
        const groups = groupTodosByPhase([{ content: 'a', status: 'pending', phase: 'P1' }]);
        expect(groups.every((group) => group.phase.length > 0)).toBe(true);
    });
});

describe('todowrite — phased model output', () => {
    it('groups phased items under phase headers with global numbering', () => {
        const text = invoke([
            { content: 'Scaffold crate', status: 'pending', phase: 'Foundation' },
            { content: 'Port OAuth', status: 'completed', phase: 'Auth' },
            { content: 'Wire workspace', status: 'in_progress', phase: 'Foundation' },
        ]);
        expect(text).toBe(
            'Updated todo list:\n' +
                '[Phase: Foundation]\n' +
                '  1. [ ] Scaffold crate\n' +
                '  2. [~] Wire workspace\n' +
                '[Phase: Auth]\n' +
                '  3. [x] Port OAuth',
        );
    });

    it('renders unphased items in a leading block without a header when phases are also present', () => {
        const text = invoke([
            { content: 'misc task', status: 'pending' },
            { content: 'Scaffold', status: 'completed', phase: 'Foundation' },
        ]);
        expect(text).toBe(
            'Updated todo list:\n' + '  1. [ ] misc task\n' + '[Phase: Foundation]\n' + '  2. [x] Scaffold',
        );
    });

    it('a fully-phased single-phase list shows one header', () => {
        const text = invoke([
            { content: 'a', status: 'pending', phase: 'Build' },
            { content: 'b', status: 'in_progress', phase: 'Build' },
        ]);
        expect(text).toBe('Updated todo list:\n[Phase: Build]\n  1. [ ] a\n  2. [~] b');
    });
});
