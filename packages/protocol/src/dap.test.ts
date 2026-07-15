import { describe, expect, it } from 'vitest';
import { BUILTIN_DAP_ADAPTERS, DapAdapterRegistrySchema, DapAdapterSchema } from './dap';

describe('DapAdapterSchema', () => {
    it('parses a valid adapter entry', () => {
        const parsed = DapAdapterSchema.parse({
            id: 'lldb-dap',
            command: 'lldb-dap',
            languages: ['c', 'cpp', 'rust'],
            supported: false,
        });
        expect(parsed.id).toBe('lldb-dap');
        expect(parsed.supported).toBe(false);
    });

    it('rejects an entry missing a required field', () => {
        expect(() =>
            DapAdapterSchema.parse({
                id: 'debugpy',
                command: 'debugpy-adapter',
                languages: ['python'],
            }),
        ).toThrow();
    });

    it('rejects an unknown field under strict mode', () => {
        expect(() =>
            DapAdapterSchema.parse({
                id: 'dlv',
                command: 'dlv',
                languages: ['go'],
                supported: false,
                extra: true,
            }),
        ).toThrow();
    });
});

describe('DapAdapterRegistrySchema', () => {
    it('parses a registry wrapping multiple adapters', () => {
        const parsed = DapAdapterRegistrySchema.parse({ adapters: BUILTIN_DAP_ADAPTERS });
        expect(parsed.adapters).toHaveLength(4);
        expect(parsed.adapters.every((entry) => entry.supported === false)).toBe(true);
    });

    it('parses an empty registry', () => {
        const parsed = DapAdapterRegistrySchema.parse({ adapters: [] });
        expect(parsed.adapters).toEqual([]);
    });
});

describe('BUILTIN_DAP_ADAPTERS catalog', () => {
    it('declares lldb-dap, debugpy, dlv, and js-debug as unsupported catalog entries', () => {
        const ids = BUILTIN_DAP_ADAPTERS.map((entry) => entry.id);
        expect(ids).toEqual(['lldb-dap', 'debugpy', 'dlv', 'js-debug']);
        expect(BUILTIN_DAP_ADAPTERS.every((entry) => entry.supported === false)).toBe(true);
    });

    it('every catalog entry validates against DapAdapterSchema', () => {
        for (const entry of BUILTIN_DAP_ADAPTERS) {
            expect(DapAdapterSchema.safeParse(entry).success).toBe(true);
        }
    });
});
