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
    TREE_SITTER_PARSERS: [
        { filetype: 'python', wasm: 'https://example.test/python.wasm', queries: { highlights: [] } },
    ],
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
        expect(addDefaultParsers).toHaveBeenCalledWith([expect.objectContaining({ filetype: 'python' })]);
        expect(getTreeSitterClient).toHaveBeenCalled();
        expect(setDataPath).toHaveBeenCalledWith('/tmp/mctrl-test-data');
    });

    it('shares an in-flight bootstrap so concurrent mounts wait for initialization', async () => {
        const { bootstrapTreeSitter, resetTreeSitterBootstrapForTest } = await import('./tree-sitter-bootstrap');
        resetTreeSitterBootstrapForTest();
        let releaseDataPath: (() => void) | undefined;
        setDataPath.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    releaseDataPath = resolve;
                }),
        );

        const first = bootstrapTreeSitter();
        const second = bootstrapTreeSitter();
        let secondSettled = false;
        void second.then(() => {
            secondSettled = true;
        });

        expect(addDefaultParsers).toHaveBeenCalledTimes(1);
        await Promise.resolve();
        expect(secondSettled).toBe(false);

        releaseDataPath?.();
        await Promise.all([first, second]);
        expect(secondSettled).toBe(true);
        expect(setDataPath).toHaveBeenCalledTimes(1);
    });
});
