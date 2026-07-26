import { errorToString, resolveMissionControlDataDir } from '@mission-control/core';
import { addDefaultParsers, getTreeSitterClient } from '@opentui/core';
import { TREE_SITTER_PARSERS } from '../components/markdown/parsers-config';

let bootstrapped = false;

export async function bootstrapTreeSitter(): Promise<void> {
    if (bootstrapped) return;
    bootstrapped = true;
    try {
        addDefaultParsers([...TREE_SITTER_PARSERS]);
        const client = getTreeSitterClient();
        await client.setDataPath(resolveMissionControlDataDir());
    } catch (error: unknown) {
        bootstrapped = false;
        const message = errorToString(error);
        process.stderr.write(`tree-sitter bootstrap failed: ${message}\n`);
    }
}

export function resetTreeSitterBootstrapForTest(): void {
    bootstrapped = false;
}
