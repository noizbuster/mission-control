import type { ModelMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { Blackboard, createBlackboard } from './blackboard';

// Characterization test pinning the Blackboard contract that the toRecord() cache
// (workflow-runtime-perf-fixes todo 2) relies on. Scope is intentionally narrow:
// toRecord/set/delete, the onMutation invalidation surface, and the guarantee that
// message mutations stay OUT of that surface. The structured-output parser is
// covered by structured-blackboard.test.ts and is deliberately not tested here.
//
// RED->GREEN NOTE: the `toRecord referential stability` block is FAILING-FIRST on
// the current production code. Blackboard.toRecord() builds
// `Object.fromEntries(this.entries.entries())` fresh on every call, so two reads
// with no intervening mutation yield distinct object references and
// `expect(second).toBe(first)` FAILS today. Todo 2 caches the record (invalidated
// by set/delete) which makes that assertion pass. Every other block below passes
// on the unchanged production code.

describe('Blackboard', () => {
    describe('toRecord / set / delete contract', () => {
        it('reflects a set value in toRecord', () => {
            const blackboard = new Blackboard();
            blackboard.set('intent.classification', 'explicit');
            expect(blackboard.toRecord()).toEqual({ 'intent.classification': 'explicit' });
        });

        it('overwrites a prior value under the same key', () => {
            const blackboard = new Blackboard();
            blackboard.set('plan.ready', false);
            blackboard.set('plan.ready', true);
            expect(blackboard.toRecord()).toEqual({ 'plan.ready': true });
        });

        it('removes a key from toRecord on delete', () => {
            const blackboard = new Blackboard();
            blackboard.set('wave.tasks', [{ id: 1 }]);
            blackboard.delete('wave.tasks');
            expect(blackboard.toRecord()).toEqual({});
            expect(blackboard.has('wave.tasks')).toBe(false);
        });

        it('returns an empty record before any entry is set', () => {
            expect(new Blackboard().toRecord()).toEqual({});
        });

        it('returns a frozen record (cache-corruption guard)', () => {
            const blackboard = createBlackboard();
            blackboard.set('key', 'value');
            expect(Object.isFrozen(blackboard.toRecord())).toBe(true);
        });
    });

    describe('toRecord referential stability (precondition for the toRecord cache)', () => {
        it('returns the same object reference across consecutive reads with no intervening mutation', () => {
            const blackboard = new Blackboard();
            blackboard.set('intent.classification', 'explicit');

            const first = blackboard.toRecord();
            const second = blackboard.toRecord();

            expect(second).toBe(first);
        });

        it('returns a new reference after a set (documents the cache-invalidation surface)', () => {
            const blackboard = new Blackboard();
            blackboard.set('plan.ready', false);

            const beforeSet = blackboard.toRecord();
            blackboard.set('plan.ready', true);
            const afterSet = blackboard.toRecord();

            expect(afterSet).not.toBe(beforeSet);
            expect(afterSet).toEqual({ 'plan.ready': true });
        });

        it('returns a new reference after a delete (documents the cache-invalidation surface)', () => {
            const blackboard = new Blackboard();
            blackboard.set('wave.tasks', [{ id: 1 }]);

            const beforeDelete = blackboard.toRecord();
            blackboard.delete('wave.tasks');
            const afterDelete = blackboard.toRecord();

            expect(afterDelete).not.toBe(beforeDelete);
            expect(afterDelete).toEqual({});
        });
    });

    describe('onMutation observer', () => {
        it('fires blackboard.set with {key, value} on set', () => {
            const onMutation = vi.fn();
            const blackboard = new Blackboard({ onMutation });

            blackboard.set('intent.classification', 'explicit');

            expect(onMutation).toHaveBeenCalledTimes(1);
            expect(onMutation).toHaveBeenCalledWith('blackboard.set', {
                key: 'intent.classification',
                value: 'explicit',
            });
        });

        it('fires blackboard.delete with {key} on delete', () => {
            const onMutation = vi.fn();
            const blackboard = new Blackboard({ onMutation });
            blackboard.set('final.verdict', 'APPROVE');

            blackboard.delete('final.verdict');

            expect(onMutation).toHaveBeenCalledTimes(2);
            expect(onMutation).toHaveBeenNthCalledWith(2, 'blackboard.delete', {
                key: 'final.verdict',
            });
        });

        it('does not throw when no observer is configured', () => {
            const blackboard = new Blackboard();
            expect(() => {
                blackboard.set('guard.cleared', true);
                blackboard.delete('guard.cleared');
            }).not.toThrow();
        });
    });

    describe('message mutations stay outside the toRecord invalidation surface', () => {
        const messages: readonly ModelMessage[] = [{ role: 'user', content: 'ping' }];

        it('appendMessages does not fire onMutation', () => {
            const onMutation = vi.fn();
            const blackboard = new Blackboard({ onMutation });

            blackboard.appendMessages(messages);

            expect(onMutation).not.toHaveBeenCalled();
        });

        it('setMessages does not fire onMutation', () => {
            const onMutation = vi.fn();
            const blackboard = new Blackboard({ onMutation });

            blackboard.setMessages(messages);

            expect(onMutation).not.toHaveBeenCalled();
        });

        it('appendMessages does not change toRecord output', () => {
            const blackboard = new Blackboard();
            blackboard.set('intent.classification', 'explicit');
            const before = blackboard.toRecord();

            blackboard.appendMessages(messages);

            expect(blackboard.toRecord()).toEqual(before);
        });

        it('setMessages does not change toRecord output', () => {
            const blackboard = new Blackboard();
            blackboard.set('intent.classification', 'explicit');
            const before = blackboard.toRecord();

            blackboard.setMessages(messages);

            expect(blackboard.toRecord()).toEqual(before);
        });
    });
});
