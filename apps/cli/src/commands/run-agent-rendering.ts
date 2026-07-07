import { type PersistentMemoryStore, TursoPersistentStore } from '@mission-control/core';
import type { CliArgs } from '../args.js';
import { type AgentUIRenderer, JsonRenderer, PlainRenderer, TuiRenderer } from '../ui/renderers.js';

export function closePersistentStore(store: PersistentMemoryStore | undefined): void {
    if (store instanceof TursoPersistentStore) {
        store.close();
    }
}

export function createRenderer(mode: CliArgs['mode'], thinking = false): AgentUIRenderer {
    switch (mode) {
        case 'plain':
            return new PlainRenderer({ thinking });
        case 'json':
        case 'jsonl':
            return new JsonRenderer();
        case 'tui':
            return new TuiRenderer({ thinking });
        default:
            return assertNever(mode);
    }
}

function assertNever(value: never): never {
    throw new Error(`Unexpected CLI mode: ${String(value)}`);
}
