/**
 * Tests for the Memory node implementation.
 */

import type { AbgNodeSpec, AbgSignal } from '@mission-control/protocol';
import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { createBlackboard } from '../../memory/blackboard.js';
import type { AbgNodeRunContext } from '../node-registry.js';
import { runMemoryNode } from './memory-node.js';

async function collectSignals(signals: AsyncIterable<AbgSignal>): Promise<readonly AbgSignal[]> {
    const collected: AbgSignal[] = [];
    for await (const signal of signals) {
        collected.push(signal);
    }
    return collected;
}

function eventTypes(signals: readonly AbgSignal[]): string[] {
    return signals
        .filter((signal): signal is Extract<AbgSignal, { type: 'emit' }> => signal.type === 'emit')
        .map((signal) => signal.event.type);
}

describe('memory-node', () => {
    const baseContext: AbgNodeRunContext = {
        graphId: 'g1',
        now: () => '2026-06-16T00:00:00.000Z',
    };

    it('emits failure when Blackboard is unavailable', async () => {
        const node: AbgNodeSpec = {
            id: 'no-blackboard',
            kind: 'memory',
            config: { op: 'get', key: 'test' },
        };

        const signals = await collectSignals(runMemoryNode(node, baseContext));

        expect(signals.map((s) => s.type)).toEqual(['started', 'failure']);
        const failureSignal = signals.find((s) => s.type === 'failure');
        if (failureSignal?.type !== 'failure') {
            throw new Error('Expected failure signal');
        }
        expect(failureSignal.error).toEqual({
            code: 'memory_unavailable',
            message: 'Blackboard not available in context',
        });
    });

    describe('get operation', () => {
        it('reads a value from the blackboard', async () => {
            const blackboard = createBlackboard();
            blackboard.set('test-key', 'test-value');

            const node: AbgNodeSpec = {
                id: 'get-test',
                kind: 'memory',
                config: { op: 'get', key: 'test-key' },
            };

            const signals = await collectSignals(runMemoryNode(node, { ...baseContext, blackboard }));

            expect(signals.map((s) => s.type)).toEqual(['started', 'emit', 'success']);
            expect(eventTypes(signals)).toEqual(['memory.read']);

            const successSignal = signals.find((s) => s.type === 'success');
            if (successSignal?.type !== 'success') {
                throw new Error('Expected success signal');
            }
            expect(successSignal.result).toEqual({
                key: 'test-key',
                value: 'test-value',
            });
        });

        it('returns undefined for missing keys', async () => {
            const blackboard = createBlackboard();

            const node: AbgNodeSpec = {
                id: 'get-missing',
                kind: 'memory',
                config: { op: 'get', key: 'nonexistent' },
            };

            const signals = await collectSignals(runMemoryNode(node, { ...baseContext, blackboard }));

            const successSignal = signals.find((s) => s.type === 'success');
            if (successSignal?.type !== 'success') {
                throw new Error('Expected success signal');
            }
            expect(successSignal.result).toEqual({
                key: 'nonexistent',
                value: undefined,
            });
        });

        it('fails when key is not a string', async () => {
            const blackboard = createBlackboard();

            const node: AbgNodeSpec = {
                id: 'get-bad-key',
                kind: 'memory',
                config: { op: 'get', key: 123 },
            };

            const signals = await collectSignals(runMemoryNode(node, { ...baseContext, blackboard }));

            expect(signals.map((s) => s.type)).toEqual(['started', 'emit', 'failure']);
            expect(eventTypes(signals)).toEqual(['memory.read']);

            const failureSignal = signals.find((s) => s.type === 'failure');
            if (failureSignal?.type !== 'failure') {
                throw new Error('Expected failure signal');
            }
            expect((failureSignal.error as { code: string }).code).toBe('memory_op_invalid');
        });
    });

    describe('set operation', () => {
        it('writes a value to the blackboard', async () => {
            const blackboard = createBlackboard();

            const node: AbgNodeSpec = {
                id: 'set-test',
                kind: 'memory',
                config: { op: 'set', key: 'new-key', value: 'new-value' },
            };

            const signals = await collectSignals(runMemoryNode(node, { ...baseContext, blackboard }));

            expect(signals.map((s) => s.type)).toEqual(['started', 'emit', 'success']);
            expect(eventTypes(signals)).toEqual(['memory.written']);

            expect(blackboard.get('new-key')).toBe('new-value');

            const successSignal = signals.find((s) => s.type === 'success');
            if (successSignal?.type !== 'success') {
                throw new Error('Expected success signal');
            }
            expect(successSignal.result).toEqual({ key: 'new-key' });
        });

        it('overwrites existing values', async () => {
            const blackboard = createBlackboard();
            blackboard.set('key', 'old');

            const node: AbgNodeSpec = {
                id: 'overwrite',
                kind: 'memory',
                config: { op: 'set', key: 'key', value: 'new' },
            };

            await collectSignals(runMemoryNode(node, { ...baseContext, blackboard }));

            expect(blackboard.get('key')).toBe('new');
        });

        it('fails when key is not a string', async () => {
            const blackboard = createBlackboard();

            const node: AbgNodeSpec = {
                id: 'set-bad-key',
                kind: 'memory',
                config: { op: 'set', key: null, value: 'test' },
            };

            const signals = await collectSignals(runMemoryNode(node, { ...baseContext, blackboard }));

            expect(signals.map((s) => s.type)).toEqual(['started', 'emit', 'failure']);
            expect(eventTypes(signals)).toEqual(['memory.written']);

            const failureSignal = signals.find((s) => s.type === 'failure');
            if (failureSignal?.type !== 'failure') {
                throw new Error('Expected failure signal');
            }
            expect((failureSignal.error as { code: string }).code).toBe('memory_op_invalid');
        });
    });

    describe('has operation', () => {
        it('returns true when key exists', async () => {
            const blackboard = createBlackboard();
            blackboard.set('exists', true);

            const node: AbgNodeSpec = {
                id: 'has-true',
                kind: 'memory',
                config: { op: 'has', key: 'exists' },
            };

            const signals = await collectSignals(runMemoryNode(node, { ...baseContext, blackboard }));

            const successSignal = signals.find((s) => s.type === 'success');
            if (successSignal?.type !== 'success') {
                throw new Error('Expected success signal');
            }
            expect(successSignal.result).toEqual({ key: 'exists', present: true });
        });

        it('returns false when key does not exist', async () => {
            const blackboard = createBlackboard();

            const node: AbgNodeSpec = {
                id: 'has-false',
                kind: 'memory',
                config: { op: 'has', key: 'missing' },
            };

            const signals = await collectSignals(runMemoryNode(node, { ...baseContext, blackboard }));

            const successSignal = signals.find((s) => s.type === 'success');
            if (successSignal?.type !== 'success') {
                throw new Error('Expected success signal');
            }
            expect(successSignal.result).toEqual({ key: 'missing', present: false });
        });

        it('fails when key is not a string', async () => {
            const blackboard = createBlackboard();

            const node: AbgNodeSpec = {
                id: 'has-bad-key',
                kind: 'memory',
                config: { op: 'has', key: undefined },
            };

            const signals = await collectSignals(runMemoryNode(node, { ...baseContext, blackboard }));

            expect(signals.map((s) => s.type)).toEqual(['started', 'failure']);

            const failureSignal = signals.find((s) => s.type === 'failure');
            if (failureSignal?.type !== 'failure') {
                throw new Error('Expected failure signal');
            }
            expect((failureSignal.error as { code: string }).code).toBe('memory_op_invalid');
        });

        it('emits memory.checked event with presence status', async () => {
            const blackboard = createBlackboard();
            blackboard.set('exists', true);

            const node: AbgNodeSpec = {
                id: 'has-emit',
                kind: 'memory',
                config: { op: 'has', key: 'exists' },
            };

            const signals = await collectSignals(runMemoryNode(node, { ...baseContext, blackboard }));

            expect(eventTypes(signals)).toContain('memory.checked');

            const emitSignal = signals.find((s) => s.type === 'emit' && s.event.type === 'memory.checked');
            if (emitSignal?.type !== 'emit') {
                throw new Error('Expected memory.checked emit signal');
            }
            expect(emitSignal.event.payload).toEqual({ key: 'exists', present: true });
        });
    });

    describe('delete operation', () => {
        it('removes a key from the blackboard', async () => {
            const blackboard = createBlackboard();
            blackboard.set('to-delete', 'value');

            const node: AbgNodeSpec = {
                id: 'delete-test',
                kind: 'memory',
                config: { op: 'delete', key: 'to-delete' },
            };

            const signals = await collectSignals(runMemoryNode(node, { ...baseContext, blackboard }));

            expect(blackboard.has('to-delete')).toBe(false);

            const successSignal = signals.find((s) => s.type === 'success');
            if (successSignal?.type !== 'success') {
                throw new Error('Expected success signal');
            }
            expect(successSignal.result).toEqual({ key: 'to-delete' });
        });

        it('is idempotent for missing keys', async () => {
            const blackboard = createBlackboard();

            const node: AbgNodeSpec = {
                id: 'delete-missing',
                kind: 'memory',
                config: { op: 'delete', key: 'never-existed' },
            };

            const signals = await collectSignals(runMemoryNode(node, { ...baseContext, blackboard }));

            expect(signals.map((s) => s.type)).toEqual(['started', 'emit', 'success']);
        });

        it('fails when key is not a string', async () => {
            const blackboard = createBlackboard();

            const node: AbgNodeSpec = {
                id: 'delete-bad-key',
                kind: 'memory',
                config: { op: 'delete', key: {} },
            };

            const signals = await collectSignals(runMemoryNode(node, { ...baseContext, blackboard }));

            expect(signals.map((s) => s.type)).toEqual(['started', 'failure']);

            const failureSignal = signals.find((s) => s.type === 'failure');
            if (failureSignal?.type !== 'failure') {
                throw new Error('Expected failure signal');
            }
            expect((failureSignal.error as { code: string }).code).toBe('memory_op_invalid');
        });

        it('emits memory.deleted event when key is deleted', async () => {
            const blackboard = createBlackboard();
            blackboard.set('to-delete', 'value');

            const node: AbgNodeSpec = {
                id: 'delete-emit',
                kind: 'memory',
                config: { op: 'delete', key: 'to-delete' },
            };

            const signals = await collectSignals(runMemoryNode(node, { ...baseContext, blackboard }));

            expect(eventTypes(signals)).toContain('memory.deleted');

            const emitSignal = signals.find((s) => s.type === 'emit' && s.event.type === 'memory.deleted');
            if (emitSignal?.type !== 'emit') {
                throw new Error('Expected memory.deleted emit signal');
            }
            expect(emitSignal.event.payload).toEqual({ key: 'to-delete' });
        });
    });

    describe('messages.get operation', () => {
        it('returns the current messages', async () => {
            const blackboard = createBlackboard();
            const messages: ModelMessage[] = [
                { role: 'user', content: 'hello' },
                { role: 'assistant', content: 'hi there' },
            ];
            blackboard.setMessages(messages);

            const node: AbgNodeSpec = {
                id: 'get-messages',
                kind: 'memory',
                config: { op: 'messages.get' },
            };

            const signals = await collectSignals(runMemoryNode(node, { ...baseContext, blackboard }));

            const successSignal = signals.find((s) => s.type === 'success');
            if (successSignal?.type !== 'success') {
                throw new Error('Expected success signal');
            }
            expect(successSignal.result).toEqual({ messages });
        });

        it('returns empty array when no messages set', async () => {
            const blackboard = createBlackboard();

            const node: AbgNodeSpec = {
                id: 'get-empty-messages',
                kind: 'memory',
                config: { op: 'messages.get' },
            };

            const signals = await collectSignals(runMemoryNode(node, { ...baseContext, blackboard }));

            const successSignal = signals.find((s) => s.type === 'success');
            if (successSignal?.type !== 'success') {
                throw new Error('Expected success signal');
            }
            expect(successSignal.result).toEqual({ messages: [] });
        });
    });

    describe('messages.append operation', () => {
        it('appends messages to the blackboard', async () => {
            const blackboard = createBlackboard();
            const initialMessages: ModelMessage[] = [{ role: 'user', content: 'first' }];
            blackboard.setMessages(initialMessages);

            const newMessages: ModelMessage[] = [{ role: 'assistant', content: 'response' }];

            const node: AbgNodeSpec = {
                id: 'append-messages',
                kind: 'memory',
                config: { op: 'messages.append', value: newMessages },
            };

            const signals = await collectSignals(runMemoryNode(node, { ...baseContext, blackboard }));

            const finalMessages = blackboard.getMessages();
            expect(finalMessages).toEqual([
                { role: 'user', content: 'first' },
                { role: 'assistant', content: 'response' },
            ]);

            const successSignal = signals.find((s) => s.type === 'success');
            if (successSignal?.type !== 'success') {
                throw new Error('Expected success signal');
            }
            expect(successSignal.result).toEqual({ appended: 1 });
        });

        it('handles empty array value', async () => {
            const blackboard = createBlackboard();

            const node: AbgNodeSpec = {
                id: 'append-empty',
                kind: 'memory',
                config: { op: 'messages.append', value: [] },
            };

            const signals = await collectSignals(runMemoryNode(node, { ...baseContext, blackboard }));

            const successSignal = signals.find((s) => s.type === 'success');
            if (successSignal?.type !== 'success') {
                throw new Error('Expected success signal');
            }
            expect(successSignal.result).toEqual({ appended: 0 });
        });

        it('fails on a non-array value instead of silently dropping it (review fix #7)', async () => {
            const blackboard = createBlackboard();
            blackboard.setMessages([{ role: 'user', content: 'existing' }]);

            const node: AbgNodeSpec = {
                id: 'append-non-array',
                kind: 'memory',
                config: { op: 'messages.append', value: 'not an array' },
            };

            const signals = await collectSignals(runMemoryNode(node, { ...baseContext, blackboard }));

            const failureSignal = signals.find((s) => s.type === 'failure');
            if (failureSignal?.type !== 'failure') {
                throw new Error('Expected failure signal');
            }
            expect((failureSignal.error as { code: string }).code).toBe('memory_op_invalid');
            // The blackboard is unchanged — no silent append of an empty array.
            expect(blackboard.getMessages()).toEqual([{ role: 'user', content: 'existing' }]);
        });
    });

    describe('invalid operations', () => {
        it('fails when op is missing', async () => {
            const blackboard = createBlackboard();

            const node: AbgNodeSpec = {
                id: 'no-op',
                kind: 'memory',
                config: { key: 'test' },
            };

            const signals = await collectSignals(runMemoryNode(node, { ...baseContext, blackboard }));

            expect(signals.map((s) => s.type)).toEqual(['started', 'failure']);

            const failureSignal = signals.find((s) => s.type === 'failure');
            if (failureSignal?.type !== 'failure') {
                throw new Error('Expected failure signal');
            }
            expect((failureSignal.error as { code: string }).code).toBe('memory_op_invalid');
        });

        it('fails when op is unknown', async () => {
            const blackboard = createBlackboard();

            const node: AbgNodeSpec = {
                id: 'unknown-op',
                kind: 'memory',
                config: { op: 'unknown_operation' },
            };

            const signals = await collectSignals(runMemoryNode(node, { ...baseContext, blackboard }));

            expect(signals.map((s) => s.type)).toEqual(['started', 'failure']);

            const failureSignal = signals.find((s) => s.type === 'failure');
            if (failureSignal?.type !== 'failure') {
                throw new Error('Expected failure signal');
            }
            expect((failureSignal.error as { code: string }).code).toBe('memory_op_invalid');
        });
    });

    describe('set/get round-trip', () => {
        it('writes and reads back complex values', async () => {
            const blackboard = createBlackboard();
            const complexValue = {
                nested: { array: [1, 2, 3], string: 'test' },
                number: 42,
                boolean: true,
            };

            const setNode: AbgNodeSpec = {
                id: 'set-complex',
                kind: 'memory',
                config: { op: 'set', key: 'complex', value: complexValue },
            };

            const getNode: AbgNodeSpec = {
                id: 'get-complex',
                kind: 'memory',
                config: { op: 'get', key: 'complex' },
            };

            await collectSignals(runMemoryNode(setNode, { ...baseContext, blackboard }));
            const signals = await collectSignals(runMemoryNode(getNode, { ...baseContext, blackboard }));

            const successSignal = signals.find((s) => s.type === 'success');
            if (successSignal?.type !== 'success') {
                throw new Error('Expected success signal');
            }
            expect(successSignal.result).toEqual({ key: 'complex', value: complexValue });
        });
    });
});
