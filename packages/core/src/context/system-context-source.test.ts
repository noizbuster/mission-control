import { describe, expect, it } from 'vitest';
import { emitMidConversationSystemMessage } from './mid-conversation-message.js';
import {
    packSystemContextSource,
    SystemContextRegistry,
    SystemContextRegistryError,
    type SystemContextSource,
    stringContextCodec,
} from './system-context-source.js';

function makeCounterSource(key: string): {
    source: SystemContextSource<string>;
    setValue: (value: string) => void;
} {
    let current = 'initial';
    return {
        setValue: (value: string) => {
            current = value;
        },
        source: {
            key,
            codec: stringContextCodec,
            loader: async () => current,
            baseline: (value) => `Counter (${key}): ${value}`,
            update: (prev, curr) => `Counter (${key}) changed from ${prev} to ${curr}`,
            removed: (prev) => `Counter (${key}) with value ${prev} is no longer active.`,
        },
    };
}

describe('SystemContextRegistry', () => {
    describe('register / lookup / list / remove', () => {
        it('registers and looks up a packed source', () => {
            const registry = new SystemContextRegistry();
            const { source } = makeCounterSource('test/counter');
            registry.register(packSystemContextSource(source));

            const found = registry.lookup('test/counter');
            expect(found).toBeDefined();
            expect(found?.key).toBe('test/counter');
        });

        it('returns undefined for unknown keys', () => {
            const registry = new SystemContextRegistry();
            expect(registry.lookup('nonexistent/key')).toBeUndefined();
        });

        it('throws SystemContextRegistryError on duplicate key', () => {
            const registry = new SystemContextRegistry();
            const { source } = makeCounterSource('test/counter');
            registry.register(packSystemContextSource(source));

            expect(() => registry.register(packSystemContextSource(source))).toThrow(SystemContextRegistryError);
        });

        it('lists registered sources', () => {
            const registry = new SystemContextRegistry();
            const a = makeCounterSource('test/a');
            const b = makeCounterSource('test/b');
            registry.register(packSystemContextSource(a.source));
            registry.register(packSystemContextSource(b.source));

            const list = registry.list();
            expect(list).toHaveLength(2);
            expect(list.map((s) => s.key)).toEqual(['test/a', 'test/b']);
        });

        it('removes a source and returns true; subsequent lookup is undefined', () => {
            const registry = new SystemContextRegistry();
            const { source } = makeCounterSource('test/counter');
            registry.register(packSystemContextSource(source));

            expect(registry.remove('test/counter')).toBe(true);
            expect(registry.lookup('test/counter')).toBeUndefined();
        });

        it('returns false when removing a key that was never registered', () => {
            const registry = new SystemContextRegistry();
            expect(registry.remove('nonexistent/key')).toBe(false);
        });
    });

    describe('getBaselineText', () => {
        it('renders baseline text from registered sources', async () => {
            const registry = new SystemContextRegistry();
            const counter = makeCounterSource('test/counter');
            counter.setValue('42');
            registry.register(packSystemContextSource(counter.source));

            const baseline = await registry.getBaselineText();
            expect(baseline).toContain('Counter (test/counter): 42');
        });

        it('joins multiple source baselines with double-newline separator', async () => {
            const registry = new SystemContextRegistry();
            const a = makeCounterSource('test/a');
            const b = makeCounterSource('test/b');
            a.setValue('1');
            b.setValue('2');
            registry.register(packSystemContextSource(a.source));
            registry.register(packSystemContextSource(b.source));

            const baseline = await registry.getBaselineText();
            expect(baseline).toContain('Counter (test/a): 1');
            expect(baseline).toContain('Counter (test/b): 2');
            expect(baseline.includes('\n\n')).toBe(true);
        });

        it('omits unavailable sources (loader returns null) from the baseline', async () => {
            const registry = new SystemContextRegistry();
            registry.register(
                packSystemContextSource<string>({
                    key: 'test/unavailable',
                    codec: stringContextCodec,
                    loader: async () => null,
                    baseline: () => 'should-not-appear',
                    update: () => null,
                }),
            );

            const baseline = await registry.getBaselineText();
            expect(baseline).toBe('');
        });
    });

    describe('getUpdatesSince', () => {
        it('emits update delta when a source value changes after baseline', async () => {
            const registry = new SystemContextRegistry();
            const counter = makeCounterSource('test/counter');
            counter.setValue('v1');
            registry.register(packSystemContextSource(counter.source));

            await registry.getBaselineText();
            counter.setValue('v2');

            const { updates, newEpoch } = await registry.getUpdatesSince(0);
            expect(updates).toHaveLength(1);
            expect(updates[0]).toContain('changed from v1 to v2');
            expect(newEpoch).toBe(1);
        });

        it('returns empty updates with unchanged epoch when nothing changed', async () => {
            const registry = new SystemContextRegistry();
            const counter = makeCounterSource('test/counter');
            counter.setValue('stable');
            registry.register(packSystemContextSource(counter.source));

            await registry.getBaselineText();
            const { updates, newEpoch } = await registry.getUpdatesSince(0);
            expect(updates).toHaveLength(0);
            expect(newEpoch).toBe(0);
        });

        it('advances epoch monotonically across successive change batches', async () => {
            const registry = new SystemContextRegistry();
            const counter = makeCounterSource('test/counter');
            counter.setValue('a');
            registry.register(packSystemContextSource(counter.source));

            await registry.getBaselineText();

            counter.setValue('b');
            const batch1 = await registry.getUpdatesSince(0);
            expect(batch1.newEpoch).toBe(1);

            counter.setValue('c');
            const batch2 = await registry.getUpdatesSince(batch1.newEpoch);
            expect(batch2.newEpoch).toBe(2);
            expect(batch2.updates[0]).toContain('changed from b to c');
        });

        it('emits baseline text for a newly registered source after initial baseline', async () => {
            const registry = new SystemContextRegistry();
            const a = makeCounterSource('test/a');
            a.setValue('1');
            registry.register(packSystemContextSource(a.source));

            await registry.getBaselineText();

            const b = makeCounterSource('test/b');
            b.setValue('2');
            registry.register(packSystemContextSource(b.source));

            const { updates } = await registry.getUpdatesSince(0);
            expect(updates.some((text) => text.includes('Counter (test/b): 2'))).toBe(true);
        });

        it('emits removal text for a removed source that had a removed renderer', async () => {
            const registry = new SystemContextRegistry();
            const counter = makeCounterSource('test/counter');
            counter.setValue('active');
            registry.register(packSystemContextSource(counter.source));

            await registry.getBaselineText();
            registry.remove('test/counter');

            const { updates } = await registry.getUpdatesSince(0);
            expect(updates.some((text) => text.includes('no longer active'))).toBe(true);
        });

        it('preserves prior snapshot for unavailable sources (stale-while-revalidate)', async () => {
            const registry = new SystemContextRegistry();
            let available = true;
            const { source, setValue } = makeCounterSource('test/counter');
            setValue('v1');
            const dynamicSource: SystemContextSource<string> = {
                ...source,
                loader: async () => (available ? source.loader() : null),
            };
            registry.register(packSystemContextSource(dynamicSource));

            await registry.getBaselineText();

            available = false;
            const { updates, newEpoch } = await registry.getUpdatesSince(0);
            expect(updates).toHaveLength(0);
            expect(newEpoch).toBe(0);

            available = true;
            setValue('v2');
            const { updates: updates2 } = await registry.getUpdatesSince(0);
            expect(updates2.some((text) => text.includes('changed from v1 to v2'))).toBe(true);
        });
    });

    describe('compact', () => {
        it('resets the epoch to zero and clears snapshots', async () => {
            const registry = new SystemContextRegistry();
            const counter = makeCounterSource('test/counter');
            counter.setValue('v1');
            registry.register(packSystemContextSource(counter.source));

            await registry.getBaselineText();
            counter.setValue('v2');
            await registry.getUpdatesSince(0);
            expect(registry.currentEpoch).toBe(1);

            registry.compact();
            expect(registry.currentEpoch).toBe(0);

            const baseline = await registry.getBaselineText();
            expect(baseline).toContain('Counter (test/counter): v2');
        });

        it('starts a fresh epoch where the current values become the new baseline', async () => {
            const registry = new SystemContextRegistry();
            const counter = makeCounterSource('test/counter');
            counter.setValue('v1');
            registry.register(packSystemContextSource(counter.source));

            await registry.getBaselineText();
            counter.setValue('v2');
            await registry.getUpdatesSince(0);

            registry.compact();

            const baseline = await registry.getBaselineText();
            expect(baseline).toContain('Counter (test/counter): v2');

            const { updates, newEpoch } = await registry.getUpdatesSince(0);
            expect(updates).toHaveLength(0);
            expect(newEpoch).toBe(0);
        });
    });
});

describe('emitMidConversationSystemMessage', () => {
    it('returns no messages and unchanged epoch when nothing changed', async () => {
        const registry = new SystemContextRegistry();
        const counter = makeCounterSource('test/counter');
        counter.setValue('stable');
        registry.register(packSystemContextSource(counter.source));

        await registry.getBaselineText();
        const result = await emitMidConversationSystemMessage(registry, 0);
        expect(result.messages).toHaveLength(0);
        expect(result.newEpoch).toBe(0);
    });

    it('combines multiple source updates into one system message with advancing epoch', async () => {
        const registry = new SystemContextRegistry();
        const a = makeCounterSource('test/a');
        const b = makeCounterSource('test/b');
        a.setValue('1');
        b.setValue('1');
        registry.register(packSystemContextSource(a.source));
        registry.register(packSystemContextSource(b.source));

        await registry.getBaselineText();
        a.setValue('2');
        b.setValue('2');

        const result = await emitMidConversationSystemMessage(registry, 0);
        expect(result.messages).toHaveLength(1);
        expect(result.messages[0]?.role).toBe('system');
        expect(result.messages[0]?.content).toContain('changed from 1 to 2');
        expect(result.newEpoch).toBe(1);
    });

    it('produces a message matching the protocol system-role shape', async () => {
        const registry = new SystemContextRegistry();
        const counter = makeCounterSource('test/counter');
        counter.setValue('v1');
        registry.register(packSystemContextSource(counter.source));

        await registry.getBaselineText();
        counter.setValue('v2');

        const { messages } = await emitMidConversationSystemMessage(registry, 0);
        const message = messages[0];
        expect(message).toBeDefined();
        expect(message?.role).toBe('system');
        expect(typeof message?.content).toBe('string');
    });
});
