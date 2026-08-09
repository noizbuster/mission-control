import { errorToString, resolveMissionControlDataDir } from '@mission-control/core';
import { addDefaultParsers, getTreeSitterClient } from '@opentui/core';
import { TREE_SITTER_PARSERS } from '../components/markdown/parsers-config';

let bootstrapped = false;
let bootstrapPromise: Promise<void> | undefined;

export function bootstrapTreeSitter(): Promise<void> {
    if (bootstrapped) return Promise.resolve();
    if (bootstrapPromise !== undefined) return bootstrapPromise;
    bootstrapPromise = initializeTreeSitter().finally(() => {
        bootstrapPromise = undefined;
    });
    return bootstrapPromise;
}

async function initializeTreeSitter(): Promise<void> {
    try {
        addDefaultParsers([...TREE_SITTER_PARSERS]);
        const client = getTreeSitterClient();
        await client.setDataPath(resolveMissionControlDataDir());
        bootstrapped = true;
    } catch (error: unknown) {
        const message = errorToString(error);
        process.stderr.write(`tree-sitter bootstrap failed: ${message}\n`);
    }
}

export function resetTreeSitterBootstrapForTest(): void {
    bootstrapped = false;
    bootstrapPromise = undefined;
}
