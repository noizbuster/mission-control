import { afterEach, describe, expect, it, vi } from 'vitest';

const addDefaultParsers = vi.fn();
const setDataPath = vi.fn(async () => {});
const getTreeSitterClient = vi.fn(() => ({ setDataPath }));

vi.mock('@opentui/core', () => ({
    addDefaultParsers,
    getTreeSitterClient,
}));

vi.mock('@mission-control/core', () => ({
    resolveMissionControlDataDir: () => '/tmp/mctrl-test-data',
}));

vi.mock('../components/markdown/parsers-config', () => ({
    TREE_SITTER_PARSERS: [{ filetype: 'python', wasm: 'https://example.test/python.wasm', queries: { highlights: [] } }],
}));

describe('bootstrapTreeSitter', () => {
    afterEach(async () => {
        vi.resetModules();
        addDefaultParsers.mockClear();
        setDataPath.mockClear();
        getTreeSitterClient.mockClear();
    });

    it('registers parser metadata and sets the data path once', async () => {
        const { bootstrapTreeSitter, resetTreeSitterBootstrapForTest } = await import('./tree-sitter-bootstrap');
        resetTreeSitterBootstrapForTest();

        await bootstrapTreeSitter();
        await bootstrapTreeSitter();

        expect(addDefaultParsers).toHaveBeenCalledTimes(1);
        expect(addDefaultParsers).toHaveBeenCalledWith([
            expect.objectContaining({ filetype: 'python' }),
        ]);
        expect(getTreeSitterClient).toHaveBeenCalled();
        expect(setDataPath).toHaveBeenCalledWith('/tmp/mctrl-test-data');
    });
});
